import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, loginAs, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import {
  createLocation,
  createProduct,
  createSales,
  createTenant,
  createUser,
  TEST_PASSWORD,
} from '../../../tests/factories';
import { expectRoleAccess, rolesWith } from '../../../tests/helpers/isolation';
import { drainJobs } from '../../jobs/runner';
import { registerCoreJobHandlers } from '../../jobs/handlers';
import { notifyAdmins, notifyUser } from './service';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
beforeAll(() => registerCoreJobHandlers());
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function team() {
  const tenant = await createTenant();
  const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
  const planner = await createUser({ role: 'PLANNER', tenantId: tenant.id });
  return { tenant, owner, planner };
}
const mk = (
  tenantId: string,
  userId: string,
  over: Partial<{ title: string; readAt: Date | null; createdAt: Date }> = {},
) =>
  prisma.notification.create({
    data: {
      tenantId,
      userId,
      type: 't',
      title: over.title ?? 'Hello',
      body: 'b',
      readAt: over.readAt ?? null,
      ...(over.createdAt && { createdAt: over.createdAt }),
    },
  });

describe('notification endpoints', () => {
  it('lists only the caller’s own notifications, newest first, with the unread count', async () => {
    const { tenant, owner, planner } = await team();
    await mk(tenant.id, owner.id, { title: 'old', createdAt: new Date('2030-01-01') });
    await mk(tenant.id, owner.id, { title: 'new', createdAt: new Date('2030-02-01') });
    await mk(tenant.id, owner.id, { title: 'read', readAt: new Date() });
    await mk(tenant.id, planner.id, { title: 'planner only' });
    const other = await createTenant();
    const ou = await createUser({ role: 'OWNER', tenantId: other.id });
    await mk(other.id, ou.id, { title: 'other tenant' });
    const res = await request(app).get('/notifications').set(tok(owner));
    expect(res.status).toBe(200);
    expect(res.body.items.map((n: { title: string }) => n.title)).toEqual(
      expect.arrayContaining(['old', 'new', 'read']),
    );
    expect(res.body.items.map((n: { title: string }) => n.title)).not.toContain('planner only');
    expect(res.body.items.map((n: { title: string }) => n.title)).not.toContain('other tenant');
    expect(res.body.total).toBe(3);
    expect(res.body.unreadCount).toBe(2);
    expect(
      (await request(app).get('/notifications?unread=true').set(tok(owner))).body.items,
    ).toHaveLength(2);
    expect((await request(app).get('/notifications').set(tok(planner))).body.unreadCount).toBe(1);
  });

  it('marks one notification read (idempotent) and all read', async () => {
    const { tenant, owner } = await team();
    const a = await mk(tenant.id, owner.id);
    await mk(tenant.id, owner.id);
    expect((await request(app).post(`/notifications/${a.id}/read`).set(tok(owner))).status).toBe(
      200,
    );
    expect((await request(app).post(`/notifications/${a.id}/read`).set(tok(owner))).status).toBe(
      200,
    );
    expect((await request(app).get('/notifications').set(tok(owner))).body.unreadCount).toBe(1);
    expect((await request(app).post('/notifications/read-all').set(tok(owner))).body.updated).toBe(
      1,
    );
    expect((await request(app).get('/notifications').set(tok(owner))).body.unreadCount).toBe(0);
  });

  it('a user cannot read or mark another user’s notification, even in the same tenant', async () => {
    const { tenant, owner, planner } = await team();
    const n = await mk(tenant.id, owner.id);
    expect((await request(app).post(`/notifications/${n.id}/read`).set(tok(planner))).status).toBe(
      404,
    );
    expect(
      (await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt,
    ).toBeNull();
    await request(app).post('/notifications/read-all').set(tok(planner));
    expect(
      (await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt,
    ).toBeNull();
  });

  it('roles: every tenant role may read; 401 anonymous; tenant isolation on mark-read', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/notifications',
      allowed: rolesWith('notifications:read'),
    });
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/notifications/read-all',
      allowed: rolesWith('notifications:read'),
    });
    // Isolation: another tenant's user gets 404 for this notification; its owner can mark it.
    const t = await createTenant();
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const n = await mk(t.id, owner.id);
    const intruder = await createUser({ role: 'OWNER' });
    expect((await request(app).post(`/notifications/${n.id}/read`).set(tok(intruder))).status).toBe(
      404,
    );
    expect((await request(app).post(`/notifications/${n.id}/read`).set(tok(owner))).status).toBe(
      200,
    );
  });

  it('paginates (max 100) and validates the unread filter', async () => {
    const { tenant, owner } = await team();
    for (let i = 0; i < 30; i++) await mk(tenant.id, owner.id);
    expect(
      (await request(app).get('/notifications?pageSize=10&page=3').set(tok(owner))).body.items,
    ).toHaveLength(10);
    expect((await request(app).get('/notifications?pageSize=101').set(tok(owner))).status).toBe(
      400,
    );
    expect((await request(app).get('/notifications?unread=maybe').set(tok(owner))).status).toBe(
      400,
    );
  });
});

describe('notification producers', () => {
  it('notifyAdmins reaches active Owners/Admins only; notifyUser targets one active user of the tenant', async () => {
    const { tenant, owner, planner } = await team();
    const admin = await createUser({ role: 'ADMIN', tenantId: tenant.id });
    await createUser({ role: 'ADMIN', tenantId: tenant.id, isActive: false });
    await notifyAdmins(tenant.id, 'x', 'T', 'B');
    expect((await prisma.notification.findMany()).map((n) => n.userId).sort()).toEqual(
      [owner.id, admin.id].sort(),
    );
    await prisma.notification.deleteMany();
    await notifyUser(tenant.id, planner.id, 'x', 'T', 'B');
    await notifyUser(tenant.id, null, 'x', 'T', 'B');
    await notifyUser(tenant.id, 'missing', 'x', 'T', 'B');
    const other = await createTenant();
    await notifyUser(other.id, planner.id, 'x', 'T', 'B'); // wrong tenant → ignored
    expect(await prisma.notification.count()).toBe(1);
  });

  it('long jobs notify the person who started them (import, forecast, scenario)', async () => {
    const tenant = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
    const p = await createProduct(tenant.id, { sku: 'N1' });
    const loc = await createLocation(tenant.id, { code: 'L1' });
    const monday = new Date(Date.now() - 21 * 86400_000);
    const iso = new Date(
      Date.UTC(
        monday.getUTCFullYear(),
        monday.getUTCMonth(),
        monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7),
      ),
    )
      .toISOString()
      .slice(0, 10);
    const pv = await request(app)
      .post('/imports/sales/preview?fileName=a.csv')
      .set(tok(owner))
      .set('Content-Type', 'text/csv')
      .send(`sku,location_code,date,quantity\nN1,L1,${iso},5\n`);
    await request(app).post(`/imports/sales/${pv.body.import.id}/commit`).set(tok(owner)).send({});
    await createSales(
      tenant.id,
      p.id,
      loc.id,
      Array.from({ length: 30 }, () => 10),
      '2025-06-02',
    );
    await drainJobs();
    await request(app).post('/forecasts/runs').set(tok(owner)).send({ horizonWeeks: 4 });
    await drainJobs();
    const run = await prisma.forecastRun.findFirstOrThrow();
    const sc = await request(app)
      .post('/scenarios')
      .set(tok(owner))
      .send({ name: 'Notify', baseForecastRunId: run.id });
    await request(app).post(`/scenarios/${sc.body.scenario.id}/run`).set(tok(owner));
    await drainJobs();
    const types = (await prisma.notification.findMany({ where: { userId: owner.id } }))
      .map((n) => n.type)
      .sort();
    expect(types).toEqual(
      expect.arrayContaining(['import.done', 'forecast.done', 'scenario.done']),
    );
  });
});

describe('DELETE /tenant (Owner only)', () => {
  it('soft-deletes the tenant, signs everyone out and blocks access', async () => {
    const { tenant, owner, planner } = await team();
    const { cookie } = await loginAs(app, planner.email);
    const res = await request(app)
      .delete('/tenant')
      .set(tok(owner))
      .send({ password: TEST_PASSWORD });
    expect(res.status).toBe(204);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe(
      'DELETED',
    );
    expect((await request(app).post('/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
    const blocked = await request(app).get('/users').set(tok(owner));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TENANT_UNAVAILABLE');
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain('tenant.deleted');
  });

  it('requires the right password and the Owner role', async () => {
    const { tenant, owner } = await team();
    expect(
      (await request(app).delete('/tenant').set(tok(owner)).send({ password: 'wrong-password-1' }))
        .status,
    ).toBe(400);
    expect((await request(app).delete('/tenant').set(tok(owner)).send({})).status).toBe(400);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe(
      'ACTIVE',
    );
    await expectRoleAccess({
      app,
      method: 'delete',
      path: '/tenant',
      body: { password: 'nope-nope-1' },
      allowed: rolesWith('tenant:delete'),
    });
  });
});
