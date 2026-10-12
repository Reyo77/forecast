import { SEASON_LENGTH, type FitOptions, type FittedModel } from '../types';
import { residualSd } from '../stats';
import { fitNaive } from './naive';

/** Forecast = the value from the same week one season ago (falls back to naive if < 1 season of history). */
export function fitSeasonalNaive(history: number[], opts: FitOptions = {}): FittedModel {
  const m = opts.season ?? SEASON_LENGTH;
  const n = history.length;
  if (n < m) return { ...fitNaive(history), name: 'seasonal_naive', degraded: true };
  const fitted = history.map((_, t) => (t >= m ? history[t - m]! : NaN));
  return {
    name: 'seasonal_naive',
    params: { season: m },
    degraded: false,
    fitted,
    residualSd: residualSd(history, fitted, 0),
    forecast: (h) => Array.from({ length: h }, (_, k) => history[n - m + (k % m)]!),
    growth: (k) => Math.sqrt(Math.ceil(k / m)),
  };
}
