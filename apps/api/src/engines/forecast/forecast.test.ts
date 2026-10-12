import fc from 'fast-check';
import { createRng } from '../../modules/sales/demo';
import { accuracy } from './metrics';
import {
  fit,
  predict,
  fitCroston,
  fitHolt,
  fitHoltWinters,
  fitMovingAverage,
  fitNaive,
  fitSeasonalNaive,
  fitSes,
} from './index';
import { MODEL_NAMES, Z80, type ModelName } from './types';

const forecastOf = (m: ReturnType<typeof fit>, h: number) => predict(m, h).values;
const close = (a: number[], b: number[], eps = 1e-9) => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(Math.abs(x - b[i]!)).toBeLessThan(eps));
};

describe('golden tests (hand-calculated)', () => {
  it('naive repeats the last value', () => close(forecastOf(fitNaive([1, 2, 3]), 2), [3, 3]));

  it('seasonal naive repeats the last full season', () => {
    close(forecastOf(fitSeasonalNaive([1, 2, 3, 4, 5, 6], { season: 3 }), 4), [4, 5, 6, 4]);
  });

  it('moving average (window 2) = mean of the last two points; fitted values are trailing means', () => {
    const m = fitMovingAverage([2, 4, 6, 8], { window: 2 });
    close(forecastOf(m, 3), [7, 7, 7]);
    expect(m.fitted[0]).toBeNaN();
    expect(m.fitted.slice(1)).toEqual([2, 3, 5]);
  });

  it('SES alpha=0.5 on [3,5,7]: level 3 → 4 → 5.5', () => {
    const m = fitSes([3, 5, 7], { alpha: 0.5 });
    close(forecastOf(m, 2), [5.5, 5.5]);
    expect(m.fitted.slice(1)).toEqual([3, 4]);
  });

  it('Holt (alpha=beta=0.5) extrapolates a perfect line exactly: [1,3,5] → 7, 9', () => {
    const m = fitHolt([1, 3, 5], { alpha: 0.5, beta: 0.5 });
    close(forecastOf(m, 2), [7, 9]);
    expect(m.residualSd).toBe(0);
  });

  it('Holt-Winters (season 2) reproduces a perfect seasonal pattern', () => {
    const m = fitHoltWinters([10, 20, 10, 20, 10, 20], {
      season: 2,
      alpha: 0.3,
      beta: 0.1,
      gamma: 0.1,
    });
    close(forecastOf(m, 4), [10, 20, 10, 20]);
    expect(m.residualSd).toBeCloseTo(0, 9);
    expect(m.degraded).toBe(false);
  });

  it('Holt-Winters (season 4) follows trend + season: y = 2t + [5,-5,3,-3]', () => {
    const season = [5, -5, 3, -3];
    const y = Array.from({ length: 16 }, (_, t) => 100 + 2 * t + season[t % 4]!);
    const out = forecastOf(fitHoltWinters(y, { season: 4, alpha: 0.2, beta: 0.1, gamma: 0.1 }), 4);
    close(
      out,
      Array.from({ length: 4 }, (_, k) => 100 + 2 * (16 + k) + season[(16 + k) % 4]!),
      1e-6,
    );
  });

  it('Croston: demand of 5 every 3rd week → rate 5/3; no fitted value exists before the first demand', () => {
    const m = fitCroston([0, 0, 5, 0, 0, 5, 0, 0, 5]);
    close(forecastOf(m, 2), [5 / 3, 5 / 3], 1e-9);
    expect(m.fitted.slice(0, 3).every(Number.isNaN)).toBe(true);
    expect(m.fitted[3]).toBeCloseTo(5 / 3, 9);
  });

  it('Croston smooths size and interval (alpha 0.1): [5,0,0,5] → interval 0.1·3 + 0.9·1 = 1.2 → 5 / 1.2', () => {
    close(forecastOf(fitCroston([5, 0, 0, 5]), 1), [5 / 1.2], 1e-9);
  });

  it('prediction interval = value ± z80·sd·growth, clamped at zero', () => {
    const m = fitNaive([10, 14, 8, 12]); // residuals vs previous: 4, -6, 4 → sd = sqrt((16+36+16)/3)
    const sd = Math.sqrt(68 / 3);
    expect(m.residualSd).toBeCloseTo(sd, 9);
    const f = predict(m, 3);
    expect(f.values).toEqual([12, 12, 12]);
    expect(f.upper[0]).toBeCloseTo(12 + Z80 * sd, 9);
    expect(f.upper[3 - 1]).toBeCloseTo(12 + Z80 * sd * Math.sqrt(3), 9);
    expect(f.lower[0]).toBeCloseTo(Math.max(0, 12 - Z80 * sd), 9);
    const low = predict(fitNaive([1, 9, 1, 9, 1]), 2);
    expect(low.lower.every((x) => x === 0)).toBe(true);
  });

  it('metrics: WAPE, MAPE, bias, MAE', () => {
    const a = accuracy([100, 200], [110, 180]);
    expect(a.wape).toBeCloseTo(0.1, 12);
    expect(a.mape).toBeCloseTo(0.1, 12);
    expect(a.bias).toBeCloseTo(-10 / 300, 12);
    expect(a.mae).toBe(15);
  });

  it('metrics ignore zero actuals in MAPE and are null when undefined', () => {
    expect(accuracy([0, 10], [5, 10])).toMatchObject({ mape: 0, wape: 0.5, bias: 0.5, mae: 2.5 });
    expect(accuracy([0, 0], [3, 0])).toEqual({ mape: null, wape: null, bias: null, mae: 1.5 });
    expect(accuracy([], [])).toEqual({ mape: null, wape: null, bias: null, mae: 0 });
  });
});

describe('edge cases for every model', () => {
  const opts = { season: 4 };
  it.each(MODEL_NAMES)('%s: empty history → zeros, no NaN', (name) => {
    const f = predict(fit(name, [], opts), 5);
    expect(f.values).toEqual([0, 0, 0, 0, 0]);
    expect(f.lower).toEqual([0, 0, 0, 0, 0]);
    expect(f.upper).toEqual([0, 0, 0, 0, 0]);
  });

  it.each(MODEL_NAMES)('%s: a single point is handled', (name) => {
    const f = predict(fit(name, [5], opts), 3);
    expect(f.values.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    if (name !== 'seasonal_naive') expect(f.values[0]).toBeCloseTo(5, 9);
  });

  it.each(MODEL_NAMES)('%s: all zeros → all zeros', (name) => {
    const f = predict(fit(name, Array(30).fill(0), opts), 6);
    expect(f.values).toEqual(Array(6).fill(0));
    expect(f.upper).toEqual(Array(6).fill(0));
  });

  it.each(['seasonal_naive', 'holt_winters'] as ModelName[])(
    '%s: shorter than a season degrades gracefully and says so',
    (name) => {
      const m = fit(name, [3, 4, 5], { season: 52 });
      expect(m.degraded).toBe(true);
      expect(predict(m, 4).values.every((v) => Number.isFinite(v))).toBe(true);
    },
  );

  it('Holt-Winters needs two seasons; with exactly two it is not degraded', () => {
    expect(fit('holt_winters', Array(7).fill(4), { season: 4 }).degraded).toBe(true);
    expect(fit('holt_winters', Array(8).fill(4), { season: 4 }).degraded).toBe(false);
  });

  it('negative / NaN inputs are treated as zero demand', () => {
    const f = predict(fit('ses', [5, -3, NaN, 5, Infinity]), 2);
    expect(f.values.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });

  it('horizon 0 gives empty arrays; fractional horizon is floored', () => {
    expect(predict(fit('naive', [1, 2]), 0).values).toEqual([]);
    expect(predict(fit('naive', [1, 2]), 2.9).values).toHaveLength(2);
  });
});

describe('properties', () => {
  const series = fc.array(fc.integer({ min: 0, max: 500 }), { maxLength: 80 });
  const horizon = fc.integer({ min: 1, max: 30 });

  it.each(MODEL_NAMES)(
    '%s: output length = horizon, finite, never negative, lower ≤ value ≤ upper',
    (name) => {
      fc.assert(
        fc.property(series, horizon, (history, h) => {
          const f = predict(fit(name, history, { season: 4 }), h);
          for (const arr of [f.values, f.lower, f.upper]) expect(arr).toHaveLength(h);
          for (let k = 0; k < h; k++) {
            expect(Number.isFinite(f.values[k]!) && Number.isFinite(f.upper[k]!)).toBe(true);
            expect(f.values[k]!).toBeGreaterThanOrEqual(0);
            expect(f.lower[k]!).toBeGreaterThanOrEqual(0);
            expect(f.lower[k]!).toBeLessThanOrEqual(f.values[k]! + 1e-9);
            expect(f.values[k]!).toBeLessThanOrEqual(f.upper[k]! + 1e-9);
          }
        }),
        { numRuns: 150 },
      );
    },
  );

  it.each(MODEL_NAMES)('%s: interval growth never shrinks with the horizon', (name) => {
    fc.assert(
      fc.property(series, (history) => {
        const m = fit(name, history, { season: 4 });
        for (let k = 1; k < 40; k++)
          expect(m.growth(k + 1)).toBeGreaterThanOrEqual(m.growth(k) - 1e-12);
      }),
      { numRuns: 60 },
    );
  });

  it.each(MODEL_NAMES)(
    '%s: a constant series gives a constant forecast and a zero-width interval',
    (name) => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 12, max: 60 }), (c, n) => {
          const f = predict(fit(name, Array(n).fill(c), { season: 4 }), 6);
          for (let k = 0; k < 6; k++) {
            expect(f.values[k]!).toBeCloseTo(c, 6);
            expect(f.upper[k]! - f.lower[k]!).toBeLessThan(1e-6);
          }
        }),
        { numRuns: 40 },
      );
    },
  );

  it('fitting is deterministic', () => {
    fc.assert(
      fc.property(
        series,
        (h) =>
          JSON.stringify(predict(fit('holt_winters', h, { season: 4 }), 5)) ===
          JSON.stringify(predict(fit('holt_winters', h, { season: 4 }), 5)),
      ),
    );
  });

  it('does not mutate its input', () => {
    const h = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8];
    const copy = [...h];
    for (const name of MODEL_NAMES) predict(fit(name, h, { season: 4 }), 4);
    expect(h).toEqual(copy);
  });

  it('forecasts scale with the data (scale-equivariance) for level/trend/season models', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 200 }), { minLength: 12, maxLength: 40 }),
        fc.integer({ min: 2, max: 9 }),
        (h, k) => {
          for (const name of [
            'naive',
            'moving_average',
            'ses',
            'holt',
            'holt_winters',
          ] as ModelName[]) {
            const a = predict(fit(name, h, { season: 4 }), 3).values;
            const b = predict(
              fit(
                name,
                h.map((x) => x * k),
                { season: 4 },
              ),
              3,
            ).values;
            a.forEach((x, i) =>
              expect(Math.abs(x * k - b[i]!)).toBeLessThan(1e-6 * Math.max(1, b[i]!)),
            );
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('prediction interval calibration', () => {
  it('about 80% of fresh observations of a stationary series fall inside the interval', () => {
    const rng = createRng(11);
    const data = Array.from({ length: 2400 }, () => Math.max(0, 100 + rng.normal() * 10));
    const train = data.slice(0, 1200);
    const test = data.slice(1200);
    for (const name of ['moving_average', 'ses'] as ModelName[]) {
      const f = predict(fit(name, train), 1);
      const inside = test.filter((y) => y >= f.lower[0]! && y <= f.upper[0]!).length / test.length;
      expect(inside).toBeGreaterThan(0.74);
      expect(inside).toBeLessThan(0.88);
    }
  });
});
