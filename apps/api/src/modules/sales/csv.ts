import { parse } from 'csv-parse/sync';
import { startOfWeekMonday } from '../../lib/time';

export const REQUIRED_HEADERS = ['sku', 'location_code', 'date', 'quantity'] as const;
export const CSV_TEMPLATE =
  'sku,location_code,date,quantity,revenue\nSKU-1,WH-1,2025-01-06,120,1500.00\nSKU-1,WH-1,2025-01-13,98,1225.50\n';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ERRORS_STORED = 200;

export interface RowError {
  row: number; // 1-based file line number (header is row 1)
  field: string;
  message: string;
}

export interface WeeklyRow {
  sku: string; // as stored in the tenant's catalog
  productId: string;
  locationCode: string;
  locationId: string;
  weekStart: Date;
  quantity: number;
  revenueCents: number;
}

export interface ParseContext {
  skuToProduct: Map<string, { id: string; sku: string }>; // keys lower-cased
  locToId: Map<string, { id: string; code: string }>; // keys lower-cased
  today: Date;
  earliestAllowed: Date;
}

export interface ParseResult {
  fatal?: { code: 'EMPTY_FILE' | 'INVALID_HEADERS' | 'INVALID_CSV'; message: string };
  rowCount: number;
  validRowCount: number;
  errors: RowError[];
  errorCount: number;
  weekly: WeeklyRow[];
}

/** Strict YYYY-MM-DD with a real calendar check (rejects 2025-02-30). */
export function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    ? date
    : null;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Validates every row and aggregates valid ones into weekly buckets (weeks start Monday).
 * Several rows for the same SKU/location/week (including exact duplicates) are summed.
 */
export function parseSalesCsv(text: string, ctx: ParseContext): ParseResult {
  const empty = (fatal?: ParseResult['fatal']): ParseResult => ({
    fatal,
    rowCount: 0,
    validRowCount: 0,
    errors: [],
    errorCount: 0,
    weekly: [],
  });
  if (!text.trim()) return empty({ code: 'EMPTY_FILE', message: 'The file is empty' });

  let records: Record<string, string>[];
  let headers: string[] = [];
  try {
    records = parse(text, {
      columns: (header: string[]) => {
        headers = header.map((h) => h.trim().toLowerCase());
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    });
  } catch (err) {
    return empty({
      code: 'INVALID_CSV',
      message: `Could not read the CSV: ${(err as Error).message}`,
    });
  }
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) {
    return empty({
      code: 'INVALID_HEADERS',
      message: `Missing required column(s): ${missing.join(', ')}. Expected: sku, location_code, date, quantity, revenue (optional).`,
    });
  }
  if (records.length === 0)
    return empty({ code: 'EMPTY_FILE', message: 'The file has a header but no data rows' });

  const errors: RowError[] = [];
  let errorCount = 0;
  let valid = 0;
  const buckets = new Map<string, WeeklyRow>();
  const fail = (row: number, field: string, message: string) => {
    errorCount++;
    if (errors.length < MAX_ERRORS_STORED) errors.push({ row, field, message });
  };

  records.forEach((raw, i) => {
    // Quoted fields keep their inner spaces, so trim every value ourselves.
    const r = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, String(v ?? '').trim()]),
    ) as Record<string, string>;
    const row = i + 2;
    let ok = true;
    const bad = (field: string, message: string) => {
      ok = false;
      fail(row, field, message);
    };
    const product = r.sku ? ctx.skuToProduct.get(r.sku.toLowerCase()) : undefined;
    if (!r.sku) bad('sku', 'SKU is required');
    else if (!product) bad('sku', `Unknown SKU "${r.sku}"`);
    const loc = r.location_code ? ctx.locToId.get(r.location_code.toLowerCase()) : undefined;
    if (!r.location_code) bad('location_code', 'Location code is required');
    else if (!loc) bad('location_code', `Unknown location "${r.location_code}"`);

    const date = r.date ? parseIsoDate(r.date) : null;
    if (!r.date) bad('date', 'Date is required');
    else if (!date) bad('date', `Invalid date "${r.date}" (use YYYY-MM-DD)`);
    else if (date > ctx.today) bad('date', 'Date is in the future');
    else if (date < ctx.earliestAllowed)
      bad('date', 'Date is older than your plan’s sales-history retention');

    let quantity = 0;
    if (r.quantity === undefined || r.quantity === '') bad('quantity', 'Quantity is required');
    else if (!NUMBER.test(r.quantity)) bad('quantity', `Quantity "${r.quantity}" is not a number`);
    else {
      quantity = Number(r.quantity);
      if (quantity < 0) bad('quantity', 'Quantity cannot be negative');
      else if (quantity > 1_000_000_000) bad('quantity', 'Quantity is too large');
    }

    let revenueCents = 0;
    if (r.revenue !== undefined && r.revenue !== '') {
      if (!NUMBER.test(r.revenue)) bad('revenue', `Revenue "${r.revenue}" is not a number`);
      else if (Number(r.revenue) < 0) bad('revenue', 'Revenue cannot be negative');
      else revenueCents = Math.round(Number(r.revenue) * 100);
    }

    if (!ok || !product || !loc || !date) return;
    valid++;
    const weekStart = startOfWeekMonday(date);
    const key = `${product.id}|${loc.id}|${weekStart.getTime()}`;
    const cur = buckets.get(key);
    if (cur) {
      cur.quantity += quantity;
      cur.revenueCents += revenueCents;
    } else {
      buckets.set(key, {
        sku: product.sku,
        productId: product.id,
        locationCode: loc.code,
        locationId: loc.id,
        weekStart,
        quantity,
        revenueCents,
      });
    }
  });

  const weekly = [...buckets.values()].sort(
    (a, b) =>
      a.sku.localeCompare(b.sku) ||
      a.locationCode.localeCompare(b.locationCode) ||
      a.weekStart.getTime() - b.weekStart.getTime(),
  );
  return { rowCount: records.length, validRowCount: valid, errors, errorCount, weekly };
}
