import { Router } from 'express';
import { z } from 'zod';
import { changePlanSchema, planInputSchema, planPatchSchema } from '@supplycast/shared';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';
import { auditReq } from '../audit/service';
import { toInvoiceDto } from './invoices';
import { ensureDefaultPlans, toPlanDto } from './plans';
import { cancelSubscription, changePlan, getSubscriptionView } from './subscription';

export function billingRouter(opts: { guards: Guards; simulatedPayments: boolean }): Router {
  const { guards, simulatedPayments } = opts;
  const router = Router();

  // Public pricing page data.
  router.get('/plans', async (_req, res, next) => {
    try {
      await ensureDefaultPlans();
      const plans = await prisma.plan.findMany({
        where: { isActive: true, isPublic: true },
        orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
      });
      res.json({ items: plans.map(toPlanDto) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/billing/subscription', ...guards.tenant('billing:read'), async (req, res, next) => {
    try {
      res.json(await getSubscriptionView(req.tenantId!, simulatedPayments));
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/billing/change-plan',
    ...guards.tenant('billing:manage'),
    async (req, res, next) => {
      try {
        const { planCode } = changePlanSchema.parse(req.body);
        const before = await prisma.subscription.findUnique({
          where: { tenantId: req.tenantId! },
          include: { plan: true },
        });
        const result = await changePlan(req.tenantId!, planCode);
        await auditReq(req, 'billing.plan_changed', 'Subscription', before?.id, {
          from: before?.plan.code,
          to: planCode,
          result: result.result,
        });
        res.json({
          ...result,
          subscription: await getSubscriptionView(req.tenantId!, simulatedPayments),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post('/billing/cancel', ...guards.tenant('billing:manage'), async (req, res, next) => {
    try {
      const result = await cancelSubscription(req.tenantId!);
      await auditReq(req, 'billing.cancelled', 'Subscription', null, { result: result.result });
      res.json({
        ...result,
        subscription: await getSubscriptionView(req.tenantId!, simulatedPayments),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/billing/invoices', ...guards.tenant('billing:read'), async (req, res, next) => {
    try {
      const p = paginationSchema.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.invoice.findMany({ orderBy: { createdAt: 'desc' }, ...skipTake(p) }),
        req.db!.invoice.count(),
      ]);
      res.json(paged(rows.map(toInvoiceDto), total, p));
    } catch (err) {
      next(err);
    }
  });

  router.get('/billing/invoices/:id', ...guards.tenant('billing:read'), async (req, res, next) => {
    try {
      const invoice = await req.db!.invoice.findUnique({ where: { id: req.params.id } });
      if (!invoice) throw new HttpError(404, 'NOT_FOUND', 'Invoice not found');
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.tenantId! } });
      res.json({ invoice: toInvoiceDto(invoice), billedTo: tenant.name });
    } catch (err) {
      next(err);
    }
  });

  // ---- Super Admin: plan management ----
  router.get('/admin/plans', ...guards.any('admin:access'), async (_req, res, next) => {
    try {
      await ensureDefaultPlans();
      const plans = await prisma.plan.findMany({
        orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
        include: { _count: { select: { subscriptions: true } } },
      });
      res.json({
        items: plans.map((p) => ({ ...toPlanDto(p), subscriberCount: p._count.subscriptions })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/admin/plans', ...guards.any('admin:access'), async (req, res, next) => {
    try {
      const input = planInputSchema.parse(req.body);
      if (await prisma.plan.findUnique({ where: { code: input.code } })) {
        throw new HttpError(409, 'PLAN_EXISTS', 'A plan with this code already exists');
      }
      const plan = await prisma.plan.create({ data: input });
      await auditReq(req, 'plan.created', 'Plan', plan.id, { code: plan.code });
      res.status(201).json({ plan: toPlanDto(plan) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/admin/plans/:id', ...guards.any('admin:access'), async (req, res, next) => {
    try {
      const patch = planPatchSchema.parse(req.body);
      const existing = await prisma.plan.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Plan not found');
      const plan = await prisma.plan.update({ where: { id: existing.id }, data: patch });
      await auditReq(req, 'plan.updated', 'Plan', plan.id, {
        code: plan.code,
        changed: Object.keys(patch),
      });
      res.json({ plan: toPlanDto(plan) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/admin/plans/:id', ...guards.any('admin:access'), async (req, res, next) => {
    try {
      z.string().min(1).parse(req.params.id);
      const existing = await prisma.plan.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Plan not found');
      const inUse = await prisma.subscription.count({
        where: { OR: [{ planId: existing.id }, { pendingPlanId: existing.id }] },
      });
      if (inUse > 0) {
        throw new HttpError(
          409,
          'PLAN_IN_USE',
          `${inUse} subscription(s) use this plan. Deactivate it instead.`,
        );
      }
      await prisma.plan.delete({ where: { id: existing.id } });
      await auditReq(req, 'plan.deleted', 'Plan', existing.id, { code: existing.code });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
