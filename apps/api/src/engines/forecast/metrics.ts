export interface Accuracy {
  /** Mean absolute percentage error over non-zero actuals, as a fraction (0.12 = 12%). null if no non-zero actuals. */
  mape: number | null;
  /** Weighted absolute percentage error: Σ|f−a| / Σ|a|. null if Σ|a| = 0. */
  wape: number | null;
  /** Σ(f−a) / Σa; positive means over-forecasting. null if Σa = 0. */
  bias: number | null;
  /** Mean absolute error (always defined). */
  mae: number;
}

export function accuracy(actual: number[], forecast: number[]): Accuracy {
  const n = Math.min(actual.length, forecast.length);
  let absErr = 0;
  let err = 0;
  let sumA = 0;
  let sumAbsA = 0;
  let pctSum = 0;
  let pctN = 0;
  for (let i = 0; i < n; i++) {
    const a = actual[i]!;
    const f = forecast[i]!;
    absErr += Math.abs(f - a);
    err += f - a;
    sumA += a;
    sumAbsA += Math.abs(a);
    if (a !== 0) {
      pctSum += Math.abs((f - a) / a);
      pctN++;
    }
  }
  return {
    mape: pctN ? pctSum / pctN : null,
    wape: sumAbsA > 0 ? absErr / sumAbsA : null,
    bias: sumA !== 0 ? err / sumA : null,
    mae: n ? absErr / n : 0,
  };
}
