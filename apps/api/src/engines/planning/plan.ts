import { roundUpToMoq, zScore } from './stats';

export interface SupplierTerms {
  supplierId: string | null;
  leadTimeDays: number;
  minOrderQty: number;
  weeklyCapacity: number | null;
}

export interface OpenReceipt {
  /** Week index the order is expected in; anything before week 0 (late orders) lands in week 0. */
  week: number;
  quantity: number;
  supplierId: string | null;
}

export interface NodeInput {
  productId: string;
  locationId: string;
  unitCostCents: number;
  unitPriceCents: number;
  onHand: number;
  /** Safety stock configured on the inventory level; the computed value is used when larger. */
  configuredSafetyStock: number;
  demand: number[];
  /** Standard deviation of weekly demand. */
  sigma: number;
  openReceipts: OpenReceipt[];
  terms: SupplierTerms;
  /** Extra lead-time days by order week (supplier delays); defaults to none. */
  extraLeadDays?: number[];
}

export interface PlanInput {
  weeks: number;
  serviceLevel: number;
  /** Weeks of demand to order beyond the lead time ("order up to" target). */
  coverWeeks: number;
  nodes: NodeInput[];
}

export interface PlannedOrder {
  productId: string;
  locationId: string;
  orderWeek: number;
  arrivalWeek: number;
  quantity: number;
  supplierId: string | null;
}

export interface NodeResult {
  productId: string;
  locationId: string;
  demand: number[];
  /** Open + planned receipts per week. */
  receipts: number[];
  onHand: number[];
  shortage: number[];
  safetyStock: number;
  leadWeeks: number;
  plannedOrders: PlannedOrder[];
}

export interface PlanKpis {
  stockoutWeeks: number;
  fillRate: number;
  avgInventoryValueCents: number;
  revenueAtRiskCents: number;
  plannedOrders: number;
  totalDemand: number;
  totalShortage: number;
}

export interface AtRiskRow {
  productId: string;
  locationId: string;
  firstStockoutWeek: number;
  shortage: number;
  revenueAtRiskCents: number;
}

export interface PlanResult {
  nodes: NodeResult[];
  kpis: PlanKpis;
  atRisk: AtRiskRow[];
}

const sum = (xs: number[], from: number, to: number) => {
  let s = 0;
  for (let i = Math.max(0, from); i <= to && i < xs.length; i++) s += xs[i]!;
  return s;
};

/** Lead time in whole weeks (at least 1). */
export const leadWeeks = (days: number) => Math.max(1, Math.ceil(days / 7 - 1e-9));

export const DEFAULT_COVER_WEEKS = 4;

/**
 * Weekly inventory projection for one product/location.
 *
 *   onHand[t] = onHand[t-1] + receipts[t] − demand[t] + shortage[t]      (shortage[t] ≥ 0, onHand[t] ≥ 0)
 *
 * When the projected stock would go negative the gap is recorded as a shortage (lost sales) and stock
 * is set to 0. At the start of each week the engine projects the position at the moment an order
 * placed now would arrive; if it is below safety stock it orders up to
 * `safety + cover weeks of demand`, rounded up to the MOQ, capped by weekly capacity.
 */
export function planNode(
  node: NodeInput,
  weeks: number,
  serviceLevel: number,
  coverWeeks: number,
): NodeResult {
  const T = weeks;
  const demand = Array.from({ length: T }, (_, t) => Math.max(0, node.demand[t] ?? 0));
  const baseLead = leadWeeks(node.terms.leadTimeDays);
  const z = zScore(serviceLevel);
  const computedSafety = z * Math.max(0, node.sigma) * Math.sqrt(baseLead);
  const safetyStock = Math.max(computedSafety, node.configuredSafetyStock, 0);

  const open = new Array<number>(T).fill(0);
  for (const r of node.openReceipts) {
    const w = Math.min(T - 1, Math.max(0, Math.floor(r.week)));
    if (T > 0 && r.week < T) open[w]! += Math.max(0, r.quantity);
  }
  const planned = new Array<number>(T).fill(0);
  const receipts = () => open.map((v, i) => v + planned[i]!);
  const tail = demand.length
    ? demand.slice(-Math.min(4, demand.length)).reduce((a, b) => a + b, 0) /
      Math.min(4, demand.length)
    : 0;
  const demandAt = (w: number) => (w < T ? demand[w]! : tail);
  const demandSum = (from: number, to: number) => {
    let s = 0;
    for (let w = from; w <= to; w++) s += demandAt(w);
    return s;
  };

  const onHand: number[] = [];
  const shortage: number[] = [];
  const plannedOrders: PlannedOrder[] = [];
  let prev = Math.max(0, node.onHand);

  for (let t = 0; t < T; t++) {
    const rec = open[t]! + planned[t]!;
    const stock = prev + rec;

    // --- ordering decision at the start of week t ---
    const hasDemand = demand.some((d) => d > 0);
    if (hasDemand) {
      const extra = node.extraLeadDays?.[t] ?? 0;
      const L = leadWeeks(node.terms.leadTimeDays + extra);
      const arrival = t + L;
      if (arrival < T) {
        const r = receipts();
        const position = stock + sum(r, t + 1, arrival) - demandSum(t, arrival - 1);
        if (position < safetyStock - 1e-9) {
          const target = safetyStock + demandSum(arrival, arrival + coverWeeks - 1);
          let qty = roundUpToMoq(target - position, node.terms.minOrderQty);
          if (node.terms.weeklyCapacity !== null) {
            qty = Math.min(qty, Math.max(0, node.terms.weeklyCapacity - planned[arrival]!));
          }
          if (qty > 1e-9) {
            planned[arrival]! += qty;
            plannedOrders.push({
              productId: node.productId,
              locationId: node.locationId,
              orderWeek: t,
              arrivalWeek: arrival,
              quantity: qty,
              supplierId: node.terms.supplierId,
            });
          }
        }
      }
    }

    // --- consume demand ---
    const available = stock;
    const short = Math.max(0, demand[t]! - available);
    shortage.push(short);
    const end = Math.max(0, available - demand[t]!);
    onHand.push(end);
    prev = end;
  }

  return {
    productId: node.productId,
    locationId: node.locationId,
    demand,
    receipts: receipts(),
    onHand,
    shortage,
    safetyStock,
    leadWeeks: baseLead,
    plannedOrders,
  };
}

export function runPlan(input: PlanInput): PlanResult {
  const nodes = input.nodes.map((n) =>
    planNode(n, input.weeks, input.serviceLevel, input.coverWeeks),
  );
  const byKey = new Map(input.nodes.map((n) => [`${n.productId}|${n.locationId}`, n]));
  let totalDemand = 0;
  let totalShortage = 0;
  let stockoutWeeks = 0;
  let revenueAtRisk = 0;
  let plannedOrders = 0;
  const atRisk: AtRiskRow[] = [];
  const invValue = new Array<number>(input.weeks).fill(0);

  for (const n of nodes) {
    const src = byKey.get(`${n.productId}|${n.locationId}`)!;
    const unit = src.unitPriceCents > 0 ? src.unitPriceCents : src.unitCostCents;
    let nodeShort = 0;
    let first = -1;
    for (let t = 0; t < input.weeks; t++) {
      totalDemand += n.demand[t]!;
      invValue[t]! += n.onHand[t]! * src.unitCostCents;
      if (n.shortage[t]! > 1e-9) {
        stockoutWeeks++;
        nodeShort += n.shortage[t]!;
        if (first < 0) first = t;
      }
    }
    totalShortage += nodeShort;
    revenueAtRisk += nodeShort * unit;
    plannedOrders += n.plannedOrders.length;
    if (nodeShort > 1e-9)
      atRisk.push({
        productId: n.productId,
        locationId: n.locationId,
        firstStockoutWeek: first,
        shortage: nodeShort,
        revenueAtRiskCents: Math.round(nodeShort * unit),
      });
  }
  atRisk.sort(
    (a, b) =>
      a.firstStockoutWeek - b.firstStockoutWeek || b.revenueAtRiskCents - a.revenueAtRiskCents,
  );
  return {
    nodes,
    atRisk,
    kpis: {
      stockoutWeeks,
      fillRate: totalDemand > 0 ? Math.max(0, 1 - totalShortage / totalDemand) : 1,
      avgInventoryValueCents: input.weeks
        ? Math.round(invValue.reduce((a, b) => a + b, 0) / input.weeks)
        : 0,
      revenueAtRiskCents: Math.round(revenueAtRisk),
      plannedOrders,
      totalDemand,
      totalShortage,
    },
  };
}
