import fc from 'fast-check';
import {
  applyDemandLevers,
  applySupplyLevers,
  matchesScope,
  type Catalog,
  type ResolvedLever,
} from './levers';
import { runPlan, type NodeInput, type PlanInput } from './plan';

const catalog: Catalog = {
  categories: new Map([
    ['A', { categoryId: 'snacks', parentId: 'food' }],
    ['B', { categoryId: 'drinks', parentId: null }],
  ]),
};

const node = (o: Partial<NodeInput> = {}): NodeInput => ({
  productId: 'A',
  locationId: 'east',
  unitCostCents: 100,
  unitPriceCents: 300,
  onHand: 0,
  configuredSafetyStock: 0,
  demand: Array(12).fill(10),
  sigma: 0,
  openReceipts: [],
  terms: { supplierId: 's1', leadTimeDays: 14, minOrderQty: 1, weeklyCapacity: null },
  ...o,
});
const input = (nodes: NodeInput[], over: Partial<PlanInput> = {}): PlanInput => ({
  weeks: 12,
  serviceLevel: 0.95,
  coverWeeks: 2,
  nodes,
  ...over,
});
const run = (i: PlanInput) => runPlan(i);

describe('scope matching', () => {
  it('matches ALL, PRODUCT, LOCATION and CATEGORY (including a parent category)', () => {
    expect(matchesScope({ scope: 'ALL' }, 'A', 'east', catalog)).toBe(true);
    expect(matchesScope({ scope: 'PRODUCT', id: 'A' }, 'A', 'east', catalog)).toBe(true);
    expect(matchesScope({ scope: 'PRODUCT', id: 'B' }, 'A', 'east', catalog)).toBe(false);
    expect(matchesScope({ scope: 'LOCATION', id: 'west' }, 'A', 'east', catalog)).toBe(false);
    expect(matchesScope({ scope: 'CATEGORY', id: 'snacks' }, 'A', 'east', catalog)).toBe(true);
    expect(matchesScope({ scope: 'CATEGORY', id: 'food' }, 'A', 'east', catalog)).toBe(true);
    expect(matchesScope({ scope: 'CATEGORY', id: 'drinks' }, 'A', 'east', catalog)).toBe(false);
    expect(matchesScope({ scope: 'CATEGORY', id: 'x' }, 'unknown-product', 'east', catalog)).toBe(
      false,
    );
  });
});

describe('DEMAND_CHANGE', () => {
  const base = new Map([
    ['A|east', Array(8).fill(100)],
    ['B|east', Array(8).fill(100)],
    ['A|west', Array(8).fill(100)],
  ]);

  it('scales only matching nodes and only inside the date range', () => {
    const out = applyDemandLevers(
      base,
      [
        {
          type: 'DEMAND_CHANGE',
          target: { scope: 'PRODUCT', id: 'A' },
          percent: 20,
          startWeek: 2,
          endWeek: 4,
        },
      ],
      catalog,
      8,
    );
    expect(out.get('A|east')).toEqual([100, 100, 120, 120, 120, 100, 100, 100]);
    expect(out.get('A|west')).toEqual([100, 100, 120, 120, 120, 100, 100, 100]);
    expect(out.get('B|east')).toEqual(Array(8).fill(100));
  });

  it('category and location scopes, negative percentages and the −100% floor', () => {
    const out = applyDemandLevers(
      base,
      [
        { type: 'DEMAND_CHANGE', target: { scope: 'CATEGORY', id: 'food' }, percent: -50 },
        {
          type: 'DEMAND_CHANGE',
          target: { scope: 'LOCATION', id: 'east' },
          percent: -100,
          startWeek: 0,
          endWeek: 0,
        },
      ],
      catalog,
      8,
    );
    expect(out.get('A|east')![0]).toBe(0);
    expect(out.get('A|east')![1]).toBe(50);
    expect(out.get('A|west')![0]).toBe(50);
    expect(out.get('B|east')![0]).toBe(0);
    expect(out.get('B|east')![1]).toBe(100);
  });

  it('levers compound in order and the input map is not modified', () => {
    const out = applyDemandLevers(
      base,
      [
        { type: 'DEMAND_CHANGE', target: { scope: 'ALL' }, percent: 10 },
        { type: 'DEMAND_CHANGE', target: { scope: 'ALL' }, percent: 10 },
      ],
      catalog,
      8,
    );
    expect(out.get('A|east')![0]).toBeCloseTo(121, 9);
    expect(base.get('A|east')![0]).toBe(100);
  });

  it('a demand rise leads to more shortage when stock is fixed', () => {
    const demand = applyDemandLevers(
      new Map([['A|east', Array(12).fill(10)]]),
      [{ type: 'DEMAND_CHANGE', target: { scope: 'ALL' }, percent: 50 }],
      catalog,
      12,
    );
    const n = node({ onHand: 60 });
    const baseline = run(input([n]));
    const scenario = run(input([{ ...n, demand: demand.get('A|east')! }]));
    expect(scenario.kpis.totalDemand).toBeCloseTo(baseline.kpis.totalDemand * 1.5, 9);
    expect(scenario.kpis.totalShortage).toBeGreaterThan(baseline.kpis.totalShortage);
  });
});

describe('SUPPLIER_DELAY', () => {
  it('a 2-week delay shifts open-order receipts by exactly 2 weeks', () => {
    const n = node({
      onHand: 100,
      openReceipts: [
        { week: 3, quantity: 40, supplierId: 's1' },
        { week: 5, quantity: 25, supplierId: 'other' },
      ],
    });
    const delayed = applySupplyLevers(
      input([n]),
      [{ type: 'SUPPLIER_DELAY', supplierId: 's1', extraDays: 14 }],
      catalog,
    );
    expect(delayed.nodes[0]!.openReceipts).toEqual([
      { week: 5, quantity: 40, supplierId: 's1' },
      { week: 5, quantity: 25, supplierId: 'other' },
    ]);
    const baseR = run(input([n])).nodes[0]!.receipts;
    const delR = run(delayed).nodes[0]!.receipts;
    expect(baseR[3]).toBeGreaterThanOrEqual(40);
    expect(delR[5]).toBeGreaterThanOrEqual(65);
    expect(delR[3]).toBeLessThan(baseR[3]!);
  });

  it('only receipts due inside the date window move; receipts pushed beyond the horizon drop out', () => {
    const n = node({
      openReceipts: [
        { week: 1, quantity: 10, supplierId: 's1' },
        { week: 6, quantity: 20, supplierId: 's1' },
        { week: 11, quantity: 30, supplierId: 's1' },
      ],
    });
    const out = applySupplyLevers(
      input([n]),
      [{ type: 'SUPPLIER_DELAY', supplierId: 's1', extraDays: 21, startWeek: 5, endWeek: 11 }],
      catalog,
    );
    expect(out.nodes[0]!.openReceipts).toEqual([
      { week: 1, quantity: 10, supplierId: 's1' },
      { week: 9, quantity: 20, supplierId: 's1' },
    ]);
  });

  it('lengthens the lead time of orders placed in the window (arrival +2 weeks)', () => {
    const n = node({ onHand: 15 });
    const baseOrder = run(input([n])).nodes[0]!.plannedOrders[0]!;
    const delayed = applySupplyLevers(
      input([n]),
      [{ type: 'SUPPLIER_DELAY', supplierId: 's1', extraDays: 14 }],
      catalog,
    );
    const delOrder = run(delayed).nodes[0]!.plannedOrders[0]!;
    expect(delOrder.arrivalWeek - delOrder.orderWeek).toBe(
      baseOrder.arrivalWeek - baseOrder.orderWeek + 2,
    );
  });

  it('a delay makes things worse (never better) for a node that depends on the supplier', () => {
    const n = node({ onHand: 25 });
    const base = run(input([n])).kpis;
    const delayed = run(
      applySupplyLevers(
        input([n]),
        [{ type: 'SUPPLIER_DELAY', supplierId: 's1', extraDays: 21 }],
        catalog,
      ),
    ).kpis;
    expect(delayed.totalShortage).toBeGreaterThanOrEqual(base.totalShortage);
    expect(delayed.fillRate).toBeLessThanOrEqual(base.fillRate);
  });

  it('does not touch other suppliers’ nodes', () => {
    const a = node({ productId: 'A' });
    const b = node({
      productId: 'B',
      terms: { supplierId: 's2', leadTimeDays: 14, minOrderQty: 1, weeklyCapacity: null },
    });
    const out = applySupplyLevers(
      input([a, b]),
      [{ type: 'SUPPLIER_DELAY', supplierId: 's1', extraDays: 14 }],
      catalog,
    );
    expect(out.nodes[1]!.extraLeadDays).toBeUndefined();
    expect(out.nodes[0]!.extraLeadDays).toEqual(Array(12).fill(14));
  });
});

describe('LEAD_TIME_CHANGE', () => {
  it('moves planned arrivals for that supplier/product', () => {
    const n = node({ onHand: 15 });
    const base = run(input([n])).nodes[0]!.plannedOrders[0]!;
    const out = applySupplyLevers(
      input([n]),
      [{ type: 'LEAD_TIME_CHANGE', supplierId: 's1', productId: 'A', leadTimeDays: 35 }],
      catalog,
    );
    expect(out.nodes[0]!.terms.leadTimeDays).toBe(35);
    const changed = run(out).nodes[0]!.plannedOrders[0]!;
    expect(base.arrivalWeek - base.orderWeek).toBe(2);
    expect(changed.arrivalWeek - changed.orderWeek).toBe(5);
  });

  it('ignores other products and other suppliers', () => {
    const out = applySupplyLevers(
      input([
        node({ productId: 'B' }),
        node({
          terms: { supplierId: 's9', leadTimeDays: 14, minOrderQty: 1, weeklyCapacity: null },
        }),
      ]),
      [{ type: 'LEAD_TIME_CHANGE', supplierId: 's1', productId: 'A', leadTimeDays: 99 }],
      catalog,
    );
    expect(out.nodes.map((n) => n.terms.leadTimeDays)).toEqual([14, 14]);
  });
});

describe('CAPACITY_CAP', () => {
  it('caps weekly receipts, takes the stricter of old and new caps, and carries the unmet quantity forward', () => {
    const n = node({ onHand: 0, demand: Array(12).fill(30) });
    const capped = applySupplyLevers(
      input([n]),
      [{ type: 'CAPACITY_CAP', supplierId: 's1', weeklyQuantity: 20 }],
      catalog,
    );
    expect(capped.nodes[0]!.terms.weeklyCapacity).toBe(20);
    const r = run(capped).nodes[0]!;
    for (const q of r.receipts) expect(q).toBeLessThanOrEqual(20 + 1e-9);
    expect(r.plannedOrders.length).toBeGreaterThan(3); // re-ordered every week the position stays short
    const twice = applySupplyLevers(
      input([n]),
      [
        { type: 'CAPACITY_CAP', supplierId: 's1', weeklyQuantity: 20 },
        { type: 'CAPACITY_CAP', supplierId: 's1', weeklyQuantity: 50 },
      ],
      catalog,
    );
    expect(twice.nodes[0]!.terms.weeklyCapacity).toBe(20);
    const base = run(input([n])).kpis;
    expect(run(capped).kpis.totalShortage).toBeGreaterThan(base.totalShortage);
  });
});

describe('SERVICE_LEVEL', () => {
  it('a higher target service level raises safety stock and planned volume', () => {
    const n = node({ sigma: 8, onHand: 30 });
    const lo = run(input([n], { serviceLevel: 0.8 }));
    const hi = run(
      applySupplyLevers(
        input([n], { serviceLevel: 0.8 }),
        [{ type: 'SERVICE_LEVEL', serviceLevel: 0.99 }],
        catalog,
      ),
    );
    expect(hi.nodes[0]!.safetyStock).toBeGreaterThan(lo.nodes[0]!.safetyStock);
    const vol = (r: typeof lo) => r.nodes[0]!.plannedOrders.reduce((s, o) => s + o.quantity, 0);
    expect(vol(hi)).toBeGreaterThan(vol(lo));
  });
});

describe('PRICE_CHANGE', () => {
  it('+10% price with elasticity 2 cuts demand 20% and raises the unit price 10%', () => {
    const lever: ResolvedLever = {
      type: 'PRICE_CHANGE',
      target: { scope: 'ALL' },
      percent: 10,
      elasticity: 2,
    };
    const demand = applyDemandLevers(new Map([['A|east', [100, 100]]]), [lever], catalog, 2);
    expect(demand.get('A|east')).toEqual([80, 80]);
    const out = applySupplyLevers(input([node()], { weeks: 2 }), [lever], catalog);
    expect(out.nodes[0]!.unitPriceCents).toBeCloseTo(330, 9);
  });
  it('a price cut raises demand; a very high rise floors demand at zero; partial windows scale the revenue valuation', () => {
    const cut = applyDemandLevers(
      new Map([['A|east', [100]]]),
      [{ type: 'PRICE_CHANGE', target: { scope: 'ALL' }, percent: -10, elasticity: 1.5 }],
      catalog,
      1,
    );
    expect(cut.get('A|east')![0]).toBeCloseTo(115, 9);
    const high = applyDemandLevers(
      new Map([['A|east', [100]]]),
      [{ type: 'PRICE_CHANGE', target: { scope: 'ALL' }, percent: 200, elasticity: 1 }],
      catalog,
      1,
    );
    expect(high.get('A|east')![0]).toBe(0);
    const half = applySupplyLevers(
      input([node()], { weeks: 4 }),
      [
        {
          type: 'PRICE_CHANGE',
          target: { scope: 'ALL' },
          percent: 10,
          elasticity: 0,
          startWeek: 0,
          endWeek: 1,
        },
      ],
      catalog,
    );
    expect(half.nodes[0]!.unitPriceCents).toBeCloseTo(300 * 1.05, 9);
  });
});

describe('combined levers and purity', () => {
  const levers: ResolvedLever[] = [
    { type: 'DEMAND_CHANGE', target: { scope: 'ALL' }, percent: 15 },
    { type: 'SUPPLIER_DELAY', supplierId: 's1', extraDays: 14 },
    { type: 'CAPACITY_CAP', supplierId: 's1', weeklyQuantity: 40 },
    { type: 'SERVICE_LEVEL', serviceLevel: 0.9 },
  ];
  const build = () => {
    const n = node({
      onHand: 50,
      sigma: 3,
      openReceipts: [{ week: 2, quantity: 30, supplierId: 's1' }],
    });
    const demand = applyDemandLevers(new Map([['A|east', n.demand]]), levers, catalog, 12);
    return applySupplyLevers(input([{ ...n, demand: demand.get('A|east')! }]), levers, catalog);
  };

  it('applying several levers together is deterministic', () => {
    expect(JSON.stringify(run(build()))).toBe(JSON.stringify(run(build())));
  });

  it('never mutates the baseline input', () => {
    const base = input([node({ openReceipts: [{ week: 2, quantity: 30, supplierId: 's1' }] })]);
    const snapshot = JSON.stringify(base);
    applySupplyLevers(base, levers, catalog);
    applyDemandLevers(new Map([['A|east', base.nodes[0]!.demand]]), levers, catalog, 12);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('with no levers the scenario equals the baseline exactly', () => {
    const base = input([node({ onHand: 40, sigma: 2 })]);
    expect(JSON.stringify(run(applySupplyLevers(base, [], catalog)))).toBe(
      JSON.stringify(run(base)),
    );
  });

  it('the balance equation still holds under any combination (property)', () => {
    const arb = fc.record({
      pct: fc.integer({ min: -90, max: 200 }),
      extra: fc.integer({ min: 1, max: 60 }),
      cap: fc.integer({ min: 5, max: 100 }),
      sl: fc.double({ min: 0.55, max: 0.99, noNaN: true }),
      onHand: fc.integer({ min: 0, max: 200 }),
    });
    fc.assert(
      fc.property(arb, (a) => {
        const lv: ResolvedLever[] = [
          {
            type: 'DEMAND_CHANGE',
            target: { scope: 'ALL' },
            percent: a.pct,
            startWeek: 1,
            endWeek: 8,
          },
          { type: 'SUPPLIER_DELAY', supplierId: 's1', extraDays: a.extra },
          { type: 'CAPACITY_CAP', supplierId: 's1', weeklyQuantity: a.cap },
          { type: 'SERVICE_LEVEL', serviceLevel: a.sl },
        ];
        const n = node({
          onHand: a.onHand,
          openReceipts: [{ week: 2, quantity: 20, supplierId: 's1' }],
        });
        const demand = applyDemandLevers(new Map([['A|east', n.demand]]), lv, catalog, 12);
        const r = run(
          applySupplyLevers(input([{ ...n, demand: demand.get('A|east')! }]), lv, catalog),
        ).nodes[0]!;
        let prev = a.onHand;
        r.onHand.forEach((oh, t) => {
          expect(oh).toBeCloseTo(prev + r.receipts[t]! - r.demand[t]! + r.shortage[t]!, 6);
          expect(oh).toBeGreaterThanOrEqual(0);
          prev = oh;
        });
      }),
      { numRuns: 150 },
    );
  });
});
