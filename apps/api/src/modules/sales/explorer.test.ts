import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import {
  createCategory,
  createLocation,
  createProduct,
  createTenant,
  createUser,
} from '../../../tests/factories';
import { expectRoleAccess, rolesWith } from '../../../tests/helpers/isolation';
import { loadDemoData } from './demoLoader';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const W1 = '2025-01-06';
const W2 = '2025-01-13';

async function seed() {
  const tenant = await createTenant({ plan: 'pro' });
  const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
  const food = await createCategory(tenant.id, { name: 'Food' });
  const snacks = await createCategory(tenant.id, { name: 'Snacks', parentId: food.id });
  const drinks = await createCategory(tenant.id, { name: 'Drinks' });
  const chips = await createProduct(tenant.id, { sku: 'CHIP', categoryId: snacks.id });
  const cola = await createProduct(tenant.id, { sku: 'COLA', categoryId: drinks.id });
  const e = await createLocation(tenant.id, { code: 'EAST' });
  const w = await createLocation(tenant.id, { code: 'WEST' });
  const rec = (p: { id: string }, l: { id: string }, date: string, q: number, rev: number) =>
    prisma.salesRecord.create({
      data: {
        tenantId: tenant.id,
        productId: p.id,
        locationId: l.id,
        date: new Date(date),
        quantity: q,
        revenueCents: rev,
      },
    });
  await rec(chips, e, W1, 10, 1000);
  await rec(chips, e, W2, 20, 2000);
  await rec(chips, w, W1, 5, 500);
  await rec(cola, e, W1, 100, 20000);
  await rec(cola, w, W2, 50, 10000);
  return { tid: tenant.id, owner, h: tok(owner), chips, cola, e, w, food, snacks, drinks };
}

const get = (h: Record<string, string>, qs = '') =>
  request(app).get(`/sales/explorer?${qs}`).set(h);

describe('GET /sales/explorer', () => {
  it('returns weekly totals that match the underlying rows', async () => {
    const { h } = await seed();
    const res = await get(h);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ quantity: 185, revenueCents: 33500, weeks: 2 });
    expect(res.body.series).toHaveLength(1);
    expect(res.body.series[0].points).toEqual([
      { weekStart: W1, quantity: 115, revenueCents: 21500 },
      { weekStart: W2, quantity: 70, revenueCents: 12000 },
    ]);
  });

  it('filters by product, location, category (including sub-categories) and date range', async () => {
    const { h, chips, e, food, drinks } = await seed();
    expect((await get(h, `productId=${chips.id}`)).body.totals.quantity).toBe(35);
    expect((await get(h, `locationId=${e.id}`)).body.totals.quantity).toBe(130);
    expect((await get(h, `categoryId=${food.id}`)).body.totals.quantity).toBe(35); // parent includes Snacks
    expect((await get(h, `categoryId=${drinks.id}`)).body.totals.quantity).toBe(150);
    expect((await get(h, `from=${W2}`)).body.totals.quantity).toBe(70);
    expect((await get(h, `to=${W1}`)).body.totals.quantity).toBe(115);
    expect((await get(h, `from=2030-01-01`)).body).toMatchObject({
      series: [],
      totals: { quantity: 0, revenueCents: 0, weeks: 0 },
    });
    expect(
      (await get(h, `productId=${chips.id}&locationId=${e.id}&from=${W2}`)).body.totals.quantity,
    ).toBe(20);
  });

  it('groups by product, location and top-level category, biggest first', async () => {
    const { h } = await seed();
    const byProduct = (await get(h, 'groupBy=product')).body.series;
    expect(byProduct.map((s: { label: string; total: number }) => [s.label, s.total])).toEqual([
      ['COLA', 150],
      ['CHIP', 35],
    ]);
    const byLoc = (await get(h, 'groupBy=location')).body.series;
    expect(byLoc.map((s: { label: string; total: number }) => [s.label, s.total])).toEqual([
      ['EAST', 130],
      ['WEST', 55],
    ]);
    const byCat = (await get(h, 'groupBy=category')).body.series;
    expect(byCat.map((s: { label: string; total: number }) => [s.label, s.total])).toEqual([
      ['Drinks', 150],
      ['Food', 35],
    ]);
    // group totals add up to the overall total
    expect(byProduct.reduce((s: number, x: { total: number }) => s + x.total, 0)).toBe(185);
  });

  it('caps the number of series at 10 and reports the rest', async () => {
    const { tid, h, e } = await seed();
    for (let i = 0; i < 12; i++) {
      const p = await createProduct(tid, { sku: `EXTRA-${i}` });
      await prisma.salesRecord.create({
        data: {
          tenantId: tid,
          productId: p.id,
          locationId: e.id,
          date: new Date(W1),
          quantity: 1 + i,
        },
      });
    }
    const res = await get(h, 'groupBy=product');
    expect(res.body.series).toHaveLength(10);
    expect(res.body.omittedSeries).toBe(4);
  });

  it('never includes another tenant’s data, even when filtering by their ids', async () => {
    const mine = await seed();
    const other = await createTenant();
    const op = await createProduct(other.id, { sku: 'OTHER' });
    const ol = await createLocation(other.id);
    await prisma.salesRecord.create({
      data: {
        tenantId: other.id,
        productId: op.id,
        locationId: ol.id,
        date: new Date(W1),
        quantity: 9999,
      },
    });
    expect((await get(mine.h)).body.totals.quantity).toBe(185);
    expect((await get(mine.h, `productId=${op.id}`)).body.totals.quantity).toBe(0);
    expect((await get(mine.h, `locationId=${ol.id}`)).body.totals.quantity).toBe(0);
  });

  it('validates query params and enforces roles (all tenant roles may read)', async () => {
    const { h } = await seed();
    expect((await get(h, 'groupBy=nonsense')).status).toBe(400);
    expect((await get(h, 'from=not-a-date')).status).toBe(400);
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/sales/explorer',
      allowed: rolesWith('sales:read'),
    });
  });
});

describe('demo data', () => {
  it('POST /demo-data loads a realistic dataset; the status endpoint flips; a second load is refused', async () => {
    const t = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const h = tok(owner);
    expect((await request(app).get('/demo-data/status').set(h)).body).toEqual({
      hasSalesData: false,
      canLoad: true,
    });
    const res = await request(app).post('/demo-data').set(h);
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({
      products: 12,
      locations: 2,
      suppliers: 3,
      weeksOfSales: 156,
    });
    expect(await prisma.salesRecord.count({ where: { tenantId: t.id } })).toBe(
      res.body.summary.salesRows,
    );
    expect(await prisma.bomItem.count({ where: { tenantId: t.id } })).toBe(6);
    expect(await prisma.openOrder.count({ where: { tenantId: t.id } })).toBe(4);
    expect((await request(app).get('/demo-data/status').set(h)).body).toEqual({
      hasSalesData: true,
      canLoad: false,
    });
    const again = await request(app).post('/demo-data').set(h);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DATA_EXISTS');
    // the explorer now has data
    expect(
      (await request(app).get('/sales/explorer?groupBy=category').set(h)).body.series.length,
    ).toBeGreaterThan(1);
    // BOM from demo data is acyclic and usable
    const bike = await prisma.product.findFirstOrThrow({
      where: { tenantId: t.id, sku: 'GFT-BOX' },
    });
    expect((await request(app).get(`/products/${bike.id}/bom`).set(h)).body.tree).toHaveLength(3);
  });

  it('is identical for every tenant (reproducible) and scoped to the loading tenant', async () => {
    const mk = async () => {
      const t = await createTenant({ plan: 'pro' });
      const o = await createUser({ role: 'OWNER', tenantId: t.id });
      await request(app).post('/demo-data').set(tok(o));
      const rows = await prisma.salesRecord.findMany({
        where: { tenantId: t.id },
        include: { product: true, location: true },
        orderBy: [{ product: { sku: 'asc' } }, { location: { code: 'asc' } }, { date: 'asc' }],
      });
      return rows.map(
        (r) =>
          `${r.product.sku}|${r.location.code}|${r.date.toISOString().slice(0, 10)}|${Number(r.quantity)}`,
      );
    };
    const [a, b] = [await mk(), await mk()];
    // dates shift only if the test crosses a week boundary between the two calls; compare the quantities
    expect(a.map((x) => x.split('|').slice(0, 2).join('|') + '|' + x.split('|')[3])).toEqual(
      b.map((x) => x.split('|').slice(0, 2).join('|') + '|' + x.split('|')[3]),
    );
    expect(await prisma.product.count()).toBe(24);
  });

  it('respects short-retention plans (Starter keeps 36 months; limits are checked first)', async () => {
    const free = await createTenant({ plan: 'free' });
    const fo = await createUser({ role: 'OWNER', tenantId: free.id });
    const res = await request(app).post('/demo-data').set(tok(fo));
    expect(res.status).toBe(402); // 2 locations > Free's 1
    expect(res.body.error.details).toMatchObject({ metric: 'locations', limit: 1 });
    expect(await prisma.product.count({ where: { tenantId: free.id } })).toBe(0); // nothing half-created
    const starter = await createTenant({ plan: 'starter' });
    await prisma.subscription.update({
      where: { tenantId: starter.id },
      data: { customLimits: { historyMonths: 12 } },
    });
    const direct = await loadDemoData(starter.id, new Date());
    expect(direct.weeksOfSales).toBe(52);
  });

  it('roles: Owner/Admin only; Planner and Viewer get 403', async () => {
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/demo-data',
      allowed: rolesWith('demo:load'),
    });
  });
});
