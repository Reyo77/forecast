import request from 'supertest';
import { kpiDelta } from '@supplycast/shared';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import {
  createBomItem,
  createCategory,
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
import {
  expectRoleAccess,
  expectTenantIsolation,
  rolesWith,
} from '../../../tests/helpers/isolation';
import { drainJobs } from '../../jobs/runner';
import { registerCoreJobHandlers } from '../../jobs/handlers';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
const ASOF = '2025-06-02';
const WEEK = 7 * 86400_000;
const weekDate = (i: number) => new Date(new Date(`${ASOF}T00:00:00Z`).getTime() + (i + 1) * WEEK);

beforeAll(() => registerCoreJobHandlers());
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

/**
 * A small hand-checkable world: finished good FG (BOM: 2 × component CMP), one location, one supplier,
 * a DONE forecast run of 8 weeks with 20 units/week of FG, stock 100 FG / 50 CMP.
 */
async function world(plan = 'pro') {
  const tenant = await createTenant({ plan });
  const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
  const food = await createCategory(tenant.id, { name: 'Food' });
  const snacks = await createCategory(tenant.id, { name: 'Snacks', parentId: food.id });
  const fg = await createProduct(tenant.id, {
    sku: 'FG',
    categoryId: snacks.id,
    unitCostCents: 200,
    unitPriceCents: 500,
  });
  const cmp = await createProduct(tenant.id, {
    sku: 'CMP',
    isComponent: true,
    unitCostCents: 20,
    unitPriceCents: 0,
  });
  const loc = await createLocation(tenant.id, { code: 'EAST' });
  const supplier = await createSupplier(tenant.id, { name: 'Acme' });
  const fgLink = await createSupplierProduct(tenant.id, supplier.id, fg.id, {
    leadTimeDays: 14,
    isPrimary: true,
  });
  const cmpLink = await createSupplierProduct(tenant.id, supplier.id, cmp.id, {
    leadTimeDays: 14,
    isPrimary: true,
  });
  await createBomItem(tenant.id, fg.id, cmp.id, 2);
  await createInventory(tenant.id, fg.id, loc.id, 100, 0);
  await createInventory(tenant.id, cmp.id, loc.id, 50, 0);
  await createSales(
    tenant.id,
    fg.id,
    loc.id,
    Array.from({ length: 26 }, (_, i) => 18 + (i % 5)),
    ASOF,
  );
  const run = await prisma.forecastRun.create({
    data: {
      tenantId: tenant.id,
      status: 'DONE',
      horizonWeeks: 8,
      method: 'AUTO',
      filters: {},
      progress: 100,
      seriesTotal: 1,
      seriesDone: 1,
      asOfWeek: new Date(ASOF),
    },
  });
  await prisma.forecastResult.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      tenantId: tenant.id,
      runId: run.id,
      productId: fg.id,
      locationId: loc.id,
      weekStart: weekDate(i),
      quantity: 20,
      lower: 15,
      upper: 25,
      modelUsed: 'naive',
    })),
  });
  return {
    tid: tenant.id,
    owner,
    h: tok(owner),
    fg,
    cmp,
    loc,
    supplier,
    fgLink,
    cmpLink,
    run,
    food,
    snacks,
  };
}

type W = Awaited<ReturnType<typeof world>>;
const create = (w: W, over: object = {}) =>
  request(app)
    .post('/scenarios')
    .set(w.h)
    .send({ name: 'Scenario A', baseForecastRunId: w.run.id, ...over });
const addLever = (w: W, id: string, lever: object) =>
  request(app).post(`/scenarios/${id}/levers`).set(w.h).send(lever);
async function runScenario(w: W, id: string) {
  const r = await request(app).post(`/scenarios/${id}/run`).set(w.h);
  expect(r.status).toBe(202);
  await drainJobs();
  return (await request(app).get(`/scenario-runs/${r.body.run.id}`).set(w.h)).body.run;
}

describe('kpiDelta (comparison math)', () => {
  it('computes absolute and percent differences with a better/worse verdict', () => {
    expect(kpiDelta('fillRate', 0.9, 0.8)).toMatchObject({ verdict: 'worse' });
    expect(kpiDelta('fillRate', 0.9, 0.95)).toMatchObject({ verdict: 'better' });
    expect(kpiDelta('stockoutWeeks', 2, 5)).toEqual({
      absolute: 3,
      percent: 150,
      verdict: 'worse',
    });
    expect(kpiDelta('revenueAtRiskCents', 1000, 400)).toEqual({
      absolute: -600,
      percent: -60,
      verdict: 'better',
    });
    expect(kpiDelta('avgInventoryValueCents', 100, 100)).toEqual({
      absolute: 0,
      percent: 0,
      verdict: 'same',
    });
    expect(kpiDelta('stockoutWeeks', 0, 2)).toEqual({
      absolute: 2,
      percent: null,
      verdict: 'worse',
    });
    expect(kpiDelta('plannedOrders', 3, 9).verdict).toBe('same'); // neutral metric
    expect(kpiDelta('totalDemand', 100, 120).verdict).toBe('same');
    expect(kpiDelta('stockoutWeeks', 0, 0)).toEqual({
      absolute: 0,
      percent: null,
      verdict: 'same',
    });
  });
});

describe('scenario CRUD', () => {
  it('creates, lists, shows, renames and deletes a scenario (audited)', async () => {
    const w = await world();
    const c = await create(w, { description: 'Main supplier is late' });
    expect(c.status).toBe(201);
    expect(c.body.scenario).toMatchObject({
      name: 'Scenario A',
      status: 'DRAFT',
      leverCount: 0,
      baseForecastRunId: w.run.id,
      description: 'Main supplier is late',
    });
    const id = c.body.scenario.id;
    expect((await request(app).get('/scenarios').set(w.h)).body.total).toBe(1);
    const detail = await request(app).get(`/scenarios/${id}`).set(w.h);
    expect(detail.body).toMatchObject({ levers: [], latestRun: null });
    expect(
      (await request(app).patch(`/scenarios/${id}`).set(w.h).send({ name: 'Renamed' })).body
        .scenario.name,
    ).toBe('Renamed');
    expect((await request(app).delete(`/scenarios/${id}`).set(w.h)).status).toBe(204);
    expect(await prisma.scenario.count()).toBe(0);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toEqual(
      expect.arrayContaining(['scenario.created', 'scenario.deleted']),
    );
  });

  it.each([
    ['empty name', { name: '' }],
    ['name too long', { name: 'x'.repeat(121) }],
    ['missing base run', { baseForecastRunId: undefined }],
  ])('400: %s', async (_l, patch) => {
    const w = await world();
    expect((await create(w, patch)).status).toBe(400);
  });

  it('the base run must exist in this tenant (404) and be finished (409)', async () => {
    const w = await world();
    const other = await createTenant();
    const foreign = await prisma.forecastRun.create({
      data: { tenantId: other.id, status: 'DONE', horizonWeeks: 4, method: 'AUTO', filters: {} },
    });
    expect((await create(w, { baseForecastRunId: foreign.id })).status).toBe(404);
    expect((await create(w, { baseForecastRunId: 'nope' })).status).toBe(404);
    const pending = await prisma.forecastRun.create({
      data: { tenantId: w.tid, status: 'RUNNING', horizonWeeks: 4, method: 'AUTO', filters: {} },
    });
    const res = await create(w, { baseForecastRunId: pending.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BASE_RUN_NOT_READY');
  });

  it('enforces the saved-scenario plan limit with 402, even under concurrency', async () => {
    const w = await world('free');
    await prisma.subscription.update({
      where: { tenantId: w.tid },
      data: { customLimits: { scenarios: 3 } },
    });
    const res = await Promise.all(
      Array.from({ length: 7 }, (_, i) => create(w, { name: `S${i}` })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    const blocked = res.find((r) => r.status === 402)!;
    expect(blocked.body.error.details).toMatchObject({ metric: 'scenarios', limit: 3, current: 3 });
    expect(await prisma.scenario.count()).toBe(3);
    // deleting frees a slot
    await request(app)
      .delete(`/scenarios/${res.find((r) => r.status === 201)!.body.scenario.id}`)
      .set(w.h);
    expect((await create(w, { name: 'again' })).status).toBe(201);
  });

  it('roles and tenant isolation', async () => {
    const t = await createTenant();
    const run = await prisma.forecastRun.create({
      data: { tenantId: t.id, status: 'DONE', horizonWeeks: 4, method: 'AUTO', filters: {} },
    });
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/scenarios',
      allowed: rolesWith('scenario:read'),
    });
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/scenarios',
      body: { name: 'x', baseForecastRunId: run.id },
      allowed: rolesWith('scenario:write'),
      roles: ['PLANNER', 'VIEWER'],
    });
    const make = (tenantId: string) =>
      prisma.forecastRun
        .create({
          data: { tenantId, status: 'DONE', horizonWeeks: 4, method: 'AUTO', filters: {} },
        })
        .then((r) =>
          prisma.scenario.create({ data: { tenantId, name: 'iso', baseForecastRunId: r.id } }),
        );
    for (const [method, suffix, body] of [
      ['get', '', undefined],
      ['patch', '', { name: 'x' }],
      ['delete', '', undefined],
      ['post', '/run', undefined],
      ['get', '/runs', undefined],
      ['post', '/levers', { type: 'SERVICE_LEVEL', params: { serviceLevel: 0.9 } }],
    ] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/scenarios/${id}${suffix}`,
        body: body as Record<string, unknown> | undefined,
        createResource: make,
      });
    }
  });
});

describe('levers', () => {
  const valid = (w: W) => ({
    demand: {
      type: 'DEMAND_CHANGE',
      target: { scope: 'CATEGORY', id: w.snacks.id },
      params: { percent: 20, startDate: '2025-06-09', endDate: '2025-07-06' },
    },
    delay: {
      type: 'SUPPLIER_DELAY',
      target: { supplierId: w.supplier.id },
      params: { extraDays: 21 },
    },
    lead: {
      type: 'LEAD_TIME_CHANGE',
      target: { supplierProductId: w.fgLink.id },
      params: { leadTimeDays: 35 },
    },
    cap: {
      type: 'CAPACITY_CAP',
      target: { supplierId: w.supplier.id },
      params: { weeklyQuantity: 15 },
    },
    service: { type: 'SERVICE_LEVEL', params: { serviceLevel: 0.99 } },
    price: {
      type: 'PRICE_CHANGE',
      target: { scope: 'PRODUCT', id: w.fg.id },
      params: { percent: 10, elasticity: 1.5 },
    },
  });

  it('accepts every lever type and describes it in plain English', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    const summaries: Record<string, string> = {};
    for (const [name, lever] of Object.entries(valid(w))) {
      const res = await addLever(w, id, lever);
      expect(res.status).toBe(201);
      summaries[name] = res.body.lever.summary;
    }
    expect(summaries.demand).toBe(
      'Demand change: Demand +20% for category Snacks (2025-06-09 → 2025-07-06)',
    );
    expect(summaries.delay).toBe('Supplier delay: Acme is 21 days late');
    expect(summaries.lead).toBe('Lead time change: Lead time becomes 35 days (Acme / FG)');
    expect(summaries.cap).toBe('Capacity cap: Acme capped at 15 units/week');
    expect(summaries.service).toBe('Service level: Target service level 99.0%');
    expect(summaries.price).toBe('Price change: Price +10% for product FG (elasticity 1.5)');
    const detail = await request(app).get(`/scenarios/${id}`).set(w.h);
    expect(detail.body.levers).toHaveLength(6);
    expect(detail.body.scenario.leverCount).toBe(6);
  });

  it.each([
    ['demand below −100%', (w: W) => ({ ...valid(w).demand, params: { percent: -101 } })],
    ['demand above +1000%', (w: W) => ({ ...valid(w).demand, params: { percent: 1001 } })],
    [
      'end date before start',
      (w: W) => ({
        ...valid(w).demand,
        params: { percent: 5, startDate: '2025-07-01', endDate: '2025-06-01' },
      }),
    ],
    ['bad date', (w: W) => ({ ...valid(w).demand, params: { percent: 5, startDate: 'whenever' } })],
    [
      'category scope without id',
      (w: W) => ({ ...valid(w).demand, target: { scope: 'CATEGORY' } }),
    ],
    ['unknown scope', (w: W) => ({ ...valid(w).demand, target: { scope: 'GALAXY', id: 'x' } })],
    ['delay of 0 days', (w: W) => ({ ...valid(w).delay, params: { extraDays: 0 } })],
    ['delay over 365 days', (w: W) => ({ ...valid(w).delay, params: { extraDays: 366 } })],
    ['fractional delay', (w: W) => ({ ...valid(w).delay, params: { extraDays: 2.5 } })],
    ['delay without supplier', (w: W) => ({ ...valid(w).delay, target: {} })],
    ['lead time 0', (w: W) => ({ ...valid(w).lead, params: { leadTimeDays: 0 } })],
    ['lead time 366', (w: W) => ({ ...valid(w).lead, params: { leadTimeDays: 366 } })],
    ['capacity 0', (w: W) => ({ ...valid(w).cap, params: { weeklyQuantity: 0 } })],
    ['negative capacity', (w: W) => ({ ...valid(w).cap, params: { weeklyQuantity: -5 } })],
    ['service level 0.4', (w: W) => ({ ...valid(w).service, params: { serviceLevel: 0.4 } })],
    ['service level 1', (w: W) => ({ ...valid(w).service, params: { serviceLevel: 1 } })],
    [
      'price drop beyond −90%',
      (w: W) => ({ ...valid(w).price, params: { percent: -95, elasticity: 1 } }),
    ],
    [
      'elasticity above 5',
      (w: W) => ({ ...valid(w).price, params: { percent: 5, elasticity: 6 } }),
    ],
    ['unknown lever type', () => ({ type: 'MAGIC', target: {}, params: {} })],
    [
      'missing params',
      (w: W) => ({ type: 'SUPPLIER_DELAY', target: { supplierId: w.supplier.id } }),
    ],
  ])('400: %s', async (_l, build) => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    const res = await addLever(w, id, build(w));
    expect(res.status).toBe(400);
    expect(await prisma.scenarioLever.count()).toBe(0);
  });

  it('boundary values are accepted (lead time 1 and 365, delay 365, service level 0.5 and 0.999, −100% demand)', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    for (const lever of [
      { ...valid(w).lead, params: { leadTimeDays: 1 } },
      { ...valid(w).lead, params: { leadTimeDays: 365 } },
      { ...valid(w).delay, params: { extraDays: 365 } },
      { ...valid(w).service, params: { serviceLevel: 0.5 } },
      { ...valid(w).service, params: { serviceLevel: 0.999 } },
      { ...valid(w).demand, params: { percent: -100 } },
    ])
      expect((await addLever(w, id, lever)).status).toBe(201);
  });

  it('rejects levers that point at another tenant’s product, category, location, supplier or supplier link (404)', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    const o = await createTenant();
    const [op, oc, ol, os] = [
      await createProduct(o.id),
      await createCategory(o.id),
      await createLocation(o.id),
      await createSupplier(o.id),
    ];
    const olink = await createSupplierProduct(o.id, os.id, op.id);
    for (const lever of [
      { type: 'DEMAND_CHANGE', target: { scope: 'PRODUCT', id: op.id }, params: { percent: 5 } },
      { type: 'DEMAND_CHANGE', target: { scope: 'CATEGORY', id: oc.id }, params: { percent: 5 } },
      { type: 'DEMAND_CHANGE', target: { scope: 'LOCATION', id: ol.id }, params: { percent: 5 } },
      {
        type: 'PRICE_CHANGE',
        target: { scope: 'PRODUCT', id: op.id },
        params: { percent: 5, elasticity: 1 },
      },
      { type: 'SUPPLIER_DELAY', target: { supplierId: os.id }, params: { extraDays: 7 } },
      { type: 'CAPACITY_CAP', target: { supplierId: os.id }, params: { weeklyQuantity: 5 } },
      {
        type: 'LEAD_TIME_CHANGE',
        target: { supplierProductId: olink.id },
        params: { leadTimeDays: 5 },
      },
    ]) {
      const res = await addLever(w, id, lever);
      expect(res.status).toBe(404);
    }
    expect(await prisma.scenarioLever.count()).toBe(0);
  });

  it('an ALL-scope demand change and a service-level lever need no ids', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    expect(
      (
        await addLever(w, id, {
          type: 'DEMAND_CHANGE',
          target: { scope: 'ALL' },
          params: { percent: 10 },
        })
      ).status,
    ).toBe(201);
  });

  it('edits and deletes levers; any change returns the scenario to DRAFT', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    const lever = (await addLever(w, id, valid(w).delay)).body.lever;
    await runScenario(w, id);
    expect((await request(app).get(`/scenarios/${id}`).set(w.h)).body.scenario.status).toBe(
      'READY',
    );
    const upd = await request(app)
      .patch(`/scenarios/${id}/levers/${lever.id}`)
      .set(w.h)
      .send({ ...valid(w).delay, params: { extraDays: 14 } });
    expect(upd.body.lever.summary).toMatch(/14 days late/);
    expect((await request(app).get(`/scenarios/${id}`).set(w.h)).body.scenario.status).toBe(
      'DRAFT',
    );
    expect(
      (
        await request(app)
          .patch(`/scenarios/${id}/levers/${lever.id}`)
          .set(w.h)
          .send({
            type: 'SUPPLIER_DELAY',
            target: { supplierId: w.supplier.id },
            params: { extraDays: 0 },
          })
      ).status,
    ).toBe(400);
    expect((await request(app).delete(`/scenarios/${id}/levers/${lever.id}`).set(w.h)).status).toBe(
      204,
    );
    expect((await request(app).delete(`/scenarios/${id}/levers/${lever.id}`).set(w.h)).status).toBe(
      404,
    );
  });

  it('a scenario holds at most 20 levers', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    for (let i = 0; i < 20; i++) expect((await addLever(w, id, valid(w).service)).status).toBe(201);
    const res = await addLever(w, id, valid(w).service);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TOO_MANY_LEVERS');
  });

  it('lever roles and isolation (patch/delete of another tenant’s lever is a 404)', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    await expectRoleAccess({
      app,
      method: 'post',
      path: `/scenarios/${id}/levers`,
      body: valid(w).service,
      allowed: rolesWith('scenario:write'),
      roles: ['PLANNER', 'VIEWER'],
    });
    const lever = (await addLever(w, id, valid(w).service)).body.lever;
    const intruder = await createUser({ role: 'OWNER' });
    for (const method of ['patch', 'delete'] as const) {
      const res = await request(app)
        [method](`/scenarios/${id}/levers/${lever.id}`)
        .set(tok(intruder))
        .send(valid(w).service);
      expect(res.status).toBe(404);
    }
  });
});

describe('scenario engine run (background job)', () => {
  it('without levers the scenario equals the baseline; BOM demand and stock flow through', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    const run = await runScenario(w, id);
    expect(run.status).toBe('DONE');
    expect(run.kpis.scenario).toEqual(run.kpis.baseline);
    // FG: 8 weeks × 20 = 160 demand; CMP: 2 per FG → 320. Both nodes are planned.
    expect(run.kpis.baseline.totalDemand).toBe(480);
    // 2 nodes × 8 weeks × 2 variants
    expect(await prisma.scenarioResult.count({ where: { scenarioRunId: run.id } })).toBe(32);
    const cmpRows = await prisma.scenarioResult.findMany({
      where: { scenarioRunId: run.id, variant: 'BASELINE', productId: w.cmp.id },
      orderBy: { weekStart: 'asc' },
    });
    expect(cmpRows.map((r) => Number(r.demand))).toEqual(Array(8).fill(40));
    expect(Number(cmpRows[0]!.projectedOnHand)).toBe(10); // 50 − 40
    expect((await request(app).get(`/scenarios/${id}`).set(w.h)).body.scenario.status).toBe(
      'READY',
    );
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
      'scenario.run_started',
    );
  });

  it('a 3-week supplier delay shifts receipts and creates stockouts the baseline does not have', async () => {
    const w = await world();
    // Baseline: FG has 100 on hand, demand 20/wk → short only if orders do not arrive in time.
    await createOpenOrder(w.tid, w.fg.id, w.loc.id, {
      quantity: 200,
      expectedDate: weekDate(4),
      supplierId: w.supplier.id,
    });
    const id = (await create(w)).body.scenario.id;
    await addLever(w, id, {
      type: 'SUPPLIER_DELAY',
      target: { supplierId: w.supplier.id },
      params: { extraDays: 21 },
    });
    const run = await runScenario(w, id);
    expect(run.kpis.baseline.stockoutWeeks).toBeLessThanOrEqual(run.kpis.scenario.stockoutWeeks);
    expect(run.kpis.scenario.totalShortage).toBeGreaterThan(run.kpis.baseline.totalShortage);
    expect(run.kpis.scenario.fillRate).toBeLessThan(run.kpis.baseline.fillRate);
    const fgBase = await prisma.scenarioResult.findMany({
      where: { scenarioRunId: run.id, variant: 'BASELINE', productId: w.fg.id },
      orderBy: { weekStart: 'asc' },
    });
    const fgScn = await prisma.scenarioResult.findMany({
      where: { scenarioRunId: run.id, variant: 'SCENARIO', productId: w.fg.id },
      orderBy: { weekStart: 'asc' },
    });
    expect(Number(fgBase[4]!.receipts)).toBeGreaterThanOrEqual(200); // open order arrives in week 4
    expect(Number(fgScn[4]!.receipts)).toBeLessThan(200); // delayed …
    expect(Number(fgScn[7]!.receipts)).toBeGreaterThanOrEqual(200); // … by exactly 3 weeks
    expect(run.atRisk.scenario.length).toBeGreaterThan(0);
    expect(run.atRisk.scenario[0]).toMatchObject({
      productSku: expect.any(String),
      locationCode: 'EAST',
      firstStockoutDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('a demand surge in a date range raises demand only in that range (category scope reaches the product and its BOM components)', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    await addLever(w, id, {
      type: 'DEMAND_CHANGE',
      target: { scope: 'CATEGORY', id: w.food.id },
      params: { percent: 50, startDate: '2025-06-23', endDate: '2025-07-06' },
    });
    const run = await runScenario(w, id);
    const rows = await prisma.scenarioResult.findMany({
      where: { scenarioRunId: run.id, variant: 'SCENARIO', productId: w.fg.id },
      orderBy: { weekStart: 'asc' },
    });
    expect(rows.map((r) => Number(r.demand))).toEqual([20, 20, 30, 30, 20, 20, 20, 20]); // weeks of Jun 23 and Jun 30
    const cmp = await prisma.scenarioResult.findMany({
      where: { scenarioRunId: run.id, variant: 'SCENARIO', productId: w.cmp.id },
      orderBy: { weekStart: 'asc' },
    });
    expect(cmp.map((r) => Number(r.demand))).toEqual([40, 40, 60, 60, 40, 40, 40, 40]);
    expect(run.kpis.scenario.totalDemand).toBeGreaterThan(run.kpis.baseline.totalDemand);
    expect(run.kpis.baseline.totalDemand).toBe(480);
  });

  it('a lead-time change moves planned arrivals; a higher service level raises planned orders', async () => {
    const w = await world();
    const a = (await create(w, { name: 'lead' })).body.scenario.id;
    await addLever(w, a, {
      type: 'LEAD_TIME_CHANGE',
      target: { supplierProductId: w.fgLink.id },
      params: { leadTimeDays: 56 },
    });
    const ra = await runScenario(w, a);
    expect(ra.kpis.scenario.totalShortage).toBeGreaterThanOrEqual(ra.kpis.baseline.totalShortage);
    const b = (await create(w, { name: 'service' })).body.scenario.id;
    await addLever(w, b, { type: 'SERVICE_LEVEL', params: { serviceLevel: 0.999 } });
    const rb = await runScenario(w, b);
    expect(rb.kpis.scenario.avgInventoryValueCents).toBeGreaterThanOrEqual(
      rb.kpis.baseline.avgInventoryValueCents,
    );
    expect(rb.kpis.scenario.plannedOrders).toBeGreaterThanOrEqual(rb.kpis.baseline.plannedOrders);
  });

  it('a capacity cap limits weekly receipts; a price rise lowers demand and raises revenue at risk per unit', async () => {
    const w = await world();
    await prisma.inventoryLevel.updateMany({ where: { productId: w.fg.id }, data: { onHand: 0 } });
    const cap = (await create(w, { name: 'cap' })).body.scenario.id;
    await addLever(w, cap, {
      type: 'CAPACITY_CAP',
      target: { supplierId: w.supplier.id },
      params: { weeklyQuantity: 5 },
    });
    const rc = await runScenario(w, cap);
    const rows = await prisma.scenarioResult.findMany({
      where: { scenarioRunId: rc.id, variant: 'SCENARIO', productId: w.fg.id },
    });
    for (const r of rows) expect(Number(r.receipts)).toBeLessThanOrEqual(5 + 1e-9);
    expect(rc.kpis.scenario.totalShortage).toBeGreaterThan(rc.kpis.baseline.totalShortage);

    const price = (await create(w, { name: 'price' })).body.scenario.id;
    await addLever(w, price, {
      type: 'PRICE_CHANGE',
      target: { scope: 'PRODUCT', id: w.fg.id },
      params: { percent: 20, elasticity: 1 },
    });
    const rp = await runScenario(w, price);
    const fgDemand = (
      await prisma.scenarioResult.findMany({
        where: { scenarioRunId: rp.id, variant: 'SCENARIO', productId: w.fg.id },
      })
    ).map((r) => Number(r.demand));
    expect(fgDemand.every((d) => Math.abs(d - 16) < 1e-9)).toBe(true); // −20%
  });

  it('planner overrides replace the model forecast in the plan', async () => {
    const w = await world();
    await prisma.forecastOverride.create({
      data: {
        tenantId: w.tid,
        productId: w.fg.id,
        locationId: w.loc.id,
        weekStart: weekDate(1),
        quantity: 500,
        reason: 'Big order',
      },
    });
    const id = (await create(w)).body.scenario.id;
    const run = await runScenario(w, id);
    const rows = await prisma.scenarioResult.findMany({
      where: { scenarioRunId: run.id, variant: 'BASELINE', productId: w.fg.id },
      orderBy: { weekStart: 'asc' },
    });
    expect(Number(rows[1]!.demand)).toBe(500);
    expect(Number(rows[0]!.demand)).toBe(20);
  });

  it('the same inputs always give the same results (deterministic)', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    await addLever(w, id, {
      type: 'SUPPLIER_DELAY',
      target: { supplierId: w.supplier.id },
      params: { extraDays: 14 },
    });
    const r1 = await runScenario(w, id);
    const r2 = await runScenario(w, id);
    expect(r2.kpis).toEqual(r1.kpis);
    expect(r2.atRisk).toEqual(r1.atRisk);
    expect(r2.id).not.toBe(r1.id);
    expect((await request(app).get(`/scenarios/${id}/runs`).set(w.h)).body.total).toBe(2);
  });

  it('levers are snapshotted on the run so later edits do not rewrite history', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    const lever = (
      await addLever(w, id, {
        type: 'SUPPLIER_DELAY',
        target: { supplierId: w.supplier.id },
        params: { extraDays: 14 },
      })
    ).body.lever;
    const run = await runScenario(w, id);
    await request(app).delete(`/scenarios/${id}/levers/${lever.id}`).set(w.h);
    const again = (await request(app).get(`/scenario-runs/${run.id}`).set(w.h)).body.run;
    expect(again.levers).toHaveLength(1);
    expect(again.levers[0].summary).toMatch(/14 days late/);
  });

  it('fails cleanly when the base forecast has no results, and the error is visible', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    await prisma.forecastResult.deleteMany({});
    const r = await request(app).post(`/scenarios/${id}/run`).set(w.h);
    for (let i = 0; i < 4; i++) await drainJobs(new Date(Date.now() + (i + 1) * 86400_000));
    const run = (await request(app).get(`/scenario-runs/${r.body.run.id}`).set(w.h)).body.run;
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/no results/);
    expect((await request(app).get(`/scenarios/${id}`).set(w.h)).body.scenario.status).toBe(
      'FAILED',
    );
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'scenario.run' } })).status).toBe(
      'FAILED',
    );
  });

  it('run roles and 409 when the base run is not ready', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    await expectRoleAccess({
      app,
      method: 'post',
      path: `/scenarios/${id}/run`,
      allowed: rolesWith('scenario:write'),
      roles: ['PLANNER', 'VIEWER'],
    });
    await prisma.forecastRun.update({ where: { id: w.run.id }, data: { status: 'FAILED' } });
    expect((await request(app).post(`/scenarios/${id}/run`).set(w.h)).status).toBe(409);
  });

  it('run detail, per-product series and tenant isolation', async () => {
    const w = await world();
    const id = (await create(w)).body.scenario.id;
    const run = await runScenario(w, id);
    expect(run.totals.baseline).toHaveLength(8);
    expect(run.totals.baseline[0]).toMatchObject({ weekStart: '2025-06-09', demand: 60 }); // FG 20 + CMP 40
    const series = (
      await request(app).get(`/scenario-runs/${run.id}/series?productId=${w.fg.id}`).set(w.h)
    ).body;
    expect(series.product.sku).toBe('FG');
    expect(series.weeks).toHaveLength(8);
    expect(series.weeks[0].baseline).toMatchObject({ demand: 20, onHand: 80, shortage: 0 });
    expect(
      (await request(app).get(`/scenario-runs/${run.id}/series?productId=nope`).set(w.h)).status,
    ).toBe(404);
    expect((await request(app).get(`/scenario-runs/${run.id}/series`).set(w.h)).status).toBe(400);
    const intruder = await createUser({ role: 'OWNER' });
    for (const path of [
      `/scenario-runs/${run.id}`,
      `/scenario-runs/${run.id}/series?productId=${w.fg.id}`,
    ]) {
      expect((await request(app).get(path).set(tok(intruder))).status).toBe(404);
    }
    await expectRoleAccess({
      app,
      method: 'get',
      path: `/scenario-runs/${run.id}`,
      allowed: rolesWith('scenario:read'),
      roles: ['VIEWER', 'PLANNER'],
    });
  });
});

describe('scenario comparison', () => {
  async function two(w: W) {
    const a = (await create(w, { name: 'Late supplier' })).body.scenario.id;
    await addLever(w, a, {
      type: 'SUPPLIER_DELAY',
      target: { supplierId: w.supplier.id },
      params: { extraDays: 28 },
    });
    const b = (await create(w, { name: 'Demand up' })).body.scenario.id;
    await addLever(w, b, {
      type: 'DEMAND_CHANGE',
      target: { scope: 'ALL' },
      params: { percent: 40 },
    });
    await runScenario(w, a);
    await runScenario(w, b);
    return { a, b };
  }

  it('returns the baseline once and each scenario’s KPIs, at-risk list and weekly totals', async () => {
    const w = await world();
    const { a, b } = await two(w);
    const res = await request(app).get(`/scenarios/compare?ids=${a},${b}`).set(w.h);
    expect(res.status).toBe(200);
    expect(res.body.baseline.kpis).toBeDefined();
    expect(res.body.scenarios.map((s: { name: string }) => s.name)).toEqual([
      'Late supplier',
      'Demand up',
    ]);
    const [late, up] = res.body.scenarios;
    expect(up.kpis.totalDemand).toBeGreaterThan(res.body.baseline.kpis.totalDemand);
    expect(late.kpis.totalDemand).toBe(res.body.baseline.kpis.totalDemand);
    expect(late.totals).toHaveLength(8);
    expect(late.levers[0].summary).toMatch(/28 days late/);
    expect(Array.isArray(up.atRisk)).toBe(true);
  });

  it('1 to 3 distinct scenarios, all run, on the same base forecast', async () => {
    const w = await world();
    const { a, b } = await two(w);
    expect((await request(app).get(`/scenarios/compare?ids=${a}`).set(w.h)).status).toBe(200);
    expect(
      (await request(app).get(`/scenarios/compare?ids=${a},${a}`).set(w.h)).body.error.code,
    ).toBe('DUPLICATE_IDS');
    expect((await request(app).get('/scenarios/compare').set(w.h)).status).toBe(400);
    const c = (await create(w, { name: 'c' })).body.scenario.id;
    const notRun = await request(app).get(`/scenarios/compare?ids=${a},${c}`).set(w.h);
    expect(notRun.status).toBe(409);
    expect(notRun.body.error.code).toBe('NOT_RUN');
    await runScenario(w, c);
    const d = (await create(w, { name: 'd' })).body.scenario.id;
    await runScenario(w, d);
    const four = await request(app).get(`/scenarios/compare?ids=${a},${b},${c},${d}`).set(w.h);
    expect(four.status).toBe(400);
    expect(four.body.error.code).toBe('TOO_MANY');
    expect((await request(app).get(`/scenarios/compare?ids=${a},${b},${c}`).set(w.h)).status).toBe(
      200,
    );
  });

  it('refuses scenarios built on different base forecast runs', async () => {
    const w = await world();
    const { a } = await two(w);
    const run2 = await prisma.forecastRun.create({
      data: {
        tenantId: w.tid,
        status: 'DONE',
        horizonWeeks: 8,
        method: 'AUTO',
        filters: {},
        asOfWeek: new Date(ASOF),
      },
    });
    await prisma.forecastResult.createMany({
      data: Array.from({ length: 8 }, (_, i) => ({
        tenantId: w.tid,
        runId: run2.id,
        productId: w.fg.id,
        locationId: w.loc.id,
        weekStart: weekDate(i),
        quantity: 10,
        lower: 5,
        upper: 15,
        modelUsed: 'naive',
      })),
    });
    const other = (await create(w, { name: 'other base', baseForecastRunId: run2.id })).body
      .scenario.id;
    await runScenario(w, other);
    const res = await request(app).get(`/scenarios/compare?ids=${a},${other}`).set(w.h);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DIFFERENT_BASE');
  });

  it('cannot compare another tenant’s scenarios (404) and Viewers can read comparisons', async () => {
    const w = await world();
    const { a } = await two(w);
    const intruder = await createUser({ role: 'OWNER' });
    expect((await request(app).get(`/scenarios/compare?ids=${a}`).set(tok(intruder))).status).toBe(
      404,
    );
    await expectRoleAccess({
      app,
      method: 'get',
      path: `/scenarios/compare?ids=${a}`,
      allowed: rolesWith('scenario:read'),
      roles: ['VIEWER'],
    });
  });
});
