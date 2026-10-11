import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/client';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';

const querySchema = paginationSchema.extend({
  action: z.string().trim().min(1).max(100).optional(),
  actorId: z.string().min(1).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  tenantId: z.string().min(1).max(64).optional(),
});

export function auditRouter(guards: Guards): Router {
  const router = Router();

  router.get('/', ...guards.any('audit:read'), async (req, res, next) => {
    try {
      const q = querySchema.parse(req.query);
      // Tenant users are confined to their own tenant by the scoped client; only a
      // Super Admin (no tenant) reads across tenants and may filter by tenantId.
      const db = req.db ?? prisma;
      const where = {
        ...(!req.auth!.tenantId && q.tenantId && { tenantId: q.tenantId }),
        ...(q.action && { action: { startsWith: q.action } }),
        ...(q.actorId && { actorId: q.actorId }),
        ...((q.from || q.to) && {
          createdAt: { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) },
        }),
      };
      const [items, total] = await Promise.all([
        db.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          ...skipTake(q),
          include: { actor: { select: { id: true, name: true, email: true } } },
        }),
        db.auditLog.count({ where }),
      ]);
      res.json(paged(items, total, q));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
