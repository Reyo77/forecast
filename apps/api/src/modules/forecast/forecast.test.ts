import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import {
  createCategory,
  createLocation,
  createProduct,
  createSales,
  createTenant,
  createUser,
} from '../../../tests/factories';
import {
  expectRoleAccess,
  expectTenantIsolation,
  rolesWith,
} from '../../../tests/helpers/isolation';
import { drainJobs } from '../../jobs/runner';
import { registerCoreJobHandlers } from '../../jobs/handlers';
import { createRng } from '../sales/demo';
import { currentUsage } from '../billing/limits';
import { forecastSeries, processForecastRun } from './service';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
const END = '2025-06-02'; // a Monday

beforeAll(() => registerCoreJobHandlers());
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const trend = (n: number, base = 50, slope = 2) =>
  Array.from({ length: n }, (_, t) => base + slope * t);

async function world(plan = 'pro') {
  const tenant = await createTenant({ plan });
  const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
  const cat = await createCategory(tenant.id, { name: 'Cat' });
  const a = await createProduct(tenant.id, { sku: 'A', categoryId: cat.id });
  const b = await createProduct(tenant.id, { sku: 'B' });
  const east = await createLocation(tenant.id, { code: 'EAST' });
  const west = await createLocation(tenant.id, { code: 'WEST' });
  await createSales(tenant.id, a.id, east.id, trend(60), END);
  await createSales(tenant.id, a.id, west.id, trend(60, 20, 1), END);
  await createSales(tenant.id, b.id, east.id, trend(60, 100, 0), END);
  return { tid: tenant.id, owner, h: tok(owner), a, b, east, west, cat };
}
const start = (h: Record<string, string>, body: object = {}) =>
  request(app)
    .post('/forecasts/runs')
    .set(h)
    .send({ horizonWeeks: 8, ...body });
async function runAndWait(h: Record<string, string>, body: object = {}) {
  const res = await start(h, body);
  expect(res.status).toBe(202);
  await drainJobs();
  return (await request(app).get(`/forecasts/runs/${res.body.run.id}`).set(h)).body.run;
}

describe('POST /forecasts/runs', () => {
  it('accepts a run (202), queues a background job and consumes one run of the plan', async () => {
    const { h, tid } = await world();
    const res = await start(h);
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({
      status: 'PENDING',
      horizonWeeks: 8,
      method: 'AUTO',
      seriesTotal: 3,
      progress: 0,
    });
    expect(await prisma.job.count({ where: { type: 'forecast.run', status: 'PENDING' } })).toBe(1);
    expect(await currentUsage(tid, 'forecastRuns')).toBe(1);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
      'forecast.run_started',
    );
  });

  it.each([
    ['horizon below 4', { horizonWeeks: 3 }],
    ['horizon above 52', { horizonWeeks: 53 }],
    ['fractional horizon', { horizonWeeks: 8.5 }],
    ['unknown method', { method: 'magic' }],
    ['non-string filter id', { filters: { productId: 5 } }],
  ])('400 for %s and consumes no usage', async (_l, body) => {
    const { h, tid } = await world();
    expect((await start(h, body)).status).toBe(400);
    expect(await currentUsage(tid, 'forecastRuns')).toBe(0);
    expect(await prisma.forecastRun.count()).toBe(0);
  });

  it('boundary horizons 4 and 52 are accepted', async () => {
    const { h } = await world();
    expect((await start(h, { horizonWeeks: 4 })).status).toBe(202);
    expect((await start(h, { horizonWeeks: 52 })).status).toBe(202);
  });

  it('400 NO_SALES_DATA when nothing matches, and usage is not consumed', async () => {
    const t = await createTenant();
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    const res = await start(tok(o));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_SALES_DATA');
    expect(await currentUsage(t.id, 'forecastRuns')).toBe(0);
    const w = await world();
    const empty = await createProduct(w.tid, { sku: 'NODATA' });
    expect((await start(w.h, { filters: { productId: empty.id } })).body.error.code).toBe(
      'NO_SALES_DATA',
    );
  });

  it('filters by category, product and location', async () => {
    const { h, a, east, cat } = await world();
    expect((await start(h, { filters: { productId: a.id } })).body.run.seriesTotal).toBe(2);
    expect((await start(h, { filters: { locationId: east.id } })).body.run.seriesTotal).toBe(2);
    expect((await start(h, { filters: { categoryId: cat.id } })).body.run.seriesTotal).toBe(2);
    expect(
      (await start(h, { filters: { productId: a.id, locationId: east.id } })).body.run.seriesTotal,
    ).toBe(1);
  });

  it('404 for another tenant’s product/location/category filter, with no usage consumed', async () => {
    const { h, tid } = await world();
    const other = await createTenant();
    const op = await createProduct(other.id);
    const ol = await createLocation(other.id);
    const oc = await createCategory(other.id);
    for (const filters of [{ productId: op.id }, { locationId: ol.id }, { categoryId: oc.id }]) {
      expect((await start(h, { filters })).status).toBe(404);
    }
    expect(await currentUsage(tid, 'forecastRuns')).toBe(0);
  });

  it('returns 402 at the plan limit; concurrent starts never exceed it', async () => {
    const { h, tid } = await world('free');
    await prisma.subscription.update({
      where: { tenantId: tid },
      data: { customLimits: { forecastRuns: 3 } },
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => start(h)));
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    const blocked = results.find((r) => r.status === 402)!;
    expect(blocked.body.error).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { metric: 'forecastRuns', limit: 3, current: 3 },
    });
    expect(await prisma.forecastRun.count()).toBe(3);
    expect(await currentUsage(tid, 'forecastRuns')).toBe(3);
  });

  it('roles: Owner/Admin/Planner may run, Viewer may not; 401 anonymous', async () => {
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/forecasts/runs',
      body: { horizonWeeks: 8 },
      allowed: rolesWith('forecast:run'),
    });
  });
});

describe('forecast job', () => {
  it('forecasts every series, saves results and accuracy, and reports 100%', async () => {
    const { h, tid, a, east } = await world();
    const run = await runAndWait(h, { horizonWeeks: 10 });
    expect(run).toMatchObject({
      status: 'DONE',
      progress: 100,
      seriesTotal: 3,
      seriesDone: 3,
      seriesFailed: 0,
      error: null,
      asOfWeek: END,
    });
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(await prisma.forecastResult.count({ where: { runId: run.id } })).toBe(30);
    expect(await prisma.forecastAccuracy.count({ where: { runId: run.id } })).toBe(3);

    const rows = await prisma.forecastResult.findMany({
      where: { runId: run.id, productId: a.id, locationId: east.id },
      orderBy: { weekStart: 'asc' },
    });
    expect(rows).toHaveLength(10);
    expect(rows[0]!.weekStart.toISOString().slice(0, 10)).toBe('2025-06-09'); // the week after the last sale
    for (const r of rows) {
      expect(Number(r.quantity)).toBeGreaterThanOrEqual(0);
      expect(Number(r.lower)).toBeLessThanOrEqual(Number(r.quantity));
      expect(Number(r.quantity)).toBeLessThanOrEqual(Number(r.upper));
      expect(r.tenantId).toBe(tid);
    }
    // A clean upward trend continues upward.
    expect(Number(rows[9]!.quantity)).toBeGreaterThan(Number(rows[0]!.quantity));
    const acc = await prisma.forecastAccuracy.findFirstOrThrow({
      where: { runId: run.id, productId: a.id, locationId: east.id },
    });
    expect(acc.modelUsed).toBe('holt');
    expect(acc.reason).toBe('backtest');
    expect(acc.wape).not.toBeNull();
    expect(acc.holdout).toBe(12);
  });

  it('a fixed method is used for every series', async () => {
    const { h } = await world();
    const run = await runAndWait(h, { method: 'ses' });
    const models = await prisma.forecastResult.findMany({
      where: { runId: run.id },
      distinct: ['modelUsed'],
      select: { modelUsed: true },
    });
    expect(models.map((m) => m.modelUsed)).toEqual(['ses']);
    expect(
      (await prisma.forecastAccuracy.findFirstOrThrow({ where: { runId: run.id } })).reason,
    ).toBe('fixed');
  });

  it('AUTO picks Croston for sparse series and Holt-Winters for seasonal ones with 3 years of data', async () => {
    const t = await createTenant({ plan: 'pro' });
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    const loc = await createLocation(t.id);
    const sparse = await createProduct(t.id, { sku: 'SPARSE' });
    const seasonal = await createProduct(t.id, { sku: 'SEASONAL' });
    const rng = createRng(4);
    await createSales(
      t.id,
      sparse.id,
      loc.id,
      Array.from({ length: 80 }, () => (rng.next() < 0.2 ? 6 : 0)),
      END,
    );
    await createSales(
      t.id,
      seasonal.id,
      loc.id,
      Array.from({ length: 156 }, (_, i) =>
        Math.max(0, Math.round(200 + 60 * Math.sin((2 * Math.PI * i) / 52) + rng.normal() * 4)),
      ),
      END,
    );
    const run = await runAndWait(tok(o), { horizonWeeks: 26 });
    const acc = Object.fromEntries(
      (
        await prisma.forecastAccuracy.findMany({
          where: { runId: run.id },
          include: { product: true },
        })
      ).map((a) => [a.product.sku, a]),
    );
    expect(acc.SPARSE!.modelUsed).toBe('croston');
    expect(acc.SPARSE!.reason).toBe('intermittent');
    expect(acc.SEASONAL!.modelUsed).toBe('holt_winters');
  });

  it('weeks without a record count as zero demand (gaps are filled)', async () => {
    const t = await createTenant();
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    const loc = await createLocation(t.id);
    const p = await createProduct(t.id, { sku: 'GAPPY' });
    // 20 weeks of data but only every 4th week recorded → 75% zero weeks → Croston
    const end = new Date(`${END}T00:00:00Z`).getTime();
    for (let i = 0; i < 20; i += 4)
      await prisma.salesRecord.create({
        data: {
          tenantId: t.id,
          productId: p.id,
          locationId: loc.id,
          date: new Date(end - i * 7 * 86400_000),
          quantity: 8,
        },
      });
    const run = await runAndWait(tok(o));
    expect(
      (await prisma.forecastAccuracy.findFirstOrThrow({ where: { runId: run.id } })).modelUsed,
    ).toBe('croston');
  });

  it('a crash in one series is recorded against that series and does not fail the run', async () => {
    const { h, a } = await world();
    const start1 = await start(h);
    const runId = start1.body.run.id;
    await processForecastRun(runId, {
      forecaster: (hist, end, hz, m) => {
        if (hist[0] === 100) throw new Error('model exploded for B'); // product B's series starts at 100
        return forecastSeries(hist, end, hz, m);
      },
    });
    const run = await prisma.forecastRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({
      status: 'DONE',
      seriesTotal: 3,
      seriesDone: 2,
      seriesFailed: 1,
      progress: 100,
      error: null,
    });
    expect(run.failures).toEqual([expect.objectContaining({ error: 'model exploded for B' })]);
    expect(await prisma.forecastResult.count({ where: { runId } })).toBe(16);
    expect(await prisma.forecastResult.count({ where: { runId, productId: a.id } })).toBe(16);
    const detail = await request(app).get(`/forecasts/runs/${runId}`).set(h);
    expect(detail.body.run.failures).toHaveLength(1);
  });

  it('if every series fails the run FAILS with the error shown', async () => {
    const { h } = await world();
    const runId = (await start(h)).body.run.id;
    await processForecastRun(runId, {
      forecaster: () => {
        throw new Error('boom');
      },
    });
    const run = await prisma.forecastRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/Every series failed.*boom/);
    expect(await prisma.forecastResult.count({ where: { runId } })).toBe(0);
  });

  it('records a failure when the sales data disappears, via the job (retries, then FAILED)', async () => {
    const { h, tid } = await world();
    const runId = (await start(h)).body.run.id;
    await prisma.salesRecord.deleteMany({ where: { tenantId: tid } });
    for (let i = 0; i < 4; i++) await drainJobs(new Date(Date.now() + (i + 1) * 86400_000));
    const run = await prisma.forecastRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/No sales history/);
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'forecast.run' } })).status).toBe(
      'FAILED',
    );
    expect((await request(app).get(`/forecasts/runs/${runId}`).set(h)).body.run.error).toMatch(
      /No sales history/,
    );
  });

  it('re-running the same job replaces rather than duplicates results', async () => {
    const { h } = await world();
    const runId = (await start(h)).body.run.id;
    await processForecastRun(runId);
    await prisma.forecastRun.update({ where: { id: runId }, data: { status: 'PENDING' } });
    await processForecastRun(runId);
    expect(await prisma.forecastResult.count({ where: { runId } })).toBe(24);
    expect(await prisma.forecastAccuracy.count({ where: { runId } })).toBe(3);
  });

  it('is deterministic: two runs on the same data give identical numbers', async () => {
    const { h } = await world();
    const r1 = await runAndWait(h);
    const r2 = await runAndWait(h);
    const dump = async (id: string) =>
      (
        await prisma.forecastResult.findMany({
          where: { runId: id },
          orderBy: [{ productId: 'asc' }, { locationId: 'asc' }, { weekStart: 'asc' }],
        })
      ).map((r) => [
        r.weekStart.toISOString(),
        Number(r.quantity),
        Number(r.lower),
        Number(r.upper),
        r.modelUsed,
      ]);
    expect(await dump(r1.id)).toEqual(await dump(r2.id));
  });
});

describe('reading runs', () => {
  it('lists runs newest first (paginated) and shows detail; viewers can read', async () => {
    const { h, tid } = await world();
    const r1 = await runAndWait(h, { horizonWeeks: 4 });
    const r2 = await runAndWait(h, { horizonWeeks: 6 });
    const list = await request(app).get('/forecasts/runs').set(h);
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([r2.id, r1.id]);
    expect((await request(app).get('/forecasts/runs?pageSize=1').set(h)).body.items).toHaveLength(
      1,
    );
    expect((await request(app).get('/forecasts/runs?pageSize=101').set(h)).status).toBe(400);
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/forecasts/runs',
      allowed: rolesWith('forecast:read'),
    });
    await expectRoleAccess({
      app,
      method: 'get',
      path: `/forecasts/runs/${r1.id}`,
      allowed: rolesWith('forecast:read'),
      roles: ['VIEWER', 'PLANNER'],
      body: undefined,
    });
    void tid;
  });

  it('results: filterable, paginated (max 100), with SKU and location codes', async () => {
    const { h, a, east } = await world();
    const run = await runAndWait(h, { horizonWeeks: 8 });
    const all = await request(app).get(`/forecasts/runs/${run.id}/results?pageSize=100`).set(h);
    expect(all.body.total).toBe(24);
    expect(all.body.items[0]).toMatchObject({ productSku: 'A', modelUsed: expect.any(String) });
    expect(
      (
        await request(app)
          .get(`/forecasts/runs/${run.id}/results?productId=${a.id}&locationId=${east.id}`)
          .set(h)
      ).body.total,
    ).toBe(8);
    expect(
      (await request(app).get(`/forecasts/runs/${run.id}/results?pageSize=5&page=2`).set(h)).body
        .items,
    ).toHaveLength(5);
    expect(
      (await request(app).get(`/forecasts/runs/${run.id}/results?pageSize=500`).set(h)).status,
    ).toBe(400);
  });

  it('accuracy table sorts by WAPE / SKU', async () => {
    const { h } = await world();
    const run = await runAndWait(h);
    const asc = (
      await request(app).get(`/forecasts/runs/${run.id}/accuracy?sort=wape&order=asc`).set(h)
    ).body.items;
    const desc = (
      await request(app).get(`/forecasts/runs/${run.id}/accuracy?sort=wape&order=desc`).set(h)
    ).body.items;
    expect(asc).toHaveLength(3);
    expect(asc.map((x: { productId: string }) => x.productId + 'x')).not.toEqual([]);
    expect(asc[0].wape).toBeLessThanOrEqual(asc[2].wape);
    expect(desc[0].wape).toBeGreaterThanOrEqual(desc[2].wape);
    const bySku = (
      await request(app).get(`/forecasts/runs/${run.id}/accuracy?sort=sku&order=desc`).set(h)
    ).body.items;
    expect(bySku[0].productSku).toBe('B');
    expect(asc[0]).toEqual(
      expect.objectContaining({
        productSku: expect.any(String),
        locationCode: expect.any(String),
        modelUsed: expect.any(String),
      }),
    );
    expect(
      (await request(app).get(`/forecasts/runs/${run.id}/accuracy?sort=bogus`).set(h)).status,
    ).toBe(400);
  });

  it('series: history + forecast for one location, or summed across locations', async () => {
    const { h, a, east, west } = await world();
    const run = await runAndWait(h, { horizonWeeks: 6 });
    const one = (
      await request(app)
        .get(`/forecasts/runs/${run.id}/series?productId=${a.id}&locationId=${east.id}`)
        .set(h)
    ).body;
    expect(one.product.sku).toBe('A');
    expect(one.location.code).toBe('EAST');
    expect(one.forecast).toHaveLength(6);
    expect(one.history.at(-1)).toEqual({ weekStart: END, quantity: 50 + 2 * 59 });
    expect(one.accuracy.wape).not.toBeNull();
    const w = (
      await request(app)
        .get(`/forecasts/runs/${run.id}/series?productId=${a.id}&locationId=${west.id}`)
        .set(h)
    ).body;
    const all = (
      await request(app).get(`/forecasts/runs/${run.id}/series?productId=${a.id}`).set(h)
    ).body;
    expect(all.location).toBeNull();
    expect(all.accuracy).toBeNull();
    expect(all.history.at(-1).quantity).toBe(
      one.history.at(-1).quantity + w.history.at(-1).quantity,
    );
    expect(all.forecast[0].quantity).toBeCloseTo(
      one.forecast[0].quantity + w.forecast[0].quantity,
      6,
    );
    expect(
      (
        await request(app)
          .get(`/forecasts/runs/${run.id}/series?productId=${a.id}&historyWeeks=10`)
          .set(h)
      ).body.history,
    ).toHaveLength(10);
  });

  it('series 404s for unknown product/location or a product with no forecast', async () => {
    const { h, a } = await world();
    const run = await runAndWait(h);
    expect(
      (await request(app).get(`/forecasts/runs/${run.id}/series?productId=nope`).set(h)).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get(`/forecasts/runs/${run.id}/series?productId=${a.id}&locationId=nope`)
          .set(h)
      ).status,
    ).toBe(404);
    const lonely = await prisma.product.create({
      data: { tenantId: (await prisma.tenant.findFirstOrThrow()).id, sku: 'LONELY', name: 'x' },
    });
    expect(
      (await request(app).get(`/forecasts/runs/${run.id}/series?productId=${lonely.id}`).set(h))
        .status,
    ).toBe(404);
    expect((await request(app).get(`/forecasts/runs/${run.id}/series`).set(h)).status).toBe(400);
  });

  it('tenant isolation on run detail, results, accuracy, series and export', async () => {
    const create = async (tenantId: string) => {
      const p = await createProduct(tenantId);
      return prisma.forecastRun
        .create({
          data: {
            tenantId,
            horizonWeeks: 4,
            method: 'AUTO',
            filters: {},
            status: 'DONE',
            seriesTotal: 1,
            asOfWeek: new Date(END),
          },
        })
        .then((r) => ({ id: r.id, productId: p.id }));
    };
    for (const suffix of ['', '/results', '/accuracy', '/export.csv']) {
      await expectTenantIsolation({
        app,
        method: 'get',
        path: (id) => `/forecasts/runs/${id}${suffix}`,
        createResource: create,
      });
    }
    // Series needs a real product id: another tenant must still get 404 for this tenant's run.
    const { a, h } = await world();
    const run = await runAndWait(h);
    const intruder = await createUser({ role: 'OWNER' });
    const res = await request(app)
      .get(`/forecasts/runs/${run.id}/series?productId=${a.id}`)
      .set(tok(intruder));
    expect(res.status).toBe(404);
  });
});

describe('CSV export', () => {
  it('exports forecast, interval, override and final columns', async () => {
    const { h, a, east } = await world();
    const run = await runAndWait(h, {
      horizonWeeks: 4,
      filters: { productId: a.id, locationId: east.id },
    });
    await request(app).put('/forecasts/overrides').set(h).send({
      productId: a.id,
      locationId: east.id,
      weekStart: '2025-06-16',
      quantity: 999,
      reason: 'Big promo planned',
    });
    const res = await request(app).get(`/forecasts/runs/${run.id}/export.csv`).set(h);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe(
      'sku,location_code,week_start,forecast,lower,upper,override,final,model_used',
    );
    expect(lines).toHaveLength(5);
    const rows = lines.slice(1).map((l) => l.split(','));
    expect(rows.map((r) => r[2])).toEqual(['2025-06-09', '2025-06-16', '2025-06-23', '2025-06-30']);
    expect(rows[1]![6]).toBe('999');
    expect(rows[1]![7]).toBe('999.00');
    expect(rows[0]![6]).toBe('');
    expect(rows[0]![7]).toBe(rows[0]![3]);
    expect(rows[0]![0]).toBe('A');
    const db = await prisma.forecastResult.findFirstOrThrow({
      where: { runId: run.id },
      orderBy: { weekStart: 'asc' },
    });
    expect(Number(rows[0]![3])).toBeCloseTo(Number(db.quantity), 2);
  });
});

describe('overrides', () => {
  const body = (a: { id: string }, l: { id: string }, over: object = {}) => ({
    productId: a.id,
    locationId: l.id,
    weekStart: '2025-06-16',
    quantity: 120,
    reason: 'Customer promotion',
    ...over,
  });

  it('sets, updates (upsert), lists and deletes an override; shows up in the series as the final value', async () => {
    const { h, a, east } = await world();
    const run = await runAndWait(h, { horizonWeeks: 6 });
    const set = await request(app).put('/forecasts/overrides').set(h).send(body(a, east));
    expect(set.status).toBe(200);
    expect(set.body.override).toMatchObject({
      productSku: 'A',
      locationCode: 'EAST',
      weekStart: '2025-06-16',
      quantity: 120,
      reason: 'Customer promotion',
    });
    const again = await request(app)
      .put('/forecasts/overrides')
      .set(h)
      .send(body(a, east, { quantity: 150, reason: 'Revised promotion' }));
    expect(again.body.override.id).toBe(set.body.override.id);
    expect(await prisma.forecastOverride.count()).toBe(1);

    const series = (
      await request(app)
        .get(`/forecasts/runs/${run.id}/series?productId=${a.id}&locationId=${east.id}`)
        .set(h)
    ).body;
    const wk = series.forecast.find((p: { weekStart: string }) => p.weekStart === '2025-06-16');
    expect(wk).toMatchObject({ override: 150, final: 150 });
    expect(wk.quantity).not.toBe(150);
    expect(
      series.forecast.filter((p: { override: number | null }) => p.override !== null),
    ).toHaveLength(1);

    const list = await request(app).get(`/forecasts/overrides?productId=${a.id}`).set(h);
    expect(list.body.total).toBe(1);
    expect(
      (await request(app).delete(`/forecasts/overrides/${set.body.override.id}`).set(h)).status,
    ).toBe(204);
    expect((await request(app).get(`/forecasts/overrides`).set(h)).body.total).toBe(0);
    const actions = (await prisma.auditLog.findMany()).map((x) => x.action);
    expect(actions).toEqual(
      expect.arrayContaining(['forecast.override_set', 'forecast.override_removed']),
    );
  });

  it('aggregated series (all locations) uses each location’s override', async () => {
    const { h, a, east } = await world();
    const run = await runAndWait(h, { horizonWeeks: 4 });
    await request(app)
      .put('/forecasts/overrides')
      .set(h)
      .send(body(a, east, { quantity: 1000 }));
    const all = (
      await request(app).get(`/forecasts/runs/${run.id}/series?productId=${a.id}`).set(h)
    ).body;
    const wk = all.forecast.find((p: { weekStart: string }) => p.weekStart === '2025-06-16');
    expect(wk.override).not.toBeNull();
    expect(wk.final).toBeGreaterThan(1000);
    expect(wk.final).toBeLessThan(wk.quantity + 1000);
  });

  it.each([
    ['missing reason', { reason: '' }],
    ['too-short reason', { reason: 'ab' }],
    ['negative quantity', { quantity: -1 }],
    ['not a Monday', { weekStart: '2025-06-17' }],
    ['bad date', { weekStart: 'soon' }],
    ['non-numeric quantity', { quantity: 'lots' }],
  ])('400: %s', async (_l, patch) => {
    const { h, a, east } = await world();
    expect(
      (
        await request(app)
          .put('/forecasts/overrides')
          .set(h)
          .send(body(a, east, patch))
      ).status,
    ).toBe(400);
    expect(await prisma.forecastOverride.count()).toBe(0);
  });

  it('rejects another tenant’s product or location (404)', async () => {
    const { h, a, east } = await world();
    const other = await createTenant();
    const op = await createProduct(other.id);
    const ol = await createLocation(other.id);
    expect(
      (await request(app).put('/forecasts/overrides').set(h).send(body(op, east))).status,
    ).toBe(404);
    expect((await request(app).put('/forecasts/overrides').set(h).send(body(a, ol))).status).toBe(
      404,
    );
  });

  it('roles: Owner/Admin/Planner may override, Viewer may not (but can read); isolation on delete', async () => {
    const t = await createTenant();
    const p = await createProduct(t.id);
    const l = await createLocation(t.id);
    await expectRoleAccess({
      app,
      method: 'put',
      path: '/forecasts/overrides',
      body: body(p, l),
      allowed: rolesWith('forecast:override'),
      roles: ['VIEWER', 'PLANNER'],
    });
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/forecasts/overrides',
      allowed: rolesWith('forecast:read'),
    });
    await expectTenantIsolation({
      app,
      method: 'delete',
      path: (id) => `/forecasts/overrides/${id}`,
      createResource: async (tenantId) =>
        prisma.forecastOverride.create({
          data: {
            tenantId,
            productId: (await createProduct(tenantId)).id,
            locationId: (await createLocation(tenantId)).id,
            weekStart: new Date('2025-06-16'),
            quantity: 5,
            reason: 'because',
          },
        }),
    });
  });
});
