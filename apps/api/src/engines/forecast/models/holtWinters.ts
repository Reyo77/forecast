import { SEASON_LENGTH, type FitOptions, type FittedModel } from '../types';
import { mean, residualSd, sse } from '../stats';
import { fitHolt } from './holt';

interface State {
  level: number;
  trend: number;
  seasonal: number[];
}

function initialState(history: number[], m: number): State {
  const first = history.slice(0, m);
  const second = history.slice(m, 2 * m);
  const m1 = mean(first);
  const m2 = mean(second);
  const trend = (m2 - m1) / m;
  // The season-1 mean sits at time (m-1)/2 and the level before t=0 is `level`; level_t = level + trend*(t+1).
  const level = m1 - (trend * (m + 1)) / 2;
  const raw = Array.from({ length: m }, (_, i) => {
    const adj = trend * (i - (m - 1) / 2);
    return (first[i]! - m1 - adj + (second[i]! - m2 - adj)) / 2;
  });
  const centre = mean(raw);
  return { level, trend, seasonal: raw.map((s) => s - centre) };
}

function run(history: number[], m: number, alpha: number, beta: number, gamma: number) {
  const st = initialState(history, m);
  let { level, trend } = st;
  const seasonal = [...st.seasonal];
  const fitted: number[] = [];
  for (let t = 0; t < history.length; t++) {
    const i = t % m;
    fitted.push(level + trend + seasonal[i]!);
    const newLevel = alpha * (history[t]! - seasonal[i]!) + (1 - alpha) * (level + trend);
    trend = beta * (newLevel - level) + (1 - beta) * trend;
    seasonal[i] = gamma * (history[t]! - newLevel) + (1 - gamma) * seasonal[i]!;
    level = newLevel;
  }
  return { fitted, level, trend, seasonal };
}

/**
 * Holt-Winters with additive seasonality (default season length 52 weeks). Needs two full seasons;
 * with less history it degrades to Holt's method and flags `degraded`.
 */
export function fitHoltWinters(history: number[], opts: FitOptions = {}): FittedModel {
  const m = Math.max(2, Math.floor(opts.season ?? SEASON_LENGTH));
  const n = history.length;
  if (n < 2 * m) return { ...fitHolt(history), name: 'holt_winters', degraded: true };

  let { alpha, beta, gamma } = opts;
  if (alpha === undefined || beta === undefined || gamma === undefined) {
    let best = Infinity;
    alpha = 0.3;
    beta = 0.05;
    gamma = 0.1;
    for (const a of [0.1, 0.3, 0.5, 0.7]) {
      for (const b of [0.01, 0.05, 0.1]) {
        for (const g of [0.05, 0.1, 0.3, 0.5]) {
          const e = sse(history, run(history, m, a, b, g).fitted);
          if (e < best - 1e-12) {
            best = e;
            alpha = a;
            beta = b;
            gamma = g;
          }
        }
      }
    }
  }
  const { fitted, level, trend, seasonal } = run(history, m, alpha, beta, gamma);
  return {
    name: 'holt_winters',
    params: { alpha, beta, gamma, season: m },
    degraded: false,
    fitted,
    residualSd: residualSd(history, fitted, 3),
    forecast: (h) =>
      Array.from({ length: h }, (_, k) => level + (k + 1) * trend + seasonal[(n + k) % m]!),
    growth: (k) => Math.sqrt(1 + (k - 1) / m + k * 0.02),
  };
}
