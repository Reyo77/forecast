import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import {
  createInventory,
  createLocation,
  createProduct,
  createSales,
  createSupplier,
  createSupplierProduct,
  createTenant,
  createUser,
} from '../../../tests/factories';
import { expectRoleAccess, rolesWith } from '../../../tests/helpers/isolation';
import { abcClass } from './routes';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
const ASOF = '2025-06-02';
const WEEK = 7 * 86400_000;
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function seedPlan() {
  const t = await createTenant({ plan: 'pro' });
  const o = await createUser({ role: 'OWNER', tenantId: t.id });
  const a = await createProduct(t.id, { sku: 'A', name: 'Alpha', unitPriceCents: 500 });
  const loc = await createLocation(t.id, { code: 'EAST' });
  const sup = await createSupplier(t.id, { name: 'Acme Supplies' });
  await createSupplierProduct(t.id, sup.id, a.id, { leadTimeDays: 14, isPrimary: true });
  await createSales(t.id, a.id, loc.id, Array(20).fill(10), ASOF);
  await createInventory(t.id, a.id, loc.id, 5, 0);
  const run = await prisma.forecastRun.create({
    data: {
      tenantId: t.id,
      status: 'DONE',
      horizonWeeks: 6,
      method: 'AUTO',
      filters: {},
      asOfWeek: new Date(ASOF),
      seriesTotal: 1,
      seriesDone: 1,
    },
  });
  await prisma.forecastResult.createMany({
    data: Array.from({ length: 6 }, (_, i) => ({
      tenantId: t.id,
      runId: run.id,
      productId: a.id,
      locationId: loc.id,
      weekStart: new Date(new Date(ASOF).getTime() + (i + 1) * WEEK),
      quantity: 10,
      lower: 8,
      upper: 12,
      modelUsed: 'naive',
    })),
  });
  return { t, o, a, loc };
}

describe('GET /insights/reorder-plan', () => {
  it('is empty for an account with no finished forecast', async () => {
    const t = await createTenant({ plan: 'pro' });
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    const res = await request(app).get('/insights/reorder-plan').set(tok(o));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      run: null,
      items: [],
      totals: { orders: 0, units: 0, costCents: 0, urgent: 0 },
    });
  });

  it('lists planned purchase orders with supplier, dates, quantity and totals', async () => {
    const { o } = await seedPlan();
    const res = await request(app).get('/insights/reorder-plan').set(tok(o));
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ asOf: ASOF, horizonWeeks: 6 });
    expect(res.body.items.length).toBeGreaterThan(0);
    const first = res.body.items[0];
    expect(first).toMatchObject({
      sku: 'A',
      productName: 'Alpha',
      locationCode: 'EAST',
      supplierName: 'Acme Supplies',
      urgent: true,
    });
    expect(first.quantity).toBeGreaterThan(0);
    expect(first.arrivalDate >= first.orderDate).toBe(true);
    expect(res.body.totals.orders).toBe(res.body.items.length);
    expect(res.body.totals.urgent).toBeGreaterThan(0);
  });

  it('exports the same plan as CSV', async () => {
    const { o } = await seedPlan();
    const res = await request(app).get('/insights/reorder-plan/export.csv').set(tok(o));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('reorder-plan.csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe(
      'sku,product,location,supplier,order_date,arrival_date,quantity,est_cost',
    );
    expect(lines[1]).toContain('A,Alpha,EAST,Acme Supplies');
  });

  it('never leaks another tenant’s plan and enforces roles', async () => {
    await seedPlan();
    const mine = await createTenant({ plan: 'pro' });
    const me = await createUser({ role: 'OWNER', tenantId: mine.id });
    expect((await request(app).get('/insights/reorder-plan').set(tok(me))).body.items).toEqual([]);
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/insights/reorder-plan',
      allowed: rolesWith('forecast:read'),
    });
  });
});

describe('GET /insights/abc', () => {
  it('classifies products by cumulative revenue (A ≤80%, B ≤95%, C rest)', async () => {
    const t = await createTenant({ plan: 'pro' });
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    const loc = await createLocation(t.id);
    const big = await createProduct(t.id, { sku: 'BIG', unitPriceCents: 1000 });
    const mid = await createProduct(t.id, { sku: 'MID', unitPriceCents: 100 });
    const tiny = await createProduct(t.id, { sku: 'TINY', unitPriceCents: 10 });
    await createSales(t.id, big.id, loc.id, Array(10).fill(900), ASOF);
    await createSales(t.id, mid.id, loc.id, Array(10).fill(90), ASOF);
    await createSales(t.id, tiny.id, loc.id, Array(10).fill(10), ASOF);
    const res = await request(app).get('/insights/abc').set(tok(o));
    expect(res.status).toBe(200);
    const rows = res.body.rows as { sku: string; class: string; cumulativePct: number }[];
    expect(rows.map((r) => r.sku)).toEqual(['BIG', 'MID', 'TINY']);
    expect(rows.map((r) => r.class)).toEqual(['A', 'B', 'C']);
    expect(rows[2]!.cumulativePct).toBeCloseTo(100, 0);
    expect(res.body.summary.map((s: { class: string }) => s.class)).toEqual(['A', 'B', 'C']);
    expect(
      res.body.summary.reduce((s: number, x: { sharePct: number }) => s + x.sharePct, 0),
    ).toBeCloseTo(100, 0);
  });

  it('is empty without sales, isolates tenants and enforces roles', async () => {
    const other = await createTenant({ plan: 'pro' });
    const ol = await createLocation(other.id);
    const op = await createProduct(other.id);
    await createSales(other.id, op.id, ol.id, [5, 5], ASOF);
    const t = await createTenant({ plan: 'pro' });
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    expect((await request(app).get('/insights/abc').set(tok(o))).body).toEqual({
      from: null,
      to: null,
      rows: [],
      summary: [],
    });
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/insights/abc',
      allowed: rolesWith('sales:read'),
    });
  });

  it('abcClass boundaries', () => {
    expect([0, 79.9, 80, 94.9, 95, 100].map(abcClass)).toEqual(['A', 'A', 'B', 'B', 'C', 'C']);
  });
});
