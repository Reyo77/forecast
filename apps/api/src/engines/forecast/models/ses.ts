import type { FitOptions, FittedModel } from '../types';
import { range, residualSd, sse } from '../stats';

function run(history: number[], alpha: number) {
  const fitted: number[] = [];
  let level = history.length ? history[0]! : 0;
  for (let t = 0; t < history.length; t++) {
    if (t === 0) fitted.push(NaN);
    else {
      fitted.push(level);
      level = alpha * history[t]! + (1 - alpha) * level;
    }
  }
  return { fitted, level };
}

/** Simple exponential smoothing; alpha is chosen by minimising in-sample squared error unless given. */
export function fitSes(history: number[], opts: FitOptions = {}): FittedModel {
  let alpha = opts.alpha;
  if (alpha === undefined) {
    let best = Infinity;
    alpha = 0.3;
    for (const a of range(0.05, 0.95, 0.05)) {
      const e = sse(history, run(history, a).fitted);
      if (e < best - 1e-12) {
        best = e;
        alpha = a;
      }
    }
  }
  const { fitted, level } = run(history, alpha);
  const a = alpha;
  return {
    name: 'ses',
    params: { alpha },
    degraded: false,
    fitted,
    residualSd: residualSd(history, fitted, 1),
    forecast: (h) => Array.from({ length: h }, () => level),
    growth: (k) => Math.sqrt(1 + (k - 1) * a * a),
  };
}
