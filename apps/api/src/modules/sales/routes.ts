import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';
import { startOfWeekMonday } from '../../lib/time';
import { enqueueJob } from '../../jobs/runner';
import { auditReq } from '../audit/service';
import { registerDeleteGuard } from '../masterdata/common';
import { CSV_TEMPLATE, MAX_FILE_BYTES, parseSalesCsv } from './csv';
import { buildParseContext, summarize } from './service';
import { loadDemoData } from './demoLoader';

export const SALES_IMPORT_JOB = 'sales.import';

registerDeleteGuard('product', async (tenantId, id) =>
  (await prisma.salesRecord.count({ where: { tenantId, productId: id } })) > 0
    ? 'This product has sales history.'
    : null,
);
registerDeleteGuard('location', async (tenantId, id) =>
  (await prisma.salesRecord.count({ where: { tenantId, locationId: id } })) > 0
    ? 'This location has sales history.'
    : null,
);

const importDto = (i: {
  id: string;
  fileName: string;
  status: string;
  rowCount: number;
  validRowCount: number;
  errorCount: number;
  importedRows: number;
  errorMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}) => ({
  id: i.id,
  fileName: i.fileName,
  status: i.status,
  rowCount: i.rowCount,
  validRowCount: i.validRowCount,
  errorCount: i.errorCount,
  importedRows: i.importedRows,
  errorMessage: i.errorMessage,
  createdAt: i.createdAt,
  finishedAt: i.finishedAt,
});

const exploreQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  productId: z.string().max(64).optional(),
  categoryId: z.string().max(64).optional(),
  locationId: z.string().max(64).optional(),
  groupBy: z.enum(['none', 'product', 'category', 'location']).default('none'),
});

export function salesRouter(guards: Guards): Router {
  const router = Router();
  const csvBody = express.text({
    type: ['text/csv', 'text/plain', 'application/csv'],
    limit: MAX_FILE_BYTES,
  });

  router.get('/imports/sales/template', ...guards.tenant('import:sales'), (_req, res) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-template.csv"');
    res.send(CSV_TEMPLATE);
  });

  router.post(
    '/imports/sales/preview',
    ...guards.tenant('import:sales'),
    csvBody,
    async (req, res, next) => {
      try {
        const text = typeof req.body === 'string' ? req.body : '';
        if (Buffer.byteLength(text) > MAX_FILE_BYTES)
          throw new HttpError(
            413,
            'FILE_TOO_LARGE',
            'The uploaded file is too large (10 MB maximum)',
          );
        const fileName = z
          .string()
          .trim()
          .min(1)
          .max(200)
          .catch('upload.csv')
          .parse(req.query.fileName);
        const ctx = await buildParseContext(req.tenantId!);
        const result = parseSalesCsv(text, ctx);
        if (result.fatal) throw new HttpError(400, result.fatal.code, result.fatal.message);
        const imp = await req.db!.salesImport.create({
          data: {
            fileName,
            status: 'PREVIEW',
            rawCsv: text,
            createdBy: req.auth!.userId,
            ...summarize(result),
          } as never,
        });
        res.status(201).json({
          import: importDto(imp),
          errors: result.errors,
          sample: summarize(result).previewRows,
          totalWeeklyRows: result.weekly.length,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/imports/sales/:id/commit',
    ...guards.tenant('import:sales'),
    async (req, res, next) => {
      try {
        const { skipErrors } = z
          .object({ skipErrors: z.boolean().default(false) })
          .parse(req.body ?? {});
        const imp = await req.db!.salesImport.findUnique({ where: { id: req.params.id } });
        if (!imp) throw new HttpError(404, 'NOT_FOUND', 'Import not found');
        if (imp.status !== 'PREVIEW')
          throw new HttpError(409, 'ALREADY_COMMITTED', 'This import has already been committed');
        if (imp.validRowCount === 0)
          throw new HttpError(
            409,
            'NOTHING_TO_IMPORT',
            'There are no valid rows to import. Fix the errors and upload again.',
          );
        if (imp.errorCount > 0 && !skipErrors) {
          throw new HttpError(
            409,
            'HAS_ERRORS',
            `${imp.errorCount} row(s) have errors. Fix the file, or confirm to import only the valid rows.`,
          );
        }
        // Atomic claim so a double click cannot queue the job twice.
        const claimed = await req.db!.salesImport.updateMany({
          where: { id: imp.id, status: 'PREVIEW' },
          data: { status: 'QUEUED', committedAt: new Date() },
        });
        if (claimed.count !== 1)
          throw new HttpError(409, 'ALREADY_COMMITTED', 'This import has already been committed');
        await enqueueJob({
          type: SALES_IMPORT_JOB,
          tenantId: req.tenantId!,
          payload: { importId: imp.id },
        });
        await auditReq(req, 'import.sales_committed', 'SalesImport', imp.id, {
          fileName: imp.fileName,
          validRows: imp.validRowCount,
          errors: imp.errorCount,
        });
        res.status(202).json({ import: importDto({ ...imp, status: 'QUEUED' }) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/imports/sales', ...guards.tenant('sales:read'), async (req, res, next) => {
    try {
      const p = paginationSchema.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.salesImport.findMany({
          where: { status: { not: 'PREVIEW' } },
          orderBy: { createdAt: 'desc' },
          ...skipTake(p),
          select: {
            id: true,
            fileName: true,
            status: true,
            rowCount: true,
            validRowCount: true,
            errorCount: true,
            importedRows: true,
            errorMessage: true,
            createdAt: true,
            finishedAt: true,
          },
        }),
        req.db!.salesImport.count({ where: { status: { not: 'PREVIEW' } } }),
      ]);
      res.json(paged(rows.map(importDto), total, p));
    } catch (err) {
      next(err);
    }
  });

  router.get('/imports/sales/:id', ...guards.tenant('sales:read'), async (req, res, next) => {
    try {
      const imp = await req.db!.salesImport.findUnique({ where: { id: req.params.id } });
      if (!imp) throw new HttpError(404, 'NOT_FOUND', 'Import not found');
      res.json({ import: importDto(imp), errors: imp.errors ?? [], sample: imp.previewRows ?? [] });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Demo data ----------
  router.get('/demo-data/status', ...guards.tenant('sales:read'), async (req, res, next) => {
    try {
      const hasSales = (await req.db!.salesRecord.count()) > 0;
      res.json({ hasSalesData: hasSales, canLoad: !hasSales });
    } catch (err) {
      next(err);
    }
  });

  router.post('/demo-data', ...guards.tenant('demo:load'), async (req, res, next) => {
    try {
      if ((await req.db!.salesRecord.count()) > 0) {
        throw new HttpError(
          409,
          'DATA_EXISTS',
          'Demo data can only be loaded into an account with no sales history',
        );
      }
      const summary = await loadDemoData(req.tenantId!, new Date());
      await auditReq(req, 'demo_data.loaded', 'Tenant', req.tenantId, summary);
      res.status(201).json({ summary });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Explorer ----------
  router.get('/sales/explorer', ...guards.tenant('sales:read'), async (req, res, next) => {
    try {
      const q = exploreQuery.parse(req.query);
      const from = q.from ? startOfWeekMonday(q.from) : undefined;
      const productIds = q.categoryId
        ? (
            await req.db!.product.findMany({
              where: {
                OR: [{ categoryId: q.categoryId }, { category: { parentId: q.categoryId } }],
              },
              select: { id: true },
            })
          ).map((p) => p.id)
        : undefined;
      const where = {
        ...(q.productId && { productId: q.productId }),
        ...(productIds && {
          productId: q.productId
            ? { in: productIds.filter((x) => x === q.productId) }
            : { in: productIds },
        }),
        ...(q.locationId && { locationId: q.locationId }),
        ...((from || q.to) && { date: { ...(from && { gte: from }), ...(q.to && { lte: q.to }) } }),
      };
      const rows = await req.db!.salesRecord.findMany({
        where,
        select: {
          date: true,
          productId: true,
          locationId: true,
          quantity: true,
          revenueCents: true,
        },
      });

      let labelOf: (r: (typeof rows)[number]) => { key: string; label: string } = () => ({
        key: 'all',
        label: 'All sales',
      });
      if (q.groupBy !== 'none') {
        const [products, locations, categories] = await Promise.all([
          req.db!.product.findMany({
            select: {
              id: true,
              sku: true,
              name: true,
              category: {
                select: { id: true, name: true, parent: { select: { id: true, name: true } } },
              },
            },
          }),
          req.db!.location.findMany({ select: { id: true, code: true } }),
          Promise.resolve(null),
        ]);
        void categories;
        const pm = new Map(products.map((p) => [p.id, p]));
        const lm = new Map(locations.map((l) => [l.id, l.code]));
        if (q.groupBy === 'product')
          labelOf = (r) => ({ key: r.productId, label: pm.get(r.productId)?.sku ?? '?' });
        if (q.groupBy === 'location')
          labelOf = (r) => ({ key: r.locationId, label: lm.get(r.locationId) ?? '?' });
        if (q.groupBy === 'category') {
          labelOf = (r) => {
            const c = pm.get(r.productId)?.category;
            const top = c?.parent ?? c;
            return { key: top?.id ?? 'none', label: top?.name ?? 'Uncategorised' };
          };
        }
      }

      const series = new Map<
        string,
        {
          key: string;
          label: string;
          total: number;
          points: Map<number, { quantity: number; revenueCents: number }>;
        }
      >();
      let totalQty = 0;
      let totalRev = 0;
      for (const r of rows) {
        const { key, label } = labelOf(r);
        const s = series.get(key) ?? { key, label, total: 0, points: new Map() };
        const t = r.date.getTime();
        const pt = s.points.get(t) ?? { quantity: 0, revenueCents: 0 };
        const qty = Number(r.quantity);
        const rev = Number(r.revenueCents);
        pt.quantity += qty;
        pt.revenueCents += rev;
        s.points.set(t, pt);
        s.total += qty;
        series.set(key, s);
        totalQty += qty;
        totalRev += rev;
      }
      const ranked = [...series.values()].sort((a, b) => b.total - a.total);
      res.json({
        series: ranked.slice(0, 10).map((s) => ({
          key: s.key,
          label: s.label,
          total: s.total,
          points: [...s.points.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([t, v]) => ({ weekStart: new Date(t).toISOString().slice(0, 10), ...v })),
        })),
        omittedSeries: Math.max(0, ranked.length - 10),
        totals: {
          quantity: totalQty,
          revenueCents: totalRev,
          weeks: new Set(rows.map((r) => r.date.getTime())).size,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
