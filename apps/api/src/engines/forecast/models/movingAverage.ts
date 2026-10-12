import type { FitOptions, FittedModel } from '../types';
import { mean, residualSd } from '../stats';

/** Forecast = the average of the last `window` observations (default 4). */
export function fitMovingAverage(history: number[], opts: FitOptions = {}): FittedModel {
  const window = Math.max(1, Math.floor(opts.window ?? 4));
  const n = history.length;
  const w = Math.min(window, n);
  const level = n ? mean(history.slice(n - w)) : 0;
  const fitted = history.map((_, t) =>
    t > 0 ? mean(history.slice(Math.max(0, t - window), t)) : NaN,
  );
  return {
    name: 'moving_average',
    params: { window },
    degraded: false,
    fitted,
    residualSd: residualSd(history, fitted, 0),
    forecast: (h) => Array.from({ length: h }, () => level),
    growth: () => 1,
  };
}
