export const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Sum of squared one-step errors over points where a fitted value exists. */
export function sse(history: number[], fitted: number[]): number {
  let s = 0;
  for (let t = 0; t < history.length; t++) {
    const f = fitted[t];
    if (f !== undefined && Number.isFinite(f)) s += (history[t]! - f) ** 2;
  }
  return s;
}

/** Residual standard deviation with a small degrees-of-freedom correction. */
export function residualSd(history: number[], fitted: number[], nParams: number): number {
  let count = 0;
  const s = sse(history, fitted);
  for (let t = 0; t < history.length; t++) if (Number.isFinite(fitted[t])) count++;
  if (count === 0) return 0;
  return Math.sqrt(s / Math.max(1, count - nParams));
}

export const finiteOrZero = (x: number) => (Number.isFinite(x) ? x : 0);

export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push(Math.round(x * 1000) / 1000);
  return out;
}
