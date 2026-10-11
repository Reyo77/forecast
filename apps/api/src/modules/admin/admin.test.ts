import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, loginAs, tokenFor } from '../../../tests/helpers/auth';
import { testApp, tokenFromLink } from '../../../tests/helpers/app';
import { createTenant, createUser } from '../../../tests/factories';
import { expectRoleAccess } from '../../../tests/helpers/isolation';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function world() {
  const sa = await createUser({ role: 'SUPER_ADMIN' });
  const t1 = await createTenant({ name: 'Alpha Foods', plan: 'pro' });
  const t2 = await createTenant({ name: 'Beta Parts', plan: 'free' });
  const o1 = await createUser({ role: 'OWNER', tenantId: t1.id, email: 'owner@alpha.com' });
  const o2 = await createUser({ role: 'OWNER', tenantId: t2.id, email: 'owner@beta.com' });
  await createUser({ role: 'PLANNER', tenantId: t1.id });
  return { sa, t1, t2, o1, o2 };
}

describe('access control: every /admin route is Super Admin only', () => {
  it('tenant roles get 403 and anonymous 401 on all admin routes', async () => {
    const { t1 } = await world();
    const inv = await prisma.invoice.create({
      data: {
        tenantId: t1.id,
        number: 'INV-X',
        amountCents: 1,
        planName: 'P',
        description: 'd',
        periodStart: new Date(),
        periodEnd: new Date(),
      },
    });
    const routes: [string, string, object?][] = [
      ['get', '/admin/tenants'],
      ['get', `/admin/tenants/${t1.id}`],
      ['post', `/admin/tenants/${t1.id}/suspend`],
      ['post', `/admin/tenants/${t1.id}/reactivate`],
      ['post', `/admin/tenants/${t1.id}/impersonate`],
      ['post', `/admin/tenants/${t1.id}/owner-reset-link`],
      ['patch', `/admin/tenants/${t1.id}/subscription`, { status: 'ACTIVE' }],
      ['patch', `/admin/invoices/${inv.id}`, { status: 'VOID' }],
      ['get', '/admin/metrics'],
      ['get', '/admin/plans'],
      ['get', '/audit-logs?tenantId=x'], // audit:read is allowed for Owner/Admin but never widens scope (covered elsewhere)
    ];
    for (const [method, path, body] of routes.slice(0, -1)) {
      await expectRoleAccess({
        app,
        method: method as 'get',
        path,
        body: body as Record<string, unknown>,
        allowed: [],
      });
    }
    const afterTenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t1.id } });
    expect(afterTenant.status).toBe('ACTIVE');
  });
});

describe('GET /admin/tenants', () => {
  it('lists tenants with plan, user count, status and last activity', async () => {
    const { sa, t1, o1 } = await world();
    await prisma.user.update({
      where: { id: o1.id },
      data: { lastLoginAt: new Date('2030-03-01T00:00:00Z') },
    });
    const res = await request(app).get('/admin/tenants').set(tok(sa));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const alpha = res.body.items.find((t: { id: string }) => t.id === t1.id);
    expect(alpha).toMatchObject({
      name: 'Alpha Foods',
      status: 'ACTIVE',
      userCount: 2,
      plan: { code: 'pro' },
    });
    expect(new Date(alpha.lastActivityAt).toISOString()).toBe('2030-03-01T00:00:00.000Z');
  });

  it('searches by name, slug or user email; filters by status and plan; paginates', async () => {
    const { sa, t2 } = await world();
    await prisma.tenant.update({ where: { id: t2.id }, data: { status: 'SUSPENDED' } });
    const get = async (qs: string) =>
      (await request(app).get(`/admin/tenants?${qs}`).set(tok(sa))).body;
    expect((await get('search=Alpha')).total).toBe(1);
    expect((await get('search=owner@beta')).items[0].name).toBe('Beta Parts');
    expect((await get('status=SUSPENDED')).total).toBe(1);
    expect((await get('plan=pro')).items[0].name).toBe('Alpha Foods');
    expect((await get('plan=starter')).total).toBe(0);
    expect((await get('pageSize=1&page=2')).items).toHaveLength(1);
    expect((await request(app).get('/admin/tenants?pageSize=101').set(tok(sa))).status).toBe(400);
    expect((await request(app).get('/admin/tenants?status=BOGUS').set(tok(sa))).status).toBe(400);
  });
});

describe('GET /admin/tenants/:id', () => {
  it('returns tenant, users, invoices and subscription; 404 for unknown', async () => {
    const { sa, t1 } = await world();
    const res = await request(app).get(`/admin/tenants/${t1.id}`).set(tok(sa));
    expect(res.body.tenant.name).toBe('Alpha Foods');
    expect(res.body.users).toHaveLength(2);
    expect(res.body.subscription.plan.code).toBe('pro');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
    expect((await request(app).get('/admin/tenants/nope').set(tok(sa))).status).toBe(404);
  });
});

describe('suspend / reactivate', () => {
  it('takes effect on the very next request, then can be reversed (audited)', async () => {
    const { sa, t1, o1 } = await world();
    const owner = await loginAs(app, o1.email);
    expect((await request(app).get('/users').set(bearer(owner.token))).status).toBe(200);

    const s = await request(app).post(`/admin/tenants/${t1.id}/suspend`).set(tok(sa));
    expect(s.body.tenant.status).toBe('SUSPENDED');
    const blocked = await request(app).get('/users').set(bearer(owner.token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TENANT_SUSPENDED');
    expect((await request(app).get('/auth/me').set(bearer(owner.token))).status).toBe(403);

    const r = await request(app).post(`/admin/tenants/${t1.id}/reactivate`).set(tok(sa));
    expect(r.body.tenant.status).toBe('ACTIVE');
    expect((await request(app).get('/users').set(bearer(owner.token))).status).toBe(200);
    const actions = (await prisma.auditLog.findMany({ where: { tenantId: t1.id } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.reactivated']));
  });

  it('404 for unknown tenant; deleted tenants cannot be reactivated', async () => {
    const { sa, t1 } = await world();
    expect((await request(app).post('/admin/tenants/nope/suspend').set(tok(sa))).status).toBe(404);
    await prisma.tenant.update({ where: { id: t1.id }, data: { status: 'DELETED' } });
    expect(
      (await request(app).post(`/admin/tenants/${t1.id}/reactivate`).set(tok(sa))).status,
    ).toBe(409);
  });
});

describe('owner reset link', () => {
  it('creates a one-time link for the tenant Owner that works', async () => {
    const { sa, t1, o1 } = await world();
    const res = await request(app).post(`/admin/tenants/${t1.id}/owner-reset-link`).set(tok(sa));
    expect(res.status).toBe(201);
    expect(res.body.ownerEmail).toBe(o1.email);
    const reset = await request(app)
      .post('/auth/reset-password')
      .send({ token: tokenFromLink(res.body.link), newPassword: 'BrandNew12345' });
    expect(reset.status).toBe(204);
    expect((await loginAs(app, o1.email, 'BrandNew12345')).res.status).toBe(200);
  });
});

describe('read-only impersonation', () => {
  async function start() {
    const w = await world();
    const res = await request(app).post(`/admin/tenants/${w.t1.id}/impersonate`).set(tok(w.sa));
    return { ...w, res, h: bearer(res.body.accessToken as string) };
  }

  it('returns a short-lived token acting as the tenant Owner, audited', async () => {
    const { res, o1, t1 } = await start();
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(o1.id);
    expect(res.body.expiresInSeconds).toBe(1800);
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'admin.impersonation_started' },
    });
    expect(log.tenantId).toBe(t1.id);
  });

  it('can read tenant data, is tagged in /auth/me, and every request is audited', async () => {
    const { h, sa, o1 } = await start();
    const users = await request(app).get('/users').set(h);
    expect(users.status).toBe(200);
    expect(users.headers['x-impersonated-by']).toBe(sa.id);
    const me = await request(app).get('/auth/me').set(h);
    expect(me.body.user.id).toBe(o1.id);
    expect(me.body.impersonating).toEqual({ by: sa.id });
    const logs = await prisma.auditLog.findMany({ where: { action: 'impersonation.request' } });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.actorId === sa.id)).toBe(true);
    expect(logs.map((l) => (l.metadata as { path: string }).path).sort()).toEqual([
      '/auth/me',
      '/users',
    ]);
  });

  it('blocks every write (POST/PATCH/DELETE), still audits the attempt, and changes nothing', async () => {
    const { h, o1, t1 } = await start();
    const planner = await prisma.user.findFirstOrThrow({
      where: { tenantId: t1.id, role: 'PLANNER' },
    });
    const attempts = [
      request(app).post('/invites').set(h).send({ email: 'z@z.com', role: 'VIEWER' }),
      request(app).patch(`/users/${planner.id}`).set(h).send({ role: 'VIEWER' }),
      request(app).post('/billing/change-plan').set(h).send({ planCode: 'free' }),
      request(app)
        .post('/auth/change-password')
        .set(h)
        .send({ currentPassword: 'Password123', newPassword: 'Hacked123456' }),
      request(app)
        .post('/tenant/transfer-ownership')
        .set(h)
        .send({ userId: planner.id, password: 'Password123' }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('IMPERSONATION_READ_ONLY');
    }
    expect(await prisma.invite.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: planner.id } })).role).toBe(
      'PLANNER',
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { id: o1.id } })).role).toBe('OWNER');
    expect(await prisma.auditLog.count({ where: { action: 'impersonation.request' } })).toBe(5);
  });

  it('cannot reach /admin while impersonating a tenant user; cannot impersonate while impersonating', async () => {
    const { h, t2 } = await start();
    expect((await request(app).get('/admin/tenants').set(h)).status).toBe(403);
    expect((await request(app).post(`/admin/tenants/${t2.id}/impersonate`).set(h)).status).toBe(
      403,
    );
  });

  it('stops working if the Super Admin is deactivated', async () => {
    const { h, sa } = await start();
    await prisma.user.update({ where: { id: sa.id }, data: { isActive: false } });
    expect((await request(app).get('/users').set(h)).status).toBe(401);
  });

  it('404 for a tenant with no active Owner or unknown tenant', async () => {
    const { sa, t1, o1 } = await world();
    await prisma.user.update({ where: { id: o1.id }, data: { isActive: false } });
    expect(
      (await request(app).post(`/admin/tenants/${t1.id}/impersonate`).set(tok(sa))).status,
    ).toBe(404);
    expect((await request(app).post('/admin/tenants/nope/impersonate').set(tok(sa))).status).toBe(
      404,
    );
  });

  it('a suspended tenant cannot be browsed even through impersonation', async () => {
    const { h, t1 } = await start();
    await prisma.tenant.update({ where: { id: t1.id }, data: { status: 'SUSPENDED' } });
    expect((await request(app).get('/users').set(h)).status).toBe(403);
  });
});

describe('GET /admin/metrics', () => {
  it('reports tenants by plan/status, MRR from paid invoices, trial conversion, AI usage and failed jobs', async () => {
    const { sa, t1, t2 } = await world();
    const now = new Date();
    const pro = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } });
    const sub1 = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t1.id } });
    await prisma.invoice.create({
      data: {
        tenantId: t1.id,
        subscriptionId: sub1.id,
        number: 'INV-1',
        amountCents: 19900,
        status: 'PAID',
        planName: 'Pro',
        description: 'x',
        periodStart: new Date(now.getTime() - 86400000),
        periodEnd: new Date(now.getTime() + 20 * 86400000),
        paidAt: now,
      },
    });
    await prisma.invoice.create({
      data: {
        tenantId: t2.id,
        number: 'INV-2',
        amountCents: 4900,
        status: 'VOID',
        planName: 'Starter',
        description: 'x',
        periodStart: new Date(now.getTime() - 86400000),
        periodEnd: new Date(now.getTime() + 20 * 86400000),
      },
    });
    await prisma.subscription.update({
      where: { tenantId: t1.id },
      data: { trialEndsAt: now, convertedAt: now, planId: pro.id },
    });
    await prisma.subscription.update({ where: { tenantId: t2.id }, data: { trialEndsAt: now } });
    await prisma.aiRequest.createMany({
      data: [
        { tenantId: t1.id, feature: 'x', status: 'OK' },
        { tenantId: t1.id, feature: 'x', status: 'OK' },
      ],
    });
    await prisma.job.create({
      data: { type: 'forecast.run', status: 'FAILED', lastError: 'boom', tenantId: t1.id },
    });
    await prisma.tenant.update({ where: { id: t2.id }, data: { status: 'SUSPENDED' } });

    const res = await request(app).get('/admin/metrics').set(tok(sa));
    expect(res.status).toBe(200);
    expect(res.body.mrrCents).toBe(19900);
    expect(res.body.totalTenants).toBe(2);
    expect(res.body.tenantsByPlan.find((p: { code: string }) => p.code === 'pro').count).toBe(1);
    expect(res.body.tenantsByStatus).toEqual(
      expect.arrayContaining([
        { status: 'SUSPENDED', count: 1 },
        { status: 'ACTIVE', count: 1 },
      ]),
    );
    expect(res.body.trials).toEqual({ started: 2, converted: 1, conversionRate: 0.5 });
    expect(res.body.aiRequestsPerDay).toHaveLength(30);
    expect(res.body.aiRequestsPerDay.at(-1).count).toBe(2);
    expect(res.body.failedJobs.count).toBe(1);
    expect(res.body.failedJobs.recent[0].lastError).toBe('boom');
  });

  it('works with no data at all', async () => {
    const sa = await createUser({ role: 'SUPER_ADMIN' });
    const res = await request(app).get('/admin/metrics').set(tok(sa));
    expect(res.body).toMatchObject({
      mrrCents: 0,
      totalTenants: 0,
      trials: { started: 0, converted: 0, conversionRate: 0 },
    });
  });
});
