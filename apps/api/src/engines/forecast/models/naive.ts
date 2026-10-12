import type { FittedModel } from '../types';
import { residualSd } from '../stats';

/** Forecast = the last observed value. */
export function fitNaive(history: number[]): FittedModel {
  const last = history.length ? history[history.length - 1]! : 0;
  const fitted = history.map((_, t) => (t > 0 ? history[t - 1]! : NaN));
  return {
    name: 'naive',
    params: {},
    degraded: false,
    fitted,
    residualSd: residualSd(history, fitted, 0),
    forecast: (h) => Array.from({ length: h }, () => last),
    growth: (k) => Math.sqrt(k),
  };
}
