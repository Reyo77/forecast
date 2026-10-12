import type { FitOptions, FittedModel } from '../types';
import { residualSd } from '../stats';

/**
 * Croston's method for intermittent demand: smooth the non-zero demand size and the interval
 * between demands separately; the forecast rate is size / interval.
 */
export function fitCroston(history: number[], opts: FitOptions = {}): FittedModel {
  const alpha = opts.alpha ?? 0.1;
  let size: number | null = null;
  let interval: number | null = null;
  let q = 1; // periods since the last demand, counting the current one
  const fitted: number[] = [];
  for (const y of history) {
    // No forecast exists before the first demand, so those periods are excluded from the residuals.
    fitted.push(size !== null && interval !== null ? size / interval : NaN);
    if (y > 0) {
      if (size === null || interval === null) {
        size = y;
        interval = q;
      } else {
        size = alpha * y + (1 - alpha) * size;
        interval = alpha * q + (1 - alpha) * interval;
      }
      q = 1;
    } else {
      q++;
    }
  }
  const rate = size !== null && interval !== null ? size / interval : 0;
  return {
    name: 'croston',
    params: { alpha },
    degraded: false,
    fitted,
    residualSd: residualSd(history, fitted, 1),
    forecast: (h) => Array.from({ length: h }, () => rate),
    growth: () => 1,
  };
}
