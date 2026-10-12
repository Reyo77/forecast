import {
  MODEL_NAMES,
  SEASON_LENGTH,
  Z80,
  type FitOptions,
  type FittedModel,
  type Forecast,
  type ModelName,
} from './types';
import { finiteOrZero } from './stats';
import { fitCroston } from './models/croston';
import { fitHolt } from './models/holt';
import { fitHoltWinters } from './models/holtWinters';
import { fitMovingAverage } from './models/movingAverage';
import { fitNaive } from './models/naive';
import { fitSeasonalNaive } from './models/seasonalNaive';
import { fitSes } from './models/ses';

export * from './types';
export { accuracy, type Accuracy } from './metrics';
export {
  fitCroston,
  fitHolt,
  fitHoltWinters,
  fitMovingAverage,
  fitNaive,
  fitSeasonalNaive,
  fitSes,
};

const FITTERS: Record<ModelName, (history: number[], opts?: FitOptions) => FittedModel> = {
  naive: (h) => fitNaive(h),
  seasonal_naive: fitSeasonalNaive,
  moving_average: fitMovingAverage,
  ses: fitSes,
  holt: fitHolt,
  holt_winters: fitHoltWinters,
  croston: fitCroston,
};

export const isModelName = (x: string): x is ModelName =>
  (MODEL_NAMES as readonly string[]).includes(x);

/** fit(history) → model. History is a weekly series, oldest first. */
export function fit(name: ModelName, history: number[], opts: FitOptions = {}): FittedModel {
  const clean = history.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  return FITTERS[name](clean, { season: SEASON_LENGTH, ...opts });
}

/**
 * predict(model, horizon) → { values, lower, upper }.
 * Values are clamped at zero; the 80% interval comes from in-sample residuals and widens with the step.
 */
export function predict(model: FittedModel, horizon: number): Forecast {
  const h = Math.max(0, Math.floor(horizon));
  const raw = model.forecast(h);
  const values: number[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  for (let k = 0; k < h; k++) {
    const v = Math.max(0, finiteOrZero(raw[k]!));
    const half = Z80 * finiteOrZero(model.residualSd) * finiteOrZero(model.growth(k + 1));
    values.push(v);
    lower.push(Math.max(0, v - half));
    upper.push(v + half);
  }
  return { values, lower, upper };
}
