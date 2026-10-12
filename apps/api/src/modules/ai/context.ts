import { weekOfYear } from '../sales/demo';

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Least-squares slope of the series as a percentage of its mean, per week. */
export function trendPctPerWeek(values: number[]): number {
  const n = values.length;
  const m = mean(values);
  if (n < 3 || m === 0) return 0;
  const xm = (n - 1) / 2;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    num += (i - xm) * (v - m);
    den += (i - xm) ** 2;
  });
  return round((num / den / m) * 100, 2);
}

/** Yearly pattern: which week of the year peaks and how far above average it is. Needs ≥ 52 weeks. */
export function seasonality(
  history: { weekStart: Date; quantity: number }[],
): { peakWeekOfYear: number; peakToAverage: number } | null {
  if (history.length < 52) return null;
  const buckets = new Map<number, number[]>();
  for (const h of history) {
    const w = Math.min(52, weekOfYear(h.weekStart));
    buckets.set(w, [...(buckets.get(w) ?? []), h.quantity]);
  }
  const avg = mean(history.map((h) => h.quantity));
  if (avg === 0) return null;
  let best = { week: 0, value: -Infinity };
  for (const [w, xs] of buckets) if (mean(xs) > best.value) best = { week: w, value: mean(xs) };
  return { peakWeekOfYear: best.week, peakToAverage: round(best.value / avg, 2) };
}

export interface ForecastSummaryInput {
  sku: string;
  productName: string;
  location: string | null;
  horizonWeeks: number;
  modelUsed: string;
  selectionReason: string | null;
  accuracy: { mape: number | null; wape: number | null; bias: number | null } | null;
  history: { weekStart: Date; quantity: number }[];
  forecast: { quantity: number; lower: number; upper: number }[];
  overrides: number;
}

/**
 * The compact, aggregated payload sent to the model: recent weekly numbers and summary statistics.
 * It contains product identifiers and numbers only — no user names, emails or account data.
 */
export function buildForecastSummary(i: ForecastSummaryInput) {
  const values = i.history.map((h) => h.quantity);
  const recent = values.slice(-26);
  const fc = i.forecast.slice(0, 12);
  const zeros = values.length ? values.filter((v) => v === 0).length / values.length : 0;
  return {
    product: { sku: i.sku, name: i.productName },
    location: i.location ?? 'all locations',
    horizonWeeks: i.horizonWeeks,
    model: { name: i.modelUsed, selection: i.selectionReason },
    accuracyOnLast12Weeks: i.accuracy
      ? {
          wapePct: i.accuracy.wape === null ? null : round(i.accuracy.wape * 100),
          mapePct: i.accuracy.mape === null ? null : round(i.accuracy.mape * 100),
          biasPct: i.accuracy.bias === null ? null : round(i.accuracy.bias * 100),
        }
      : null,
    history: {
      weeksAvailable: values.length,
      recentWeeklyUnits: recent.map((v) => round(v, 0)),
      average: round(mean(values)),
      recentAverage: round(mean(recent)),
      trendPctPerWeek: trendPctPerWeek(values.slice(-52)),
      zeroWeeksPct: round(zeros * 100, 0),
      seasonality: seasonality(i.history),
    },
    forecast: {
      next12WeeklyUnits: fc.map((f) => round(f.quantity, 0)),
      average: round(mean(fc.map((f) => f.quantity))),
      intervalWidthPct:
        fc.length && mean(fc.map((f) => f.quantity)) > 0
          ? round(
              (mean(fc.map((f) => f.upper - f.lower)) / mean(fc.map((f) => f.quantity))) * 100,
              0,
            )
          : null,
    },
    plannerOverrides: i.overrides,
  };
}

export interface RiskSummaryInput {
  kpis: { baseline: Record<string, number>; scenario: Record<string, number> };
  atRisk: {
    sku: string;
    location: string;
    firstStockoutDate: string;
    shortage: number;
    revenueAtRiskCents: number;
  }[];
  levers: string[];
}

export function buildRiskSummary(i: RiskSummaryInput) {
  const k = (o: Record<string, number>) => ({
    fillRatePct: round(o.fillRate! * 100),
    stockoutWeeks: o.stockoutWeeks,
    unitsShort: round(o.totalShortage!, 0),
    revenueAtRiskUsd: round(o.revenueAtRiskCents! / 100, 0),
    avgInventoryValueUsd: round(o.avgInventoryValueCents! / 100, 0),
    plannedOrders: o.plannedOrders,
  });
  return {
    levers: i.levers.slice(0, 10),
    baseline: k(i.kpis.baseline),
    scenario: k(i.kpis.scenario),
    topAtRiskProducts: i.atRisk.slice(0, 10).map((a) => ({
      sku: a.sku,
      location: a.location,
      firstStockout: a.firstStockoutDate,
      unitsShort: round(a.shortage, 0),
      revenueAtRiskUsd: round(a.revenueAtRiskCents / 100, 0),
    })),
  };
}
