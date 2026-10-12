import { Router } from 'express';
import { z } from 'zod';
import {
  assistantRequestSchema,
  explainOutputSchema,
  explainRequestSchema,
  leverInputSchema,
  LEVER_LABELS,
  LEVER_TYPES,
  riskOutputSchema,
  riskRequestSchema,
  scenarioTextSchema,
  type ExplainOutput,
  type LeverInput,
  type RiskOutput,
  type ScenarioProposal,
} from '@supplycast/shared';
import type { ScopedClient } from '../../db/scoped';
import type { AiMessage } from '../../ai/types';
import {
  assistantSystemPromptV1,
  explainForecastPromptV1,
  riskSummaryPromptV1,
  scenarioBuilderPromptV1,
} from '../../ai/prompts';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { auditReq } from '../audit/service';
import { leverSummary, loadNames } from '../scenarios/summary';
import { buildForecastSummary, buildRiskSummary } from './context';
import { AiService, getInsight, saveInsight } from './service';
import { executeTool, toolDeclarations } from './tools';

const WEEK = 7 * 86400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** What the model returns for the scenario builder: names, not ids. */
export const aiScenarioSchema = z.object({
  summary: z.string().max(1000).default(''),
  levers: z
    .array(
      z.object({
        type: z.enum(LEVER_TYPES),
        scope: z.enum(['ALL', 'PRODUCT', 'CATEGORY', 'LOCATION']).optional(),
        targetName: z.string().max(200).optional(),
        supplierName: z.string().max(200).optional(),
        productSku: z.string().max(100).optional(),
        percent: z.number().optional(),
        elasticity: z.number().optional(),
        extraDays: z.number().optional(),
        leadTimeDays: z.number().optional(),
        weeklyQuantity: z.number().optional(),
        serviceLevel: z.number().optional(),
        startDate: z.string().max(40).optional(),
        endDate: z.string().max(40).optional(),
      }),
    )
    .max(10)
    .default([]),
  unresolved: z.array(z.string().max(300)).max(10).default([]),
});
type AiLever = z.infer<typeof aiScenarioSchema>['levers'][number];

export interface Lookups {
  suppliers: Map<string, string>; // lower-cased name → id
  categories: Map<string, string>;
  products: Map<string, string>; // lower-cased SKU → id
  locations: Map<string, string>;
  links: Map<string, string>; // `${supplierId}|${productId}` → supplierProductId
}

const key = (s?: string) => (s ?? '').trim().toLowerCase();
const validDate = (s?: string) =>
  s && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s)) ? s.slice(0, 10) : undefined;

/**
 * Turns a model-proposed lever (names) into a real lever (ids of THIS tenant only). Names that do not
 * exist are never guessed: they come back as an explanation in `unresolved`.
 */
export function resolveAiLever(
  l: AiLever,
  lk: Lookups,
): { lever?: LeverInput; unresolved?: string } {
  const dates = {
    ...(validDate(l.startDate) && { startDate: validDate(l.startDate) }),
    ...(validDate(l.endDate) && { endDate: validDate(l.endDate) }),
  };
  const scopeTarget = (): { target?: Record<string, string>; error?: string } => {
    const scope = l.scope ?? 'ALL';
    if (scope === 'ALL') return { target: { scope } };
    const map =
      scope === 'PRODUCT' ? lk.products : scope === 'CATEGORY' ? lk.categories : lk.locations;
    const id = map.get(key(l.targetName));
    return id
      ? { target: { scope, id } }
      : { error: `${scope.toLowerCase()} "${l.targetName ?? ''}" was not found in your data` };
  };
  let candidate: unknown;
  switch (l.type) {
    case 'DEMAND_CHANGE': {
      const t = scopeTarget();
      if (t.error) return { unresolved: t.error };
      candidate = { type: l.type, target: t.target, params: { percent: l.percent, ...dates } };
      break;
    }
    case 'PRICE_CHANGE': {
      const t = scopeTarget();
      if (t.error) return { unresolved: t.error };
      candidate = {
        type: l.type,
        target: t.target,
        params: { percent: l.percent, elasticity: l.elasticity ?? 1, ...dates },
      };
      break;
    }
    case 'SUPPLIER_DELAY':
    case 'CAPACITY_CAP': {
      const supplierId = lk.suppliers.get(key(l.supplierName));
      if (!supplierId)
        return { unresolved: `supplier "${l.supplierName ?? ''}" was not found in your data` };
      candidate =
        l.type === 'SUPPLIER_DELAY'
          ? { type: l.type, target: { supplierId }, params: { extraDays: l.extraDays, ...dates } }
          : { type: l.type, target: { supplierId }, params: { weeklyQuantity: l.weeklyQuantity } };
      break;
    }
    case 'LEAD_TIME_CHANGE': {
      const supplierId = lk.suppliers.get(key(l.supplierName));
      const productId = lk.products.get(key(l.productSku));
      if (!supplierId)
        return { unresolved: `supplier "${l.supplierName ?? ''}" was not found in your data` };
      if (!productId)
        return { unresolved: `product "${l.productSku ?? ''}" was not found in your data` };
      const link = lk.links.get(`${supplierId}|${productId}`);
      if (!link)
        return { unresolved: `${l.supplierName} does not supply ${l.productSku} in your data` };
      candidate = {
        type: l.type,
        target: { supplierProductId: link },
        params: { leadTimeDays: l.leadTimeDays },
      };
      break;
    }
    case 'SERVICE_LEVEL': {
      const level =
        l.serviceLevel !== undefined && l.serviceLevel > 1 ? l.serviceLevel / 100 : l.serviceLevel;
      candidate = { type: l.type, target: {}, params: { serviceLevel: level } };
      break;
    }
  }
  const parsed = leverInputSchema.safeParse(candidate);
  if (!parsed.success)
    return {
      unresolved: `${LEVER_LABELS[l.type]}: ${parsed.error.issues[0]?.message ?? 'invalid values'}`,
    };
  return { lever: parsed.data };
}

async function buildLookups(db: ScopedClient): Promise<
  Lookups & {
    names: { suppliers: string[]; categories: string[]; products: string[]; locations: string[] };
  }
> {
  const [suppliers, categories, products, locations, links] = await Promise.all([
    db.supplier.findMany({ select: { id: true, name: true }, take: 300 }),
    db.category.findMany({ select: { id: true, name: true }, take: 300 }),
    db.product.findMany({ select: { id: true, sku: true }, take: 500 }),
    db.location.findMany({ select: { id: true, code: true }, take: 100 }),
    db.supplierProduct.findMany({
      select: { id: true, supplierId: true, productId: true },
      take: 2000,
    }),
  ]);
  return {
    suppliers: new Map(suppliers.map((s) => [key(s.name), s.id])),
    categories: new Map(categories.map((c) => [key(c.name), c.id])),
    products: new Map(products.map((p) => [key(p.sku), p.id])),
    locations: new Map(locations.map((l) => [key(l.code), l.id])),
    links: new Map(links.map((l) => [`${l.supplierId}|${l.productId}`, l.id])),
    names: {
      suppliers: suppliers.map((s) => s.name),
      categories: categories.map((c) => c.name),
      products: products.map((p) => p.sku),
      locations: locations.map((l) => l.code),
    },
  };
}

export function aiRouter(opts: { guards: Guards; ai: AiService }): Router {
  const { guards, ai } = opts;
  const router = Router();
  const use = guards.tenant('ai:use');

  router.post('/ai/explain-forecast', ...use, async (req, res, next) => {
    try {
      const input = explainRequestSchema.parse(req.body);
      const db = req.db!;
      const run = await db.forecastRun.findUnique({ where: { id: input.runId } });
      if (!run) throw new HttpError(404, 'NOT_FOUND', 'Forecast run not found');
      const product = await db.product.findUnique({ where: { id: input.productId } });
      if (!product) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
      const location = input.locationId
        ? await db.location.findUnique({ where: { id: input.locationId } })
        : null;
      if (input.locationId && !location)
        throw new HttpError(404, 'NOT_FOUND', 'Location not found');

      const refKey = `${run.id}|${product.id}|${location?.id ?? '*'}`;
      const cached = await getInsight<ExplainOutput>(req.tenantId!, 'FORECAST_EXPLAIN', refKey);
      if (cached) return void res.json({ result: cached, cached: true });

      const locFilter = location ? { locationId: location.id } : {};
      const results = await db.forecastResult.findMany({
        where: { runId: run.id, productId: product.id, ...locFilter },
        orderBy: { weekStart: 'asc' },
      });
      if (results.length === 0)
        throw new HttpError(404, 'NOT_FOUND', 'No forecast for this product in this run');
      const weeks = new Map<number, { quantity: number; lower: number; upper: number }>();
      for (const r of results) {
        const w = weeks.get(r.weekStart.getTime()) ?? { quantity: 0, lower: 0, upper: 0 };
        w.quantity += Number(r.quantity);
        w.lower += Number(r.lower);
        w.upper += Number(r.upper);
        weeks.set(r.weekStart.getTime(), w);
      }
      const asOf = run.asOfWeek ?? new Date();
      const sales = await db.salesRecord.findMany({
        where: {
          productId: product.id,
          ...locFilter,
          date: { gt: new Date(asOf.getTime() - 156 * WEEK), lte: asOf },
        },
        select: { date: true, quantity: true },
      });
      const hist = new Map<number, number>();
      for (const s of sales)
        hist.set(s.date.getTime(), (hist.get(s.date.getTime()) ?? 0) + Number(s.quantity));
      const history = [...hist.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, q]) => ({ weekStart: new Date(t), quantity: q }));
      const acc = location
        ? await db.forecastAccuracy.findFirst({
            where: { runId: run.id, productId: product.id, locationId: location.id },
          })
        : null;
      const models = [...new Set(results.map((r) => r.modelUsed))];
      const overrides = await db.forecastOverride.count({
        where: { productId: product.id, ...locFilter },
      });

      const summary = buildForecastSummary({
        sku: product.sku,
        productName: product.name,
        location: location?.code ?? null,
        horizonWeeks: run.horizonWeeks,
        modelUsed: models.length === 1 ? models[0]! : 'mixed',
        selectionReason: acc?.reason ?? null,
        accuracy: acc ? { mape: acc.mape, wape: acc.wape, bias: acc.bias } : null,
        history,
        forecast: [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
        overrides,
      });
      const p = explainForecastPromptV1(summary);
      const result = await ai.structured(
        { tenantId: req.tenantId!, userId: req.auth!.userId, feature: 'explain_forecast' },
        { system: p.system, prompt: p.prompt, schema: explainOutputSchema },
      );
      await saveInsight(req.tenantId!, 'FORECAST_EXPLAIN', refKey, p.version, result);
      res.json({ result, cached: false });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ai/scenario-from-text', ...use, async (req, res, next) => {
    try {
      const input = scenarioTextSchema.parse(req.body);
      const db = req.db!;
      const base = input.baseForecastRunId
        ? await db.forecastRun.findUnique({ where: { id: input.baseForecastRunId } })
        : await db.forecastRun.findFirst({
            where: { status: 'DONE' },
            orderBy: { createdAt: 'desc' },
          });
      if (!base)
        throw new HttpError(
          input.baseForecastRunId ? 404 : 409,
          input.baseForecastRunId ? 'NOT_FOUND' : 'NO_FORECAST',
          input.baseForecastRunId
            ? 'Forecast run not found'
            : 'Run a forecast first — scenarios start from a finished forecast.',
        );
      if (base.status !== 'DONE' || !base.asOfWeek)
        throw new HttpError(409, 'BASE_RUN_NOT_READY', 'Choose a finished forecast run');

      const lk = await buildLookups(db);
      const horizonStart = new Date(base.asOfWeek.getTime() + WEEK);
      const horizonEnd = new Date(base.asOfWeek.getTime() + base.horizonWeeks * WEEK);
      const p = scenarioBuilderPromptV1({
        text: input.text,
        today: isoDay(new Date()),
        horizonStart: isoDay(horizonStart),
        horizonEnd: isoDay(horizonEnd),
        ...lk.names,
      });
      const out = await ai.structured(
        { tenantId: req.tenantId!, userId: req.auth!.userId, feature: 'scenario_builder' },
        { system: p.system, prompt: p.prompt, schema: aiScenarioSchema },
      );

      const nm = await loadNames(db);
      const levers: ScenarioProposal['levers'] = [];
      const unresolved = [...out.unresolved];
      for (const l of out.levers) {
        const r = resolveAiLever(l, lk);
        if (r.lever)
          levers.push({
            lever: r.lever,
            summary: `${LEVER_LABELS[r.lever.type]}: ${leverSummary({ type: r.lever.type, target: r.lever.target as Record<string, unknown>, params: JSON.parse(JSON.stringify(r.lever.params)) as Record<string, unknown> }, nm)}`,
          });
        else unresolved.push(r.unresolved!);
      }
      // Nothing is saved here: the planner reviews the proposal and confirms in a separate step.
      const body: ScenarioProposal = {
        interpretation: out.summary,
        levers,
        unresolved,
        baseForecastRunId: base.id,
      };
      await auditReq(req, 'ai.scenario_proposed', 'ForecastRun', base.id, {
        levers: levers.length,
        unresolved: unresolved.length,
      });
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.post('/ai/risk-summary', ...use, async (req, res, next) => {
    try {
      const { scenarioRunId } = riskRequestSchema.parse(req.body);
      const db = req.db!;
      const run = await db.scenarioRun.findUnique({ where: { id: scenarioRunId } });
      if (!run) throw new HttpError(404, 'NOT_FOUND', 'Scenario run not found');
      if (run.status !== 'DONE' || !run.kpis || !run.atRisk)
        throw new HttpError(409, 'RUN_NOT_READY', 'The scenario run has not finished');
      const cached = await getInsight<RiskOutput>(req.tenantId!, 'RISK_SUMMARY', run.id);
      if (cached) return void res.json({ result: cached, cached: true });

      const [nm, products, locations, scenario] = await Promise.all([
        loadNames(db),
        db.product.findMany({ select: { id: true, sku: true } }),
        db.location.findMany({ select: { id: true, code: true } }),
        db.scenario.findUnique({
          where: { id: run.scenarioId },
          select: { baseForecastRunId: true },
        }),
      ]);
      const base = scenario
        ? await db.forecastRun.findUnique({
            where: { id: scenario.baseForecastRunId },
            select: { asOfWeek: true },
          })
        : null;
      const week0 = (base?.asOfWeek?.getTime() ?? Date.now()) + WEEK;
      const p0 = new Map(products.map((p) => [p.id, p.sku]));
      const l0 = new Map(locations.map((l) => [l.id, l.code]));
      const kpis = run.kpis as {
        baseline: Record<string, number>;
        scenario: Record<string, number>;
      };
      const atRisk = (
        run.atRisk as {
          scenario: {
            productId: string;
            locationId: string;
            firstStockoutWeek: number;
            shortage: number;
            revenueAtRiskCents: number;
          }[];
        }
      ).scenario;
      const summary = buildRiskSummary({
        kpis,
        atRisk: atRisk.map((a) => ({
          sku: p0.get(a.productId) ?? '?',
          location: l0.get(a.locationId) ?? '?',
          firstStockoutDate: isoDay(new Date(week0 + a.firstStockoutWeek * WEEK)),
          shortage: a.shortage,
          revenueAtRiskCents: a.revenueAtRiskCents,
        })),
        levers: (
          run.levers as {
            type: string;
            target: Record<string, unknown>;
            params: Record<string, unknown>;
          }[]
        ).map((l) => leverSummary(l, nm)),
      });
      const p = riskSummaryPromptV1(summary);
      const result = await ai.structured(
        { tenantId: req.tenantId!, userId: req.auth!.userId, feature: 'risk_summary' },
        { system: p.system, prompt: p.prompt, schema: riskOutputSchema },
      );
      await saveInsight(req.tenantId!, 'RISK_SUMMARY', run.id, p.version, result);
      res.json({ result, cached: false });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ai/assistant', ...use, async (req, res, next) => {
    try {
      const input = assistantRequestSchema.parse(req.body);
      const sys = assistantSystemPromptV1();
      const messages: AiMessage[] = [
        ...input.history.map((h): AiMessage => ({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.text }],
        })),
        { role: 'user', parts: [{ text: input.question }] },
      ];
      const ctx = { db: req.db!, now: new Date() };
      const out = await ai.converse(
        { tenantId: req.tenantId!, userId: req.auth!.userId, feature: 'assistant' },
        {
          system: sys.system,
          messages,
          tools: toolDeclarations(),
          execute: (name, args) => executeTool(ctx, name, args),
        },
      );
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
