import { Router } from 'express';
import { runPlan } from '../../engines/planning/plan';
import type { Guards } from '../../middleware/guards';
import { getUsageLines } from '../billing/limits';
import { buildPlanInput, DEFAULT_SERVICE_LEVEL } from '../scenarios/compute';
import { loadPlanningData } from '../scenarios/service';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function dashboardRouter(guards: Guards): Router {
  const router = Router();

  router.get('/dashboard', ...guards.tenant('dashboard:read'), async (req, res, next) => {
    try {
      const db = req.db!;
      const [runs, latestDone, products, locations, suppliers, salesAgg, lateOrders, usage] =
        await Promise.all([
          db.forecastRun.findMany({ orderBy: { createdAt: 'desc' }, take: 5 }),
          db.forecastRun.findFirst({ where: { status: 'DONE' }, orderBy: { createdAt: 'desc' } }),
          db.product.count({ where: { isActive: true } }),
          db.location.count(),
          db.supplier.count(),
          db.salesRecord.aggregate({
            _max: { date: true },
            _min: { date: true },
            _count: { _all: true },
          }),
          db.openOrder.count({
            where: {
              expectedDate: {
                lt: new Date(
                  Date.UTC(
                    new Date().getUTCFullYear(),
                    new Date().getUTCMonth(),
                    new Date().getUTCDate(),
                  ),
                ),
              },
            },
          }),
          getUsageLines(req.tenantId!),
        ]);

      // Forecast accuracy of the latest finished run (average WAPE over series that could be backtested).
      let accuracy: {
        runId: string;
        date: string;
        wape: number | null;
        seriesCount: number;
        backtested: number;
        models: { model: string; count: number }[];
      } | null = null;
      if (latestDone) {
        const rows = await db.forecastAccuracy.findMany({
          where: { runId: latestDone.id },
          select: { wape: true, modelUsed: true },
        });
        const w = rows.filter((r) => r.wape !== null).map((r) => r.wape as number);
        const byModel = new Map<string, number>();
        rows.forEach((r) => byModel.set(r.modelUsed, (byModel.get(r.modelUsed) ?? 0) + 1));
        accuracy = {
          runId: latestDone.id,
          date: isoDay(latestDone.createdAt),
          wape: w.length ? w.reduce((a, b) => a + b, 0) / w.length : null,
          seriesCount: rows.length,
          backtested: w.length,
          models: [...byModel.entries()]
            .map(([model, count]) => ({ model, count }))
            .sort((a, b) => b.count - a.count),
        };
      }

      // Upcoming stockouts: the baseline plan (no levers) built from the latest finished forecast.
      let stockouts:
        | {
            sku: string;
            location: string;
            firstStockoutDate: string;
            shortage: number;
            revenueAtRiskCents: number;
          }[]
        | null = null;
      if (latestDone?.asOfWeek) {
        try {
          const data = await loadPlanningData(req.tenantId!, latestDone.id);
          const plan = runPlan(
            buildPlanInput(
              { ...data, serviceLevel: DEFAULT_SERVICE_LEVEL },
              data.independentDemand,
            ),
          );
          const skus = new Map(
            (await db.product.findMany({ select: { id: true, sku: true } })).map((p) => [
              p.id,
              p.sku,
            ]),
          );
          const locs = new Map(
            (await db.location.findMany({ select: { id: true, code: true } })).map((l) => [
              l.id,
              l.code,
            ]),
          );
          stockouts = plan.atRisk.slice(0, 5).map((a) => ({
            sku: skus.get(a.productId) ?? '?',
            location: locs.get(a.locationId) ?? '?',
            firstStockoutDate: isoDay(data.weekStarts[a.firstStockoutWeek]!),
            shortage: Math.round(a.shortage * 10) / 10,
            revenueAtRiskCents: a.revenueAtRiskCents,
          }));
        } catch {
          stockouts = null;
        }
      }

      res.json({
        counts: { products, locations, suppliers, lateOrders },
        sales: {
          records: salesAgg._count._all,
          from: salesAgg._min.date ? isoDay(salesAgg._min.date) : null,
          to: salesAgg._max.date ? isoDay(salesAgg._max.date) : null,
        },
        accuracy,
        upcomingStockouts: stockouts,
        latestRuns: runs.map((r) => ({
          id: r.id,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          horizonWeeks: r.horizonWeeks,
          seriesDone: r.seriesDone,
          seriesTotal: r.seriesTotal,
        })),
        usage,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
