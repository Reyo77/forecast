import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';

export function notificationsRouter(guards: Guards): Router {
  const router = Router();
  const guard = guards.tenant('notifications:read');
  const mine = (userId: string) => ({ userId });

  router.get('/notifications', ...guard, async (req, res, next) => {
    try {
      const q = paginationSchema
        .extend({ unread: z.enum(['true', 'false']).optional() })
        .parse(req.query);
      const where = { ...mine(req.auth!.userId), ...(q.unread === 'true' && { readAt: null }) };
      const [rows, total, unreadCount] = await Promise.all([
        req.db!.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
        req.db!.notification.count({ where }),
        req.db!.notification.count({ where: { ...mine(req.auth!.userId), readAt: null } }),
      ]);
      res.json({
        ...paged(
          rows.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            body: n.body,
            readAt: n.readAt?.toISOString() ?? null,
            createdAt: n.createdAt.toISOString(),
          })),
          total,
          q,
        ),
        unreadCount,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/notifications/read-all', ...guard, async (req, res, next) => {
    try {
      const r = await req.db!.notification.updateMany({
        where: { ...mine(req.auth!.userId), readAt: null },
        data: { readAt: new Date() },
      });
      res.json({ updated: r.count });
    } catch (err) {
      next(err);
    }
  });

  router.post('/notifications/:id/read', ...guard, async (req, res, next) => {
    try {
      const n = await req.db!.notification.findFirst({
        where: { id: req.params.id!, ...mine(req.auth!.userId) },
      });
      if (!n) throw new HttpError(404, 'NOT_FOUND', 'Notification not found');
      if (!n.readAt)
        await req.db!.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
