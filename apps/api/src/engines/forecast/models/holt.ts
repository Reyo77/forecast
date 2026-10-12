import type { FitOptions, FittedModel } from '../types';
import { range, residualSd, sse } from '../stats';
import { fitSes } from './ses';

function run(history: number[], alpha: number, beta: number) {
  const fitted: number[] = [];
  let level = history[0]!;
  let trend = history[1]! - history[0]!;
  for (let t = 0; t < history.length; t++) {
    if (t === 0) {
      fitted.push(NaN);
      continue;
    }
    fitted.push(level + trend);
    const newLevel = alpha * history[t]! + (1 - alpha) * (level + trend);
    trend = beta * (newLevel - level) + (1 - beta) * trend;
    level = newLevel;
  }
  return { fitted, level, trend };
}

/** Holt's linear trend method; (alpha, beta) chosen by grid search on in-sample squared error unless given. */
export function fitHolt(history: number[], opts: FitOptions = {}): FittedModel {
  if (history.length < 2) {
    const ses = fitSes(history, opts);
    return { ...ses, name: 'holt', degraded: true };
  }
  let alpha = opts.alpha;
  let beta = opts.beta;
  if (alpha === undefined || beta === undefined) {
    let best = Infinity;
    alpha = 0.5;
    beta = 0.1;
    for (const a of [0.05, ...range(0.1, 0.9, 0.1)]) {
      for (const b of [0.01, 0.05, 0.1, 0.2, 0.3, 0.5]) {
        const e = sse(history, run(history, a, b).fitted);
        if (e < best - 1e-12) {
          best = e;
          alpha = a;
          beta = b;
        }
      }
    }
  }
  const { fitted, level, trend } = run(history, alpha, beta);
  return {
    name: 'holt',
    params: { alpha, beta },
    degraded: false,
    fitted,
    residualSd: residualSd(history, fitted, 2),
    forecast: (h) => Array.from({ length: h }, (_, k) => level + (k + 1) * trend),
    growth: (k) => Math.sqrt(k),
  };
}
