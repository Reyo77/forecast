import fc from 'fast-check';
import { createRng } from '../../modules/sales/demo';
import { backtestModel, selectModel, zeroShare } from './backtest';
import { accuracy } from './metrics';
import { fit, predict } from './index';
import { MODEL_NAMES } from './types';

const noisy = (n: number, f: (t: number) => number, sigma: number, seed = 5) => {
  const rng = createRng(seed);
  return Array.from({ length: n }, (_, t) => Math.max(0, Math.round(f(t) + rng.normal() * sigma)));
};

describe('backtest scoring', () => {
  it('scores a model on the last N weeks after fitting on the rest', () => {
    const h = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16];
    const acc = backtestModel('naive', h, 3);
    expect(acc).toEqual(accuracy([15, 14, 16], [13, 13, 13]));
  });

  it('zeroShare', () => {
    expect(zeroShare([0, 0, 1, 2])).toBe(0.5);
    expect(zeroShare([])).toBe(1);
  });
});

describe('automatic model selection', () => {
  it('trend series → Holt', () => {
    const s = selectModel(noisy(80, (t) => 50 + 3 * t, 4));
    expect(s.model).toBe('holt');
    expect(s.reason).toBe('backtest');
    expect(s.scores.map((x) => x.model)).toEqual(['naive', 'moving_average', 'ses', 'holt']); // 80 weeks < 2 seasons
  });

  it('seasonal series with three years of history → Holt-Winters', () => {
    const y = noisy(156, (t) => 200 + 0.5 * t + 60 * Math.sin((2 * Math.PI * t) / 52), 5);
    const s = selectModel(y);
    expect(s.model).toBe('holt_winters');
    expect(s.scores.map((x) => x.model)).toContain('seasonal_naive');
    expect(s.accuracy!.wape!).toBeLessThan(0.15);
  });

  it('sparse series (>50% zero weeks) → Croston', () => {
    const rng = createRng(3);
    const y = Array.from({ length: 80 }, () =>
      rng.next() < 0.25 ? 4 + Math.floor(rng.next() * 4) : 0,
    );
    expect(zeroShare(y)).toBeGreaterThan(0.5);
    const s = selectModel(y);
    expect(s.model).toBe('croston');
    expect(s.reason).toBe('intermittent');
    expect(s.accuracy).not.toBeNull();
  });

  it('exactly 50% zeros is not treated as intermittent', () => {
    const y = Array.from({ length: 40 }, (_, i) => (i % 2 ? 10 : 0));
    expect(selectModel(y).reason).toBe('backtest');
  });

  it('series shorter than two seasons skip Holt-Winters and seasonal naive; longer ones include them', () => {
    const short = selectModel(noisy(100, () => 100, 5)); // train = 88 < 104
    expect(short.scores.map((s) => s.model)).not.toContain('holt_winters');
    expect(short.scores.map((s) => s.model)).not.toContain('seasonal_naive');
    const long = selectModel(noisy(120, () => 100, 5)); // train = 108 ≥ 104
    expect(long.scores.map((s) => s.model)).toEqual(
      expect.arrayContaining(['holt_winters', 'seasonal_naive']),
    );
  });

  it('a perfectly constant series picks the simplest model (ties → first)', () => {
    expect(selectModel(Array(40).fill(25)).model).toBe('naive');
  });

  it('picks the lowest-WAPE candidate and reports its backtest accuracy', () => {
    const s = selectModel(noisy(60, (t) => 100 + 2 * t, 6));
    const best = [...s.scores].sort((a, b) => a.score - b.score)[0]!;
    expect(s.model).toBe(best.model);
    expect(s.accuracy!.wape).toBe(best.wape);
    expect(s.holdout).toBe(12);
  });

  it('too little history → no backtest, simple model, no accuracy', () => {
    const s = selectModel([5, 6, 7]);
    expect(s).toMatchObject({ model: 'ses', reason: 'short-history', accuracy: null, scores: [] });
    expect(selectModel([4]).model).toBe('naive');
    expect(selectModel([]).model).toBe('croston'); // empty counts as all-zero → intermittent path, no crash
  });

  it('holdout shrinks for short series (never more than a third)', () => {
    expect(selectModel(Array.from({ length: 15 }, (_, i) => 10 + i)).holdout).toBe(5);
  });

  it('a series that is zero in the holdout is ranked by MAE instead of WAPE', () => {
    const y = [...Array(40).fill(20), ...Array(12).fill(0)];
    const s = selectModel(y);
    expect(s.scores.every((c) => c.wape === null)).toBe(true);
    expect(MODEL_NAMES).toContain(s.model);
    expect(s.scores.every((c) => Number.isFinite(c.score))).toBe(true);
  });

  it('is deterministic and any selected model can produce a valid forecast (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 300 }), { maxLength: 130 }), (h) => {
        const a = selectModel(h);
        expect(JSON.stringify(a)).toBe(JSON.stringify(selectModel(h)));
        const f = predict(fit(a.model, h), 8);
        expect(f.values.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
        for (const sc of a.scores) expect(Number.isFinite(sc.score)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('Holt-Winters beats seasonal naive on noisy seasonal data, seasonal naive beats naive', () => {
    const y = noisy(156, (t) => 150 + 40 * Math.sin((2 * Math.PI * t) / 52), 6, 9);
    const s = selectModel(y);
    const by = Object.fromEntries(s.scores.map((c) => [c.model, c.score]));
    expect(by.holt_winters).toBeLessThan(by.seasonal_naive!);
    expect(by.seasonal_naive).toBeLessThan(by.naive!);
  });
});

describe('performance', () => {
  it('selects and forecasts 300 three-year series in a few seconds', () => {
    const rng = createRng(1);
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) {
      const base = 20 + Math.floor(rng.next() * 200);
      const y = Array.from({ length: 156 }, (_, t) =>
        Math.max(
          0,
          Math.round(base * (1 + 0.3 * Math.sin((2 * Math.PI * t) / 52)) + rng.normal() * 5),
        ),
      );
      const sel = selectModel(y);
      predict(fit(sel.model, y), 26);
    }
    expect(Date.now() - t0).toBeLessThan(15000);
  });
});
