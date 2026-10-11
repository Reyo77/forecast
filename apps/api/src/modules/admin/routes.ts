import { Router } from 'express';
import { z } from 'zod';
import { adminSubscriptionSchema, customLimitsSchema } from '@supplycast/shared';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';
import { DAY_MS } from '../../lib/time';
import { auditReq } from '../audit/service';
import { IMPERSONATION_TTL_SECONDS, signAccessToken } from '../auth/tokens';
import { toAuthUser } from '../auth/service';
import { calculateMrr, toInvoiceDto } from '../billing/invoices';
import { getPlanByCode, toPlanDto } from '../billing/plans';
import { getSubscriptionView } from '../billing/subscription';
import { newToken, RESET_TTL_MS } from '../users/service';

const listQuery = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
  plan: z.string().trim().max(30).optional(),
});

export function adminRouter(opts: {
  guards: Guards;
  accessSecret: string;
  appUrl: string;
  simulatedPayments: boolean;
}): Router {
  const { guards, accessSecret, appUrl, simulatedPayments } = opts;
  const router = Router();
  const guard = guards.any('admin:access');

  async function findTenant(id: string) {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new HttpError(404, 'NOT_FOUND', 'Tenant not found');
    return tenant;
  }

  router.get('/tenants', ...guard, async (req, res, next) => {
    try {
      const q = listQuery.parse(req.query);
      const where: Prisma.TenantWhereInput = {
        ...(q.status && { status: q.status }),
        ...(q.plan && { subscription: { plan: { code: q.plan } } }),
        ...(q.search && {
          OR: [
            { name: { contains: q.search } },
            { slug: { contains: q.search } },
            { users: { some: { email: { contains: q.search } } } },
          ],
        }),
      };
      const [rows, total] = await Promise.all([
        prisma.tenant.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          ...skipTake(q),
          include: {
            subscription: { include: { plan: true } },
            _count: { select: { users: true } },
            users: {
              select: { lastLoginAt: true },
              orderBy: { lastLoginAt: { sort: 'desc', nulls: 'last' } },
              take: 1,
            },
          },
        }),
        prisma.tenant.count({ where }),
      ]);
      res.json(
        paged(
          rows.map((t) => ({
            id: t.id,
            name: t.name,
            slug: t.slug,
            status: t.status,
            createdAt: t.createdAt,
            userCount: t._count.users,
            plan: t.subscription
              ? { code: t.subscription.plan.code, name: t.subscription.plan.name }
              : null,
            subscriptionStatus: t.subscription?.status ?? null,
            lastActivityAt: t.users[0]?.lastLoginAt ?? null,
          })),
          total,
          q,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/tenants/:id', ...guard, async (req, res, next) => {
    try {
      const tenant = await findTenant(req.params.id!);
      req.auditTenantId = tenant.id;
      const [users, invoices, subscription, subRow] = await Promise.all([
        prisma.user.findMany({
          where: { tenantId: tenant.id },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            lastLoginAt: true,
          },
        }),
        prisma.invoice.findMany({
          where: { tenantId: tenant.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        getSubscriptionView(tenant.id, simulatedPayments).catch(() => null),
        prisma.subscription.findUnique({ where: { tenantId: tenant.id } }),
      ]);
      res.json({
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          createdAt: tenant.createdAt,
        },
        users,
        invoices: invoices.map(toInvoiceDto),
        subscription,
        customLimits: subRow?.customLimits ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  for (const [path, status, action] of [
    ['suspend', 'SUSPENDED', 'tenant.suspended'],
    ['reactivate', 'ACTIVE', 'tenant.reactivated'],
  ] as const) {
    router.post(`/tenants/:id/${path}`, ...guard, async (req, res, next) => {
      try {
        const tenant = await findTenant(req.params.id!);
        req.auditTenantId = tenant.id;
        if (tenant.status === 'DELETED')
          throw new HttpError(409, 'TENANT_DELETED', 'This tenant has been deleted');
        const updated = await prisma.tenant.update({ where: { id: tenant.id }, data: { status } });
        await auditReq(req, action, 'Tenant', tenant.id, {
          name: tenant.name,
          from: tenant.status,
        });
        res.json({ tenant: { id: updated.id, status: updated.status } });
      } catch (err) {
        next(err);
      }
    });
  }

  router.post('/tenants/:id/owner-reset-link', ...guard, async (req, res, next) => {
    try {
      const tenant = await findTenant(req.params.id!);
      req.auditTenantId = tenant.id;
      const owner = await prisma.user.findFirst({ where: { tenantId: tenant.id, role: 'OWNER' } });
      if (!owner) throw new HttpError(404, 'NOT_FOUND', 'Tenant has no Owner');
      const { token, tokenHash } = newToken();
      const expiresAt = new Date(Date.now() + RESET_TTL_MS);
      await prisma.$transaction([
        prisma.passwordResetToken.deleteMany({ where: { userId: owner.id, usedAt: null } }),
        prisma.passwordResetToken.create({ data: { userId: owner.id, tokenHash, expiresAt } }),
      ]);
      await auditReq(req, 'user.reset_link_created', 'User', owner.id, {
        email: owner.email,
        byAdmin: true,
      });
      res.status(201).json({
        link: `${appUrl}/reset-password?token=${token}`,
        expiresAt,
        ownerEmail: owner.email,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/tenants/:id/impersonate', ...guard, async (req, res, next) => {
    try {
      if (req.auth!.impersonatorId)
        throw new HttpError(403, 'FORBIDDEN', 'Cannot impersonate while impersonating');
      const tenant = await findTenant(req.params.id!);
      req.auditTenantId = tenant.id;
      const owner = await prisma.user.findFirst({
        where: { tenantId: tenant.id, role: 'OWNER', isActive: true },
      });
      if (!owner) throw new HttpError(404, 'NOT_FOUND', 'Tenant has no active Owner');
      const accessToken = signAccessToken(
        { sub: owner.id, tenantId: tenant.id, role: owner.role, imp: req.auth!.userId },
        accessSecret,
        IMPERSONATION_TTL_SECONDS,
      );
      await auditReq(req, 'admin.impersonation_started', 'Tenant', tenant.id, {
        name: tenant.name,
        asUser: owner.id,
      });
      res.json({
        accessToken,
        user: toAuthUser(owner),
        tenantName: tenant.name,
        expiresInSeconds: IMPERSONATION_TTL_SECONDS,
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/tenants/:id/subscription', ...guard, async (req, res, next) => {
    try {
      const input = adminSubscriptionSchema.parse(req.body);
      const tenant = await findTenant(req.params.id!);
      req.auditTenantId = tenant.id;
      const sub = await prisma.subscription.findUnique({ where: { tenantId: tenant.id } });
      if (!sub) throw new HttpError(404, 'NOT_FOUND', 'Tenant has no subscription');
      const plan = input.planCode ? await getPlanByCode(input.planCode) : null;
      if (input.planCode && !plan) throw new HttpError(400, 'PLAN_UNAVAILABLE', 'Unknown plan');
      if (input.customLimits) customLimitsSchema.parse(input.customLimits);
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          ...(plan && { planId: plan.id, pendingPlanId: null }),
          ...(input.status && { status: input.status }),
          ...(input.customLimits !== undefined && {
            customLimits: input.customLimits === null ? Prisma.DbNull : input.customLimits,
          }),
        },
      });
      await auditReq(
        req,
        'admin.subscription_updated',
        'Subscription',
        sub.id,
        { ...input },
        tenant.id,
      );
      res.json(await getSubscriptionView(tenant.id, simulatedPayments));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/invoices/:id', ...guard, async (req, res, next) => {
    try {
      const { status } = z.object({ status: z.enum(['PAID', 'VOID']) }).parse(req.body);
      const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
      if (!invoice) throw new HttpError(404, 'NOT_FOUND', 'Invoice not found');
      req.auditTenantId = invoice.tenantId;
      if (invoice.status === 'VOID')
        throw new HttpError(409, 'INVOICE_VOID', 'A void invoice cannot be changed');
      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status, ...(status === 'PAID' && !invoice.paidAt && { paidAt: new Date() }) },
      });
      await auditReq(req, 'admin.invoice_updated', 'Invoice', invoice.id, {
        number: invoice.number,
        from: invoice.status,
        to: status,
      });
      res.json({ invoice: toInvoiceDto(updated) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/metrics', ...guard, async (_req, res, next) => {
    try {
      const now = new Date();
      const [subs, tenantsByStatus, invoices, ai, failedJobs, failedCount, totalUsers] =
        await Promise.all([
          prisma.subscription.findMany({ include: { plan: true } }),
          prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
          prisma.invoice.findMany({
            select: {
              tenantId: true,
              amountCents: true,
              status: true,
              periodStart: true,
              periodEnd: true,
            },
          }),
          prisma.aiRequest.findMany({
            where: { createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } },
            select: { createdAt: true },
          }),
          prisma.job.findMany({
            where: { status: 'FAILED' },
            orderBy: { updatedAt: 'desc' },
            take: 10,
            select: { id: true, type: true, lastError: true, updatedAt: true, tenantId: true },
          }),
          prisma.job.count({ where: { status: 'FAILED' } }),
          prisma.user.count({ where: { tenantId: { not: null } } }),
        ]);
      const byPlan = new Map<string, { plan: string; count: number }>();
      for (const s of subs) {
        const cur = byPlan.get(s.plan.code) ?? { plan: s.plan.name, count: 0 };
        cur.count++;
        byPlan.set(s.plan.code, cur);
      }
      const trialsStarted = subs.filter((s) => s.trialEndsAt).length;
      const converted = subs.filter((s) => s.convertedAt).length;
      const perDay = new Map<string, number>();
      for (let i = 29; i >= 0; i--)
        perDay.set(new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10), 0);
      for (const r of ai) {
        const d = r.createdAt.toISOString().slice(0, 10);
        if (perDay.has(d)) perDay.set(d, perDay.get(d)! + 1);
      }
      res.json({
        tenantsByPlan: [...byPlan.entries()].map(([code, v]) => ({ code, ...v })),
        tenantsByStatus: tenantsByStatus.map((g) => ({ status: g.status, count: g._count._all })),
        totalTenants: subs.length,
        totalUsers,
        mrrCents: calculateMrr(invoices, now),
        trials: {
          started: trialsStarted,
          converted,
          conversionRate: trialsStarted ? converted / trialsStarted : 0,
        },
        aiRequestsPerDay: [...perDay.entries()].map(([date, count]) => ({ date, count })),
        failedJobs: { count: failedCount, recent: failedJobs },
        plans: subs.length ? undefined : [],
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export { toPlanDto };
