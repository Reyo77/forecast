import { Router } from 'express';
import { runPlan } from '../../engines/planning/plan';
import type { Guards } from '../../middleware/guards';
import { buildPlanInput, DEFAULT_SERVICE_LEVEL } from '../scenarios/compute';
import { loadPlanningData } from '../scenarios/service';

const WEEK = 7 * 86400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const csvCell = (v: string | number) => {
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise spreadsheet formulas
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export interface ReorderItem {
  sku: string;
  productName: string;
  locationCode: string;
  supplierName: string | null;
  orderDate: string;
  arrivalDate: string;
  quantity: number;
  estCostCents: number;
  /** True when the order should go out in the first planning week. */
  urgent: boolean;
}

export interface ReorderPlan {
  run: { id: string; asOf: string; horizonWeeks: number } | null;
  items: ReorderItem[];
  totals: { orders: number; units: number; costCents: number; urgent: number };
}

export interface AbcRow {
  productId: string;
  sku: string;
  name: string;
  revenueCents: number;
  units: number;
  sharePct: number;
  cumulativePct: number;
  class: 'A' | 'B' | 'C';
}

export const abcClass = (cumulativeBefore: number): 'A' | 'B' | 'C' =>
  cumulativeBefore < 80 ? 'A' : cumulativeBefore < 95 ? 'B' : 'C';

export function insightsRouter(guards: Guards): Router {
  const router = Router();
  const readForecast = guards.tenant('forecast:read');
  const readSales = guards.tenant('sales:read');

  /** The baseline plan's purchase orders, built from the newest finished forecast. */
  async function buildReorderPlan(
    req: Parameters<(typeof readForecast)[number]>[0],
  ): Promise<ReorderPlan> {
    const db = req.db!;
    const run = await db.forecastRun.findFirst({
      where: { status: 'DONE' },
      orderBy: { createdAt: 'desc' },
    });
    const empty: ReorderPlan = {
      run: null,
      items: [],
      totals: { orders: 0, units: 0, costCents: 0, urgent: 0 },
    };
    if (!run?.asOfWeek) return empty;
    const data = await loadPlanningData(req.tenantId!, run.id);
    const plan = runPlan(
      buildPlanInput({ ...data, serviceLevel: DEFAULT_SERVICE_LEVEL }, data.independentDemand),
    );
    const [products, locations, suppliers] = await Promise.all([
      db.product.findMany({ select: { id: true, sku: true, name: true, unitCostCents: true } }),
      db.location.findMany({ select: { id: true, code: true } }),
      db.supplier.findMany({ select: { id: true, name: true } }),
    ]);
    const P = new Map(products.map((p) => [p.id, p]));
    const L = new Map(locations.map((l) => [l.id, l.code]));
    const S = new Map(suppliers.map((s) => [s.id, s.name]));
    const asOf = run.asOfWeek.getTime();
    const day = (w: number) => isoDay(new Date(asOf + (w + 1) * WEEK));
    const items: ReorderItem[] = [];
    for (const n of plan.nodes) {
      for (const o of n.plannedOrders) {
        const p = P.get(o.productId);
        if (!p) continue;
        const qty = Math.round(o.quantity * 10) / 10;
        items.push({
          sku: p.sku,
          productName: p.name,
          locationCode: L.get(o.locationId) ?? '?',
          supplierName: o.supplierId ? (S.get(o.supplierId) ?? null) : null,
          orderDate: day(o.orderWeek),
          arrivalDate: day(o.arrivalWeek),
          quantity: qty,
          estCostCents: Math.round(qty * p.unitCostCents),
          urgent: o.orderWeek <= 0,
        });
      }
    }
    items.sort((a, b) => a.orderDate.localeCompare(b.orderDate) || b.estCostCents - a.estCostCents);
    return {
      run: { id: run.id, asOf: isoDay(run.asOfWeek), horizonWeeks: run.horizonWeeks },
      items,
      totals: {
        orders: items.length,
        units: Math.round(items.reduce((s, i) => s + i.quantity, 0)),
        costCents: items.reduce((s, i) => s + i.estCostCents, 0),
        urgent: items.filter((i) => i.urgent).length,
      },
    };
  }

  router.get('/insights/reorder-plan', ...readForecast, async (req, res, next) => {
    try {
      res.json(await buildReorderPlan(req));
    } catch (err) {
      next(err);
    }
  });

  router.get('/insights/reorder-plan/export.csv', ...readForecast, async (req, res, next) => {
    try {
      const plan = await buildReorderPlan(req);
      const lines = ['sku,product,location,supplier,order_date,arrival_date,quantity,est_cost'];
      for (const i of plan.items) {
        lines.push(
          [
            csvCell(i.sku),
            csvCell(i.productName),
            csvCell(i.locationCode),
            csvCell(i.supplierName ?? ''),
            i.orderDate,
            i.arrivalDate,
            i.quantity,
            (i.estCostCents / 100).toFixed(2),
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="reorder-plan.csv"');
      res.send(lines.join('\n') + '\n');
    } catch (err) {
      next(err);
    }
  });

  /** ABC analysis: which products make 80% / 15% / 5% of revenue over the last 52 weeks. */
  router.get('/insights/abc', ...readSales, async (req, res, next) => {
    try {
      const db = req.db!;
      const latest = await db.salesRecord.aggregate({ _max: { date: true } });
      if (!latest._max.date) {
        res.json({ from: null, to: null, rows: [], summary: [] });
        return;
      }
      const to = latest._max.date;
      const from = new Date(to.getTime() - 51 * WEEK);
      const grouped = await db.salesRecord.groupBy({
        by: ['productId'],
        where: { date: { gte: from, lte: to } },
        _sum: { revenueCents: true, quantity: true },
      });
      const products = await db.product.findMany({ select: { id: true, sku: true, name: true } });
      const P = new Map(products.map((p) => [p.id, p]));
      const sorted = grouped
        .map((g) => ({
          productId: g.productId,
          revenueCents: Number(g._sum.revenueCents ?? 0),
          units: Number(g._sum.quantity ?? 0),
        }))
        .sort((a, b) => b.revenueCents - a.revenueCents);
      const total = sorted.reduce((s, r) => s + r.revenueCents, 0);
      let cum = 0;
      const rows: AbcRow[] = sorted.map((r) => {
        const before = total ? (cum / total) * 100 : 100;
        cum += r.revenueCents;
        const p = P.get(r.productId);
        return {
          productId: r.productId,
          sku: p?.sku ?? '?',
          name: p?.name ?? '?',
          revenueCents: r.revenueCents,
          units: Math.round(r.units),
          sharePct: total ? Math.round((r.revenueCents / total) * 1000) / 10 : 0,
          cumulativePct: total ? Math.round((cum / total) * 1000) / 10 : 0,
          class: abcClass(before),
        };
      });
      const summary = (['A', 'B', 'C'] as const).map((c) => {
        const rs = rows.filter((r) => r.class === c);
        return {
          class: c,
          products: rs.length,
          revenueCents: rs.reduce((s, r) => s + r.revenueCents, 0),
          sharePct: total
            ? Math.round((rs.reduce((s, r) => s + r.revenueCents, 0) / total) * 1000) / 10
            : 0,
        };
      });
      res.json({ from: isoDay(from), to: isoDay(to), rows, summary });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
