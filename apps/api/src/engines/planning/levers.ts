import type { NodeInput, PlanInput } from './plan';

export type Scope = { scope: 'ALL' } | { scope: 'PRODUCT' | 'CATEGORY' | 'LOCATION'; id: string };

/** Levers with dates already converted to week indexes of the planning horizon (inclusive; undefined = open ended). */
export type ResolvedLever =
  | { type: 'DEMAND_CHANGE'; target: Scope; percent: number; startWeek?: number; endWeek?: number }
  | {
      type: 'SUPPLIER_DELAY';
      supplierId: string;
      extraDays: number;
      startWeek?: number;
      endWeek?: number;
    }
  | { type: 'LEAD_TIME_CHANGE'; supplierId: string; productId: string; leadTimeDays: number }
  | { type: 'CAPACITY_CAP'; supplierId: string; weeklyQuantity: number }
  | { type: 'SERVICE_LEVEL'; serviceLevel: number }
  | {
      type: 'PRICE_CHANGE';
      target: Scope;
      percent: number;
      elasticity: number;
      startWeek?: number;
      endWeek?: number;
    };

export interface Catalog {
  /** productId → its category id and parent category id (if any). */
  categories: Map<string, { categoryId: string | null; parentId: string | null }>;
}

export function matchesScope(
  scope: Scope,
  productId: string,
  locationId: string,
  catalog: Catalog,
): boolean {
  switch (scope.scope) {
    case 'ALL':
      return true;
    case 'PRODUCT':
      return productId === scope.id;
    case 'LOCATION':
      return locationId === scope.id;
    case 'CATEGORY': {
      const c = catalog.categories.get(productId);
      return !!c && (c.categoryId === scope.id || c.parentId === scope.id);
    }
  }
}

const inRange = (t: number, start?: number, end?: number) =>
  (start === undefined || t >= start) && (end === undefined || t <= end);

/** Share of the horizon covered by [start, end], used to blend a price change into revenue valuation. */
const coverage = (weeks: number, start?: number, end?: number) => {
  let n = 0;
  for (let t = 0; t < weeks; t++) if (inRange(t, start, end)) n++;
  return weeks ? n / weeks : 0;
};

/**
 * Stage 1: demand-side levers (DEMAND_CHANGE, PRICE_CHANGE elasticity) applied to *independent*
 * demand, before it is exploded through the BOM. Returns a new map.
 */
export function applyDemandLevers(
  demand: Map<string, number[]>,
  levers: ResolvedLever[],
  catalog: Catalog,
  weeks: number,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [key, series] of demand) {
    const [productId, locationId] = key.split('|') as [string, string];
    const next = Array.from({ length: weeks }, (_, t) => series[t] ?? 0);
    for (const lever of levers) {
      if (lever.type === 'DEMAND_CHANGE') {
        if (!matchesScope(lever.target, productId, locationId, catalog)) continue;
        for (let t = 0; t < weeks; t++)
          if (inRange(t, lever.startWeek, lever.endWeek))
            next[t]! *= Math.max(0, 1 + lever.percent / 100);
      } else if (lever.type === 'PRICE_CHANGE') {
        if (!matchesScope(lever.target, productId, locationId, catalog)) continue;
        // Linear elasticity: +10% price with elasticity 1.5 → −15% demand.
        const factor = Math.max(0, 1 - (lever.elasticity * lever.percent) / 100);
        for (let t = 0; t < weeks; t++)
          if (inRange(t, lever.startWeek, lever.endWeek)) next[t]! *= factor;
      }
    }
    out.set(key, next);
  }
  return out;
}

/** Stage 2: supply-side levers and price valuation applied to the plan input. Returns a deep copy. */
export function applySupplyLevers(
  input: PlanInput,
  levers: ResolvedLever[],
  catalog: Catalog,
): PlanInput {
  const nodes: NodeInput[] = input.nodes.map((n) => ({
    ...n,
    demand: [...n.demand],
    openReceipts: n.openReceipts.map((r) => ({ ...r })),
    terms: { ...n.terms },
    extraLeadDays: n.extraLeadDays ? [...n.extraLeadDays] : undefined,
  }));
  let serviceLevel = input.serviceLevel;
  const T = input.weeks;

  for (const lever of levers) {
    switch (lever.type) {
      case 'SERVICE_LEVEL':
        serviceLevel = lever.serviceLevel;
        break;
      case 'SUPPLIER_DELAY': {
        const shift = Math.max(1, Math.ceil(lever.extraDays / 7 - 1e-9));
        for (const n of nodes) {
          if (n.terms.supplierId === lever.supplierId) {
            const extra = n.extraLeadDays ?? new Array<number>(T).fill(0);
            for (let t = 0; t < T; t++)
              if (inRange(t, lever.startWeek, lever.endWeek)) extra[t]! += lever.extraDays;
            n.extraLeadDays = extra;
          }
          // Open orders from the delayed supplier that were due in the window arrive later.
          n.openReceipts = n.openReceipts
            .map((r) =>
              r.supplierId === lever.supplierId &&
              inRange(Math.max(0, r.week), lever.startWeek, lever.endWeek)
                ? { ...r, week: Math.max(0, r.week) + shift }
                : r,
            )
            .filter((r) => r.week < T);
        }
        break;
      }
      case 'LEAD_TIME_CHANGE':
        for (const n of nodes)
          if (n.productId === lever.productId && n.terms.supplierId === lever.supplierId)
            n.terms.leadTimeDays = lever.leadTimeDays;
        break;
      case 'CAPACITY_CAP':
        for (const n of nodes) {
          if (n.terms.supplierId === lever.supplierId)
            n.terms.weeklyCapacity =
              n.terms.weeklyCapacity === null
                ? lever.weeklyQuantity
                : Math.min(n.terms.weeklyCapacity, lever.weeklyQuantity);
        }
        break;
      case 'PRICE_CHANGE':
        for (const n of nodes) {
          if (matchesScope(lever.target, n.productId, n.locationId, catalog)) {
            n.unitPriceCents =
              n.unitPriceCents *
              (1 + (lever.percent / 100) * coverage(T, lever.startWeek, lever.endWeek));
          }
        }
        break;
      case 'DEMAND_CHANGE':
        break; // handled in stage 1
    }
  }
  return { ...input, serviceLevel, nodes };
}
