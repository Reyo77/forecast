import request from 'supertest';
import { prisma } from './db/client';
import { resetDb } from '../tests/helpers/db';
import { bearer, tokenFor } from '../tests/helpers/auth';
import { testApp } from '../tests/helpers/app';
import { listRoutes } from '../tests/helpers/routes';
import {
  createCategory,
  createLocation,
  createProduct,
  createSupplier,
  createSupplierProduct,
  createTenant,
  createUser,
} from '../tests/factories';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

/** Routes that are deliberately reachable without logging in. */
const PUBLIC = new Set([
  'GET /health',
  'GET /plans',
  'POST /auth/signup',
  'POST /auth/login',
  'POST /auth/refresh',
  'POST /auth/logout',
  'POST /auth/reset-password',
  'POST /invites/accept',
  'POST /billing/webhook',
]);
/** Authenticated routes that apply to the caller's own account and need no special permission. */
const SELF_SERVICE = new Set(['GET /auth/me', 'PATCH /auth/me', 'POST /auth/change-password']);

describe('route audit (Feature 8.2)', () => {
  const routes = listRoutes(app);
  const id = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

  it('finds a realistic number of routes (the audit itself is not vacuous)', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.map(id)).toEqual(
      expect.arrayContaining([
        'GET /health',
        'POST /auth/login',
        'GET /users',
        'POST /forecasts/runs',
        'GET /admin/metrics',
        'POST /ai/assistant',
        'GET /dashboard',
      ]),
    );
  });

  it('every route requires authentication unless explicitly listed as public', () => {
    const unguarded = routes
      .filter((r) => !PUBLIC.has(id(r)) && !r.guards.includes('auth'))
      .map(id);
    expect(unguarded).toEqual([]);
  });

  it('every protected route also enforces a role/permission (except self-service account routes)', () => {
    const noRole = routes
      .filter((r) => !PUBLIC.has(id(r)) && !SELF_SERVICE.has(id(r)) && !r.guards.includes('role'))
      .map(id);
    expect(noRole).toEqual([]);
  });

  it('every protected route applies the tenant guard, so suspended tenants are blocked everywhere', () => {
    const noTenant = routes
      .filter((r) => !PUBLIC.has(id(r)) && !r.guards.includes('tenant'))
      .map(id);
    expect(noTenant).toEqual([]);
  });

  it('the public allowlist only contains routes that exist (no stale exemptions)', () => {
    const all = new Set(routes.map(id));
    for (const p of PUBLIC) expect(all.has(p)).toBe(true);
  });

  it('protected routes answer 401 without a token (sampled across every module)', async () => {
    const samples = routes
      .filter((r) => !PUBLIC.has(id(r)) && r.method === 'GET' && !r.path.includes(':'))
      .slice(0, 80);
    expect(samples.length).toBeGreaterThan(20);
    for (const r of samples) {
      const res = await request(app).get(r.path);
      expect({ route: id(r), status: res.status }).toEqual({ route: id(r), status: 401 });
    }
  });
});

describe('pagination limits (max page size 100) on every list endpoint', () => {
  it('rejects pageSize=101 and applies sane defaults', async () => {
    const tenant = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
    const sa = await createUser({ role: 'SUPER_ADMIN' });
    const supplier = await createSupplier(tenant.id);
    const product = await createProduct(tenant.id);
    await createSupplierProduct(tenant.id, supplier.id, product.id);
    await createCategory(tenant.id);
    await createLocation(tenant.id);
    const run = await prisma.forecastRun.create({
      data: { tenantId: tenant.id, status: 'DONE', horizonWeeks: 4, method: 'AUTO', filters: {} },
    });
    const scenario = await prisma.scenario.create({
      data: { tenantId: tenant.id, name: 's', baseForecastRunId: run.id },
    });

    const tenantLists = [
      '/users',
      '/invites',
      '/audit-logs',
      '/categories',
      '/products',
      '/locations',
      '/suppliers',
      '/inventory',
      '/open-orders',
      '/billing/invoices',
      '/forecasts/runs',
      '/forecasts/overrides',
      '/imports/sales',
      '/scenarios',
      '/notifications',
      `/suppliers/${supplier.id}/products`,
      `/products/${product.id}/suppliers`,
      `/forecasts/runs/${run.id}/results`,
      `/forecasts/runs/${run.id}/accuracy`,
      `/scenarios/${scenario.id}/runs`,
    ];
    for (const path of tenantLists) {
      const sep = path.includes('?') ? '&' : '?';
      const bad = await request(app).get(`${path}${sep}pageSize=101`).set(tok(owner));
      expect({ path, status: bad.status }).toEqual({ path, status: 400 });
      const ok = await request(app).get(`${path}${sep}pageSize=100`).set(tok(owner));
      expect({ path, status: ok.status }).toEqual({ path, status: 200 });
      expect(ok.body).toEqual(
        expect.objectContaining({
          items: expect.any(Array),
          total: expect.any(Number),
          page: 1,
          pageSize: 100,
        }),
      );
      const zero = await request(app).get(`${path}${sep}page=0`).set(tok(owner));
      expect({ path, status: zero.status }).toEqual({ path, status: 400 });
    }
    expect((await request(app).get('/admin/tenants?pageSize=101').set(tok(sa))).status).toBe(400);
    expect((await request(app).get('/admin/tenants?pageSize=100').set(tok(sa))).status).toBe(200);
  });

  it('defaults to 25 items per page where no explicit default is set', async () => {
    const tenant = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
    for (let i = 0; i < 30; i++)
      await createProduct(tenant.id, { sku: `P${String(i).padStart(2, '0')}` });
    const res = await request(app).get('/products').set(tok(owner));
    expect(res.body.items).toHaveLength(25);
    expect(res.body.total).toBe(30);
    expect((await request(app).get('/products?page=2').set(tok(owner))).body.items).toHaveLength(5);
  });
});

describe('database indexes for common filters', () => {
  it('has the composite indexes the list/aggregation queries rely on', async () => {
    const rows = await prisma.$queryRaw<{ TABLE_NAME: string; INDEX_NAME: string; cols: string }[]>`
      SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() GROUP BY TABLE_NAME, INDEX_NAME`;
    const has = (table: string, cols: string) =>
      rows.some((r) => r.TABLE_NAME === table && r.cols === cols);
    expect(has('SalesRecord', 'tenantId,productId,date')).toBe(true);
    expect(has('SalesRecord', 'tenantId,date')).toBe(true);
    expect(has('Product', 'tenantId,sku')).toBe(true);
    expect(has('ForecastResult', 'runId,productId,locationId')).toBe(true);
    expect(has('ForecastAccuracy', 'runId,wape')).toBe(true);
    expect(has('AuditLog', 'tenantId,createdAt')).toBe(true);
    expect(has('Notification', 'tenantId,userId,readAt')).toBe(true);
    expect(has('Job', 'status,runAfter')).toBe(true);
    // every tenant-owned table has an index that starts with tenantId
    const tenantTables = (
      await prisma.$queryRaw<
        { TABLE_NAME: string }[]
      >`SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenantId'`
    ).map((r) => r.TABLE_NAME);
    for (const t of tenantTables)
      expect({
        t,
        indexed: rows.some((r) => r.TABLE_NAME === t && r.cols.split(',')[0] === 'tenantId'),
      }).toEqual({ t, indexed: true });
  });
});
