export const MODEL_NAMES = [
  'naive',
  'seasonal_naive',
  'moving_average',
  'ses',
  'holt',
  'holt_winters',
  'croston',
] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

export const SEASON_LENGTH = 52;
/** z-score for a two-sided 80% prediction interval. */
export const Z80 = 1.2815515655446004;

export interface FittedModel {
  name: ModelName;
  params: Record<string, number>;
  /** True when the history was too short for the model, so a simpler method was used instead. */
  degraded: boolean;
  /** One-step-ahead in-sample fitted values (NaN where no prediction was possible). */
  fitted: number[];
  /** Standard deviation of the in-sample one-step residuals. */
  residualSd: number;
  /** Raw (unclamped) point forecasts for steps 1..h. */
  forecast(h: number): number[];
  /** How the interval half-width scales with the forecast step k (1-based). */
  growth(k: number): number;
}

export interface Forecast {
  values: number[];
  lower: number[];
  upper: number[];
}

export interface FitOptions {
  season?: number;
  window?: number;
  alpha?: number;
  beta?: number;
  gamma?: number;
}
