import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import {
  createInventory,
  createLocation,
  createOpenOrder,
  createProduct,
  createSales,
  createSupplier,
  createSupplierProduct,
  createTenant,
  createUser,
} from '../../../tests/factories';
import { expectRoleAccess, rolesWith } from '../../../tests/helpers/isolation';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
const ASOF = '2025-06-02';
const WEEK = 7 * 86400_000;
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('GET /dashboard', () => {
  it('is empty-but-valid for a brand new account', async () => {
    const t = await createTenant({ plan: 'starter' });
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    const res = await request(app).get('/dashboard').set(tok(o));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      counts: { products: 0, locations: 0, suppliers: 0, lateOrders: 0 },
      sales: { records: 0, from: null, to: null },
      accuracy: null,
      upcomingStockouts: null,
      latestRuns: [],
    });
    expect(res.body.usage.find((u: { metric: string }) => u.metric === 'users')).toEqual({
      metric: 'users',
      limit: 5,
      current: 1,
    });
  });

  it('reports counts, sales span, forecast accuracy, latest runs, usage and projected stockouts', async () => {
    const t = await createTenant({ plan: 'pro' });
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    const [a, b, c] = [
      await createProduct(t.id, { sku: 'A', unitPriceCents: 500 }),
      await createProduct(t.id, { sku: 'B' }),
      await createProduct(t.id, { sku: 'C', isActive: false }),
    ];
    const loc = await createLocation(t.id, { code: 'EAST' });
    const sup = await createSupplier(t.id);
    await createSupplierProduct(t.id, sup.id, a.id, { leadTimeDays: 14, isPrimary: true });
    await createSales(t.id, a.id, loc.id, Array(20).fill(10), ASOF);
    await createInventory(t.id, a.id, loc.id, 5, 0); // far too little stock → stockout soon
    await createOpenOrder(t.id, b.id, loc.id, { expectedDate: new Date('2020-01-01') }); // late
    const r1 = await prisma.forecastRun.create({
      data: {
        tenantId: t.id,
        status: 'DONE',
        horizonWeeks: 6,
        method: 'AUTO',
        filters: {},
        asOfWeek: new Date(ASOF),
        seriesTotal: 1,
        seriesDone: 1,
        createdAt: new Date('2025-06-03'),
      },
    });
    await prisma.forecastRun.create({
      data: {
        tenantId: t.id,
        status: 'FAILED',
        horizonWeeks: 6,
        method: 'AUTO',
        filters: {},
        createdAt: new Date('2025-06-04'),
      },
    });
    await prisma.forecastResult.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({
        tenantId: t.id,
        runId: r1.id,
        productId: a.id,
        locationId: loc.id,
        weekStart: new Date(new Date(ASOF).getTime() + (i + 1) * WEEK),
        quantity: 10,
        lower: 8,
        upper: 12,
        modelUsed: 'naive',
      })),
    });
    await prisma.forecastAccuracy.createMany({
      data: [
        {
          tenantId: t.id,
          runId: r1.id,
          productId: a.id,
          locationId: loc.id,
          modelUsed: 'holt',
          wape: 0.1,
        },
        {
          tenantId: t.id,
          runId: r1.id,
          productId: b.id,
          locationId: loc.id,
          modelUsed: 'naive',
          wape: 0.3,
        },
        {
          tenantId: t.id,
          runId: r1.id,
          productId: c.id,
          locationId: loc.id,
          modelUsed: 'naive',
          wape: null,
        },
      ],
    });

    const res = (await request(app).get('/dashboard').set(tok(o))).body;
    expect(res.counts).toEqual({ products: 2, locations: 1, suppliers: 1, lateOrders: 1 });
    expect(res.sales).toMatchObject({ records: 20, to: ASOF });
    expect(res.accuracy.wape).toBeCloseTo(0.2, 9);
    expect(res.accuracy).toMatchObject({ seriesCount: 3, backtested: 2, date: '2025-06-03' });
    expect(res.accuracy.models).toEqual([
      { model: 'naive', count: 2 },
      { model: 'holt', count: 1 },
    ]);
    expect(res.latestRuns.map((r: { status: string }) => r.status)).toEqual(['FAILED', 'DONE']);
    expect(res.upcomingStockouts[0]).toMatchObject({
      sku: 'A',
      location: 'EAST',
      shortage: expect.any(Number),
    });
    expect(res.upcomingStockouts[0].firstStockoutDate).toMatch(/^2025-06-\d\d$/);
    expect(res.upcomingStockouts[0].revenueAtRiskCents).toBeGreaterThan(0);
  });

  it('never includes another tenant’s data', async () => {
    const mine = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: mine.id });
    const other = await createTenant({ plan: 'pro' });
    const op = await createProduct(other.id, { sku: 'OTHER' });
    const ol = await createLocation(other.id);
    await createSales(other.id, op.id, ol.id, Array(10).fill(5), ASOF);
    await createOpenOrder(other.id, op.id, ol.id, { expectedDate: new Date('2020-01-01') });
    const res = (await request(app).get('/dashboard').set(tok(owner))).body;
    expect(res.counts).toEqual({ products: 0, locations: 0, suppliers: 0, lateOrders: 0 });
    expect(res.sales.records).toBe(0);
  });

  it('every tenant role can read it; others get 403/401', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/dashboard',
      allowed: rolesWith('dashboard:read'),
    });
    const sa = await createUser({ role: 'SUPER_ADMIN' });
    expect((await request(app).get('/dashboard').set(tok(sa))).status).toBe(403);
  });
});
