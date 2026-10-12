import type { LeverInput } from '@supplycast/shared';
import { explodeDemand, type BomEdge } from '../../engines/planning/bom';
import {
  applyDemandLevers,
  applySupplyLevers,
  type Catalog,
  type ResolvedLever,
  type Scope,
} from '../../engines/planning/levers';
import {
  DEFAULT_COVER_WEEKS,
  runPlan,
  type NodeInput,
  type PlanInput,
  type PlanResult,
  type SupplierTerms,
} from '../../engines/planning/plan';
import { stdDev } from '../../engines/planning/stats';

const WEEK = 7 * 86400_000;
export const HISTORY_WEEKS = 26;
export const DEFAULT_SERVICE_LEVEL = 0.95;
export const DEFAULT_TERMS: SupplierTerms = {
  supplierId: null,
  leadTimeDays: 14,
  minOrderQty: 1,
  weeklyCapacity: null,
};

/** Everything the planning engine needs, loaded from the database (or built by hand in tests). */
export interface PlanningData {
  weekStarts: Date[];
  /** Forecast (with overrides applied) of independent demand, key = `${productId}|${locationId}`. */
  independentDemand: Map<string, number[]>;
  /** Recent weekly sales (HISTORY_WEEKS long) for the same keys, used for σ. */
  history: Map<string, number[]>;
  products: Map<string, { unitCostCents: number; unitPriceCents: number }>;
  inventory: Map<string, { onHand: number; safetyStock: number }>;
  openOrders: { key: string; week: number; quantity: number; supplierId: string | null }[];
  terms: Map<string, SupplierTerms>; // by productId
  bomEdges: BomEdge[];
  catalog: Catalog;
  supplierProducts: Map<string, { supplierId: string; productId: string }>;
  serviceLevel?: number;
  coverWeeks?: number;
}

export interface PersistedLever {
  type: LeverInput['type'];
  target: Record<string, unknown>;
  params: Record<string, unknown>;
}

const weeks = (d: PlanningData) => d.weekStarts.length;

export function buildPlanInput(
  data: PlanningData,
  independentDemand: Map<string, number[]>,
): PlanInput {
  const T = weeks(data);
  const exploded = explodeDemand(data.bomEdges, independentDemand, T);
  const history = explodeDemand(data.bomEdges, data.history, HISTORY_WEEKS);
  const keys = new Set<string>([
    ...exploded.keys(),
    ...data.inventory.keys(),
    ...data.openOrders.map((o) => o.key),
  ]);
  const nodes: NodeInput[] = [];
  for (const key of [...keys].sort()) {
    const [productId, locationId] = key.split('|') as [string, string];
    const product = data.products.get(productId);
    if (!product) continue;
    const inv = data.inventory.get(key);
    nodes.push({
      productId,
      locationId,
      unitCostCents: product.unitCostCents,
      unitPriceCents: product.unitPriceCents,
      onHand: inv?.onHand ?? 0,
      configuredSafetyStock: inv?.safetyStock ?? 0,
      demand: exploded.get(key) ?? new Array<number>(T).fill(0),
      sigma: stdDev(history.get(key) ?? []),
      openReceipts: data.openOrders
        .filter((o) => o.key === key)
        .map((o) => ({ week: o.week, quantity: o.quantity, supplierId: o.supplierId })),
      terms: data.terms.get(productId) ?? DEFAULT_TERMS,
    });
  }
  return {
    weeks: T,
    serviceLevel: data.serviceLevel ?? DEFAULT_SERVICE_LEVEL,
    coverWeeks: data.coverWeeks ?? DEFAULT_COVER_WEEKS,
    nodes,
  };
}

/** Index of the planning week containing `date`, as an integer (can be negative or ≥ weeks). */
export function weekIndex(data: PlanningData, date: Date): number {
  return Math.floor((date.getTime() - data.weekStarts[0]!.getTime()) / WEEK);
}

function resolveRange(
  data: PlanningData,
  startDate?: unknown,
  endDate?: unknown,
): { startWeek?: number; endWeek?: number } {
  const T = weeks(data);
  let startWeek: number | undefined;
  let endWeek: number | undefined;
  if (startDate) startWeek = Math.max(0, weekIndex(data, new Date(startDate as string)));
  if (endDate) endWeek = Math.min(T - 1, weekIndex(data, new Date(endDate as string)));
  // A window completely outside the horizon affects nothing: make it empty.
  if (startWeek !== undefined && startWeek > T - 1) return { startWeek: T, endWeek: T - 1 };
  if (endWeek !== undefined && endWeek < 0) return { startWeek: 1, endWeek: 0 };
  return { startWeek, endWeek };
}

/** Converts stored levers (dates, supplier-product links) into week-indexed levers for the engine. */
export function resolveLevers(levers: PersistedLever[], data: PlanningData): ResolvedLever[] {
  const out: ResolvedLever[] = [];
  for (const l of levers) {
    const p = l.params as Record<string, number | string | undefined>;
    const t = l.target as Record<string, string>;
    switch (l.type) {
      case 'DEMAND_CHANGE':
        out.push({
          type: 'DEMAND_CHANGE',
          target: t as unknown as Scope,
          percent: Number(p.percent),
          ...resolveRange(data, p.startDate, p.endDate),
        });
        break;
      case 'PRICE_CHANGE':
        out.push({
          type: 'PRICE_CHANGE',
          target: t as unknown as Scope,
          percent: Number(p.percent),
          elasticity: Number(p.elasticity ?? 1),
          ...resolveRange(data, p.startDate, p.endDate),
        });
        break;
      case 'SUPPLIER_DELAY':
        out.push({
          type: 'SUPPLIER_DELAY',
          supplierId: t.supplierId!,
          extraDays: Number(p.extraDays),
          ...resolveRange(data, p.startDate, p.endDate),
        });
        break;
      case 'LEAD_TIME_CHANGE': {
        const link = data.supplierProducts.get(t.supplierProductId!);
        if (link)
          out.push({
            type: 'LEAD_TIME_CHANGE',
            supplierId: link.supplierId,
            productId: link.productId,
            leadTimeDays: Number(p.leadTimeDays),
          });
        break;
      }
      case 'CAPACITY_CAP':
        out.push({
          type: 'CAPACITY_CAP',
          supplierId: t.supplierId!,
          weeklyQuantity: Number(p.weeklyQuantity),
        });
        break;
      case 'SERVICE_LEVEL':
        out.push({ type: 'SERVICE_LEVEL', serviceLevel: Number(p.serviceLevel) });
        break;
    }
  }
  return out;
}

export interface ScenarioComputation {
  baseline: PlanResult;
  scenario: PlanResult;
}

/** Baseline (no levers) and scenario plans from the same data, so the comparison is fair. */
export function computeScenario(data: PlanningData, levers: PersistedLever[]): ScenarioComputation {
  const resolved = resolveLevers(levers, data);
  const T = weeks(data);
  const baselineInput = buildPlanInput(data, data.independentDemand);
  const demand = applyDemandLevers(data.independentDemand, resolved, data.catalog, T);
  const scenarioInput = applySupplyLevers(buildPlanInput(data, demand), resolved, data.catalog);
  return { baseline: runPlan(baselineInput), scenario: runPlan(scenarioInput) };
}

export interface WeekTotals {
  weekStart: string;
  demand: number;
  onHand: number;
  shortage: number;
}

export function weeklyTotals(result: PlanResult, weekStarts: Date[]): WeekTotals[] {
  return weekStarts.map((w, t) => ({
    weekStart: w.toISOString().slice(0, 10),
    demand: result.nodes.reduce((s, n) => s + n.demand[t]!, 0),
    onHand: result.nodes.reduce((s, n) => s + n.onHand[t]!, 0),
    shortage: result.nodes.reduce((s, n) => s + n.shortage[t]!, 0),
  }));
}
