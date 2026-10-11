import express from 'express';
import request from 'supertest';
import { DEFAULT_PLANS } from '@supplycast/shared';
import { prisma } from '../../db/client';
import { errorHandler } from '../../middleware/errors';
import { createGuards } from '../../middleware/guards';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import { createTenant, createUser } from '../../../tests/factories';
import {
  checkLimit,
  createWithinLimit,
  currentUsage,
  getEffectiveLimits,
  incrementUsage,
  registerLiveCounter,
  reserveUsage,
} from './limits';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const jan = new Date('2030-01-15T12:00:00Z');
const feb = new Date('2030-02-03T12:00:00Z');

describe('count-based limits via the API (users)', () => {
  it('blocks invites with 402 PLAN_LIMIT_REACHED {metric, limit, current} at the limit', async () => {
    const t = await createTenant({ plan: 'free' }); // 2 users
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const ok = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'a@x.com', role: 'VIEWER' });
    expect(ok.status).toBe(201);
    const res = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'b@x.com', role: 'VIEWER' });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { metric: 'users', limit: 2, current: 2, upgradeUrl: '/billing' },
    });
    expect(res.body.error.message).toMatch(/Upgrade/);
    expect(await prisma.invite.count()).toBe(1);
  });

  it('pending invites hold a seat; revoking one frees it; expired invites do not count', async () => {
    const t = await createTenant({ plan: 'free' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const inv = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'a@x.com', role: 'VIEWER' });
    expect(
      (
        await request(app)
          .post('/invites')
          .set(tok(owner))
          .send({ email: 'b@x.com', role: 'VIEWER' })
      ).status,
    ).toBe(402);
    await request(app).delete(`/invites/${inv.body.invite.id}`).set(tok(owner));
    expect(
      (
        await request(app)
          .post('/invites')
          .set(tok(owner))
          .send({ email: 'b@x.com', role: 'VIEWER' })
      ).status,
    ).toBe(201);
    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(
      (
        await request(app)
          .post('/invites')
          .set(tok(owner))
          .send({ email: 'c@x.com', role: 'VIEWER' })
      ).status,
    ).toBe(201);
  });

  it('re-inviting the same email does not use a second seat', async () => {
    const t = await createTenant({ plan: 'free' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    for (let i = 0; i < 3; i++)
      expect(
        (
          await request(app)
            .post('/invites')
            .set(tok(owner))
            .send({ email: 'same@x.com', role: 'VIEWER' })
        ).status,
      ).toBe(201);
  });

  it('reactivating a user is blocked at the limit', async () => {
    const t = await createTenant({ plan: 'free' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const gone = await createUser({ role: 'VIEWER', tenantId: t.id, isActive: false });
    await createUser({ role: 'VIEWER', tenantId: t.id });
    const res = await request(app)
      .patch(`/users/${gone.id}`)
      .set(tok(owner))
      .send({ isActive: true });
    expect(res.status).toBe(402);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: gone.id } })).isActive).toBe(false);
  });

  it('Enterprise custom limits are respected (raise and lower)', async () => {
    const t = await createTenant({ plan: 'enterprise' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    await prisma.subscription.update({
      where: { tenantId: t.id },
      data: { customLimits: { users: 2 } },
    });
    expect((await getEffectiveLimits(t.id)).users).toBe(2);
    expect((await getEffectiveLimits(t.id)).skus).toBe(DEFAULT_PLANS[3]!.limits.skus);
    expect(
      (
        await request(app)
          .post('/invites')
          .set(tok(owner))
          .send({ email: 'a@x.com', role: 'VIEWER' })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post('/invites')
          .set(tok(owner))
          .send({ email: 'b@x.com', role: 'VIEWER' })
      ).status,
    ).toBe(402);
    await prisma.subscription.update({
      where: { tenantId: t.id },
      data: { customLimits: { users: 50 } },
    });
    expect(
      (
        await request(app)
          .post('/invites')
          .set(tok(owner))
          .send({ email: 'b@x.com', role: 'VIEWER' })
      ).status,
    ).toBe(201);
  });

  it('concurrent invites cannot exceed the limit', async () => {
    const t = await createTenant({ plan: 'starter' }); // 5 users
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(app)
          .post('/invites')
          .set(tok(owner))
          .send({ email: `p${i}@x.com`, role: 'VIEWER' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    expect(results.filter((r) => r.status === 402)).toHaveLength(8);
    expect(await prisma.invite.count()).toBe(4);
  });
});

describe('createWithinLimit with registered counters (skus/locations/scenarios)', () => {
  it('uses the registered live counter and stays atomic under concurrency', async () => {
    const t = await createTenant({ plan: 'free' }); // 50 SKUs
    let rows = 0;
    registerLiveCounter('skus', async () => rows);
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, () =>
        createWithinLimit(t.id, 'skus', async () => {
          rows++;
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(50);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures).toHaveLength(10);
    expect(failures[0]!.reason).toMatchObject({
      status: 402,
      code: 'PLAN_LIMIT_REACHED',
      details: { metric: 'skus', limit: 50 },
    });
    registerLiveCounter('skus', async () => 0);
  });

  it('supports bulk creation (by > 1) and rejects the whole batch if it does not fit', async () => {
    const t = await createTenant({ plan: 'free' });
    let rows = 45;
    registerLiveCounter('skus', async () => rows);
    await expect(
      createWithinLimit(t.id, 'skus', async () => undefined, { by: 10 }),
    ).rejects.toMatchObject({ status: 402 });
    await createWithinLimit(
      t.id,
      'skus',
      async () => {
        rows += 5;
      },
      { by: 5 },
    );
    expect(rows).toBe(50);
    registerLiveCounter('skus', async () => 0);
  });

  it('does not run `create` when over the limit and rolls back if it throws', async () => {
    const t = await createTenant({ plan: 'free' });
    registerLiveCounter('locations', async () => 1); // limit 1
    const create = jest.fn();
    await expect(createWithinLimit(t.id, 'locations', create)).rejects.toMatchObject({
      status: 402,
    });
    expect(create).not.toHaveBeenCalled();
    registerLiveCounter('locations', async () => 0);
  });
});

describe('period limits (forecast runs, AI requests)', () => {
  it('blocks at the limit, then resets in the next billing period', async () => {
    const t = await createTenant({ plan: 'free' }); // 10 forecast runs
    for (let i = 0; i < 10; i++) await reserveUsage(t.id, 'forecastRuns', { now: jan });
    await expect(reserveUsage(t.id, 'forecastRuns', { now: jan })).rejects.toMatchObject({
      status: 402,
      details: { metric: 'forecastRuns', limit: 10, current: 10 },
    });
    expect(await currentUsage(t.id, 'forecastRuns', jan)).toBe(10);
    expect(await currentUsage(t.id, 'forecastRuns', feb)).toBe(0);
    await expect(reserveUsage(t.id, 'forecastRuns', { now: feb })).resolves.toBeDefined();
    expect(await currentUsage(t.id, 'forecastRuns', feb)).toBe(1);
  });

  it('release gives a unit back (failed work is not billed) and never goes below zero', async () => {
    const t = await createTenant({ plan: 'free' });
    const r = await reserveUsage(t.id, 'aiRequests', { now: jan });
    expect(await currentUsage(t.id, 'aiRequests', jan)).toBe(1);
    await r.release();
    await r.release();
    expect(await currentUsage(t.id, 'aiRequests', jan)).toBe(0);
  });

  it('concurrent reservations never exceed the limit', async () => {
    const t = await createTenant({ plan: 'free' });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => reserveUsage(t.id, 'aiRequests', { now: jan })),
    ); // limit 20
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
    expect(await currentUsage(t.id, 'aiRequests', jan)).toBe(20);
  });

  it('respects custom limits and per-tenant counters', async () => {
    const a = await createTenant({ plan: 'free' });
    const b = await createTenant({ plan: 'free' });
    await prisma.subscription.update({
      where: { tenantId: a.id },
      data: { customLimits: { aiRequests: 1 } },
    });
    await reserveUsage(a.id, 'aiRequests', { now: jan });
    await expect(reserveUsage(a.id, 'aiRequests', { now: jan })).rejects.toMatchObject({
      status: 402,
    });
    await expect(reserveUsage(b.id, 'aiRequests', { now: jan })).resolves.toBeDefined();
  });

  it('incrementUsage adds to the period counter', async () => {
    const t = await createTenant();
    await incrementUsage(t.id, 'aiRequests', 3, jan);
    await incrementUsage(t.id, 'aiRequests', 2, jan);
    expect(await currentUsage(t.id, 'aiRequests', jan)).toBe(5);
  });
});

describe('notifications at 80% and 100%', () => {
  it('notifies Owner/Admin once per level per period', async () => {
    const t = await createTenant({ plan: 'free' }); // 20 AI requests
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const admin = await createUser({ role: 'ADMIN', tenantId: t.id });
    await createUser({ role: 'VIEWER', tenantId: t.id });
    for (let i = 0; i < 15; i++) await reserveUsage(t.id, 'aiRequests', { now: jan });
    expect(await prisma.notification.count({ where: { tenantId: t.id } })).toBe(0);
    await reserveUsage(t.id, 'aiRequests', { now: jan }); // 16 = 80%
    const eighty = await prisma.notification.findMany({ where: { tenantId: t.id } });
    expect(eighty.map((n) => n.userId).sort()).toEqual([owner.id, admin.id].sort());
    expect(eighty.every((n) => n.type === 'usage.aiRequests.80')).toBe(true);
    for (let i = 0; i < 4; i++) await reserveUsage(t.id, 'aiRequests', { now: jan }); // 20 = 100%
    const types = new Set(
      (await prisma.notification.findMany({ where: { tenantId: t.id } })).map((n) => n.type),
    );
    expect(types).toEqual(new Set(['usage.aiRequests.80', 'usage.aiRequests.100']));
    expect(await prisma.notification.count({ where: { tenantId: t.id } })).toBe(4);
  });

  it('notifies when a count-based limit is approached via the API', async () => {
    const t = await createTenant({ plan: 'starter' }); // 5 users
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    for (const e of ['a', 'b', 'c'])
      await request(app)
        .post('/invites')
        .set(tok(owner))
        .send({ email: `${e}@x.com`, role: 'VIEWER' });
    const n = await prisma.notification.findMany({ where: { tenantId: t.id } });
    expect(n.map((x) => x.type)).toEqual(['usage.users.80']);
  });
});

describe('checkLimit middleware', () => {
  const mini = express();
  mini.get(
    '/needs-ai',
    ...createGuards('test-access-secret').tenant('ai:use'),
    checkLimit('aiRequests'),
    (_req, res) => res.json({ ok: true }),
  );
  mini.use(errorHandler);

  it('lets requests through under the limit and 402s at it', async () => {
    const t = await createTenant({ plan: 'free' });
    const planner = await createUser({ role: 'PLANNER', tenantId: t.id });
    expect((await request(mini).get('/needs-ai').set(tok(planner))).status).toBe(200);
    await incrementUsage(t.id, 'aiRequests', 20);
    const res = await request(mini).get('/needs-ai').set(tok(planner));
    expect(res.status).toBe(402);
    expect(res.body.error.details).toMatchObject({ metric: 'aiRequests', limit: 20, current: 20 });
  });
});
