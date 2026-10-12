import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import { createLocation, createProduct, createTenant, createUser } from '../../../tests/factories';
import {
  expectRoleAccess,
  expectTenantIsolation,
  rolesWith,
} from '../../../tests/helpers/isolation';
import { drainJobs } from '../../jobs/runner';
import { registerCoreJobHandlers } from '../../jobs/handlers';
import { startOfWeekMonday } from '../../lib/time';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
const fixture = (n: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../../tests/fixtures', n), 'utf8');

beforeAll(() => registerCoreJobHandlers());
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function setup(plan = 'pro') {
  const tenant = await createTenant({ plan });
  const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
  const a = await createProduct(tenant.id, { sku: 'SKU-A' });
  const b = await createProduct(tenant.id, { sku: 'SKU-B' });
  const loc = await createLocation(tenant.id, { code: 'WH-1' });
  return { tid: tenant.id, owner, h: tok(owner), a, b, loc };
}

// Recent dates so retention never interferes.
const recentMonday = () => {
  const d = startOfWeekMonday(new Date(Date.now() - 21 * 86400_000));
  return (offsetDays: number) =>
    new Date(d.getTime() + offsetDays * 86400_000).toISOString().slice(0, 10);
};
const csvOf = (rows: string[]) => `sku,location_code,date,quantity,revenue\n${rows.join('\n')}\n`;
const preview = (h: Record<string, string>, csv: string, name = 'sales.csv') =>
  request(app)
    .post(`/imports/sales/preview?fileName=${name}`)
    .set(h)
    .set('Content-Type', 'text/csv')
    .send(csv);

describe('POST /imports/sales/preview', () => {
  it('validates, aggregates a sample and stores a PREVIEW import without writing any sales', async () => {
    const { h, tid } = await setup();
    const d = recentMonday();
    const res = await preview(
      h,
      csvOf([`SKU-A,WH-1,${d(0)},10,100`, `SKU-A,WH-1,${d(2)},5,50`, `NOPE,WH-1,${d(0)},1,1`]),
    );
    expect(res.status).toBe(201);
    expect(res.body.import).toMatchObject({
      fileName: 'sales.csv',
      status: 'PREVIEW',
      rowCount: 3,
      validRowCount: 2,
      errorCount: 1,
    });
    expect(res.body.errors).toEqual([{ row: 4, field: 'sku', message: 'Unknown SKU "NOPE"' }]);
    expect(res.body.sample).toEqual([
      { sku: 'SKU-A', location: 'WH-1', weekStart: d(0), quantity: 15, revenueCents: 15000 },
    ]);
    expect(res.body.totalWeeklyRows).toBe(1);
    expect(await prisma.salesRecord.count({ where: { tenantId: tid } })).toBe(0);
  });

  it.each([
    ['wrong headers', fixture('wrong-headers.csv'), 'INVALID_HEADERS'],
    ['empty file', fixture('empty.csv'), 'EMPTY_FILE'],
    ['header only', fixture('header-only.csv'), 'EMPTY_FILE'],
  ])('400 for %s and creates no import', async (_l, csv, code) => {
    const { h } = await setup();
    const res = await preview(h, csv);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(await prisma.salesImport.count()).toBe(0);
  });

  it('413 for a file over 10 MB', async () => {
    const { h } = await setup();
    const big = 'sku,location_code,date,quantity\n' + 'SKU-A,WH-1,2025-01-06,1\n'.repeat(500_000);
    expect(Buffer.byteLength(big)).toBeGreaterThan(10 * 1024 * 1024);
    const res = await preview(h, big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('only knows the caller’s own SKUs and locations', async () => {
    const { h } = await setup();
    const other = await createTenant();
    await createProduct(other.id, { sku: 'THEIRS' });
    const d = recentMonday();
    const res = await preview(h, csvOf([`THEIRS,WH-1,${d(0)},1,1`]));
    expect(res.body.errors[0].message).toBe('Unknown SKU "THEIRS"');
  });

  it('enforces the plan’s history retention (Free = 12 months)', async () => {
    const { h } = await setup('free');
    const d = recentMonday();
    const res = await preview(h, csvOf([`SKU-A,WH-1,2020-01-06,1,1`, `SKU-A,WH-1,${d(0)},1,1`]));
    expect(res.body.errors).toEqual([
      { row: 2, field: 'date', message: 'Date is older than your plan’s sales-history retention' },
    ]);
    expect(res.body.import.validRowCount).toBe(1);
  });

  it('roles: Owner/Admin/Planner may import, Viewer may not; 401 anonymous', async () => {
    await setup();
    const t = await createTenant();
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/imports/sales/preview',
      body: undefined,
      allowed: rolesWith('import:sales'),
    });
    void t;
  });
});

describe('POST /imports/sales/:id/commit (background job)', () => {
  it('queues a job; the worker aggregates weekly and writes the sales, then clears the stored file', async () => {
    const { h, tid, a, loc } = await setup();
    const d = recentMonday();
    const p = await preview(
      h,
      csvOf([`SKU-A,WH-1,${d(0)},10,100`, `SKU-A,WH-1,${d(3)},5,50`, `SKU-A,WH-1,${d(7)},8,80`]),
    );
    const id = p.body.import.id;
    const c = await request(app).post(`/imports/sales/${id}/commit`).set(h).send({});
    expect(c.status).toBe(202);
    expect(c.body.import.status).toBe('QUEUED');
    expect(await prisma.salesRecord.count()).toBe(0); // not yet — runs in the background
    expect(await prisma.job.count({ where: { type: 'sales.import', status: 'PENDING' } })).toBe(1);

    expect(await drainJobs()).toBe(1);
    const imp = await prisma.salesImport.findUniqueOrThrow({ where: { id } });
    expect(imp).toMatchObject({
      status: 'DONE',
      importedRows: 2,
      errorMessage: null,
      rawCsv: null,
    });
    const rows = await prisma.salesRecord.findMany({
      where: { tenantId: tid },
      orderBy: { date: 'asc' },
    });
    expect(
      rows.map((r) => [
        r.productId,
        r.locationId,
        r.date.toISOString().slice(0, 10),
        Number(r.quantity),
        Number(r.revenueCents),
      ]),
    ).toEqual([
      [a.id, loc.id, d(0), 15, 15000],
      [a.id, loc.id, d(7), 8, 8000],
    ]);
    const detail = await request(app).get(`/imports/sales/${id}`).set(h);
    expect(detail.body.import.status).toBe('DONE');
    expect((await prisma.auditLog.findMany()).map((x) => x.action)).toContain(
      'import.sales_committed',
    );
  });

  it('with errors it needs explicit confirmation (skipErrors) and then imports only the valid rows', async () => {
    const { h } = await setup();
    const d = recentMonday();
    const p = await preview(h, csvOf([`SKU-A,WH-1,${d(0)},10,100`, `NOPE,WH-1,${d(0)},1,1`]));
    const id = p.body.import.id;
    const blocked = await request(app).post(`/imports/sales/${id}/commit`).set(h).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('HAS_ERRORS');
    expect((await prisma.salesImport.findUniqueOrThrow({ where: { id } })).status).toBe('PREVIEW');
    expect(
      (await request(app).post(`/imports/sales/${id}/commit`).set(h).send({ skipErrors: true }))
        .status,
    ).toBe(202);
    await drainJobs();
    const done = await prisma.salesImport.findUniqueOrThrow({ where: { id } });
    expect(done).toMatchObject({ status: 'DONE', importedRows: 1, errorCount: 1 });
  });

  it('cannot commit twice, or an import with no valid rows', async () => {
    const { h } = await setup();
    const d = recentMonday();
    const ok = (await preview(h, csvOf([`SKU-A,WH-1,${d(0)},10,100`]))).body.import.id;
    expect((await request(app).post(`/imports/sales/${ok}/commit`).set(h).send({})).status).toBe(
      202,
    );
    const again = await request(app).post(`/imports/sales/${ok}/commit`).set(h).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_COMMITTED');
    const none = (await preview(h, csvOf([`NOPE,WH-1,${d(0)},10,100`]))).body.import.id;
    const r = await request(app)
      .post(`/imports/sales/${none}/commit`)
      .set(h)
      .send({ skipErrors: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NOTHING_TO_IMPORT');
    expect(await prisma.job.count()).toBe(1);
  });

  it('concurrent commits queue exactly one job', async () => {
    const { h } = await setup();
    const d = recentMonday();
    const id = (await preview(h, csvOf([`SKU-A,WH-1,${d(0)},10,100`]))).body.import.id;
    const res = await Promise.all(
      [1, 2, 3, 4].map(() => request(app).post(`/imports/sales/${id}/commit`).set(h).send({})),
    );
    expect(res.filter((r) => r.status === 202)).toHaveLength(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it('re-importing the same weeks replaces the earlier rows instead of doubling them', async () => {
    const { h, a, loc } = await setup();
    const d = recentMonday();
    const run = async (rows: string[]) => {
      const id = (await preview(h, csvOf(rows))).body.import.id;
      await request(app).post(`/imports/sales/${id}/commit`).set(h).send({});
      await drainJobs();
    };
    await run([
      `SKU-A,WH-1,${d(0)},10,100`,
      `SKU-A,WH-1,${d(7)},20,200`,
      `SKU-B,WH-1,${d(0)},4,40`,
    ]);
    await run([`SKU-A,WH-1,${d(1)},99,990`]); // same week as d(0) → replaces it; other weeks untouched
    const rows = await prisma.salesRecord.findMany({
      where: { productId: a.id, locationId: loc.id },
      orderBy: { date: 'asc' },
    });
    expect(rows.map((r) => [r.date.toISOString().slice(0, 10), Number(r.quantity)])).toEqual([
      [d(0), 99],
      [d(7), 20],
    ]);
    expect(await prisma.salesRecord.count()).toBe(3); // SKU-B untouched
    await run([`SKU-A,WH-1,${d(0)},99,990`]); // identical re-import is idempotent
    expect(await prisma.salesRecord.count()).toBe(3);
  });

  it('records a job failure on both the job and the import with the error message', async () => {
    const { h } = await setup();
    const d = recentMonday();
    const id = (await preview(h, csvOf([`SKU-A,WH-1,${d(0)},10,100`]))).body.import.id;
    await request(app).post(`/imports/sales/${id}/commit`).set(h).send({});
    await prisma.salesImport.update({ where: { id }, data: { rawCsv: null } }); // simulate lost upload
    const far = new Date(Date.now() + 365 * 86400_000);
    for (let i = 0; i < 4; i++) await drainJobs(new Date(far.getTime() + i * 3600_000 * 24));
    const imp = await prisma.salesImport.findUniqueOrThrow({ where: { id } });
    expect(imp.status).toBe('FAILED');
    expect(imp.errorMessage).toMatch(/no longer available/);
    const job = await prisma.job.findFirstOrThrow({ where: { type: 'sales.import' } });
    expect(job.status).toBe('FAILED');
    expect(job.lastError).toMatch(/no longer available/);
    expect(await prisma.salesRecord.count()).toBe(0);
    const list = await request(app).get('/imports/sales').set(h);
    expect(list.body.items[0]).toMatchObject({
      status: 'FAILED',
      errorMessage: expect.stringMatching(/no longer available/),
    });
  });

  it('rows whose SKU was removed between preview and commit are skipped, not fatal', async () => {
    const { h, b } = await setup();
    const d = recentMonday();
    const id = (await preview(h, csvOf([`SKU-A,WH-1,${d(0)},10,100`, `SKU-B,WH-1,${d(0)},4,40`])))
      .body.import.id;
    await request(app).post(`/imports/sales/${id}/commit`).set(h).send({});
    await prisma.product.delete({ where: { id: b.id } });
    await drainJobs();
    expect(await prisma.salesRecord.count()).toBe(1);
    expect(await prisma.salesImport.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'DONE',
      importedRows: 1,
      errorCount: 1,
    });
  });

  it('roles and tenant isolation on commit / detail', async () => {
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/imports/sales/nope/commit',
      body: {},
      allowed: rolesWith('import:sales'),
    });
    for (const [method, suffix] of [
      ['get', ''],
      ['post', '/commit'],
    ] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/imports/sales/${id}${suffix}`,
        body: method === 'post' ? {} : undefined,
        createResource: (tenantId) =>
          prisma.salesImport.create({
            data: { tenantId, fileName: 'x.csv', status: 'PREVIEW', rowCount: 1, validRowCount: 1 },
          }),
      });
    }
  });
});

describe('listing and template', () => {
  it('lists committed imports (newest first, previews hidden), paginated; roles read-only for Viewer', async () => {
    const { h, tid } = await setup();
    await prisma.salesImport.create({
      data: { tenantId: tid, fileName: 'preview.csv', status: 'PREVIEW' },
    });
    await prisma.salesImport.create({
      data: {
        tenantId: tid,
        fileName: 'old.csv',
        status: 'DONE',
        createdAt: new Date('2030-01-01'),
      },
    });
    await prisma.salesImport.create({
      data: {
        tenantId: tid,
        fileName: 'new.csv',
        status: 'QUEUED',
        createdAt: new Date('2030-02-01'),
      },
    });
    const res = await request(app).get('/imports/sales').set(h);
    expect(res.body.items.map((i: { fileName: string }) => i.fileName)).toEqual([
      'new.csv',
      'old.csv',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('rawCsv');
    expect((await request(app).get('/imports/sales?pageSize=1').set(h)).body.items).toHaveLength(1);
    expect((await request(app).get('/imports/sales?pageSize=101').set(h)).status).toBe(400);
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/imports/sales',
      allowed: rolesWith('sales:read'),
    });
  });

  it('serves a CSV template that itself passes validation shape', async () => {
    const { h } = await setup();
    const res = await request(app).get('/imports/sales/template').set(h);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toBe('sku,location_code,date,quantity,revenue');
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/imports/sales/template',
      allowed: rolesWith('import:sales'),
    });
  });
});

describe('sales history protects master data', () => {
  it('products and locations with sales history cannot be deleted (409), only deactivated', async () => {
    const { h, tid, a, loc } = await setup();
    await prisma.salesRecord.create({
      data: {
        tenantId: tid,
        productId: a.id,
        locationId: loc.id,
        date: new Date('2025-01-06'),
        quantity: 5,
      },
    });
    const p = await request(app).delete(`/products/${a.id}`).set(h);
    expect(p.status).toBe(409);
    expect(p.body.error.message).toMatch(/sales history\. Deactivate it instead/);
    expect((await request(app).delete(`/locations/${loc.id}`).set(h)).status).toBe(409);
    expect(
      (await request(app).patch(`/products/${a.id}`).set(h).send({ isActive: false })).status,
    ).toBe(200);
  });
});
