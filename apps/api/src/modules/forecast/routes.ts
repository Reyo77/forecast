import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  createRunSchema,
  overrideInputSchema,
  type AccuracyRow,
  type ForecastPoint,
  type ForecastRunDto,
  type OverrideDto,
  type SeriesResponse,
} from '@supplycast/shared';
import type { ForecastRun } from '@prisma/client';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';
import { startOfWeekMonday } from '../../lib/time';
import { auditReq } from '../audit/service';
import { createRun } from './service';

const num = (d: unknown) => (d === null || d === undefined ? 0 : Number(d));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export const toRunDto = (r: ForecastRun): ForecastRunDto => ({
  id: r.id,
  status: r.status,
  horizonWeeks: r.horizonWeeks,
  method: r.method,
  filters: (r.filters ?? {}) as ForecastRunDto['filters'],
  progress: r.progress,
  seriesTotal: r.seriesTotal,
  seriesDone: r.seriesDone,
  seriesFailed: r.seriesFailed,
  failures: (r.failures as ForecastRunDto['failures']) ?? null,
  asOfWeek: r.asOfWeek ? isoDay(r.asOfWeek) : null,
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
});

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function forecastRouter(guards: Guards): Router {
  const router = Router();
  const read = guards.tenant('forecast:read');

  router.post('/forecasts/runs', ...guards.tenant('forecast:run'), async (req, res, next) => {
    try {
      const input = createRunSchema.parse(req.body);
      const run = await createRun(req.tenantId!, req.auth!.userId, input);
      await auditReq(req, 'forecast.run_started', 'ForecastRun', run.id, {
        horizonWeeks: input.horizonWeeks,
        method: input.method,
        series: run.seriesTotal,
      });
      res.status(202).json({ run: toRunDto(run) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/forecasts/runs', ...read, async (req, res, next) => {
    try {
      const p = paginationSchema.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.forecastRun.findMany({ orderBy: { createdAt: 'desc' }, ...skipTake(p) }),
        req.db!.forecastRun.count(),
      ]);
      res.json(paged(rows.map(toRunDto), total, p));
    } catch (err) {
      next(err);
    }
  });

  async function findRun(req: Request, id: string) {
    const run = await req.db!.forecastRun.findUnique({ where: { id } });
    if (!run) throw new HttpError(404, 'NOT_FOUND', 'Forecast run not found');
    return run;
  }

  router.get('/forecasts/runs/:id', ...read, async (req, res, next) => {
    try {
      res.json({ run: toRunDto(await findRun(req, req.params.id!)) });
    } catch (err) {
      next(err);
    }
  });

  const resultsQuery = paginationSchema.extend({
    productId: z.string().max(64).optional(),
    locationId: z.string().max(64).optional(),
  });

  router.get('/forecasts/runs/:id/results', ...read, async (req, res, next) => {
    try {
      const run = await findRun(req, req.params.id!);
      const q = resultsQuery.parse(req.query);
      const where = {
        runId: run.id,
        ...(q.productId && { productId: q.productId }),
        ...(q.locationId && { locationId: q.locationId }),
      };
      const [rows, total] = await Promise.all([
        req.db!.forecastResult.findMany({
          where,
          orderBy: [{ product: { sku: 'asc' } }, { locationId: 'asc' }, { weekStart: 'asc' }],
          include: { product: true, location: true },
          ...skipTake(q),
        }),
        req.db!.forecastResult.count({ where }),
      ]);
      res.json(
        paged(
          rows.map((r) => ({
            productId: r.productId,
            productSku: r.product.sku,
            locationId: r.locationId,
            locationCode: r.location.code,
            weekStart: isoDay(r.weekStart),
            quantity: num(r.quantity),
            lower: num(r.lower),
            upper: num(r.upper),
            modelUsed: r.modelUsed,
          })),
          total,
          q,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  const accuracyQuery = paginationSchema.extend({
    sort: z.enum(['wape', 'mape', 'bias', 'sku', 'model']).default('wape'),
    order: z.enum(['asc', 'desc']).default('desc'),
  });

  router.get('/forecasts/runs/:id/accuracy', ...read, async (req, res, next) => {
    try {
      const run = await findRun(req, req.params.id!);
      const q = accuracyQuery.parse(req.query);
      const orderBy =
        q.sort === 'sku'
          ? { product: { sku: q.order } }
          : q.sort === 'model'
            ? { modelUsed: q.order }
            : { [q.sort]: { sort: q.order, nulls: 'last' } };
      const [rows, total] = await Promise.all([
        req.db!.forecastAccuracy.findMany({
          where: { runId: run.id },
          orderBy: orderBy as never,
          include: { product: true, location: true },
          ...skipTake(q),
        }),
        req.db!.forecastAccuracy.count({ where: { runId: run.id } }),
      ]);
      const items: AccuracyRow[] = rows.map((a) => ({
        productId: a.productId,
        productSku: a.product.sku,
        productName: a.product.name,
        locationId: a.locationId,
        locationCode: a.location.code,
        modelUsed: a.modelUsed,
        reason: a.reason,
        mape: a.mape,
        wape: a.wape,
        bias: a.bias,
      }));
      res.json(paged(items, total, q));
    } catch (err) {
      next(err);
    }
  });

  // History + forecast + overrides for the chart. Without locationId, sums all locations of the product.
  router.get('/forecasts/runs/:id/series', ...read, async (req, res, next) => {
    try {
      const run = await findRun(req, req.params.id!);
      const q = z
        .object({
          productId: z.string().min(1).max(64),
          locationId: z.string().max(64).optional(),
          historyWeeks: z.coerce.number().int().min(4).max(260).default(104),
        })
        .parse(req.query);
      const product = await req.db!.product.findUnique({ where: { id: q.productId } });
      if (!product) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
      const location = q.locationId
        ? await req.db!.location.findUnique({ where: { id: q.locationId } })
        : null;
      if (q.locationId && !location) throw new HttpError(404, 'NOT_FOUND', 'Location not found');
      const locFilter = q.locationId ? { locationId: q.locationId } : {};

      const results = await req.db!.forecastResult.findMany({
        where: { runId: run.id, productId: product.id, ...locFilter },
        orderBy: { weekStart: 'asc' },
      });
      if (results.length === 0)
        throw new HttpError(404, 'NOT_FOUND', 'No forecast for this product in this run');
      const overrides = await req.db!.forecastOverride.findMany({
        where: { productId: product.id, ...locFilter },
      });
      const ovMap = new Map(
        overrides.map((o) => [`${o.locationId}|${o.weekStart.getTime()}`, num(o.quantity)]),
      );

      const weeks = new Map<
        number,
        { q: number; lo: number; hi: number; fin: number; ov: boolean }
      >();
      for (const r of results) {
        const t = r.weekStart.getTime();
        const cur = weeks.get(t) ?? { q: 0, lo: 0, hi: 0, fin: 0, ov: false };
        const o = ovMap.get(`${r.locationId}|${t}`);
        cur.q += num(r.quantity);
        cur.lo += num(r.lower);
        cur.hi += num(r.upper);
        cur.fin += o ?? num(r.quantity);
        cur.ov = cur.ov || o !== undefined;
        weeks.set(t, cur);
      }
      const forecast: ForecastPoint[] = [...weeks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({
          weekStart: isoDay(new Date(t)),
          quantity: v.q,
          lower: v.lo,
          upper: v.hi,
          override: v.ov ? v.fin : null,
          final: v.fin,
        }));

      const from = new Date(
        (run.asOfWeek ?? new Date()).getTime() - q.historyWeeks * 7 * 86400_000,
      );
      const sales = await req.db!.salesRecord.findMany({
        where: { productId: product.id, ...locFilter, date: { gt: from } },
        select: { date: true, quantity: true },
      });
      const hist = new Map<number, number>();
      for (const s of sales)
        hist.set(s.date.getTime(), (hist.get(s.date.getTime()) ?? 0) + num(s.quantity));
      const history = [...hist.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({ weekStart: isoDay(new Date(t)), quantity: v }));

      const acc = q.locationId
        ? await req.db!.forecastAccuracy.findFirst({
            where: { runId: run.id, productId: product.id, locationId: q.locationId },
          })
        : null;
      const models = [...new Set(results.map((r) => r.modelUsed))];
      const body: SeriesResponse = {
        product: { id: product.id, sku: product.sku, name: product.name },
        location: location ? { id: location.id, code: location.code } : null,
        modelUsed: models.length === 1 ? models[0]! : 'mixed',
        accuracy: acc
          ? { mape: acc.mape, wape: acc.wape, bias: acc.bias, reason: acc.reason }
          : null,
        history,
        forecast,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/forecasts/runs/:id/export.csv', ...read, async (req, res, next) => {
    try {
      const run = await findRun(req, req.params.id!);
      const [rows, overrides] = await Promise.all([
        req.db!.forecastResult.findMany({
          where: { runId: run.id },
          orderBy: [
            { product: { sku: 'asc' } },
            { location: { code: 'asc' } },
            { weekStart: 'asc' },
          ],
          include: { product: true, location: true },
        }),
        req.db!.forecastOverride.findMany(),
      ]);
      const ov = new Map(
        overrides.map((o) => [
          `${o.productId}|${o.locationId}|${o.weekStart.getTime()}`,
          num(o.quantity),
        ]),
      );
      const lines = ['sku,location_code,week_start,forecast,lower,upper,override,final,model_used'];
      for (const r of rows) {
        const o = ov.get(`${r.productId}|${r.locationId}|${r.weekStart.getTime()}`);
        const q = num(r.quantity);
        lines.push(
          [
            csvCell(r.product.sku),
            csvCell(r.location.code),
            isoDay(r.weekStart),
            q.toFixed(2),
            num(r.lower).toFixed(2),
            num(r.upper).toFixed(2),
            o === undefined ? '' : o,
            (o ?? q).toFixed(2),
            r.modelUsed,
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="forecast-${run.id}.csv"`);
      res.send(lines.join('\n') + '\n');
    } catch (err) {
      next(err);
    }
  });

  // ---------------- Overrides ----------------
  const toOverrideDto = (o: {
    id: string;
    productId: string;
    locationId: string;
    weekStart: Date;
    quantity: unknown;
    reason: string;
    updatedAt: Date;
    product: { sku: string };
    location: { code: string };
  }): OverrideDto => ({
    id: o.id,
    productId: o.productId,
    productSku: o.product.sku,
    locationId: o.locationId,
    locationCode: o.location.code,
    weekStart: isoDay(o.weekStart),
    quantity: num(o.quantity),
    reason: o.reason,
    updatedAt: o.updatedAt.toISOString(),
  });

  router.get('/forecasts/overrides', ...read, async (req, res, next) => {
    try {
      const q = paginationSchema
        .extend({
          productId: z.string().max(64).optional(),
          locationId: z.string().max(64).optional(),
        })
        .parse(req.query);
      const where = {
        ...(q.productId && { productId: q.productId }),
        ...(q.locationId && { locationId: q.locationId }),
      };
      const [rows, total] = await Promise.all([
        req.db!.forecastOverride.findMany({
          where,
          orderBy: { weekStart: 'asc' },
          include: { product: true, location: true },
          ...skipTake(q),
        }),
        req.db!.forecastOverride.count({ where }),
      ]);
      res.json(paged(rows.map(toOverrideDto), total, q));
    } catch (err) {
      next(err);
    }
  });

  router.put(
    '/forecasts/overrides',
    ...guards.tenant('forecast:override'),
    async (req, res, next) => {
      try {
        const input = overrideInputSchema.parse(req.body);
        const weekStart = new Date(
          Date.UTC(
            input.weekStart.getUTCFullYear(),
            input.weekStart.getUTCMonth(),
            input.weekStart.getUTCDate(),
          ),
        );
        if (startOfWeekMonday(weekStart).getTime() !== weekStart.getTime()) {
          throw new HttpError(400, 'NOT_A_WEEK_START', 'Week must start on a Monday');
        }
        const [product, location] = await Promise.all([
          req.db!.product.findUnique({ where: { id: input.productId } }),
          req.db!.location.findUnique({ where: { id: input.locationId } }),
        ]);
        if (!product) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
        if (!location) throw new HttpError(404, 'NOT_FOUND', 'Location not found');
        const o = await req.db!.forecastOverride.upsert({
          where: {
            tenantId_productId_locationId_weekStart: {
              tenantId: req.tenantId!,
              productId: product.id,
              locationId: location.id,
              weekStart,
            },
          },
          update: { quantity: input.quantity, reason: input.reason, userId: req.auth!.userId },
          create: {
            productId: product.id,
            locationId: location.id,
            weekStart,
            quantity: input.quantity,
            reason: input.reason,
            userId: req.auth!.userId,
          } as never,
          include: { product: true, location: true },
        });
        await auditReq(req, 'forecast.override_set', 'ForecastOverride', o.id, {
          sku: product.sku,
          location: location.code,
          weekStart: isoDay(weekStart),
          quantity: input.quantity,
        });
        res.json({ override: toOverrideDto(o) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/forecasts/overrides/:id',
    ...guards.tenant('forecast:override'),
    async (req, res, next) => {
      try {
        const o = await req.db!.forecastOverride.findUnique({ where: { id: req.params.id! } });
        if (!o) throw new HttpError(404, 'NOT_FOUND', 'Override not found');
        await req.db!.forecastOverride.delete({ where: { id: o.id } });
        await auditReq(req, 'forecast.override_removed', 'ForecastOverride', o.id);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
