import type { Prisma } from '@prisma/client';
import type { CreateRunInput } from '@supplycast/shared';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import { backtestModel, DEFAULT_HOLDOUT, selectModel } from '../../engines/forecast/backtest';
import { fit, predict } from '../../engines/forecast';
import { densify, weeksAfter } from '../../engines/forecast/series';
import { SEASON_LENGTH, type ModelName } from '../../engines/forecast/types';
import { reserveUsage } from '../billing/limits';
import { enqueueJob } from '../../jobs/runner';
import { notifyUser } from '../notifications/service';

export const FORECAST_RUN_JOB = 'forecast.run';

export interface SeriesForecast {
  modelUsed: ModelName;
  reason: string | null;
  holdout: number;
  accuracy: { mape: number | null; wape: number | null; bias: number | null } | null;
  weekStarts: number[];
  values: number[];
  lower: number[];
  upper: number[];
}

/** Forecast one weekly series with automatic model selection or a fixed model. Pure apart from its inputs. */
export function forecastSeries(
  history: number[],
  endWeek: number,
  horizon: number,
  method: 'AUTO' | ModelName,
): SeriesForecast {
  let modelUsed: ModelName;
  let reason: string | null = null;
  let accuracy: SeriesForecast['accuracy'] = null;
  let holdout = 0;
  if (method === 'AUTO') {
    const sel = selectModel(history);
    modelUsed = sel.model;
    reason = sel.reason;
    holdout = sel.holdout;
    accuracy = sel.accuracy
      ? { mape: sel.accuracy.mape, wape: sel.accuracy.wape, bias: sel.accuracy.bias }
      : null;
  } else {
    modelUsed = method;
    reason = 'fixed';
    holdout = Math.min(DEFAULT_HOLDOUT, Math.floor(history.length / 3));
    if (holdout >= 2 && history.length - holdout >= 3) {
      const a = backtestModel(method, history, holdout, { season: SEASON_LENGTH });
      accuracy = { mape: a.mape, wape: a.wape, bias: a.bias };
    } else holdout = 0;
  }
  const f = predict(fit(modelUsed, history), horizon);
  return {
    modelUsed,
    reason,
    holdout,
    accuracy,
    weekStarts: weeksAfter(endWeek, horizon),
    values: f.values,
    lower: f.lower,
    upper: f.upper,
  };
}

interface SeriesKey {
  productId: string;
  locationId: string;
}

async function filteredProductIds(
  tenantId: string,
  filters: CreateRunInput['filters'],
): Promise<string[] | undefined> {
  if (filters.productId) return [filters.productId];
  if (filters.categoryId) {
    const rows = await prisma.product.findMany({
      where: {
        tenantId,
        OR: [{ categoryId: filters.categoryId }, { category: { parentId: filters.categoryId } }],
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
  return undefined;
}

/** Distinct product/location pairs that have sales history and match the filters. */
export async function resolveSeries(
  tenantId: string,
  filters: CreateRunInput['filters'],
): Promise<SeriesKey[]> {
  const productIds = await filteredProductIds(tenantId, filters);
  if (productIds && productIds.length === 0) return [];
  const rows = await prisma.salesRecord.groupBy({
    by: ['productId', 'locationId'],
    where: {
      tenantId,
      ...(productIds && { productId: { in: productIds } }),
      ...(filters.locationId && { locationId: filters.locationId }),
    },
  });
  return rows.map((r) => ({ productId: r.productId, locationId: r.locationId }));
}

export async function createRun(tenantId: string, userId: string, input: CreateRunInput) {
  // Validate that filter targets belong to this tenant (404, not data).
  const { filters } = input;
  if (
    filters.productId &&
    !(await prisma.product.findFirst({ where: { id: filters.productId, tenantId } }))
  )
    throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  if (
    filters.locationId &&
    !(await prisma.location.findFirst({ where: { id: filters.locationId, tenantId } }))
  )
    throw new HttpError(404, 'NOT_FOUND', 'Location not found');
  if (
    filters.categoryId &&
    !(await prisma.category.findFirst({ where: { id: filters.categoryId, tenantId } }))
  )
    throw new HttpError(404, 'NOT_FOUND', 'Category not found');

  const series = await resolveSeries(tenantId, filters);
  if (series.length === 0) {
    throw new HttpError(
      400,
      'NO_SALES_DATA',
      'There is no sales history for this selection. Import sales or load demo data first.',
    );
  }
  // Usage is consumed only now that the run is valid and about to start.
  const reservation = await reserveUsage(tenantId, 'forecastRuns');
  try {
    const run = await prisma.forecastRun.create({
      data: {
        tenantId,
        horizonWeeks: input.horizonWeeks,
        method: input.method,
        filters: filters as Prisma.InputJsonValue,
        seriesTotal: series.length,
        createdBy: userId,
      },
    });
    await enqueueJob({ type: FORECAST_RUN_JOB, tenantId, payload: { runId: run.id } });
    return run;
  } catch (err) {
    await reservation.release();
    throw err;
  }
}

export type SeriesForecaster = typeof forecastSeries;

const CHUNK_PRODUCTS = 40;
const MAX_FAILURES_STORED = 100;

/**
 * Job body: forecast every matching series, saving results and accuracy. A failure in one series is
 * recorded against that series and does not fail the run; the run fails only if nothing succeeded.
 */
export async function processForecastRun(
  runId: string,
  opts: { now?: Date; forecaster?: SeriesForecaster } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const forecaster = opts.forecaster ?? forecastSeries;
  const run = await prisma.forecastRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`Forecast run ${runId} not found`);
  if (run.status === 'DONE') return;
  const tenantId = run.tenantId;
  const filters = run.filters as CreateRunInput['filters'];
  const method = run.method as 'AUTO' | ModelName;

  await prisma.forecastRun.update({
    where: { id: run.id },
    data: {
      status: 'RUNNING',
      startedAt: now,
      progress: 0,
      seriesDone: 0,
      seriesFailed: 0,
      failures: [] as never,
      error: null,
    },
  });
  // Re-runs (job retries) start from a clean slate.
  await prisma.forecastResult.deleteMany({ where: { runId: run.id } });
  await prisma.forecastAccuracy.deleteMany({ where: { runId: run.id } });

  try {
    const series = await resolveSeries(tenantId, filters);
    const latest = await prisma.salesRecord.aggregate({
      where: { tenantId },
      _max: { date: true },
    });
    if (!latest._max.date || series.length === 0)
      throw new Error('No sales history found for this run');
    const endWeek = latest._max.date.getTime();
    await prisma.forecastRun.update({
      where: { id: run.id },
      data: { seriesTotal: series.length, asOfWeek: new Date(endWeek) },
    });

    const byProduct = new Map<string, SeriesKey[]>();
    for (const s of series) byProduct.set(s.productId, [...(byProduct.get(s.productId) ?? []), s]);
    const productIds = [...byProduct.keys()];

    let done = 0;
    let failed = 0;
    const failures: { productId: string; locationId: string; error: string }[] = [];

    for (let i = 0; i < productIds.length; i += CHUNK_PRODUCTS) {
      const chunk = productIds.slice(i, i + CHUNK_PRODUCTS);
      const rows = await prisma.salesRecord.findMany({
        where: {
          tenantId,
          productId: { in: chunk },
          ...(filters.locationId && { locationId: filters.locationId }),
        },
        select: { productId: true, locationId: true, date: true, quantity: true },
      });
      const grouped = new Map<string, { weekStart: number; quantity: number }[]>();
      for (const r of rows) {
        const k = `${r.productId}|${r.locationId}`;
        const list = grouped.get(k) ?? [];
        list.push({ weekStart: r.date.getTime(), quantity: Number(r.quantity) });
        grouped.set(k, list);
      }

      const results: Prisma.ForecastResultCreateManyInput[] = [];
      const accuracies: Prisma.ForecastAccuracyCreateManyInput[] = [];
      for (const pid of chunk) {
        for (const key of byProduct.get(pid)!) {
          try {
            const points = grouped.get(`${key.productId}|${key.locationId}`) ?? [];
            const { values } = densify(points, endWeek);
            const f = forecaster(values, endWeek, run.horizonWeeks, method);
            f.weekStarts.forEach((w, idx) =>
              results.push({
                tenantId,
                runId: run.id,
                productId: key.productId,
                locationId: key.locationId,
                weekStart: new Date(w),
                quantity: f.values[idx]!,
                lower: f.lower[idx]!,
                upper: f.upper[idx]!,
                modelUsed: f.modelUsed,
              }),
            );
            accuracies.push({
              tenantId,
              runId: run.id,
              productId: key.productId,
              locationId: key.locationId,
              modelUsed: f.modelUsed,
              reason: f.reason,
              holdout: f.holdout,
              mape: f.accuracy?.mape ?? null,
              wape: f.accuracy?.wape ?? null,
              bias: f.accuracy?.bias ?? null,
            });
            done++;
          } catch (err) {
            failed++;
            if (failures.length < MAX_FAILURES_STORED)
              failures.push({
                productId: key.productId,
                locationId: key.locationId,
                error: (err as Error).message.slice(0, 300),
              });
          }
        }
      }
      for (let j = 0; j < results.length; j += 2000)
        await prisma.forecastResult.createMany({ data: results.slice(j, j + 2000) });
      if (accuracies.length) await prisma.forecastAccuracy.createMany({ data: accuracies });
      await prisma.forecastRun.update({
        where: { id: run.id },
        data: {
          seriesDone: done,
          seriesFailed: failed,
          failures: failures as never,
          progress: Math.min(99, Math.floor(((done + failed) / series.length) * 100)),
        },
      });
    }

    const allFailed = done === 0;
    await prisma.forecastRun.update({
      where: { id: run.id },
      data: {
        status: allFailed ? 'FAILED' : 'DONE',
        progress: 100,
        finishedAt: new Date(),
        error: allFailed
          ? `Every series failed. First error: ${failures[0]?.error ?? 'unknown'}`
          : null,
      },
    });
    await notifyUser(
      tenantId,
      run.createdBy,
      allFailed ? 'forecast.failed' : 'forecast.done',
      allFailed ? 'Forecast run failed' : 'Forecast run finished',
      allFailed
        ? 'Every series failed. Open the run to see the error.'
        : `${done} series forecast${failed ? `, ${failed} failed` : ''}. Open Forecasts to review.`,
    );
  } catch (err) {
    await prisma.forecastRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: (err as Error).message.slice(0, 2000),
      },
    });
    throw err;
  }
}
