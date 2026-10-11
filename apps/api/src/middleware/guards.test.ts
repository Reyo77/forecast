import express from 'express';
import request from 'supertest';
import { PERMISSIONS, ROLES, can, type Permission } from '@supplycast/shared';
import { prisma } from '../db/client';
import { errorHandler } from './errors';
import { createGuards } from './guards';
import { requireRole } from './rbac';
import { resetDb } from '../../tests/helpers/db';
import { bearer, loginAs } from '../../tests/helpers/auth';
import { createApp } from '../app';
import { createTenant, createUser } from '../../tests/factories';
import { expectTenantIsolation } from '../../tests/helpers/isolation';

const SECRET = 'test-access-secret';
const guards = createGuards(SECRET);
const fullApp = createApp(
  { APP_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: SECRET },
  { loginRateLimitMax: 100000 },
);

// A tiny app with one route per permission, plus tenant-scoped data routes.
const app = express();
app.use(express.json());
for (const perm of Object.keys(PERMISSIONS) as Permission[]) {
  app.get(`/perm/${perm.replace(':', '__')}`, ...guards.any(perm), (_req, res) =>
    res.json({ ok: true }),
  );
}
app.get('/tenant-only', ...guards.tenant('dashboard:read'), (req, res) =>
  res.json({ tenantId: req.tenantId }),
);
app.get('/users/:id', ...guards.tenant('dashboard:read'), async (req, res, next) => {
  try {
    const u = await req.db!.user.findFirst({ where: { id: req.params.id } });
    if (!u) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'nope' } });
    res.json({ id: u.id });
  } catch (e) {
    next(e);
  }
});
app.post('/echo-tenant', ...guards.tenant('dashboard:read'), (req, res) => {
  res.json({ tenantId: req.tenantId, bodyTenantId: req.body.tenantId });
});
app.get('/role-only', requireRole('OWNER'), (_req, res) => res.json({ ok: true }));
app.use(errorHandler);

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('permission map', () => {
  it('only references real roles and is non-empty', () => {
    for (const [perm, roles] of Object.entries(PERMISSIONS)) {
      expect(roles.length).toBeGreaterThan(0);
      for (const r of roles as readonly string[]) expect(ROLES).toContain(r);
      expect(perm).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });

  it('can() handles missing roles', () => {
    expect(can(null, 'dashboard:read')).toBe(false);
    expect(can(undefined, 'dashboard:read')).toBe(false);
  });
});

describe('RBAC matrix: every role × every permission', () => {
  for (const role of ROLES) {
    it(`${role} gets exactly the permissions the map grants`, async () => {
      const user = await createUser({ role });
      const { token } = await loginAs(fullApp, user.email);
      for (const perm of Object.keys(PERMISSIONS) as Permission[]) {
        const res = await request(app)
          .get(`/perm/${perm.replace(':', '__')}`)
          .set(bearer(token));
        expect({ perm, status: res.status }).toEqual({ perm, status: can(role, perm) ? 200 : 403 });
      }
    });
  }

  it('returns 401 without a token for every permission', async () => {
    for (const perm of Object.keys(PERMISSIONS) as Permission[]) {
      expect((await request(app).get(`/perm/${perm.replace(':', '__')}`)).status).toBe(401);
    }
  });

  it('requireRole without auth context is 401', async () => {
    expect((await request(app).get('/role-only')).status).toBe(401);
  });
});

describe('tenant context', () => {
  it('takes the tenant from the token, ignoring a client-supplied tenantId', async () => {
    const owner = await createUser({ role: 'OWNER' });
    const other = await createTenant();
    const { token } = await loginAs(fullApp, owner.email);
    const res = await request(app)
      .post('/echo-tenant?tenantId=' + other.id)
      .set(bearer(token))
      .send({ tenantId: other.id });
    expect(res.body.tenantId).toBe(owner.tenantId);
    expect(res.body.tenantId).not.toBe(other.id);
  });

  it('blocks suspended tenants on the next request with TENANT_SUSPENDED', async () => {
    const owner = await createUser({ role: 'OWNER' });
    const { token } = await loginAs(fullApp, owner.email);
    expect((await request(app).get('/tenant-only').set(bearer(token))).status).toBe(200);
    await prisma.tenant.update({ where: { id: owner.tenantId! }, data: { status: 'SUSPENDED' } });
    const res = await request(app).get('/tenant-only').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
  });

  it('blocks deleted tenants', async () => {
    const owner = await createUser({ role: 'OWNER' });
    const { token } = await loginAs(fullApp, owner.email);
    await prisma.tenant.update({ where: { id: owner.tenantId! }, data: { status: 'DELETED' } });
    const res = await request(app).get('/tenant-only').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_UNAVAILABLE');
  });

  it('rejects a Super Admin (no tenant) on tenant-only routes', async () => {
    const admin = await createUser({ role: 'SUPER_ADMIN' });
    const { token } = await loginAs(fullApp, admin.email);
    const res = await request(app).get('/tenant-only').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_REQUIRED');
  });

  it('returns 404 (not 403, no data) for another tenant’s resource', async () => {
    await expectTenantIsolation({
      app,
      method: 'get',
      path: (id) => `/users/${id}`,
      createResource: (tenantId) => createUser({ tenantId, role: 'PLANNER' }),
    });
  });
});

describe('GET /auth/me (Feature 1.1 + 1.2)', () => {
  it('works for a tenant user and a Super Admin', async () => {
    const owner = await createUser({ role: 'OWNER' });
    const admin = await createUser({ role: 'SUPER_ADMIN' });
    for (const u of [owner, admin]) {
      const { token } = await loginAs(fullApp, u.email);
      const res = await request(fullApp).get('/auth/me').set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(u.id);
    }
  });

  it('is blocked for a suspended tenant', async () => {
    const owner = await createUser({ role: 'OWNER' });
    const { token } = await loginAs(fullApp, owner.email);
    await prisma.tenant.update({ where: { id: owner.tenantId! }, data: { status: 'SUSPENDED' } });
    const res = await request(fullApp).get('/auth/me').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
  });
});
