import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { MAX_ERRORS_STORED, parseIsoDate, parseSalesCsv, type ParseContext } from './csv';

const fixture = (name: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../../tests/fixtures', name), 'utf8');

const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  skuToProduct: new Map([
    ['sku-a', { id: 'pa', sku: 'SKU-A' }],
    ['sku-b', { id: 'pb', sku: 'SKU-B' }],
  ]),
  locToId: new Map([['wh-1', { id: 'l1', code: 'WH-1' }]]),
  today: new Date('2025-06-30T00:00:00Z'),
  earliestAllowed: new Date('2022-06-30T00:00:00Z'),
  ...over,
});
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('parseIsoDate', () => {
  it.each(['2025-01-06', '2024-02-29', '2000-12-31'])('accepts %s', (v) =>
    expect(parseIsoDate(v)).not.toBeNull(),
  );
  it.each([
    '2025-02-30',
    '2023-02-29',
    '2025-13-01',
    '01/06/2025',
    '2025-1-6',
    '2025-01-06T00:00',
    '',
    'tomorrow',
  ])('rejects %s', (v) => expect(parseIsoDate(v)).toBeNull());
});

describe('weekly aggregation (weeks start Monday, UTC)', () => {
  it('sums daily rows into Monday-based weeks; Sunday belongs to the previous week', () => {
    const r = parseSalesCsv(fixture('valid.csv'), ctx());
    expect(r.errorCount).toBe(0);
    expect(r.rowCount).toBe(5);
    expect(r.validRowCount).toBe(5);
    expect(r.weekly.map((w) => [w.sku, iso(w.weekStart), w.quantity, w.revenueCents])).toEqual([
      ['SKU-A', '2025-01-06', 17, 17050], // Mon 6th, Wed 8th, Sun 12th
      ['SKU-A', '2025-01-13', 7, 7025],
      ['SKU-B', '2025-01-06', 3, 0],
    ]);
  });

  it('sums exact duplicate rows (several transactions per day are normal)', () => {
    const r = parseSalesCsv(fixture('duplicates.csv'), ctx());
    expect(r.errorCount).toBe(0);
    expect(r.weekly).toHaveLength(1);
    expect(r.weekly[0]).toMatchObject({ quantity: 25, revenueCents: 25000 });
  });

  it('matches SKU and location case-insensitively, trims spaces, handles CRLF, BOM and quoted fields', () => {
    const csv =
      '﻿SKU , Location_Code,DATE,Quantity\r\n" sku-a ",wh-1,2025-01-06,"1,5"\r\nsku-a,WH-1,2025-01-07,2\r\n';
    const r = parseSalesCsv(csv, ctx());
    // "1,5" is not a valid number (decimal comma): flagged, not silently misread
    expect(r.errors).toEqual([
      { row: 2, field: 'quantity', message: 'Quantity "1,5" is not a number' },
    ]);
    expect(r.weekly).toHaveLength(1);
    expect(r.weekly[0]).toMatchObject({ sku: 'SKU-A', locationCode: 'WH-1', quantity: 2 });
  });

  it('ignores unknown extra columns and treats revenue as optional', () => {
    const r = parseSalesCsv(
      'sku,location_code,date,quantity,notes\nSKU-A,WH-1,2025-01-06,4,hello\n',
      ctx(),
    );
    expect(r.errorCount).toBe(0);
    expect(r.weekly[0]).toMatchObject({ quantity: 4, revenueCents: 0 });
  });

  it('rounds revenue to whole cents', () => {
    const r = parseSalesCsv(
      'sku,location_code,date,quantity,revenue\nSKU-A,WH-1,2025-01-06,1,10.005\nSKU-A,WH-1,2025-01-07,1,0.1\n',
      ctx(),
    );
    expect(r.weekly[0]!.revenueCents).toBe(Math.round(10.005 * 100) + 10);
  });

  it('conserves total quantity (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 500 })), {
          minLength: 1,
          maxLength: 60,
        }),
        (rows) => {
          const base = Date.UTC(2024, 0, 1);
          const csv = [
            'sku,location_code,date,quantity',
            ...rows.map(([d, q]) => `SKU-A,WH-1,${iso(new Date(base + d * 86400_000))},${q}`),
          ].join('\n');
          const r = parseSalesCsv(csv, ctx());
          expect(r.errorCount).toBe(0);
          expect(r.weekly.reduce((s, w) => s + w.quantity, 0)).toBe(
            rows.reduce((s, [, q]) => s + q, 0),
          );
          expect(r.weekly.every((w) => w.weekStart.getUTCDay() === 1)).toBe(true);
        },
      ),
    );
  });
});

describe('validation', () => {
  it('reports every bad row with its line number and field, and still aggregates the valid ones', () => {
    const r = parseSalesCsv(fixture('mixed-errors.csv'), ctx());
    expect(r.rowCount).toBe(11);
    expect(r.validRowCount).toBe(2);
    expect(r.errorCount).toBe(9);
    const byRow = Object.fromEntries(r.errors.map((e) => [e.row, e]));
    expect(byRow[3]).toMatchObject({ field: 'sku', message: 'Unknown SKU "NOPE"' });
    expect(byRow[4]).toMatchObject({
      field: 'location_code',
      message: 'Unknown location "NOWHERE"',
    });
    expect(byRow[5]).toMatchObject({ field: 'date' });
    expect(byRow[5]!.message).toMatch(/Invalid date/);
    expect(byRow[6]!.message).toMatch(/Invalid date "01\/13\/2025"/);
    expect(byRow[7]).toMatchObject({ field: 'quantity', message: 'Quantity cannot be negative' });
    expect(byRow[8]!.message).toMatch(/not a number/);
    expect(byRow[9]).toMatchObject({ field: 'revenue', message: 'Revenue cannot be negative' });
    expect(byRow[10]).toMatchObject({ field: 'date', message: 'Date is in the future' });
    expect(byRow[11]).toMatchObject({ field: 'sku', message: 'SKU is required' });
    expect(r.weekly.map((w) => w.sku)).toEqual(['SKU-A', 'SKU-B']);
  });

  it('rejects dates older than the plan retention', () => {
    const r = parseSalesCsv(
      'sku,location_code,date,quantity\nSKU-A,WH-1,2020-01-06,1\nSKU-A,WH-1,2025-01-06,1\n',
      ctx(),
    );
    expect(r.errors).toEqual([
      { row: 2, field: 'date', message: 'Date is older than your plan’s sales-history retention' },
    ]);
    expect(r.validRowCount).toBe(1);
  });

  it('wrong headers are a fatal error naming the missing columns', () => {
    const r = parseSalesCsv(fixture('wrong-headers.csv'), ctx());
    expect(r.fatal?.code).toBe('INVALID_HEADERS');
    expect(r.fatal?.message).toMatch(/location_code, date, quantity/);
    expect(r.weekly).toEqual([]);
  });

  it('empty file and header-only file are fatal', () => {
    expect(parseSalesCsv(fixture('empty.csv'), ctx()).fatal?.code).toBe('EMPTY_FILE');
    expect(parseSalesCsv('   \n  ', ctx()).fatal?.code).toBe('EMPTY_FILE');
    expect(parseSalesCsv(fixture('header-only.csv'), ctx()).fatal?.code).toBe('EMPTY_FILE');
  });

  it('malformed CSV (unterminated quote) is a fatal INVALID_CSV, not a crash', () => {
    const r = parseSalesCsv('sku,location_code,date,quantity\n"SKU-A,WH-1,2025-01-06,1\n', ctx());
    expect(r.fatal?.code).toBe('INVALID_CSV');
  });

  it('caps stored errors but still counts all of them', () => {
    const rows = Array.from(
      { length: MAX_ERRORS_STORED + 50 },
      () => 'NOPE,WH-1,2025-01-06,1',
    ).join('\n');
    const r = parseSalesCsv(`sku,location_code,date,quantity\n${rows}\n`, ctx());
    expect(r.errorCount).toBe(MAX_ERRORS_STORED + 50);
    expect(r.errors).toHaveLength(MAX_ERRORS_STORED);
  });

  it('handles a large file (50k rows) quickly', () => {
    const lines = ['sku,location_code,date,quantity,revenue'];
    for (let i = 0; i < 50_000; i++)
      lines.push(
        `SKU-${i % 2 ? 'A' : 'B'},WH-1,2025-0${1 + (i % 5)}-1${i % 9},${i % 17},${(i % 17) * 2.5}`,
      );
    const t = Date.now();
    const r = parseSalesCsv(lines.join('\n'), ctx());
    expect(r.rowCount).toBe(50_000);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
