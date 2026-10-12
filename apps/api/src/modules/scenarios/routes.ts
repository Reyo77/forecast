import { Router } from 'express';
import { z } from 'zod';
import {
  LEVER_LABELS,
  leverInputSchema,
  scenarioInputSchema,
  scenarioPatchSchema,
  type AtRiskDto,
  type LeverDto,
  type LeverInput,
  type PlanKpisDto,
  type ScenarioDto,
  type ScenarioRunDto,
  type WeekTotal,
} from '@supplycast/shared';
import type { Scenario, ScenarioLever, ScenarioRun } from '@prisma/client';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import type { ScopedClient } from '../../db/scoped';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';
import { auditReq } from '../audit/service';
import { createWithinLimit } from '../billing/limits';
import { startScenarioRun } from './service';

const MAX_LEVERS = 20;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const num = (d: unknown) => Number(d ?? 0);

type Kpis = { baseline: PlanKpisDto; scenario: PlanKpisDto };

function leverSummary(
  l: { type: string; target: Record<string, unknown>; params: Record<string, unknown> },
  names: Map<string, string>,
): string {
  const t = l.target as Record<string, string>;
  const p = l.params as Record<string, number | string | undefined>;
  const scope = (x: Record<string, string>) =>
    x.scope === 'ALL' ? 'everything' : `${x.scope!.toLowerCase()} ${names.get(x.id!) ?? x.id}`;
  const range =
    p.startDate || p.endDate
      ? ` (${p.startDate ? String(p.startDate).slice(0, 10) : 'start'} → ${p.endDate ? String(p.endDate).slice(0, 10) : 'end'})`
      : '';
  switch (l.type) {
    case 'DEMAND_CHANGE':
      return `Demand ${Number(p.percent) >= 0 ? '+' : ''}${p.percent}% for ${scope(t)}${range}`;
    case 'SUPPLIER_DELAY':
      return `${names.get(t.supplierId!) ?? 'Supplier'} is ${p.extraDays} days late${range}`;
    case 'LEAD_TIME_CHANGE':
      return `Lead time becomes ${p.leadTimeDays} days (${names.get(t.supplierProductId!) ?? 'supplier link'})`;
    case 'CAPACITY_CAP':
      return `${names.get(t.supplierId!) ?? 'Supplier'} capped at ${p.weeklyQuantity} units/week`;
    case 'SERVICE_LEVEL':
      return `Target service level ${(Number(p.serviceLevel) * 100).toFixed(1)}%`;
    case 'PRICE_CHANGE':
      return `Price ${Number(p.percent) >= 0 ? '+' : ''}${p.percent}% for ${scope(t)} (elasticity ${p.elasticity ?? 1})${range}`;
    default:
      return l.type;
  }
}

export function scenarioRouter(guards: Guards): Router {
  const router = Router();
  const read = guards.tenant('scenario:read');
  const write = guards.tenant('scenario:write');

  async function names(db: ScopedClient): Promise<Map<string, string>> {
    const [products, categories, locations, suppliers, links] = await Promise.all([
      db.product.findMany({ select: { id: true, sku: true } }),
      db.category.findMany({ select: { id: true, name: true } }),
      db.location.findMany({ select: { id: true, code: true } }),
      db.supplier.findMany({ select: { id: true, name: true } }),
      db.supplierProduct.findMany({
        select: {
          id: true,
          supplier: { select: { name: true } },
          product: { select: { sku: true } },
        },
      }),
    ]);
    const m = new Map<string, string>();
    products.forEach((p) => m.set(p.id, p.sku));
    categories.forEach((c) => m.set(c.id, c.name));
    locations.forEach((l) => m.set(l.id, l.code));
    suppliers.forEach((s) => m.set(s.id, s.name));
    links.forEach((l) => m.set(l.id, `${l.supplier.name} / ${l.product.sku}`));
    return m;
  }

  /** Every id a lever points at must belong to the caller's tenant (404 otherwise). */
  async function assertLeverRefs(db: ScopedClient, lever: LeverInput) {
    const missing = () =>
      new HttpError(
        404,
        'NOT_FOUND',
        'A product, category, location or supplier in this lever was not found',
      );
    const t = lever.target as Record<string, string>;
    if (lever.type === 'DEMAND_CHANGE' || lever.type === 'PRICE_CHANGE') {
      const s = lever.target;
      if (s.scope === 'PRODUCT' && !(await db.product.findUnique({ where: { id: s.id } })))
        throw missing();
      if (s.scope === 'CATEGORY' && !(await db.category.findUnique({ where: { id: s.id } })))
        throw missing();
      if (s.scope === 'LOCATION' && !(await db.location.findUnique({ where: { id: s.id } })))
        throw missing();
    }
    if (
      (lever.type === 'SUPPLIER_DELAY' || lever.type === 'CAPACITY_CAP') &&
      !(await db.supplier.findUnique({ where: { id: t.supplierId! } }))
    )
      throw missing();
    if (
      lever.type === 'LEAD_TIME_CHANGE' &&
      !(await db.supplierProduct.findUnique({ where: { id: t.supplierProductId! } }))
    )
      throw missing();
  }

  const leverDto = (l: ScenarioLever, nm: Map<string, string>): LeverDto => ({
    id: l.id,
    type: l.type as LeverDto['type'],
    target: l.target as Record<string, unknown>,
    params: l.params as Record<string, unknown>,
    summary: `${LEVER_LABELS[l.type as keyof typeof LEVER_LABELS] ?? l.type}: ${leverSummary({ type: l.type, target: l.target as Record<string, unknown>, params: l.params as Record<string, unknown> }, nm)}`,
  });

  const scenarioDto = (
    s: Scenario & { _count?: { levers: number }; runs?: ScenarioRun[] },
  ): ScenarioDto => ({
    id: s.id,
    name: s.name,
    description: s.description,
    baseForecastRunId: s.baseForecastRunId,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    leverCount: s._count?.levers ?? 0,
    latestKpis: (s.runs?.[0]?.kpis as Kpis | null) ?? null,
  });

  const toRunDto = async (
    r: ScenarioRun,
    db: ScopedClient,
    withDetail: boolean,
  ): Promise<ScenarioRunDto> => {
    const nm = await names(db);
    let atRisk: ScenarioRunDto['atRisk'] = null;
    if (withDetail && r.atRisk) {
      const products = new Map(
        (await db.product.findMany({ select: { id: true, sku: true, name: true } })).map((p) => [
          p.id,
          p,
        ]),
      );
      const locations = new Map(
        (await db.location.findMany({ select: { id: true, code: true } })).map((l) => [
          l.id,
          l.code,
        ]),
      );
      const base = await db.scenario.findUnique({
        where: { id: r.scenarioId },
        select: { baseForecastRunId: true },
      });
      const run = base
        ? await db.forecastRun.findUnique({
            where: { id: base.baseForecastRunId },
            select: { asOfWeek: true },
          })
        : null;
      const week0 = (run?.asOfWeek?.getTime() ?? Date.now()) + 7 * 86400_000;
      const enrich = (rows: unknown): AtRiskDto[] =>
        (
          rows as {
            productId: string;
            locationId: string;
            firstStockoutWeek: number;
            shortage: number;
            revenueAtRiskCents: number;
          }[]
        ).map((a) => ({
          ...a,
          productSku: products.get(a.productId)?.sku ?? '?',
          productName: products.get(a.productId)?.name ?? '?',
          locationCode: locations.get(a.locationId) ?? '?',
          firstStockoutDate: isoDay(new Date(week0 + a.firstStockoutWeek * 7 * 86400_000)),
        }));
      const raw = r.atRisk as { baseline: unknown; scenario: unknown };
      atRisk = { baseline: enrich(raw.baseline), scenario: enrich(raw.scenario) };
    }
    return {
      id: r.id,
      scenarioId: r.scenarioId,
      status: r.status,
      error: r.error,
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      kpis: (r.kpis as Kpis | null) ?? null,
      atRisk,
      totals: withDetail
        ? ((r.totals as { baseline: WeekTotal[]; scenario: WeekTotal[] } | null) ?? null)
        : null,
      levers: (
        r.levers as {
          type: string;
          target: Record<string, unknown>;
          params: Record<string, unknown>;
        }[]
      ).map((l, i) => ({
        id: String(i),
        type: l.type as LeverDto['type'],
        target: l.target,
        params: l.params,
        summary: leverSummary(l, nm),
      })),
    };
  };

  async function findScenario(db: ScopedClient, id: string) {
    const s = await db.scenario.findUnique({ where: { id } });
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Scenario not found');
    return s;
  }
  async function assertBaseRun(db: ScopedClient, id: string) {
    const run = await db.forecastRun.findUnique({ where: { id } });
    if (!run) throw new HttpError(404, 'NOT_FOUND', 'Forecast run not found');
    if (run.status !== 'DONE')
      throw new HttpError(409, 'BASE_RUN_NOT_READY', 'Choose a finished forecast run as the base');
  }

  router.get('/scenarios', ...read, async (req, res, next) => {
    try {
      const p = paginationSchema.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.scenario.findMany({
          orderBy: { createdAt: 'desc' },
          include: {
            _count: { select: { levers: true } },
            runs: { where: { status: 'DONE' }, orderBy: { createdAt: 'desc' }, take: 1 },
          },
          ...skipTake(p),
        }),
        req.db!.scenario.count(),
      ]);
      res.json(paged(rows.map(scenarioDto), total, p));
    } catch (e) {
      next(e);
    }
  });

  // Must be registered before /scenarios/:id
  router.get('/scenarios/compare', ...read, async (req, res, next) => {
    try {
      const ids = z
        .string()
        .min(1)
        .parse(req.query.ids)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (new Set(ids).size !== ids.length)
        throw new HttpError(400, 'DUPLICATE_IDS', 'Each scenario can only be compared once');
      if (ids.length < 1 || ids.length > 3)
        throw new HttpError(400, 'TOO_MANY', 'Compare between 1 and 3 scenarios');
      const items = [];
      for (const id of ids) {
        const s = await findScenario(req.db!, id);
        const run = await req.db!.scenarioRun.findFirst({
          where: { scenarioId: s.id, status: 'DONE' },
          orderBy: { createdAt: 'desc' },
        });
        if (!run) throw new HttpError(409, 'NOT_RUN', `Scenario "${s.name}" has not been run yet`);
        items.push({ scenario: s, run });
      }
      if (new Set(items.map((i) => i.scenario.baseForecastRunId)).size > 1) {
        throw new HttpError(
          409,
          'DIFFERENT_BASE',
          'These scenarios use different base forecast runs, so their baselines differ. Compare scenarios built on the same run.',
        );
      }
      const first = await toRunDto(items[0]!.run, req.db!, true);
      res.json({
        baseline: {
          kpis: first.kpis!.baseline,
          atRisk: first.atRisk!.baseline,
          totals: first.totals!.baseline,
        },
        scenarios: await Promise.all(
          items.map(async (i) => {
            const d = await toRunDto(i.run, req.db!, true);
            return {
              id: i.scenario.id,
              name: i.scenario.name,
              runId: i.run.id,
              kpis: d.kpis!.scenario,
              atRisk: d.atRisk!.scenario,
              totals: d.totals!.scenario,
              levers: d.levers,
            };
          }),
        ),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/scenarios', ...write, async (req, res, next) => {
    try {
      const input = scenarioInputSchema.parse(req.body);
      await assertBaseRun(req.db!, input.baseForecastRunId);
      const s = await createWithinLimit(req.tenantId!, 'scenarios', (tx) =>
        (tx as unknown as ScopedClient).scenario.create({
          data: {
            tenantId: req.tenantId!,
            name: input.name,
            description: input.description ?? null,
            baseForecastRunId: input.baseForecastRunId,
            createdBy: req.auth!.userId,
          } as never,
        }),
      );
      await auditReq(req, 'scenario.created', 'Scenario', s.id, { name: s.name });
      res.status(201).json({ scenario: scenarioDto(s) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/scenarios/:id', ...read, async (req, res, next) => {
    try {
      const s = await findScenario(req.db!, req.params.id!);
      const [levers, nm, latest] = await Promise.all([
        req.db!.scenarioLever.findMany({
          where: { scenarioId: s.id },
          orderBy: { createdAt: 'asc' },
        }),
        names(req.db!),
        req.db!.scenarioRun.findFirst({
          where: { scenarioId: s.id },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      res.json({
        scenario: { ...scenarioDto({ ...s, _count: { levers: levers.length } }) },
        levers: levers.map((l) => leverDto(l, nm)),
        latestRun: latest ? await toRunDto(latest, req.db!, latest.status === 'DONE') : null,
      });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/scenarios/:id', ...write, async (req, res, next) => {
    try {
      const input = scenarioPatchSchema.parse(req.body);
      const s = await findScenario(req.db!, req.params.id!);
      if (input.baseForecastRunId) await assertBaseRun(req.db!, input.baseForecastRunId);
      const updated = await req.db!.scenario.update({
        where: { id: s.id },
        data: { ...input, ...(input.baseForecastRunId && { status: 'DRAFT' }) },
      });
      res.json({ scenario: scenarioDto(updated) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/scenarios/:id', ...write, async (req, res, next) => {
    try {
      const s = await findScenario(req.db!, req.params.id!);
      await req.db!.scenario.delete({ where: { id: s.id } });
      await auditReq(req, 'scenario.deleted', 'Scenario', s.id, { name: s.name });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Levers ----------------
  const serializeLever = (l: LeverInput) =>
    JSON.parse(JSON.stringify({ target: l.target, params: l.params })) as {
      target: Record<string, unknown>;
      params: Record<string, unknown>;
    };

  router.post('/scenarios/:id/levers', ...write, async (req, res, next) => {
    try {
      const lever = leverInputSchema.parse(req.body);
      const s = await findScenario(req.db!, req.params.id!);
      if ((await req.db!.scenarioLever.count({ where: { scenarioId: s.id } })) >= MAX_LEVERS)
        throw new HttpError(
          409,
          'TOO_MANY_LEVERS',
          `A scenario can have at most ${MAX_LEVERS} levers`,
        );
      await assertLeverRefs(req.db!, lever);
      const created = await req.db!.scenarioLever.create({
        data: { scenarioId: s.id, type: lever.type, ...serializeLever(lever) } as never,
      });
      await req.db!.scenario.update({ where: { id: s.id }, data: { status: 'DRAFT' } });
      res.status(201).json({ lever: leverDto(created, await names(req.db!)) });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/scenarios/:id/levers/:leverId', ...write, async (req, res, next) => {
    try {
      const lever = leverInputSchema.parse(req.body);
      const s = await findScenario(req.db!, req.params.id!);
      const existing = await req.db!.scenarioLever.findFirst({
        where: { id: req.params.leverId!, scenarioId: s.id },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Lever not found');
      await assertLeverRefs(req.db!, lever);
      const updated = await req.db!.scenarioLever.update({
        where: { id: existing.id },
        data: { type: lever.type, ...serializeLever(lever) } as never,
      });
      await req.db!.scenario.update({ where: { id: s.id }, data: { status: 'DRAFT' } });
      res.json({ lever: leverDto(updated, await names(req.db!)) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/scenarios/:id/levers/:leverId', ...write, async (req, res, next) => {
    try {
      const s = await findScenario(req.db!, req.params.id!);
      const existing = await req.db!.scenarioLever.findFirst({
        where: { id: req.params.leverId!, scenarioId: s.id },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Lever not found');
      await req.db!.scenarioLever.delete({ where: { id: existing.id } });
      await req.db!.scenario.update({ where: { id: s.id }, data: { status: 'DRAFT' } });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Runs ----------------
  router.post('/scenarios/:id/run', ...write, async (req, res, next) => {
    try {
      await findScenario(req.db!, req.params.id!);
      const run = await startScenarioRun(req.tenantId!, req.params.id!, req.auth!.userId);
      await auditReq(req, 'scenario.run_started', 'Scenario', req.params.id!, { runId: run.id });
      res.status(202).json({ run: await toRunDto(run, req.db!, false) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/scenarios/:id/runs', ...read, async (req, res, next) => {
    try {
      const s = await findScenario(req.db!, req.params.id!);
      const p = paginationSchema.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.scenarioRun.findMany({
          where: { scenarioId: s.id },
          orderBy: { createdAt: 'desc' },
          ...skipTake(p),
        }),
        req.db!.scenarioRun.count({ where: { scenarioId: s.id } }),
      ]);
      res.json(paged(await Promise.all(rows.map((r) => toRunDto(r, req.db!, false))), total, p));
    } catch (e) {
      next(e);
    }
  });

  router.get('/scenario-runs/:id', ...read, async (req, res, next) => {
    try {
      const r = await req.db!.scenarioRun.findUnique({ where: { id: req.params.id! } });
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'Scenario run not found');
      res.json({ run: await toRunDto(r, req.db!, r.status === 'DONE') });
    } catch (e) {
      next(e);
    }
  });

  // Per-week baseline vs scenario for one product (summed over locations unless one is given).
  router.get('/scenario-runs/:id/series', ...read, async (req, res, next) => {
    try {
      const r = await req.db!.scenarioRun.findUnique({ where: { id: req.params.id! } });
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'Scenario run not found');
      const q = z
        .object({ productId: z.string().min(1).max(64), locationId: z.string().max(64).optional() })
        .parse(req.query);
      const product = await req.db!.product.findUnique({ where: { id: q.productId } });
      if (!product) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
      if (q.locationId && !(await req.db!.location.findUnique({ where: { id: q.locationId } })))
        throw new HttpError(404, 'NOT_FOUND', 'Location not found');
      const rows = await req.db!.scenarioResult.findMany({
        where: {
          scenarioRunId: r.id,
          productId: product.id,
          ...(q.locationId && { locationId: q.locationId }),
        },
        orderBy: { weekStart: 'asc' },
      });
      const weeks = new Map<
        string,
        { weekStart: string; baseline: Record<string, number>; scenario: Record<string, number> }
      >();
      for (const row of rows) {
        const key = isoDay(row.weekStart);
        const w = weeks.get(key) ?? {
          weekStart: key,
          baseline: { demand: 0, receipts: 0, onHand: 0, shortage: 0 },
          scenario: { demand: 0, receipts: 0, onHand: 0, shortage: 0 },
        };
        const target = row.variant === 'BASELINE' ? w.baseline : w.scenario;
        target.demand! += num(row.demand);
        target.receipts! += num(row.receipts);
        target.onHand! += num(row.projectedOnHand);
        target.shortage! += num(row.shortage);
        weeks.set(key, w);
      }
      res.json({
        product: { id: product.id, sku: product.sku, name: product.name },
        weeks: [...weeks.values()],
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
