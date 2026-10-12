import fc from 'fast-check';
import { explodeDemand, type BomEdge } from './bom';
import { leadWeeks, planNode, runPlan, type NodeInput } from './plan';
import { roundUpToMoq, stdDev, zScore } from './stats';

const node = (o: Partial<NodeInput> = {}): NodeInput => ({
  productId: 'p',
  locationId: 'l',
  unitCostCents: 100,
  unitPriceCents: 300,
  onHand: 25,
  configuredSafetyStock: 0,
  demand: [10, 10, 10, 10, 10, 10],
  sigma: 0,
  openReceipts: [],
  terms: { supplierId: 's', leadTimeDays: 14, minOrderQty: 1, weeklyCapacity: null },
  ...o,
});
const plan = (n: NodeInput, weeks = n.demand.length, sl = 0.95, cover = 2) =>
  planNode(n, weeks, sl, cover);

describe('golden test: hand-calculated projection', () => {
  it('on hand 25, demand 10/week, lead time 2 weeks, cover 2 weeks', () => {
    const r = plan(node());
    expect(r.onHand).toEqual([15, 5, 0, 15, 5, 0]);
    expect(r.shortage).toEqual([0, 0, 5, 0, 0, 5]);
    expect(r.receipts).toEqual([0, 0, 0, 25, 0, 0]);
    // placed at the start of week 1 (position 15 − 20 = −5 < 0), order up to 20 → 25, arrives 2 weeks later
    expect(r.plannedOrders).toEqual([
      {
        productId: 'p',
        locationId: 'l',
        orderWeek: 1,
        arrivalWeek: 3,
        quantity: 25,
        supplierId: 's',
      },
    ]);
    const k = runPlan({ weeks: 6, serviceLevel: 0.95, coverWeeks: 2, nodes: [node()] }).kpis;
    expect(k.stockoutWeeks).toBe(2);
    expect(k.totalShortage).toBe(10);
    expect(k.totalDemand).toBe(60);
    expect(k.fillRate).toBeCloseTo(1 - 10 / 60, 12);
    expect(k.plannedOrders).toBe(1);
    expect(k.revenueAtRiskCents).toBe(10 * 300);
    // average inventory value: (15+5+0+15+5+0)/6 units × 100 cents
    expect(k.avgInventoryValueCents).toBe(Math.round((40 / 6) * 100));
  });

  it('rounds the order up to the minimum order quantity (25 → 30)', () => {
    const r = plan(
      node({ terms: { supplierId: 's', leadTimeDays: 14, minOrderQty: 30, weeklyCapacity: null } }),
    );
    expect(r.plannedOrders.map((o) => o.quantity)).toEqual([30]);
    expect(r.shortage).toEqual([0, 0, 5, 0, 0, 0]);
    expect(r.onHand).toEqual([15, 5, 0, 20, 10, 0]);
  });

  it('open orders arrive in their expected week; late ones land in week 0', () => {
    const r = plan(
      node({
        onHand: 0,
        demand: [5, 5, 5, 5],
        terms: { supplierId: 's', leadTimeDays: 7, minOrderQty: 1, weeklyCapacity: null },
        openReceipts: [{ week: 1, quantity: 12, supplierId: 's' }],
      }),
      4,
      0.95,
      1,
    );
    expect(r.shortage).toEqual([5, 0, 0, 3]);
    expect(r.receipts).toEqual([0, 12, 0, 0]);
    const late = plan(
      node({
        onHand: 0,
        demand: [5, 5],
        openReceipts: [{ week: -2, quantity: 20, supplierId: 's' }],
      }),
      2,
    );
    expect(late.receipts[0]).toBe(20);
    expect(late.shortage).toEqual([0, 0]);
  });

  it('safety stock = z × σ × √(lead weeks), floored by the configured safety stock', () => {
    const r = plan(node({ sigma: 4 }));
    expect(r.safetyStock).toBeCloseTo(1.6448536 * 4 * Math.sqrt(2), 5);
    expect(r.leadWeeks).toBe(2);
    expect(plan(node({ sigma: 4, configuredSafetyStock: 12 })).safetyStock).toBe(12);
    expect(plan(node({ sigma: 4 }), 6, 0.99).safetyStock).toBeGreaterThan(r.safetyStock);
    expect(
      plan(
        node({
          sigma: 4,
          terms: { supplierId: 's', leadTimeDays: 28, minOrderQty: 1, weeklyCapacity: null },
        }),
      ).safetyStock,
    ).toBeCloseTo(1.6448536 * 4 * 2, 5);
  });

  it('a higher service level orders more (bigger safety stock)', () => {
    const base = node({ sigma: 6, onHand: 40, demand: Array(12).fill(10) });
    const lo = plan(base, 12, 0.8, 2).plannedOrders.reduce((s, o) => s + o.quantity, 0);
    const hi = plan(base, 12, 0.99, 2).plannedOrders.reduce((s, o) => s + o.quantity, 0);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('lead time, capacity and delays', () => {
  it('lead time in weeks is rounded up and at least one', () => {
    expect(leadWeeks(1)).toBe(1);
    expect(leadWeeks(7)).toBe(1);
    expect(leadWeeks(8)).toBe(2);
    expect(leadWeeks(14)).toBe(2);
    expect(leadWeeks(15)).toBe(3);
    expect(leadWeeks(365)).toBe(53);
  });

  it('every planned order arrives exactly lead-time weeks after it is placed', () => {
    const r = plan(
      node({
        onHand: 0,
        demand: Array(20).fill(10),
        terms: { supplierId: 's', leadTimeDays: 21, minOrderQty: 1, weeklyCapacity: null },
      }),
      20,
      0.95,
      3,
    );
    expect(r.plannedOrders.length).toBeGreaterThan(0);
    for (const o of r.plannedOrders) expect(o.arrivalWeek - o.orderWeek).toBe(3);
  });

  it('extra lead days (supplier delay) push planned arrivals out by whole weeks', () => {
    const base = node({ onHand: 15, demand: Array(12).fill(10) });
    const normal = plan(base, 12, 0.95, 2).plannedOrders[0]!;
    const delayed = plan({ ...base, extraLeadDays: Array(12).fill(14) }, 12, 0.95, 2)
      .plannedOrders[0]!;
    expect(delayed.arrivalWeek - delayed.orderWeek).toBe(normal.arrivalWeek - normal.orderWeek + 2);
  });

  it('weekly capacity caps each arrival week; unmet quantity is re-ordered later (carried forward)', () => {
    const n = node({
      onHand: 0,
      demand: Array(16).fill(20),
      terms: { supplierId: 's', leadTimeDays: 7, minOrderQty: 1, weeklyCapacity: 10 },
    });
    const r = plan(n, 16, 0.95, 2);
    for (const q of r.receipts) expect(q).toBeLessThanOrEqual(10 + 1e-9);
    expect(r.shortage.some((s) => s > 0)).toBe(true);
    // Orders keep being placed every week the position is short (the cap does not swallow demand).
    expect(r.plannedOrders.length).toBeGreaterThan(5);
    const uncapped = plan({ ...n, terms: { ...n.terms, weeklyCapacity: null } }, 16, 0.95, 2);
    expect(r.shortage.reduce((a, b) => a + b, 0)).toBeGreaterThan(
      uncapped.shortage.reduce((a, b) => a + b, 0),
    );
  });

  it('beyond-horizon orders are not planned; nodes without demand never order', () => {
    expect(plan(node({ demand: [0, 0, 0, 0], onHand: 0 })).plannedOrders).toEqual([]);
    expect(plan(node({ demand: [0, 0, 0, 0], onHand: 7 })).onHand).toEqual([7, 7, 7, 7]);
    expect(plan(node({ demand: [5], onHand: 0 }), 1).plannedOrders).toEqual([]);
  });
});

describe('explodeDemand (multi-level BOM)', () => {
  const e = (parentId: string, componentId: string, quantityPer: number): BomEdge => ({
    parentId,
    componentId,
    quantityPer,
  });
  it('explodes finished-good demand into components at the same location', () => {
    const out = explodeDemand(
      [e('A', 'B', 2), e('B', 'C', 3)],
      new Map([
        ['A|east', [10, 20]],
        ['A|west', [1, 1]],
      ]),
      2,
    );
    expect(out.get('A|east')).toEqual([10, 20]);
    expect(out.get('B|east')).toEqual([20, 40]);
    expect(out.get('C|east')).toEqual([60, 120]);
    expect(out.get('C|west')).toEqual([6, 6]);
  });
  it('adds independent demand for components and sums multiple parents; does not mutate input', () => {
    const input = new Map([
      ['A|l', [10, 10]],
      ['X|l', [5, 5]],
      ['B|l', [1, 1]],
    ]);
    const out = explodeDemand([e('A', 'B', 1), e('X', 'B', 2)], input, 2);
    expect(out.get('B|l')).toEqual([1 + 10 + 10, 1 + 10 + 10]);
    expect(input.get('B|l')).toEqual([1, 1]);
  });
  it('products without a BOM pass through unchanged', () => {
    expect(explodeDemand([], new Map([['A|l', [3, 4]]]), 2).get('A|l')).toEqual([3, 4]);
  });
});

describe('helpers', () => {
  it('zScore matches known normal quantiles', () => {
    expect(zScore(0.5)).toBeCloseTo(0, 9);
    expect(zScore(0.95)).toBeCloseTo(1.6448536, 6);
    expect(zScore(0.99)).toBeCloseTo(2.3263479, 6);
    expect(zScore(0.9)).toBeCloseTo(1.2815516, 6);
    expect(zScore(0.05)).toBeCloseTo(-zScore(0.95), 9);
    expect(zScore(0.999)).toBeCloseTo(3.0902323, 5);
    expect(() => zScore(0)).toThrow();
    expect(() => zScore(1)).toThrow();
  });
  it('roundUpToMoq', () => {
    expect(roundUpToMoq(25, 30)).toBe(30);
    expect(roundUpToMoq(61, 30)).toBe(90);
    expect(roundUpToMoq(60, 30)).toBe(60);
    expect(roundUpToMoq(60.00000000001, 30)).toBe(60);
    expect(roundUpToMoq(0, 30)).toBe(0);
    expect(roundUpToMoq(5, 0)).toBe(5);
    expect(roundUpToMoq(0.2, 10)).toBe(10);
  });
  it('stdDev', () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935, 6);
    expect(stdDev([5])).toBe(0);
  });
});

describe('invariants (property tests)', () => {
  const nodeArb = fc.record({
    onHand: fc.integer({ min: 0, max: 300 }),
    demand: fc.array(fc.integer({ min: 0, max: 80 }), { minLength: 1, maxLength: 30 }),
    sigma: fc.integer({ min: 0, max: 30 }),
    lead: fc.integer({ min: 1, max: 60 }),
    moq: fc.integer({ min: 1, max: 50 }),
    safety: fc.integer({ min: 0, max: 40 }),
    open: fc.array(
      fc.record({
        week: fc.integer({ min: -3, max: 35 }),
        quantity: fc.integer({ min: 0, max: 100 }),
      }),
      { maxLength: 4 },
    ),
    cap: fc.option(fc.integer({ min: 5, max: 200 }), { nil: null }),
    sl: fc.double({ min: 0.5, max: 0.99, noNaN: true }),
    cover: fc.integer({ min: 1, max: 8 }),
  });
  type ArbValue<A> = A extends fc.Arbitrary<infer T> ? T : never;
  const toNode = (a: ArbValue<typeof nodeArb>): NodeInput =>
    node({
      onHand: a.onHand,
      demand: a.demand,
      sigma: a.sigma,
      configuredSafetyStock: a.safety,
      openReceipts: a.open.map((o) => ({ ...o, supplierId: 's' })),
      terms: { supplierId: 's', leadTimeDays: a.lead, minOrderQty: a.moq, weeklyCapacity: a.cap },
    });

  it('the balance equation holds every week, stock and shortage are never negative', () => {
    fc.assert(
      fc.property(nodeArb, (a) => {
        const r = planNode(toNode(a), a.demand.length, a.sl, a.cover);
        let prev = a.onHand;
        for (let t = 0; t < a.demand.length; t++) {
          expect(r.onHand[t]!).toBeGreaterThanOrEqual(0);
          expect(r.shortage[t]!).toBeGreaterThanOrEqual(0);
          expect(r.receipts[t]!).toBeGreaterThanOrEqual(0);
          expect(r.onHand[t]!).toBeCloseTo(
            prev + r.receipts[t]! - a.demand[t]! + r.shortage[t]!,
            6,
          );
          // a shortage only exists when stock ran out
          if (r.shortage[t]! > 1e-9) expect(r.onHand[t]!).toBe(0);
          prev = r.onHand[t]!;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('planned orders respect lead time, MOQ multiples (when uncapped) and capacity', () => {
    fc.assert(
      fc.property(nodeArb, (a) => {
        const r = planNode(toNode(a), a.demand.length, a.sl, a.cover);
        const L = leadWeeks(a.lead);
        for (const o of r.plannedOrders) {
          expect(o.arrivalWeek - o.orderWeek).toBe(L);
          expect(o.arrivalWeek).toBeLessThan(a.demand.length);
          expect(o.quantity).toBeGreaterThan(0);
          if (a.cap === null)
            expect(Math.abs(o.quantity / a.moq - Math.round(o.quantity / a.moq))).toBeLessThan(
              1e-9,
            );
        }
        if (a.cap !== null) {
          const perWeek = new Map<number, number>();
          for (const o of r.plannedOrders)
            perWeek.set(o.arrivalWeek, (perWeek.get(o.arrivalWeek) ?? 0) + o.quantity);
          for (const q of perWeek.values()) expect(q).toBeLessThanOrEqual(a.cap + 1e-9);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('stock covering the whole horizon means no shortage and no orders', () => {
    fc.assert(
      fc.property(nodeArb, (a) => {
        const total = a.demand.reduce((s, x) => s + x, 0);
        const r = planNode(
          { ...toNode(a), onHand: total + 10_000 },
          a.demand.length,
          a.sl,
          a.cover,
        );
        expect(r.shortage.every((x) => x === 0)).toBe(true);
        expect(r.plannedOrders).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('no starting stock and no supply means every unit of demand is short', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 3 }),
        (demand) => {
          // lead time (8+ weeks) is longer than the horizon, so nothing can arrive in time
          const r = planNode(
            node({
              onHand: 0,
              demand,
              terms: { supplierId: 's', leadTimeDays: 70, minOrderQty: 1, weeklyCapacity: null },
            }),
            demand.length,
            0.95,
            2,
          );
          expect(r.shortage).toEqual(demand);
          expect(r.plannedOrders).toEqual([]);
        },
      ),
    );
  });

  it('zero demand: nothing ordered, nothing short, stock plus receipts only', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        (onHand, weeks) => {
          const r = planNode(node({ onHand, demand: Array(weeks).fill(0) }), weeks, 0.95, 4);
          expect(r.plannedOrders).toEqual([]);
          expect(r.shortage.every((s) => s === 0)).toBe(true);
          expect(r.onHand.every((x) => x === onHand)).toBe(true);
        },
      ),
    );
  });

  it('fill rate is within [0,1], KPIs are deterministic and revenue at risk is non-negative', () => {
    fc.assert(
      fc.property(fc.array(nodeArb, { minLength: 1, maxLength: 5 }), (arr) => {
        const weeks = Math.min(...arr.map((a) => a.demand.length));
        const nodes = arr.map((a, i) => ({
          ...toNode(a),
          productId: `p${i}`,
          demand: a.demand.slice(0, weeks),
        }));
        const r1 = runPlan({ weeks, serviceLevel: 0.95, coverWeeks: 4, nodes });
        const r2 = runPlan({ weeks, serviceLevel: 0.95, coverWeeks: 4, nodes });
        expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
        expect(r1.kpis.fillRate).toBeGreaterThanOrEqual(0);
        expect(r1.kpis.fillRate).toBeLessThanOrEqual(1);
        expect(r1.kpis.revenueAtRiskCents).toBeGreaterThanOrEqual(0);
        expect(r1.atRisk.every((x) => x.shortage > 0)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe('runPlan KPIs and the at-risk list', () => {
  it('lists at-risk products ordered by first stockout week, then revenue at risk', () => {
    const r = runPlan({
      weeks: 6,
      serviceLevel: 0.95,
      coverWeeks: 2,
      nodes: [
        node({ productId: 'late', onHand: 45, demand: Array(6).fill(10) }), // first short in week 4
        node({
          productId: 'soon-cheap',
          onHand: 5,
          unitPriceCents: 100,
          demand: Array(6).fill(10),
        }),
        node({
          productId: 'soon-pricey',
          onHand: 5,
          unitPriceCents: 900,
          demand: Array(6).fill(10),
        }),
        node({ productId: 'fine', onHand: 1000, demand: Array(6).fill(10) }),
      ],
    });
    expect(r.atRisk.map((a) => a.productId)).toEqual(['soon-pricey', 'soon-cheap', 'late']);
    expect(r.atRisk[0]!.firstStockoutWeek).toBe(0);
    expect(r.atRisk.find((a) => a.productId === 'fine')).toBeUndefined();
  });

  it('values revenue at risk at the unit cost for components (no price)', () => {
    const r = runPlan({
      weeks: 2,
      serviceLevel: 0.95,
      coverWeeks: 1,
      nodes: [node({ unitPriceCents: 0, unitCostCents: 40, onHand: 0, demand: [10, 10] })],
    });
    expect(r.kpis.revenueAtRiskCents).toBe(20 * 40);
  });

  it('an empty plan has a fill rate of 1', () => {
    expect(runPlan({ weeks: 4, serviceLevel: 0.95, coverWeeks: 4, nodes: [] }).kpis).toMatchObject({
      fillRate: 1,
      stockoutWeeks: 0,
      plannedOrders: 0,
    });
  });
});
