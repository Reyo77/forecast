import { startOfWeekMonday } from '../../lib/time';

/** Small deterministic PRNG (mulberry32) so the same seed always yields the same data. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Standard normal via Box–Muller. */
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

export interface DemoProduct {
  sku: string;
  name: string;
  category: string;
  subCategory?: string;
  unitCostCents: number;
  unitPriceCents: number;
  isComponent: boolean;
  /** Baseline weekly demand (units) per location before trend/season. */
  base: number;
  trendPerWeek: number;
  seasonAmp: number;
  /** Peak week-of-year for seasonality. */
  seasonPeak: number;
  intermittent: boolean;
}

export interface DemoData {
  categories: { name: string; parent?: string }[];
  products: DemoProduct[];
  locations: { code: string; name: string; type: 'WAREHOUSE' | 'STORE' | 'PLANT' }[];
  suppliers: { name: string; defaultLeadTimeDays: number; reliabilityPct: number }[];
  supplierLinks: {
    supplier: string;
    sku: string;
    leadTimeDays: number;
    minOrderQty: number;
    unitCostCents: number;
    weeklyCapacity: number | null;
    isPrimary: boolean;
  }[];
  bom: { parent: string; component: string; quantityPer: number }[];
  inventory: { sku: string; location: string; onHand: number; safetyStock: number }[];
  openOrders: {
    sku: string;
    location: string;
    supplier: string;
    quantity: number;
    weeksFromNow: number;
  }[];
  sales: {
    sku: string;
    location: string;
    weekStart: Date;
    quantity: number;
    revenueCents: number;
  }[];
}

const PRODUCTS: DemoProduct[] = [
  {
    sku: 'SNK-CHIP',
    name: 'Sea Salt Chips 150g',
    category: 'Snacks',
    subCategory: 'Chips',
    unitCostCents: 120,
    unitPriceCents: 249,
    isComponent: false,
    base: 220,
    trendPerWeek: 0.35,
    seasonAmp: 0.18,
    seasonPeak: 30,
    intermittent: false,
  },
  {
    sku: 'SNK-NUTS',
    name: 'Roasted Almonds 200g',
    category: 'Snacks',
    subCategory: 'Nuts',
    unitCostCents: 310,
    unitPriceCents: 599,
    isComponent: false,
    base: 140,
    trendPerWeek: 0.2,
    seasonAmp: 0.35,
    seasonPeak: 50,
    intermittent: false,
  },
  {
    sku: 'SNK-BAR',
    name: 'Protein Bar 12-pack',
    category: 'Snacks',
    subCategory: 'Bars',
    unitCostCents: 640,
    unitPriceCents: 1199,
    isComponent: false,
    base: 90,
    trendPerWeek: 0.5,
    seasonAmp: 0.1,
    seasonPeak: 2,
    intermittent: false,
  },
  {
    sku: 'BEV-COLD',
    name: 'Cold Brew Coffee 1L',
    category: 'Beverages',
    subCategory: 'Coffee',
    unitCostCents: 210,
    unitPriceCents: 449,
    isComponent: false,
    base: 160,
    trendPerWeek: 0.25,
    seasonAmp: 0.45,
    seasonPeak: 28,
    intermittent: false,
  },
  {
    sku: 'BEV-TEA',
    name: 'Green Tea 20 bags',
    category: 'Beverages',
    subCategory: 'Tea',
    unitCostCents: 150,
    unitPriceCents: 349,
    isComponent: false,
    base: 110,
    trendPerWeek: -0.05,
    seasonAmp: 0.25,
    seasonPeak: 3,
    intermittent: false,
  },
  {
    sku: 'BEV-SODA',
    name: 'Sparkling Water 12-pack',
    category: 'Beverages',
    subCategory: 'Water',
    unitCostCents: 260,
    unitPriceCents: 549,
    isComponent: false,
    base: 250,
    trendPerWeek: 0.1,
    seasonAmp: 0.4,
    seasonPeak: 29,
    intermittent: false,
  },
  {
    sku: 'GFT-BOX',
    name: 'Holiday Gift Box',
    category: 'Gifting',
    unitCostCents: 1400,
    unitPriceCents: 2999,
    isComponent: false,
    base: 30,
    trendPerWeek: 0.1,
    seasonAmp: 1.1,
    seasonPeak: 50,
    intermittent: false,
  },
  {
    sku: 'GFT-SPEC',
    name: 'Limited Edition Tin',
    category: 'Gifting',
    unitCostCents: 900,
    unitPriceCents: 2199,
    isComponent: false,
    base: 3,
    trendPerWeek: 0,
    seasonAmp: 0.3,
    seasonPeak: 48,
    intermittent: true,
  },
  {
    sku: 'CMP-BOX',
    name: 'Gift Box Packaging',
    category: 'Components',
    unitCostCents: 180,
    unitPriceCents: 0,
    isComponent: true,
    base: 0,
    trendPerWeek: 0,
    seasonAmp: 0,
    seasonPeak: 0,
    intermittent: false,
  },
  {
    sku: 'CMP-TIN',
    name: 'Collector Tin Shell',
    category: 'Components',
    unitCostCents: 220,
    unitPriceCents: 0,
    isComponent: true,
    base: 0,
    trendPerWeek: 0,
    seasonAmp: 0,
    seasonPeak: 0,
    intermittent: false,
  },
  {
    sku: 'CMP-NUTS',
    name: 'Bulk Almonds 5kg',
    category: 'Components',
    unitCostCents: 1900,
    unitPriceCents: 0,
    isComponent: true,
    base: 0,
    trendPerWeek: 0,
    seasonAmp: 0,
    seasonPeak: 0,
    intermittent: false,
  },
  {
    sku: 'CMP-TEA',
    name: 'Tea Leaf Pouch',
    category: 'Components',
    unitCostCents: 60,
    unitPriceCents: 0,
    isComponent: true,
    base: 0,
    trendPerWeek: 0,
    seasonAmp: 0,
    seasonPeak: 0,
    intermittent: false,
  },
];

export interface DemoOptions {
  seed: number;
  /** Last week of data (inclusive). */
  endDate: Date;
  /** Number of weeks of history to generate (default 156 = 3 years). */
  weeks?: number;
}

const LOCATION_SCALE: Record<string, number> = { 'WH-EAST': 1, 'WH-WEST': 0.7 };

export function weekOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / (7 * 86400_000)) + 1;
}

/** Realistic weekly demand: trend × yearly seasonality × promotions × noise (never negative). */
export function generateDemo(opts: DemoOptions): DemoData {
  const rng = createRng(opts.seed);
  const weeks = opts.weeks ?? 156;
  const lastWeek = startOfWeekMonday(opts.endDate);
  const locations: DemoData['locations'] = [
    { code: 'WH-EAST', name: 'East Coast Warehouse', type: 'WAREHOUSE' },
    { code: 'WH-WEST', name: 'West Coast Warehouse', type: 'WAREHOUSE' },
  ];

  // Promotion calendar shared by all products: ~6 two-week windows a year, deterministic per seed.
  const promoWeeks = new Set<number>();
  for (let w = 0; w < weeks; w++)
    if (rng.next() < 0.05) [w, w + 1].forEach((x) => promoWeeks.add(x));

  const sales: DemoData['sales'] = [];
  for (const p of PRODUCTS.filter((x) => !x.isComponent)) {
    for (const loc of locations) {
      const scale = LOCATION_SCALE[loc.code] ?? 1;
      for (let i = 0; i < weeks; i++) {
        const weekStart = new Date(lastWeek.getTime() - (weeks - 1 - i) * 7 * 86400_000);
        const season =
          1 + p.seasonAmp * Math.cos((2 * Math.PI * (weekOfYear(weekStart) - p.seasonPeak)) / 52);
        const trend = 1 + (p.trendPerWeek * i) / Math.max(p.base, 1);
        const promo = promoWeeks.has(i) ? 1.35 : 1;
        let qty: number;
        if (p.intermittent) {
          // Sparse demand: mostly zero weeks, occasional small orders (Croston territory).
          qty =
            rng.next() < 0.22
              ? Math.max(1, Math.round(p.base * (1 + rng.normal() * 0.6) * season))
              : 0;
        } else {
          const noise = 1 + rng.normal() * 0.08;
          qty = Math.max(0, Math.round(p.base * scale * trend * season * promo * noise));
        }
        sales.push({
          sku: p.sku,
          location: loc.code,
          weekStart,
          quantity: qty,
          revenueCents: qty * p.unitPriceCents,
        });
      }
    }
  }

  return {
    categories: [
      { name: 'Snacks' },
      { name: 'Chips', parent: 'Snacks' },
      { name: 'Nuts', parent: 'Snacks' },
      { name: 'Bars', parent: 'Snacks' },
      { name: 'Beverages' },
      { name: 'Coffee', parent: 'Beverages' },
      { name: 'Tea', parent: 'Beverages' },
      { name: 'Water', parent: 'Beverages' },
      { name: 'Gifting' },
      { name: 'Components' },
    ],
    products: PRODUCTS,
    locations,
    suppliers: [
      { name: 'Acme Supplies', defaultLeadTimeDays: 21, reliabilityPct: 93 },
      { name: 'Globex Packaging', defaultLeadTimeDays: 35, reliabilityPct: 88 },
      { name: 'Harvest Foods Co', defaultLeadTimeDays: 14, reliabilityPct: 97 },
    ],
    supplierLinks: [
      ...PRODUCTS.filter((p) => !p.isComponent && !['GFT-BOX', 'GFT-SPEC'].includes(p.sku)).map(
        (p, i) => ({
          supplier: i % 2 ? 'Harvest Foods Co' : 'Acme Supplies',
          sku: p.sku,
          leadTimeDays: i % 2 ? 14 : 21,
          minOrderQty: 200,
          unitCostCents: p.unitCostCents,
          weeklyCapacity: i % 3 === 0 ? 1500 : null,
          isPrimary: true,
        }),
      ),
      {
        supplier: 'Globex Packaging',
        sku: 'CMP-BOX',
        leadTimeDays: 35,
        minOrderQty: 500,
        unitCostCents: 180,
        weeklyCapacity: 800,
        isPrimary: true,
      },
      {
        supplier: 'Globex Packaging',
        sku: 'CMP-TIN',
        leadTimeDays: 42,
        minOrderQty: 300,
        unitCostCents: 220,
        weeklyCapacity: 400,
        isPrimary: true,
      },
      {
        supplier: 'Harvest Foods Co',
        sku: 'CMP-NUTS',
        leadTimeDays: 14,
        minOrderQty: 20,
        unitCostCents: 1900,
        weeklyCapacity: null,
        isPrimary: true,
      },
      {
        supplier: 'Acme Supplies',
        sku: 'CMP-NUTS',
        leadTimeDays: 28,
        minOrderQty: 10,
        unitCostCents: 2050,
        weeklyCapacity: null,
        isPrimary: false,
      },
      {
        supplier: 'Harvest Foods Co',
        sku: 'CMP-TEA',
        leadTimeDays: 14,
        minOrderQty: 1000,
        unitCostCents: 60,
        weeklyCapacity: null,
        isPrimary: true,
      },
    ],
    bom: [
      { parent: 'GFT-BOX', component: 'CMP-BOX', quantityPer: 1 },
      { parent: 'GFT-BOX', component: 'SNK-NUTS', quantityPer: 2 },
      { parent: 'GFT-BOX', component: 'BEV-TEA', quantityPer: 1 },
      { parent: 'GFT-SPEC', component: 'CMP-TIN', quantityPer: 1 },
      { parent: 'SNK-NUTS', component: 'CMP-NUTS', quantityPer: 0.04 },
      { parent: 'BEV-TEA', component: 'CMP-TEA', quantityPer: 20 },
    ],
    inventory: [
      ...PRODUCTS.filter((p) => !p.isComponent).flatMap((p) =>
        locations.map((l) => ({
          sku: p.sku,
          location: l.code,
          onHand: Math.round(p.base * (LOCATION_SCALE[l.code] ?? 1) * 3),
          safetyStock: Math.round(p.base * (LOCATION_SCALE[l.code] ?? 1) * 0.8),
        })),
      ),
      { sku: 'CMP-BOX', location: 'WH-EAST', onHand: 900, safetyStock: 200 },
      { sku: 'CMP-TIN', location: 'WH-EAST', onHand: 150, safetyStock: 100 },
      { sku: 'CMP-NUTS', location: 'WH-EAST', onHand: 18, safetyStock: 6 },
      { sku: 'CMP-TEA', location: 'WH-EAST', onHand: 2500, safetyStock: 800 },
    ],
    openOrders: [
      {
        sku: 'SNK-CHIP',
        location: 'WH-EAST',
        supplier: 'Acme Supplies',
        quantity: 800,
        weeksFromNow: 2,
      },
      {
        sku: 'BEV-COLD',
        location: 'WH-WEST',
        supplier: 'Harvest Foods Co',
        quantity: 600,
        weeksFromNow: 1,
      },
      {
        sku: 'CMP-BOX',
        location: 'WH-EAST',
        supplier: 'Globex Packaging',
        quantity: 1000,
        weeksFromNow: 5,
      },
      {
        sku: 'SNK-NUTS',
        location: 'WH-EAST',
        supplier: 'Acme Supplies',
        quantity: 400,
        weeksFromNow: -1,
      },
    ],
    sales,
  };
}

/** Serialises generated sales as the import CSV so the demo data provably passes the validators. */
export function demoSalesToCsv(data: DemoData): string {
  const lines = ['sku,location_code,date,quantity,revenue'];
  for (const s of data.sales)
    lines.push(
      `${s.sku},${s.location},${s.weekStart.toISOString().slice(0, 10)},${s.quantity},${(s.revenueCents / 100).toFixed(2)}`,
    );
  return lines.join('\n') + '\n';
}
