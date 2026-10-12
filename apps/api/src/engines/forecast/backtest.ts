import { accuracy, type Accuracy } from './metrics';
import { fit, predict } from './index';
import { SEASON_LENGTH, type FitOptions, type ModelName } from './types';

export const DEFAULT_HOLDOUT = 12;
const CANDIDATE_ORDER: ModelName[] = [
  'naive',
  'moving_average',
  'ses',
  'holt',
  'seasonal_naive',
  'holt_winters',
];

export interface CandidateScore extends Accuracy {
  model: ModelName;
  /** The number used to rank candidates: WAPE, or MAE when the holdout has no demand. */
  score: number;
}

export interface Selection {
  model: ModelName;
  reason: 'intermittent' | 'backtest' | 'short-history';
  /** Backtest accuracy of the chosen model (null when there was too little history to backtest). */
  accuracy: Accuracy | null;
  scores: CandidateScore[];
  holdout: number;
}

export const zeroShare = (history: number[]) =>
  history.length ? history.filter((v) => v <= 0).length / history.length : 1;

/** Score one model by fitting on everything except the last `holdout` weeks and forecasting them. */
export function backtestModel(
  model: ModelName,
  history: number[],
  holdout: number,
  opts: FitOptions = {},
): Accuracy {
  const train = history.slice(0, history.length - holdout);
  const actual = history.slice(history.length - holdout);
  const forecast = predict(fit(model, train, opts), holdout).values;
  return accuracy(actual, forecast);
}

/**
 * Backtest every eligible model on a holdout and pick the lowest WAPE.
 * Rules: series shorter than 2 seasons skip Holt-Winters and seasonal naive; series with more than
 * 50% zero weeks use Croston.
 */
export function selectModel(
  history: number[],
  opts: { holdout?: number; season?: number } = {},
): Selection {
  const season = opts.season ?? SEASON_LENGTH;
  const n = history.length;
  const holdout = Math.min(opts.holdout ?? DEFAULT_HOLDOUT, Math.floor(n / 3));
  const canBacktest = holdout >= 2 && n - holdout >= 3;
  const fitOpts = { season };

  if (zeroShare(history) > 0.5) {
    return {
      model: 'croston',
      reason: 'intermittent',
      accuracy: canBacktest ? backtestModel('croston', history, holdout, fitOpts) : null,
      scores: [],
      holdout: canBacktest ? holdout : 0,
    };
  }
  if (!canBacktest) {
    return {
      model: n >= 3 ? 'ses' : 'naive',
      reason: 'short-history',
      accuracy: null,
      scores: [],
      holdout: 0,
    };
  }

  const trainLen = n - holdout;
  const eligible = CANDIDATE_ORDER.filter((m) =>
    m === 'seasonal_naive' || m === 'holt_winters' ? trainLen >= 2 * season : true,
  );
  const scores: CandidateScore[] = eligible.map((model) => {
    const acc = backtestModel(model, history, holdout, fitOpts);
    return { model, ...acc, score: acc.wape ?? acc.mae };
  });
  // Ties go to the simpler (earlier) model.
  let best = scores[0]!;
  for (const s of scores) if (s.score < best.score - 1e-9) best = s;
  const { model, score: _score, ...acc } = best;
  void _score;
  return { model, reason: 'backtest', accuracy: acc, scores, holdout };
}
