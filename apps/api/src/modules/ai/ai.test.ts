import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../../app';
import { FakeAiClient } from '../../ai/fake';
import { UnconfiguredAiClient } from '../../ai/gemini';
import { logger } from '../../config/logger';
import { prisma } from '../../db/client';
import { scoped } from '../../db/scoped';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import {
  createInventory,
  createLocation,
  createOpenOrder,
  createProduct,
  createSales,
  createSupplier,
  createSupplierProduct,
  createCategory,
  createTenant,
  createUser,
} from '../../../tests/factories';
import { expectRoleAccess, rolesWith } from '../../../tests/helpers/isolation';
import { currentUsage } from '../billing/limits';
import { extractJson } from './service';
import { buildForecastSummary, buildRiskSummary, seasonality, trendPctPerWeek } from './context';
import { aiScenarioSchema, resolveAiLever, type Lookups } from './routes';
import { executeTool, TOOL_NAMES, toolDeclarations } from './tools';

const ASOF = '2025-06-02';
const WEEK = 7 * 86400_000;
const weekDate = (i: number) => new Date(new Date(`${ASOF}T00:00:00Z`).getTime() + (i + 1) * WEEK);
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));

const fake = new FakeAiClient();
let app = makeApp();
function makeApp(timeoutMs = 2000) {
  return createApp(
    { APP_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'test-access-secret' },
    { loginRateLimitMax: 1_000_000, aiClient: fake, aiTimeoutMs: timeoutMs },
  );
}

beforeEach(async () => {
  await resetDb();
  fake.requests.length = 0;
  fake.delayMs = 0;
  (fake as unknown as { queue: unknown[] }).queue.length = 0;
  app = makeApp();
});
afterAll(() => prisma.$disconnect());

const explainOk = {
  explanation: 'Demand is rising steadily.',
  drivers: ['Upward trend', 'Seasonality'],
  confidence: 'MEDIUM',
  caveats: ['Short history'],
};
const riskOk = {
  summary: 'Fill rate drops sharply.',
  severity: 'HIGH',
  actions: ['Expedite orders', 'Raise safety stock', 'Find an alternate supplier'],
};

async function world(plan = 'pro') {
  const tenant = await createTenant({ plan, name: 'Secret Company Name Ltd' });
  const owner = await createUser({
    role: 'OWNER',
    tenantId: tenant.id,
    email: 'owner.private@secret-domain.test',
  });
  const cat = await createCategory(tenant.id, { name: 'Snacks' });
  const p = await createProduct(tenant.id, {
    sku: 'SKU-AI',
    name: 'Widget',
    categoryId: cat.id,
    unitPriceCents: 500,
  });
  const loc = await createLocation(tenant.id, { code: 'EAST' });
  const supplier = await createSupplier(tenant.id, { name: 'Acme Supplies' });
  const link = await createSupplierProduct(tenant.id, supplier.id, p.id, { isPrimary: true });
  await createSales(
    tenant.id,
    p.id,
    loc.id,
    Array.from({ length: 60 }, (_, i) => 100 + i),
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
      productId: p.id,
      locationId: loc.id,
      weekStart: weekDate(i),
      quantity: 160 + i,
      lower: 140,
      upper: 180,
      modelUsed: 'holt',
    })),
  });
  await prisma.forecastAccuracy.create({
    data: {
      tenantId: tenant.id,
      runId: run.id,
      productId: p.id,
      locationId: loc.id,
      modelUsed: 'holt',
      reason: 'backtest',
      holdout: 12,
      mape: 0.08,
      wape: 0.07,
      bias: -0.01,
    },
  });
  return { tid: tenant.id, owner, h: tok(owner), cat, p, loc, supplier, link, run };
}
type W = Awaited<ReturnType<typeof world>>;
const explain = (w: W, body: object = {}) =>
  request(app)
    .post('/ai/explain-forecast')
    .set(w.h)
    .send({ runId: w.run.id, productId: w.p.id, locationId: w.loc.id, ...body });

describe('7.1 AI service layer', () => {
  it('returns validated structured output, records an AiRequest and charges one request', async () => {
    const w = await world();
    fake.enqueue({ text: JSON.stringify(explainOk), inputTokens: 321, outputTokens: 45 });
    const res = await explain(w);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: { ...explainOk }, cached: false });
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(1);
    const row = await prisma.aiRequest.findFirstOrThrow();
    expect(row).toMatchObject({
      tenantId: w.tid,
      userId: w.owner.id,
      feature: 'explain_forecast',
      status: 'OK',
      inputTokens: 321,
      outputTokens: 45,
    });
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fake.requests[0]!.json).toBe(true);
    expect(fake.requests[0]!.system).toMatch(/JSON/);
  });

  it('accepts JSON wrapped in a markdown fence or extra prose', async () => {
    const w = await world();
    fake.enqueue({ text: 'Sure! ```json\n' + JSON.stringify(explainOk) + '\n```' });
    expect((await explain(w)).status).toBe(200);
  });

  it('retries once on invalid JSON, telling the model what was wrong; tokens add up; charged once', async () => {
    const w = await world();
    fake.enqueue(
      { text: 'not json at all', inputTokens: 100, outputTokens: 10 },
      { text: JSON.stringify(explainOk), inputTokens: 150, outputTokens: 30 },
    );
    const res = await explain(w);
    expect(res.status).toBe(200);
    expect(fake.requests).toHaveLength(2);
    const retry = fake.requests[1]!.messages;
    expect(retry.at(-1)!.role).toBe('user');
    expect(JSON.stringify(retry.at(-1))).toMatch(/not valid for the required JSON shape/);
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(1);
    expect(await prisma.aiRequest.count()).toBe(1);
    expect(await prisma.aiRequest.findFirstOrThrow()).toMatchObject({
      inputTokens: 250,
      outputTokens: 40,
      status: 'OK',
    });
  });

  it('also retries when the JSON parses but fails the schema (e.g. confidence out of range, too many drivers)', async () => {
    const w = await world();
    fake.enqueue(
      { text: JSON.stringify({ ...explainOk, confidence: 'CERTAIN' }) },
      { text: JSON.stringify({ ...explainOk, drivers: ['a', 'b', 'c', 'd', 'e', 'f'] }) },
    );
    const res = await explain(w);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('AI_INVALID_RESPONSE');
    expect(fake.requests).toHaveLength(2);
  });

  it('after two invalid answers returns a friendly error, records INVALID_OUTPUT and does not charge usage', async () => {
    const w = await world();
    fake.enqueue({ text: '{"explanation": 5}' }, { text: 'still nope' });
    const res = await explain(w);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/unexpected format/);
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(0);
    expect(await prisma.aiRequest.findFirstOrThrow()).toMatchObject({ status: 'INVALID_OUTPUT' });
    expect(await prisma.aiInsight.count()).toBe(0);
  });

  it('times out after the configured limit with a friendly 504, releasing the usage', async () => {
    app = makeApp(80);
    const w = await world();
    fake.delayMs = 400;
    fake.enqueue({ text: JSON.stringify(explainOk) });
    const res = await explain(w);
    expect(res.status).toBe(504);
    expect(res.body.error).toMatchObject({
      code: 'AI_TIMEOUT',
      message: expect.stringMatching(/took too long/),
    });
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(0);
    expect(await prisma.aiRequest.findFirstOrThrow()).toMatchObject({ status: 'TIMEOUT' });
  });

  it('hides provider errors behind a friendly message and does not charge', async () => {
    const w = await world();
    fake.enqueue(new Error('429 quota exceeded for key AIza-SECRET-KEY'));
    const res = await explain(w);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('AI_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/AIza|quota/);
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(0);
    expect(await prisma.aiRequest.findFirstOrThrow()).toMatchObject({ status: 'ERROR' });
  });

  it('503 when no AI backend is configured', async () => {
    const unconfigured = createApp(
      { APP_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'test-access-secret' },
      { aiClient: new UnconfiguredAiClient() },
    );
    const w = await world();
    const res = await request(unconfigured)
      .post('/ai/explain-forecast')
      .set(w.h)
      .send({ runId: w.run.id, productId: w.p.id });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
  });

  it('enforces the plan’s AI limit with 402 before any model call, and concurrent requests never exceed it', async () => {
    const w = await world('free');
    await prisma.subscription.update({
      where: { tenantId: w.tid },
      data: { customLimits: { aiRequests: 3 } },
    });
    const products = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        createProduct(w.tid, { sku: `P${i}` }).then(async (p) => {
          await prisma.forecastResult.create({
            data: {
              tenantId: w.tid,
              runId: w.run.id,
              productId: p.id,
              locationId: w.loc.id,
              weekStart: weekDate(0),
              quantity: 1,
              lower: 0,
              upper: 2,
              modelUsed: 'naive',
            },
          });
          return p;
        }),
      ),
    );
    for (let i = 0; i < 20; i++) fake.enqueue({ text: JSON.stringify(explainOk) });
    const res = await Promise.all(products.map((p) => explain(w, { productId: p.id })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(3);
    const blocked = res.find((r) => r.status === 402)!;
    expect(blocked.body.error).toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      details: { metric: 'aiRequests', limit: 3 },
    });
    expect(fake.requests).toHaveLength(3); // blocked requests never reached the model
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(3);
  });

  it('never logs prompts, product data or API keys', async () => {
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(logger, m));
    const w = await world();
    await prisma.product.update({
      where: { id: w.p.id },
      data: { name: 'ULTRA-SECRET-PRODUCT-NAME' },
    });
    fake.enqueue({ text: 'bad' }, { text: 'bad again' });
    await explain(w);
    fake.enqueue(new Error('boom AIzaSyFAKEKEY123'));
    await explain(w);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain('ULTRA-SECRET-PRODUCT-NAME');
    expect(logged).not.toContain('AIzaSyFAKEKEY123');
    expect(logged).not.toMatch(/Forecast summary/);
    expect(logged).toContain('explain_forecast'); // metadata only
    spies.forEach((s) => s.mockRestore());
  });

  it('no test file may import the real Gemini client or the Google SDK', () => {
    const roots = [path.resolve(__dirname, '../../'), path.resolve(__dirname, '../../../tests')];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.test\.ts$|\/tests\/.*\.ts$/.test(p) && !p.endsWith('ai.test.ts')) {
          const src = fs.readFileSync(p, 'utf8');
          if (/from ['"][^'"]*ai\/gemini['"]/.test(src) || /@google\/genai/.test(src))
            offenders.push(p);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it('extractJson handles fences, prose and rejects garbage', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go: {"a":3} hope that helps')).toEqual({ a: 3 });
    expect(() => extractJson('nothing here')).toThrow();
  });
});

describe('7.2 forecast explanation', () => {
  it('builds a compact, PII-free summary prompt from aggregated numbers', async () => {
    const w = await world();
    await createUser({
      role: 'PLANNER',
      tenantId: w.tid,
      email: 'planner.private@secret-domain.test',
    });
    fake.enqueue({ text: JSON.stringify(explainOk) });
    await explain(w);
    const prompt = JSON.stringify(fake.requests[0]!.messages) + (fake.requests[0]!.system ?? '');
    expect(prompt).toContain('SKU-AI');
    expect(prompt).toContain('holt');
    expect(prompt).toContain('wapePct');
    for (const secret of [
      'secret-domain.test',
      'Secret Company Name',
      w.owner.email,
      w.tid,
      w.p.id,
      w.run.id,
    ])
      expect(prompt).not.toContain(secret);
    expect(prompt.length).toBeLessThan(4000); // compact
    const summaryJson =
      /Forecast summary:\\n(.*?)"\}\]/.exec(JSON.stringify(fake.requests[0]!.messages))?.[1] ?? '';
    expect(summaryJson).toMatch(/recentWeeklyUnits/);
  });

  it('caches per run + product + location so repeated clicks use no quota or model calls', async () => {
    const w = await world();
    fake.enqueue({ text: JSON.stringify(explainOk) });
    const first = await explain(w);
    const second = await explain(w);
    const third = await explain(w);
    expect(first.body.cached).toBe(false);
    expect(second.body).toEqual({ result: explainOk, cached: true });
    expect(third.body.cached).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(1);
    expect(await prisma.aiInsight.count()).toBe(1);
    // a different scope (all locations) is a different insight
    fake.enqueue({ text: JSON.stringify({ ...explainOk, confidence: 'HIGH' }) });
    const all = await request(app)
      .post('/ai/explain-forecast')
      .set(w.h)
      .send({ runId: w.run.id, productId: w.p.id });
    expect(all.body.cached).toBe(false);
    expect(all.body.result.confidence).toBe('HIGH');
    expect(await prisma.aiInsight.count()).toBe(2);
  });

  it('a cached explanation is served even when the quota is exhausted', async () => {
    const w = await world('free');
    fake.enqueue({ text: JSON.stringify(explainOk) });
    await explain(w);
    await prisma.subscription.update({
      where: { tenantId: w.tid },
      data: { customLimits: { aiRequests: 1 } },
    });
    expect((await explain(w)).status).toBe(200);
  });

  it('404 for unknown or another tenant’s run/product/location (the model is never called)', async () => {
    const w = await world();
    const other = await createTenant();
    const [op, ol] = [await createProduct(other.id), await createLocation(other.id)];
    const orun = await prisma.forecastRun.create({
      data: {
        tenantId: other.id,
        status: 'DONE',
        horizonWeeks: 4,
        method: 'AUTO',
        filters: {},
        asOfWeek: new Date(ASOF),
      },
    });
    expect((await explain(w, { runId: orun.id })).status).toBe(404);
    expect((await explain(w, { productId: op.id })).status).toBe(404);
    expect((await explain(w, { locationId: ol.id })).status).toBe(404);
    const lonely = await createProduct(w.tid, { sku: 'NOFC' });
    expect((await explain(w, { productId: lonely.id })).status).toBe(404);
    expect(fake.requests).toHaveLength(0);
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(0);
  });

  it('400 for bad input; roles: Owner/Admin/Planner only; isolation for the run id', async () => {
    const w = await world();
    expect((await request(app).post('/ai/explain-forecast').set(w.h).send({})).status).toBe(400);
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/ai/explain-forecast',
      body: { runId: w.run.id, productId: w.p.id },
      allowed: rolesWith('ai:use'),
    });
    fake.enqueue({ text: JSON.stringify(explainOk) });
    const intruder = await createUser({ role: 'OWNER' });
    expect(
      (
        await request(app)
          .post('/ai/explain-forecast')
          .set(tok(intruder))
          .send({ runId: w.run.id, productId: w.p.id })
      ).status,
    ).toBe(404);
  });

  describe('summary statistics', () => {
    it('trendPctPerWeek: slope as % of the mean per week', () => {
      expect(trendPctPerWeek([100, 100, 100, 100])).toBe(0);
      expect(trendPctPerWeek(Array.from({ length: 10 }, (_, i) => 100 + 10 * i))).toBeCloseTo(
        (10 / 145) * 100,
        1,
      );
      expect(trendPctPerWeek([5, 3])).toBe(0);
      expect(trendPctPerWeek([0, 0, 0, 0])).toBe(0);
    });
    it('seasonality needs a full year and finds the peak week', () => {
      const start = Date.UTC(2023, 0, 2);
      const series = Array.from({ length: 104 }, (_, i) => ({
        weekStart: new Date(start + i * WEEK),
        quantity: i % 52 === 25 ? 300 : 100,
      }));
      const s = seasonality(series)!;
      expect(s.peakToAverage).toBeGreaterThan(1.5);
      expect(s.peakWeekOfYear).toBeGreaterThan(20);
      expect(seasonality(series.slice(0, 40))).toBeNull();
      expect(seasonality(series.map((x) => ({ ...x, quantity: 0 })))).toBeNull();
    });
    it('buildForecastSummary truncates to the last 26 history weeks and next 12 forecast weeks', () => {
      const history = Array.from({ length: 200 }, (_, i) => ({
        weekStart: new Date(Date.UTC(2022, 0, 3) + i * WEEK),
        quantity: i,
      }));
      const s = buildForecastSummary({
        sku: 'X',
        productName: 'N',
        location: null,
        horizonWeeks: 26,
        modelUsed: 'holt',
        selectionReason: 'backtest',
        accuracy: { mape: 0.123, wape: 0.1, bias: -0.02 },
        history,
        forecast: Array.from({ length: 26 }, (_, i) => ({
          quantity: 200 + i,
          lower: 190,
          upper: 215,
        })),
        overrides: 2,
      });
      expect(s.history.recentWeeklyUnits).toHaveLength(26);
      expect(s.history.recentWeeklyUnits.at(-1)).toBe(199);
      expect(s.forecast.next12WeeklyUnits).toHaveLength(12);
      expect(s.accuracyOnLast12Weeks).toEqual({ wapePct: 10, mapePct: 12.3, biasPct: -2 });
      expect(s.location).toBe('all locations');
      expect(s.plannerOverrides).toBe(2);
      expect(JSON.stringify(s).length).toBeLessThan(2500);
    });
  });
});

describe('7.3 natural-language scenario builder', () => {
  const ask = (w: W, text: string, body: object = {}) =>
    request(app)
      .post('/ai/scenario-from-text')
      .set(w.h)
      .send({ text, ...body });

  it('turns the model’s named levers into real levers with this tenant’s ids, for review — and saves nothing', async () => {
    const w = await world();
    fake.enqueueJson({
      summary: 'Supplier is late and snack demand rises.',
      levers: [
        {
          type: 'SUPPLIER_DELAY',
          supplierName: 'acme supplies',
          extraDays: 21,
          startDate: '2025-12-01',
          endDate: '2025-12-31',
        },
        { type: 'DEMAND_CHANGE', scope: 'CATEGORY', targetName: 'Snacks', percent: 15 },
      ],
      unresolved: [],
    });
    const res = await ask(
      w,
      'What if Acme Supplies is 3 weeks late in December and demand for snacks rises 15%?',
    );
    expect(res.status).toBe(200);
    expect(res.body.baseForecastRunId).toBe(w.run.id);
    expect(res.body.levers).toHaveLength(2);
    expect(res.body.levers[0].lever).toEqual({
      type: 'SUPPLIER_DELAY',
      target: { supplierId: w.supplier.id },
      params: {
        extraDays: 21,
        startDate: '2025-12-01T00:00:00.000Z',
        endDate: '2025-12-31T00:00:00.000Z',
      },
    });
    expect(res.body.levers[1].lever).toEqual({
      type: 'DEMAND_CHANGE',
      target: { scope: 'CATEGORY', id: w.cat.id },
      params: { percent: 15 },
    });
    expect(res.body.levers[0].summary).toBe(
      'Supplier delay: Acme Supplies is 21 days late (2025-12-01 → 2025-12-31)',
    );
    expect(res.body.unresolved).toEqual([]);
    // Nothing persisted: no scenarios or levers, and only the AI request itself was metered.
    expect(await prisma.scenario.count()).toBe(0);
    expect(await prisma.scenarioLever.count()).toBe(0);
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(1);
  });

  it('shows unknown names as unresolved instead of guessing', async () => {
    const w = await world();
    fake.enqueueJson({
      summary: 'x',
      levers: [
        { type: 'SUPPLIER_DELAY', supplierName: 'Globex', extraDays: 14 },
        { type: 'DEMAND_CHANGE', scope: 'CATEGORY', targetName: 'Snack', percent: 10 }, // near miss: not guessed
        { type: 'DEMAND_CHANGE', scope: 'PRODUCT', targetName: 'NOPE-SKU', percent: 10 },
        { type: 'DEMAND_CHANGE', scope: 'LOCATION', targetName: 'MOON', percent: 10 },
        {
          type: 'LEAD_TIME_CHANGE',
          supplierName: 'Acme Supplies',
          productSku: 'SKU-AI',
          leadTimeDays: 30,
        },
      ],
      unresolved: ['the red warehouse'],
    });
    const res = await ask(w, 'whatever');
    expect(res.body.levers.map((l: { lever: { type: string } }) => l.lever.type)).toEqual([
      'LEAD_TIME_CHANGE',
    ]);
    expect(res.body.levers[0].lever.target).toEqual({ supplierProductId: w.link.id });
    expect(res.body.unresolved).toEqual(
      [
        'the red warehouse',
        'supplier "Globex" was not found in your data',
        'category "Snack" was not found in your data',
        'product "NOPE-SKU" was not found in your data'.replace('product', 'product'),
        'location "MOON" was not found in your data',
      ]
        .map((s) => s)
        .filter(Boolean)
        .sort((a, b) => (a === 'the red warehouse' ? -1 : b === 'the red warehouse' ? 1 : 0)),
    );
  });

  it('can only reference the current tenant’s ids: another tenant’s supplier/product names do not resolve', async () => {
    const w = await world();
    const other = await createTenant();
    const os = await createSupplier(other.id, { name: 'Foreign Supplier' });
    const op = await createProduct(other.id, { sku: 'FOREIGN-SKU' });
    await createSupplierProduct(other.id, os.id, op.id);
    fake.enqueueJson({
      summary: 'x',
      levers: [
        { type: 'SUPPLIER_DELAY', supplierName: 'Foreign Supplier', extraDays: 7 },
        { type: 'PRICE_CHANGE', scope: 'PRODUCT', targetName: 'FOREIGN-SKU', percent: 5 },
      ],
      unresolved: [],
    });
    const res = await ask(w, 'some request');
    expect(res.body.levers).toEqual([]);
    expect(res.body.unresolved).toHaveLength(2);
    // and the prompt only ever listed this tenant's names
    const prompt = JSON.stringify(fake.requests[0]!.messages);
    expect(prompt).toContain('Acme Supplies');
    expect(prompt).not.toMatch(/Foreign|FOREIGN-SKU/);
  });

  it('validates proposed levers with the same Zod schemas as manual levers (out-of-range values become unresolved)', async () => {
    const w = await world();
    fake.enqueueJson({
      summary: 'x',
      levers: [
        { type: 'SUPPLIER_DELAY', supplierName: 'Acme Supplies', extraDays: 0 },
        { type: 'SUPPLIER_DELAY', supplierName: 'Acme Supplies', extraDays: 500 },
        {
          type: 'LEAD_TIME_CHANGE',
          supplierName: 'Acme Supplies',
          productSku: 'SKU-AI',
          leadTimeDays: 999,
        },
        { type: 'CAPACITY_CAP', supplierName: 'Acme Supplies', weeklyQuantity: -3 },
        { type: 'DEMAND_CHANGE', scope: 'ALL', percent: -150 },
        { type: 'SERVICE_LEVEL', serviceLevel: 97 },
        { type: 'SERVICE_LEVEL', serviceLevel: 0.2 },
        { type: 'DEMAND_CHANGE', scope: 'ALL' },
      ],
      unresolved: [],
    });
    const res = await ask(w, 'some request');
    expect(res.body.levers).toHaveLength(1);
    expect(res.body.levers[0].lever).toEqual({
      type: 'SERVICE_LEVEL',
      target: {},
      params: { serviceLevel: 0.97 },
    });
    expect(res.body.unresolved).toHaveLength(7);
  });

  it('ignores malformed dates instead of failing, and rejects reversed ranges', async () => {
    const w = await world();
    fake.enqueueJson({
      summary: 'x',
      levers: [
        {
          type: 'SUPPLIER_DELAY',
          supplierName: 'Acme Supplies',
          extraDays: 7,
          startDate: 'December',
          endDate: 'soon',
        },
        {
          type: 'SUPPLIER_DELAY',
          supplierName: 'Acme Supplies',
          extraDays: 7,
          startDate: '2025-12-31',
          endDate: '2025-12-01',
        },
      ],
      unresolved: [],
    });
    const res = await ask(w, 'some request');
    expect(res.body.levers[0].lever.params).toEqual({ extraDays: 7 });
    expect(res.body.unresolved).toHaveLength(1);
  });

  it('the prompt contains names and the horizon, never ids; the explicit base run is honoured', async () => {
    const w = await world();
    fake.enqueueJson({ summary: '', levers: [], unresolved: [] });
    await ask(w, 'Some request', { baseForecastRunId: w.run.id });
    const prompt = JSON.stringify(fake.requests[0]!.messages) + fake.requests[0]!.system;
    expect(prompt).toContain('SKU-AI');
    expect(prompt).toContain('2025-06-09'); // horizon start
    for (const id of [w.tid, w.p.id, w.supplier.id, w.cat.id, w.loc.id, w.run.id])
      expect(prompt).not.toContain(id);
    expect(prompt).not.toMatch(/secret-domain|Secret Company/);
  });

  it('409 without a finished forecast, 404 for another tenant’s base run, 400 for empty text', async () => {
    const t = await createTenant();
    const o = await createUser({ role: 'OWNER', tenantId: t.id });
    expect(
      (await request(app).post('/ai/scenario-from-text').set(tok(o)).send({ text: 'hello there' }))
        .body.error.code,
    ).toBe('NO_FORECAST');
    const w = await world();
    expect(
      (
        await ask(w, 'hello there', {
          baseForecastRunId: (
            await prisma.forecastRun.create({
              data: {
                tenantId: t.id,
                status: 'DONE',
                horizonWeeks: 4,
                method: 'AUTO',
                filters: {},
              },
            })
          ).id,
        })
      ).status,
    ).toBe(404);
    expect((await ask(w, '')).status).toBe(400);
    expect((await ask(w, 'x'.repeat(1001))).status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  it('roles apply, and the builder counts as one AI request (402 at the limit)', async () => {
    const w = await world('free');
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/ai/scenario-from-text',
      body: { text: 'hello there' },
      allowed: rolesWith('ai:use'),
    });
    await prisma.subscription.update({
      where: { tenantId: w.tid },
      data: { customLimits: { aiRequests: 1 } },
    });
    fake.enqueueJson({ summary: '', levers: [], unresolved: [] });
    expect((await ask(w, 'first request')).status).toBe(200);
    const blocked = await ask(w, 'second request');
    expect(blocked.status).toBe(402);
    expect(fake.requests).toHaveLength(1);
  });

  it('resolveAiLever is pure and name matching is case-insensitive but exact', () => {
    const lk: Lookups = {
      suppliers: new Map([['acme', 's1']]),
      categories: new Map([['snacks', 'c1']]),
      products: new Map([['sku-1', 'p1']]),
      locations: new Map([['east', 'l1']]),
      links: new Map([['s1|p1', 'link1']]),
    };
    expect(
      resolveAiLever(
        { type: 'DEMAND_CHANGE', scope: 'CATEGORY', targetName: ' SNACKS ', percent: 5 },
        lk,
      ).lever,
    ).toBeDefined();
    expect(
      resolveAiLever(
        { type: 'DEMAND_CHANGE', scope: 'CATEGORY', targetName: 'snack', percent: 5 },
        lk,
      ).unresolved,
    ).toMatch(/not found/);
    expect(
      resolveAiLever(
        { type: 'LEAD_TIME_CHANGE', supplierName: 'Acme', productSku: 'SKU-1', leadTimeDays: 20 },
        lk,
      ).lever?.target,
    ).toEqual({ supplierProductId: 'link1' });
    expect(
      resolveAiLever(
        { type: 'LEAD_TIME_CHANGE', supplierName: 'Acme', productSku: 'SKU-2', leadTimeDays: 20 },
        lk,
      ).unresolved,
    ).toMatch(/SKU-2/);
    expect(aiScenarioSchema.safeParse({ levers: [{ type: 'MAGIC' }] }).success).toBe(false);
  });
});

describe('7.4 scenario risk summary', () => {
  async function scenarioRun(w: W, status: 'DONE' | 'RUNNING' = 'DONE') {
    const scenario = await prisma.scenario.create({
      data: {
        tenantId: w.tid,
        name: 'Late supplier',
        baseForecastRunId: w.run.id,
        status: 'READY',
      },
    });
    return prisma.scenarioRun.create({
      data: {
        tenantId: w.tid,
        scenarioId: scenario.id,
        status,
        levers: [
          {
            type: 'SUPPLIER_DELAY',
            target: { supplierId: w.supplier.id },
            params: { extraDays: 21 },
          },
        ],
        kpis: {
          baseline: {
            stockoutWeeks: 1,
            fillRate: 0.98,
            avgInventoryValueCents: 500000,
            revenueAtRiskCents: 10000,
            plannedOrders: 4,
            totalDemand: 1000,
            totalShortage: 20,
          },
          scenario: {
            stockoutWeeks: 6,
            fillRate: 0.81,
            avgInventoryValueCents: 420000,
            revenueAtRiskCents: 950000,
            plannedOrders: 7,
            totalDemand: 1000,
            totalShortage: 190,
          },
        },
        atRisk: {
          baseline: [],
          scenario: [
            {
              productId: w.p.id,
              locationId: w.loc.id,
              firstStockoutWeek: 2,
              shortage: 120,
              revenueAtRiskCents: 600000,
            },
          ],
        },
      },
    });
  }
  const summarise = (w: W, id: string) =>
    request(app).post('/ai/risk-summary').set(w.h).send({ scenarioRunId: id });

  it('summarises KPIs and the at-risk list into an executive summary with 3–5 actions', async () => {
    const w = await world();
    const run = await scenarioRun(w);
    fake.enqueueJson(riskOk);
    const res = await summarise(w, run.id);
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual(riskOk);
    const prompt = JSON.stringify(fake.requests[0]!.messages);
    expect(prompt).toContain('fillRatePct');
    expect(prompt).toContain('81');
    expect(prompt).toContain('SKU-AI');
    expect(prompt).toContain('Acme Supplies is 21 days late');
    for (const id of [w.tid, w.p.id, run.id, w.supplier.id]) expect(prompt).not.toContain(id);
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(1);
  });

  it('validates the response schema: fewer than 3 or more than 5 actions, bad severity → retry then friendly error', async () => {
    const w = await world();
    const run = await scenarioRun(w);
    fake.enqueueJson({ ...riskOk, actions: ['only one'] }, { ...riskOk, severity: 'CRITICAL' });
    const bad = await summarise(w, run.id);
    expect(bad.status).toBe(502);
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(0);
    fake.enqueueJson({ ...riskOk, actions: ['1', '2', '3', '4', '5', '6'] }, riskOk);
    expect((await summarise(w, run.id)).status).toBe(200); // second attempt valid
  });

  it('caches per scenario run', async () => {
    const w = await world();
    const run = await scenarioRun(w);
    fake.enqueueJson(riskOk);
    await summarise(w, run.id);
    const again = await summarise(w, run.id);
    expect(again.body.cached).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('409 until the run has finished; 404 for other tenants; roles', async () => {
    const w = await world();
    const running = await scenarioRun(w, 'RUNNING');
    expect((await summarise(w, running.id)).status).toBe(409);
    const done = await scenarioRun(w);
    const intruder = await createUser({ role: 'OWNER' });
    expect(
      (
        await request(app)
          .post('/ai/risk-summary')
          .set(tok(intruder))
          .send({ scenarioRunId: done.id })
      ).status,
    ).toBe(404);
    expect((await summarise(w, 'nope')).status).toBe(404);
    expect((await request(app).post('/ai/risk-summary').set(w.h).send({})).status).toBe(400);
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/ai/risk-summary',
      body: { scenarioRunId: 'x' },
      allowed: rolesWith('ai:use'),
    });
  });

  it('buildRiskSummary rounds numbers and converts cents to dollars', () => {
    const s = buildRiskSummary({
      kpis: {
        baseline: {
          fillRate: 0.9876,
          stockoutWeeks: 2,
          totalShortage: 12.34,
          revenueAtRiskCents: 123456,
          avgInventoryValueCents: 99999,
          plannedOrders: 3,
        },
        scenario: {
          fillRate: 0.5,
          stockoutWeeks: 9,
          totalShortage: 500,
          revenueAtRiskCents: 9999999,
          avgInventoryValueCents: 1,
          plannedOrders: 20,
        },
      },
      atRisk: Array.from({ length: 15 }, (_, i) => ({
        sku: `S${i}`,
        location: 'E',
        firstStockoutDate: '2025-07-07',
        shortage: 10.4,
        revenueAtRiskCents: 5000,
      })),
      levers: Array.from({ length: 12 }, (_, i) => `lever ${i}`),
    });
    expect(s.baseline).toMatchObject({ fillRatePct: 98.8, revenueAtRiskUsd: 1235, unitsShort: 12 });
    expect(s.topAtRiskProducts).toHaveLength(10);
    expect(s.levers).toHaveLength(10);
  });
});

describe('7.4 assistant (function calling over a fixed allowlist)', () => {
  const ask = (w: W, question: string, history: object[] = []) =>
    request(app).post('/ai/assistant').set(w.h).send({ question, history });
  const call = (name: string, args: Record<string, unknown> = {}) => ({
    text: '',
    functionCalls: [{ name, args }],
  });

  it('lets the model call an allowlisted function, runs it for the tenant and answers from the result', async () => {
    const w = await world();
    fake.enqueue(call('getTopProductsByRevenue', { limit: 3 }), {
      text: 'Your top product is SKU-AI.',
    });
    const res = await ask(w, 'Which products make the most revenue?');
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Your top product is SKU-AI.');
    expect(res.body.toolCalls).toEqual([
      { name: 'getTopProductsByRevenue', args: { limit: 3 }, ok: true },
    ]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]!.tools!.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const second = JSON.stringify(fake.requests[1]!.messages);
    expect(second).toContain('functionResponse');
    expect(second).toContain('"sku":"SKU-AI"');
    expect(await currentUsage(w.tid, 'aiRequests')).toBe(1); // quota applies per question, not per round
    expect((await prisma.aiRequest.findFirstOrThrow()).feature).toBe('assistant');
  });

  it('every question costs one request of quota; at the limit it returns 402 without calling the model', async () => {
    const w = await world('free');
    await prisma.subscription.update({
      where: { tenantId: w.tid },
      data: { customLimits: { aiRequests: 2 } },
    });
    fake.enqueue({ text: 'a' }, call('getLateOpenOrders'), { text: 'b' }, { text: 'c' });
    expect((await ask(w, 'first question')).status).toBe(200);
    expect((await ask(w, 'second question')).status).toBe(200); // two model rounds, still one request
    const third = await ask(w, 'third question');
    expect(third.status).toBe(402);
    expect(third.body.error.details).toMatchObject({ metric: 'aiRequests', limit: 2, current: 2 });
    expect(fake.requests).toHaveLength(3);
  });

  it('rejects unknown function names (nothing executes) and tells the model what is allowed', async () => {
    const w = await world();
    fake.enqueue(
      {
        text: '',
        functionCalls: [
          { name: 'runSql', args: { query: 'DROP TABLE Product' } },
          { name: 'constructor', args: {} },
          { name: '__proto__', args: {} },
          { name: 'toString', args: {} },
        ],
      },
      { text: 'Sorry, I cannot do that.' },
    );
    const res = await ask(w, 'drop everything');
    expect(res.status).toBe(200);
    expect(res.body.toolCalls.map((t: { ok: boolean }) => t.ok)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const response = JSON.stringify(fake.requests[1]!.messages.at(-1));
    expect(response).toMatch(/Unknown function \\"runSql\\"/);
    expect(await prisma.product.count()).toBe(1); // untouched
  });

  it('validates arguments strictly (out-of-range numbers, unknown keys, wrong types)', async () => {
    const w = await world();
    const ctx = { db: scoped(w.tid), now: new Date() };
    for (const [name, args] of [
      ['getTopProductsByRevenue', { limit: 1000 }],
      ['getTopProductsByRevenue', { limit: 0 }],
      ['getTopProductsByRevenue', { limit: 3, extra: 'x' }],
      ['getSalesTrend', { weeks: 1 }],
      ['getSalesTrend', { productSku: 5 }],
      ['getWorstAccuracy', { limit: 'ten' }],
    ] as const) {
      const out = await executeTool(ctx, name, args);
      expect(out.ok).toBe(false);
      expect(String(out.response.error)).toMatch(/Invalid arguments/);
    }
    expect((await executeTool(ctx, 'getTopProductsByRevenue', undefined)).ok).toBe(true); // defaults apply
  });

  it('caps tool calls per question and rounds, and falls back to a friendly message', async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) fake.enqueue(call('getLateOpenOrders'));
    const res = await ask(w, 'keep looking');
    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/too many lookups/i);
    expect(fake.requests.length).toBe(4);
  });

  it('answers directly when no function is needed; empty replies get a fallback', async () => {
    const w = await world();
    fake.enqueue({ text: 'Hello! Ask me about your sales.' }, { text: '   ' });
    expect((await ask(w, 'hi there')).body).toEqual({
      answer: 'Hello! Ask me about your sales.',
      toolCalls: [],
    });
    expect((await ask(w, 'hello again')).body.answer).toMatch(/could not produce an answer/);
  });

  it('keeps conversation history (max 6 turns) and validates the question', async () => {
    const w = await world();
    fake.enqueue({ text: 'ok' });
    await ask(w, 'and for last month?', [
      { role: 'user', text: 'top products?' },
      { role: 'assistant', text: 'SKU-AI' },
    ]);
    const msgs = fake.requests[0]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    expect((await ask(w, '')).status).toBe(400);
    expect((await ask(w, 'x'.repeat(501))).status).toBe(400);
    expect((await ask(w, 'fine', new Array(7).fill({ role: 'user', text: 'x' }))).status).toBe(400);
    expect((await ask(w, 'fine', [{ role: 'system', text: 'x' }])).status).toBe(400);
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/ai/assistant',
      body: { question: 'hello there' },
      allowed: rolesWith('ai:use'),
    });
  });

  it('every function is tenant-scoped: tenant B only ever sees tenant B’s data', async () => {
    const a = await world();
    const bTenant = await createTenant({ plan: 'pro' });
    const bOwner = await createUser({ role: 'OWNER', tenantId: bTenant.id });
    const bp = await createProduct(bTenant.id, { sku: 'B-ONLY', unitPriceCents: 100 });
    const bl = await createLocation(bTenant.id, { code: 'B-LOC' });
    await createSales(bTenant.id, bp.id, bl.id, Array(10).fill(7), ASOF);
    await createInventory(bTenant.id, bp.id, bl.id, 0, 5);
    await createOpenOrder(bTenant.id, bp.id, bl.id, { expectedDate: new Date('2020-01-01') });
    await createInventory(a.tid, a.p.id, a.loc.id, 0, 5);
    await createOpenOrder(a.tid, a.p.id, a.loc.id, { expectedDate: new Date('2020-01-01') });
    const arun = await prisma.forecastRun.create({
      data: {
        tenantId: bTenant.id,
        status: 'DONE',
        horizonWeeks: 4,
        method: 'AUTO',
        filters: {},
        asOfWeek: new Date(ASOF),
      },
    });
    await prisma.forecastAccuracy.create({
      data: {
        tenantId: bTenant.id,
        runId: arun.id,
        productId: bp.id,
        locationId: bl.id,
        modelUsed: 'naive',
        wape: 0.9,
      },
    });
    const sc = await prisma.scenario.create({
      data: { tenantId: bTenant.id, name: 'B scen', baseForecastRunId: arun.id },
    });
    await prisma.scenarioRun.create({
      data: {
        tenantId: bTenant.id,
        scenarioId: sc.id,
        status: 'DONE',
        levers: [],
        kpis: {},
        atRisk: {
          baseline: [],
          scenario: [
            {
              productId: bp.id,
              locationId: bl.id,
              firstStockoutWeek: 0,
              shortage: 5,
              revenueAtRiskCents: 500,
            },
          ],
        },
      },
    });

    const ctxB = { db: scoped(bTenant.id), now: new Date() };
    const ctxA = { db: scoped(a.tid), now: new Date() };
    const dump = async (ctx: typeof ctxB) =>
      JSON.stringify(await Promise.all(TOOL_NAMES.map((n) => executeTool(ctx, n, {}))));
    const b = await dump(ctxB);
    const aa = await dump(ctxA);
    expect(b).toContain('B-ONLY');
    expect(b).not.toContain('SKU-AI');
    expect(aa).toContain('SKU-AI');
    expect(aa).not.toContain('B-ONLY');
    // and through the API
    fake.enqueue(call('getTopProductsByRevenue'), { text: 'done' });
    await request(app)
      .post('/ai/assistant')
      .set(tok(bOwner))
      .send({ question: 'top products please' });
    expect(JSON.stringify(fake.requests[1]!.messages)).toContain('B-ONLY');
    expect(JSON.stringify(fake.requests[1]!.messages)).not.toContain('SKU-AI');
  });

  describe('the functions themselves', () => {
    it('getTopProductsByRevenue ranks by revenue in dollars within the look-back window', async () => {
      const w = await world();
      const cheap = await createProduct(w.tid, { sku: 'CHEAP' });
      await createSales(w.tid, cheap.id, w.loc.id, Array(60).fill(1), ASOF);
      const out = await executeTool(
        { db: scoped(w.tid), now: new Date() },
        'getTopProductsByRevenue',
        { limit: 2, weeks: 10 },
      );
      const products = (out.response as { products: { sku: string; revenueUsd: number }[] })
        .products;
      expect(products.map((p) => p.sku)).toEqual(['SKU-AI', 'CHEAP']);
      expect(products[0]!.revenueUsd).toBe(
        Array.from({ length: 10 }, (_, i) => 150 + i).reduce((a, b) => a + b, 0) * 1,
      ); // qty×$1 (factory revenue = qty × 100¢)
    });
    it('getWorstAccuracy returns the highest WAPE first from the latest finished run', async () => {
      const w = await world();
      const p2 = await createProduct(w.tid, { sku: 'BAD' });
      await prisma.forecastAccuracy.create({
        data: {
          tenantId: w.tid,
          runId: w.run.id,
          productId: p2.id,
          locationId: w.loc.id,
          modelUsed: 'naive',
          wape: 0.55,
          bias: 0.2,
        },
      });
      const out = (
        await executeTool({ db: scoped(w.tid), now: new Date() }, 'getWorstAccuracy', {})
      ).response as { series: { sku: string; wapePct: number }[] };
      expect(out.series.map((s) => s.sku)).toEqual(['BAD', 'SKU-AI']);
      expect(out.series[0]!.wapePct).toBe(55);
    });
    it('getSalesTrend: totals per week, reports an unknown SKU instead of failing', async () => {
      const w = await world();
      const ok = (
        await executeTool({ db: scoped(w.tid), now: new Date() }, 'getSalesTrend', {
          productSku: 'SKU-AI',
          weeks: 4,
        })
      ).response as { weeks: { units: number }[] };
      expect(ok.weeks).toHaveLength(4);
      expect(ok.weeks.at(-1)!.units).toBe(159);
      expect(
        (
          await executeTool({ db: scoped(w.tid), now: new Date() }, 'getSalesTrend', {
            productSku: 'NOPE',
          })
        ).response,
      ).toEqual({ error: 'No product with SKU NOPE' });
    });
    it('getLowStockProducts and getLateOpenOrders', async () => {
      const w = await world();
      await createInventory(w.tid, w.p.id, w.loc.id, 2, 10);
      const sup = await createSupplier(w.tid, { name: 'Late Co' });
      await createOpenOrder(w.tid, w.p.id, w.loc.id, {
        expectedDate: new Date(
          Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth(),
            new Date().getUTCDate() - 10,
          ),
        ),
        supplierId: sup.id,
      });
      await createOpenOrder(w.tid, w.p.id, w.loc.id, {
        expectedDate: new Date(Date.now() + 10 * 86400_000),
      });
      const ctx = { db: scoped(w.tid), now: new Date() };
      expect(
        ((await executeTool(ctx, 'getLowStockProducts', {})).response as { products: unknown[] })
          .products,
      ).toEqual([{ sku: 'SKU-AI', location: 'EAST', onHand: 2, safetyStock: 10 }]);
      const late = (await executeTool(ctx, 'getLateOpenOrders', {})).response as {
        lateOrders: { supplier: string; daysLate: number }[];
      };
      expect(late.lateOrders).toHaveLength(1);
      expect(late.lateOrders[0]).toMatchObject({ supplier: 'Late Co', daysLate: 10 });
    });
    it('empty accounts get friendly notes, and declarations match the allowlist', async () => {
      const t = await createTenant();
      const ctx = { db: scoped(t.id), now: new Date() };
      expect((await executeTool(ctx, 'getTopProductsByRevenue', {})).response).toMatchObject({
        note: expect.stringMatching(/No sales/),
      });
      expect((await executeTool(ctx, 'getWorstAccuracy', {})).response).toMatchObject({
        note: expect.stringMatching(/No finished forecast/),
      });
      expect((await executeTool(ctx, 'getAtRiskProducts', {})).response).toMatchObject({
        note: expect.stringMatching(/No scenario/),
      });
      expect(
        toolDeclarations()
          .map((d) => d.name)
          .sort(),
      ).toEqual([...TOOL_NAMES].sort());
      for (const d of toolDeclarations())
        expect(d.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    });
  });
});
