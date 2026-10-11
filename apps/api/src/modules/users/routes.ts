import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  createInviteSchema,
  transferOwnershipSchema,
  updateUserSchema,
  type TeamInvite,
  type TeamUser,
} from '@supplycast/shared';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';
import { auditReq } from '../audit/service';
import { createWithinLimit } from '../billing/limits';
import { INVITE_TTL_MS, newToken, RESET_TTL_MS } from './service';

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

const toTeamUser = (u: {
  id: string;
  email: string;
  name: string;
  role: TeamUser['role'];
  isActive: boolean;
  createdAt: Date;
}): TeamUser => ({
  ...u,
  createdAt: u.createdAt.toISOString(),
});

export function usersRouter(opts: { guards: Guards; appUrl: string }): Router {
  const { guards, appUrl } = opts;
  const router = Router();

  router.get('/users', ...guards.tenant('team:read'), async (req, res, next) => {
    try {
      const p = paginationSchema.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.user.findMany({
          orderBy: { createdAt: 'asc' },
          select: userSelect,
          ...skipTake(p),
        }),
        req.db!.user.count(),
      ]);
      res.json(paged(rows.map(toTeamUser), total, p));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/users/:id', ...guards.tenant('team:manage'), async (req, res, next) => {
    try {
      const input = updateUserSchema.parse(req.body);
      const target = await req.db!.user.findUnique({ where: { id: req.params.id } });
      if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
      const actor = req.auth!;
      if (target.role === 'OWNER') {
        if (actor.role !== 'OWNER')
          throw new HttpError(403, 'FORBIDDEN', 'Only the Owner can change the Owner');
        throw new HttpError(
          400,
          'OWNER_PROTECTED',
          'The Owner cannot be demoted or deactivated. Transfer ownership first.',
        );
      }
      if (target.id === actor.userId) {
        throw new HttpError(
          400,
          'SELF_MODIFY',
          'You cannot change your own role or deactivate yourself',
        );
      }
      const data = {
        ...(input.role && { role: input.role }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      };
      // Reactivating a user takes a seat, so it is checked against the plan's user limit.
      const updated =
        input.isActive === true && !target.isActive
          ? await createWithinLimit(req.tenantId!, 'users', (tx) =>
              tx.user.update({ where: { id: target.id }, data, select: userSelect }),
            )
          : await req.db!.user.update({ where: { id: target.id }, data, select: userSelect });
      if (input.isActive === false) {
        await prisma.refreshToken.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await auditReq(req, 'user.deactivated', 'User', target.id, { email: target.email });
      }
      if (input.isActive === true && !target.isActive) {
        await auditReq(req, 'user.reactivated', 'User', target.id, { email: target.email });
      }
      if (input.role && input.role !== target.role) {
        await auditReq(req, 'user.role_changed', 'User', target.id, {
          email: target.email,
          from: target.role,
          to: input.role,
        });
      }
      res.json({ user: toTeamUser(updated) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/users/:id/reset-link', ...guards.tenant('team:manage'), async (req, res, next) => {
    try {
      const target = await req.db!.user.findUnique({ where: { id: req.params.id } });
      if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
      if (target.role === 'OWNER' && req.auth!.role !== 'OWNER') {
        throw new HttpError(403, 'FORBIDDEN', 'Only the Owner can reset the Owner’s password');
      }
      const { token, tokenHash } = newToken();
      const expiresAt = new Date(Date.now() + RESET_TTL_MS);
      await prisma.$transaction([
        prisma.passwordResetToken.deleteMany({ where: { userId: target.id, usedAt: null } }),
        prisma.passwordResetToken.create({ data: { userId: target.id, tokenHash, expiresAt } }),
      ]);
      await auditReq(req, 'user.reset_link_created', 'User', target.id, { email: target.email });
      res.status(201).json({ link: `${appUrl}/reset-password?token=${token}`, expiresAt });
    } catch (err) {
      next(err);
    }
  });

  router.post('/invites', ...guards.tenant('team:manage'), async (req, res, next) => {
    try {
      const input = createInviteSchema.parse(req.body);
      if (await prisma.user.findUnique({ where: { email: input.email } })) {
        throw new HttpError(409, 'EMAIL_TAKEN', 'A user with this email already exists');
      }
      const { token, tokenHash } = newToken();
      const invite = await createWithinLimit(
        req.tenantId!,
        'users',
        (tx) =>
          tx.invite.create({
            data: {
              tenantId: req.tenantId!,
              email: input.email,
              role: input.role,
              tokenHash,
              expiresAt: new Date(Date.now() + INVITE_TTL_MS),
              invitedById: req.auth!.userId,
            },
          }),
        {
          // A re-invite replaces the old one, so drop it before counting seats.
          beforeCount: async (tx) => {
            await tx.invite.deleteMany({
              where: { tenantId: req.tenantId!, email: input.email, acceptedAt: null },
            });
          },
        },
      );
      await auditReq(req, 'user.invited', 'Invite', invite.id, {
        email: input.email,
        role: input.role,
      });
      res.status(201).json({
        invite: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
        },
        link: `${appUrl}/accept-invite?token=${token}`,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/invites', ...guards.tenant('team:read'), async (req, res, next) => {
    try {
      const p = paginationSchema.parse(req.query);
      const where = { acceptedAt: null };
      const [rows, total] = await Promise.all([
        req.db!.invite.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(p) }),
        req.db!.invite.count({ where }),
      ]);
      const now = Date.now();
      const items: TeamInvite[] = rows.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
        expired: i.expiresAt.getTime() <= now,
      }));
      res.json(paged(items, total, p));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/invites/:id', ...guards.tenant('team:manage'), async (req, res, next) => {
    try {
      const invite = await req.db!.invite.findFirst({
        where: { id: req.params.id, acceptedAt: null },
      });
      if (!invite) throw new HttpError(404, 'NOT_FOUND', 'Invite not found');
      await req.db!.invite.delete({ where: { id: invite.id } });
      await auditReq(req, 'invite.revoked', 'Invite', invite.id, { email: invite.email });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/tenant/transfer-ownership',
    ...guards.tenant('tenant:transfer-ownership'),
    async (req, res, next) => {
      try {
        const input = transferOwnershipSchema.parse(req.body);
        const me = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
        if (!(await bcrypt.compare(input.password, me.passwordHash))) {
          throw new HttpError(400, 'INVALID_PASSWORD', 'Password is incorrect');
        }
        if (input.userId === me.id)
          throw new HttpError(400, 'SELF_TRANSFER', 'You already own this account');
        const target = await req.db!.user.findUnique({ where: { id: input.userId } });
        if (!target) throw new HttpError(404, 'NOT_FOUND', 'User not found');
        if (!target.isActive)
          throw new HttpError(
            400,
            'USER_INACTIVE',
            'Cannot transfer ownership to a deactivated user',
          );
        await prisma.$transaction([
          prisma.user.update({ where: { id: target.id }, data: { role: 'OWNER' } }),
          prisma.user.update({ where: { id: me.id }, data: { role: 'ADMIN' } }),
        ]);
        await auditReq(req, 'tenant.ownership_transferred', 'Tenant', req.tenantId, {
          from: me.email,
          to: target.email,
        });
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
