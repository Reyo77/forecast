import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import { densify } from '../../engines/forecast/series';
import type { SupplierTerms } from '../../engines/planning/plan';
import type { PlanResult } from '../../engines/planning/plan';
import { enqueueJob } from '../../jobs/runner';
import { registerLiveCounter } from '../billing/limits';
import { notifyUser } from '../notifications/service';
import {
  computeScenario,
  HISTORY_WEEKS,
  weeklyTotals,
  type PersistedLever,
  type PlanningData,
} from './compute';

export const SCENARIO_RUN_JOB = 'scenario.run';
const WEEK = 7 * 86400_000;
const MAX_STORED_ROWS = 200;

registerLiveCounter('scenarios', (tenantId, db) => db.scenario.count({ where: { tenantId } }));

/** Loads forecast (with overrides), history, stock, orders, suppliers and BOM for a base forecast run. */
export async function loadPlanningData(tenantId: string, baseRunId: string): Promise<PlanningData> {
  const run = await prisma.forecastRun.findFirst({
    where: { id: baseRunId, tenantId, status: 'DONE' },
  });
  if (!run || !run.asOfWeek) throw new Error('The base forecast run is missing or not finished');
  const T = run.horizonWeeks;
  const asOf = run.asOfWeek.getTime();
  const weekStarts = Array.from({ length: T }, (_, i) => new Date(asOf + (i + 1) * WEEK));
  const idx = (d: Date) => Math.round((d.getTime() - weekStarts[0]!.getTime()) / WEEK);

  const results = await prisma.forecastResult.findMany({
    where: { runId: run.id },
    select: { productId: true, locationId: true, weekStart: true, quantity: true },
  });
  if (results.length === 0) throw new Error('The base forecast run has no results');
  const independentDemand = new Map<string, number[]>();
  for (const r of results) {
    const key = `${r.productId}|${r.locationId}`;
    const arr = independentDemand.get(key) ?? new Array<number>(T).fill(0);
    const i = idx(r.weekStart);
    if (i >= 0 && i < T) arr[i] = Number(r.quantity);
    independentDemand.set(key, arr);
  }
  // Planner overrides replace the model forecast.
  const overrides = await prisma.forecastOverride.findMany({
    where: { tenantId, weekStart: { gte: weekStarts[0]!, lte: weekStarts[T - 1]! } },
  });
  for (const o of overrides) {
    const arr = independentDemand.get(`${o.productId}|${o.locationId}`);
    const i = idx(o.weekStart);
    if (arr && i >= 0 && i < T) arr[i] = Number(o.quantity);
  }

  const histFrom = new Date(asOf - (HISTORY_WEEKS - 1) * WEEK);
  const sales = await prisma.salesRecord.findMany({
    where: { tenantId, date: { gte: histFrom, lte: run.asOfWeek } },
    select: { productId: true, locationId: true, date: true, quantity: true },
  });
  const byKey = new Map<string, { weekStart: number; quantity: number }[]>();
  for (const s of sales) {
    const key = `${s.productId}|${s.locationId}`;
    if (!independentDemand.has(key)) continue;
    const list = byKey.get(key) ?? [];
    list.push({ weekStart: s.date.getTime(), quantity: Number(s.quantity) });
    byKey.set(key, list);
  }
  const history = new Map<string, number[]>();
  for (const [key, pts] of byKey) {
    // Align every series to the same HISTORY_WEEKS window ending at the last data week.
    const dense = densify([...pts, { weekStart: histFrom.getTime(), quantity: 0 }], asOf);
    history.set(key, dense.values.slice(-HISTORY_WEEKS));
  }

  const [products, inventory, orders, links, bom, categories] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId },
      select: {
        id: true,
        unitCostCents: true,
        unitPriceCents: true,
        categoryId: true,
        category: { select: { parentId: true } },
      },
    }),
    prisma.inventoryLevel.findMany({ where: { tenantId } }),
    prisma.openOrder.findMany({ where: { tenantId } }),
    prisma.supplierProduct.findMany({
      where: { tenantId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.bomItem.findMany({ where: { tenantId } }),
    Promise.resolve(null),
  ]);
  void categories;
  const terms = new Map<string, SupplierTerms>();
  for (const l of links) {
    if (!terms.has(l.productId))
      terms.set(l.productId, {
        supplierId: l.supplierId,
        leadTimeDays: l.leadTimeDays,
        minOrderQty: Number(l.minOrderQty),
        weeklyCapacity: l.weeklyCapacity === null ? null : Number(l.weeklyCapacity),
      });
  }
  return {
    weekStarts,
    independentDemand,
    history,
    products: new Map(
      products.map((p) => [
        p.id,
        { unitCostCents: p.unitCostCents, unitPriceCents: p.unitPriceCents },
      ]),
    ),
    inventory: new Map(
      inventory.map((i) => [
        `${i.productId}|${i.locationId}`,
        { onHand: Number(i.onHand), safetyStock: Number(i.safetyStock) },
      ]),
    ),
    openOrders: orders.map((o) => ({
      key: `${o.productId}|${o.locationId}`,
      week: idx(o.expectedDate),
      quantity: Number(o.quantity),
      supplierId: o.supplierId,
    })),
    terms,
    bomEdges: bom.map((b) => ({
      parentId: b.parentProductId,
      componentId: b.componentProductId,
      quantityPer: Number(b.quantityPer),
    })),
    catalog: {
      categories: new Map(
        products.map((p) => [
          p.id,
          { categoryId: p.categoryId, parentId: p.category?.parentId ?? null },
        ]),
      ),
    },
    supplierProducts: new Map(
      links.map((l) => [l.id, { supplierId: l.supplierId, productId: l.productId }]),
    ),
  };
}

const sortedAtRisk = (r: PlanResult) =>
  r.atRisk.slice(0, MAX_STORED_ROWS).map((a) => ({
    productId: a.productId,
    locationId: a.locationId,
    firstStockoutWeek: a.firstStockoutWeek,
    shortage: a.shortage,
    revenueAtRiskCents: a.revenueAtRiskCents,
  }));

/** Job body: compute baseline + scenario plans from the base forecast and store results and KPIs. */
export async function processScenarioRun(runId: string, now = new Date()): Promise<void> {
  const run = await prisma.scenarioRun.findUnique({
    where: { id: runId },
    include: { scenario: true },
  });
  if (!run) throw new Error(`Scenario run ${runId} not found`);
  if (run.status === 'DONE') return;
  await prisma.scenarioRun.update({
    where: { id: run.id },
    data: { status: 'RUNNING', startedAt: now, error: null },
  });
  await prisma.scenario.update({ where: { id: run.scenarioId }, data: { status: 'RUNNING' } });
  try {
    const data = await loadPlanningData(run.tenantId, run.scenario.baseForecastRunId);
    const { baseline, scenario } = computeScenario(data, run.levers as unknown as PersistedLever[]);

    await prisma.scenarioResult.deleteMany({ where: { scenarioRunId: run.id } });
    const rows: Prisma.ScenarioResultCreateManyInput[] = [];
    for (const [variant, result] of [
      ['BASELINE', baseline],
      ['SCENARIO', scenario],
    ] as const) {
      for (const n of result.nodes) {
        data.weekStarts.forEach((w, t) =>
          rows.push({
            tenantId: run.tenantId,
            scenarioRunId: run.id,
            variant,
            productId: n.productId,
            locationId: n.locationId,
            weekStart: w,
            demand: n.demand[t]!,
            receipts: n.receipts[t]!,
            projectedOnHand: n.onHand[t]!,
            shortage: n.shortage[t]!,
          }),
        );
      }
    }
    for (let i = 0; i < rows.length; i += 2000)
      await prisma.scenarioResult.createMany({ data: rows.slice(i, i + 2000) });

    const planned = scenario.nodes
      .flatMap((n) => n.plannedOrders)
      .sort((a, b) => a.orderWeek - b.orderWeek)
      .slice(0, 300);
    await prisma.scenarioRun.update({
      where: { id: run.id },
      data: {
        status: 'DONE',
        finishedAt: new Date(),
        kpis: { baseline: baseline.kpis, scenario: scenario.kpis } as never,
        atRisk: { baseline: sortedAtRisk(baseline), scenario: sortedAtRisk(scenario) } as never,
        totals: {
          baseline: weeklyTotals(baseline, data.weekStarts),
          scenario: weeklyTotals(scenario, data.weekStarts),
        } as never,
        plannedOrders: planned as never,
      },
    });
    await prisma.scenario.update({ where: { id: run.scenarioId }, data: { status: 'READY' } });
    await notifyUser(
      run.tenantId,
      run.createdBy,
      'scenario.done',
      'Scenario run finished',
      `"${run.scenario.name}" is ready to review.`,
    );
  } catch (err) {
    await prisma.scenarioRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: (err as Error).message.slice(0, 2000),
      },
    });
    await prisma.scenario.update({ where: { id: run.scenarioId }, data: { status: 'FAILED' } });
    throw err;
  }
}

export async function startScenarioRun(tenantId: string, scenarioId: string, userId: string) {
  const scenario = await prisma.scenario.findFirst({
    where: { id: scenarioId, tenantId },
    include: { levers: true },
  });
  if (!scenario) throw new HttpError(404, 'NOT_FOUND', 'Scenario not found');
  const base = await prisma.forecastRun.findFirst({
    where: { id: scenario.baseForecastRunId, tenantId },
  });
  if (!base || base.status !== 'DONE')
    throw new HttpError(409, 'BASE_RUN_NOT_READY', 'The base forecast run is not finished');
  const run = await prisma.scenarioRun.create({
    data: {
      tenantId,
      scenarioId,
      levers: scenario.levers.map((l) => ({
        type: l.type,
        target: l.target,
        params: l.params,
      })) as never,
      createdBy: userId,
    },
  });
  await prisma.scenario.update({ where: { id: scenarioId }, data: { status: 'RUNNING' } });
  await enqueueJob({ type: SCENARIO_RUN_JOB, tenantId, payload: { scenarioRunId: run.id } });
  return run;
}
