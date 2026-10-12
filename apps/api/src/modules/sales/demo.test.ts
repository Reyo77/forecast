import { generateDemo, createRng, demoSalesToCsv, weekOfYear } from './demo';
import { parseSalesCsv } from './csv';

const end = new Date('2026-06-15T00:00:00Z');

describe('createRng', () => {
  it('is deterministic per seed and produces different streams for different seeds', () => {
    const a = createRng(1);
    const b = createRng(1);
    const c = createRng(2);
    const sa = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(sa);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('generateDemo', () => {
  const data = generateDemo({ seed: 7, endDate: end });

  it('is deterministic for the same seed and differs for another', () => {
    expect(generateDemo({ seed: 7, endDate: end })).toEqual(data);
    expect(generateDemo({ seed: 8, endDate: end }).sales).not.toEqual(data.sales);
  });

  it('creates 3 years of weekly sales per finished product and location, ending on a Monday', () => {
    const finished = data.products.filter((p) => !p.isComponent).length;
    expect(data.sales).toHaveLength(finished * data.locations.length * 156);
    expect(data.sales.every((s) => s.weekStart.getUTCDay() === 1)).toBe(true);
    const last = Math.max(...data.sales.map((s) => s.weekStart.getTime()));
    expect(last).toBeLessThanOrEqual(end.getTime());
    expect(end.getTime() - last).toBeLessThan(7 * 86400_000);
  });

  it('never produces negative or fractional quantities; revenue = qty × price', () => {
    for (const s of data.sales) {
      expect(s.quantity).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(s.quantity)).toBe(true);
      const p = data.products.find((x) => x.sku === s.sku)!;
      expect(s.revenueCents).toBe(s.quantity * p.unitPriceCents);
    }
  });

  it('has trend, yearly seasonality and sparse demand', () => {
    const series = (sku: string, loc = 'WH-EAST') =>
      data.sales
        .filter((s) => s.sku === sku && s.location === loc)
        .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const chips = series('SNK-CHIP').map((s) => s.quantity);
    expect(avg(chips.slice(-52))).toBeGreaterThan(avg(chips.slice(0, 52))); // upward trend
    const gift = series('GFT-BOX');
    const winter = gift
      .filter((s) => [49, 50, 51, 52].includes(weekOfYear(s.weekStart)))
      .map((s) => s.quantity);
    const summer = gift
      .filter((s) => [27, 28, 29, 30].includes(weekOfYear(s.weekStart)))
      .map((s) => s.quantity);
    expect(avg(winter)).toBeGreaterThan(avg(summer) * 1.5); // strong Q4 peak
    const sparse = series('GFT-SPEC').map((s) => s.quantity);
    expect(sparse.filter((q) => q === 0).length / sparse.length).toBeGreaterThan(0.5); // intermittent
    expect(data.sales.some((s) => s.location === 'WH-WEST')).toBe(true);
  });

  it('has a coherent catalog: 2-level categories, BOM refs, supplier links, stock, orders (one late)', () => {
    const skus = new Set(data.products.map((p) => p.sku));
    expect(data.bom.every((b) => skus.has(b.parent) && skus.has(b.component))).toBe(true);
    expect(
      data.supplierLinks.every(
        (l) => skus.has(l.sku) && data.suppliers.some((s) => s.name === l.supplier),
      ),
    ).toBe(true);
    expect(data.supplierLinks.every((l) => l.leadTimeDays >= 1 && l.leadTimeDays <= 365)).toBe(
      true,
    );
    expect(
      data.inventory.every((i) => skus.has(i.sku) && i.onHand >= 0 && i.safetyStock >= 0),
    ).toBe(true);
    expect(data.openOrders.some((o) => o.weeksFromNow < 0)).toBe(true);
    const catNames = new Set(data.categories.map((c) => c.name));
    expect(data.products.every((p) => catNames.has(p.subCategory ?? p.category))).toBe(true);
    // every sub-category's parent is top-level (max two levels)
    for (const c of data.categories.filter((c) => c.parent))
      expect(data.categories.find((x) => x.name === c.parent)!.parent).toBeUndefined();
  });

  it('passes the import validators with zero errors (same rules as a user CSV)', () => {
    const r = parseSalesCsv(demoSalesToCsv(data), {
      skuToProduct: new Map(
        data.products.map((p, i) => [p.sku.toLowerCase(), { id: `p${i}`, sku: p.sku }]),
      ),
      locToId: new Map(
        data.locations.map((l, i) => [l.code.toLowerCase(), { id: `l${i}`, code: l.code }]),
      ),
      today: new Date(end.getTime() + 86400_000),
      earliestAllowed: new Date(end.getTime() - 4 * 365 * 86400_000),
    });
    expect(r.fatal).toBeUndefined();
    expect(r.errorCount).toBe(0);
    expect(r.weekly).toHaveLength(data.sales.length);
  });

  it('can generate fewer weeks (for plans with short retention)', () => {
    expect(generateDemo({ seed: 7, endDate: end, weeks: 52 }).sales.length).toBe(
      data.sales.length / 3,
    );
  });
});
