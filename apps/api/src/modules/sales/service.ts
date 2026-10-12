import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/client';
import { addMonths } from '../../lib/time';
import { getEffectiveLimits } from '../billing/limits';
import { MAX_ERRORS_STORED, parseSalesCsv, type ParseResult, type WeeklyRow } from './csv';

export async function buildParseContext(tenantId: string, now = new Date()) {
  const [products, locations, limits] = await Promise.all([
    prisma.product.findMany({ where: { tenantId }, select: { id: true, sku: true } }),
    prisma.location.findMany({ where: { tenantId }, select: { id: true, code: true } }),
    getEffectiveLimits(tenantId),
  ]);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    skuToProduct: new Map(products.map((p) => [p.sku.toLowerCase(), p])),
    locToId: new Map(locations.map((l) => [l.code.toLowerCase(), l])),
    today,
    earliestAllowed: addMonths(today, -limits.historyMonths),
  };
}

export const previewRowsOf = (weekly: WeeklyRow[], n = 20) =>
  weekly.slice(0, n).map((w) => ({
    sku: w.sku,
    location: w.locationCode,
    weekStart: w.weekStart.toISOString().slice(0, 10),
    quantity: w.quantity,
    revenueCents: w.revenueCents,
  }));

/**
 * Writes weekly buckets, replacing any existing row for the same product/location/week
 * (re-importing a week never doubles it). Runs in one transaction.
 */
export async function writeWeekly(
  tenantId: string,
  importId: string | null,
  weekly: WeeklyRow[],
): Promise<number> {
  const groups = new Map<string, WeeklyRow[]>();
  for (const w of weekly) {
    const k = `${w.productId}|${w.locationId}`;
    const list = groups.get(k);
    if (list) list.push(w);
    else groups.set(k, [w]);
  }
  await prisma.$transaction(
    async (tx) => {
      for (const rows of groups.values()) {
        const first = rows[0]!;
        await tx.salesRecord.deleteMany({
          where: {
            tenantId,
            productId: first.productId,
            locationId: first.locationId,
            date: { in: rows.map((r) => r.weekStart) },
          },
        });
        for (let i = 0; i < rows.length; i += 1000) {
          await tx.salesRecord.createMany({
            data: rows.slice(i, i + 1000).map((r) => ({
              tenantId,
              productId: r.productId,
              locationId: r.locationId,
              date: r.weekStart,
              quantity: r.quantity,
              revenueCents: r.revenueCents,
              importId,
            })),
          });
        }
      }
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  return weekly.length;
}

export function summarize(result: ParseResult) {
  return {
    rowCount: result.rowCount,
    validRowCount: result.validRowCount,
    errorCount: result.errorCount,
    errors: result.errors.slice(0, MAX_ERRORS_STORED) as unknown as Prisma.InputJsonValue,
    previewRows: previewRowsOf(result.weekly) as unknown as Prisma.InputJsonValue,
  };
}

/** Job body: re-validate the stored CSV (catalog may have changed) and import the valid rows. */
export async function processSalesImport(importId: string, now = new Date()): Promise<void> {
  const imp = await prisma.salesImport.findUnique({ where: { id: importId } });
  if (!imp) throw new Error(`Import ${importId} not found`);
  if (imp.status === 'DONE') return;
  await prisma.salesImport.update({ where: { id: imp.id }, data: { status: 'PROCESSING' } });
  try {
    if (!imp.rawCsv) throw new Error('The uploaded file is no longer available');
    const result = parseSalesCsv(imp.rawCsv, await buildParseContext(imp.tenantId, now));
    if (result.fatal) throw new Error(result.fatal.message);
    const written = await writeWeekly(imp.tenantId, imp.id, result.weekly);
    await prisma.salesImport.update({
      where: { id: imp.id },
      data: {
        status: 'DONE',
        ...summarize(result),
        importedRows: written,
        errorMessage: null,
        finishedAt: now,
        rawCsv: null,
      },
    });
  } catch (err) {
    await prisma.salesImport.update({
      where: { id: imp.id },
      data: {
        status: 'FAILED',
        errorMessage: (err as Error).message.slice(0, 2000),
        finishedAt: now,
      },
    });
    throw err;
  }
}
