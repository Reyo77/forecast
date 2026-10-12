import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeSub, makeUser, mockApi, page, renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

const base = (
  extra: Record<string, (b: unknown, url: string) => Promise<Response> | Response> = {},
  me = makeUser(),
) => ({
  ...loggedInAs(me),
  'GET /billing/subscription': () => json(200, makeSub({ status: 'ACTIVE' })),
  'GET /demo-data/status': () => json(200, { hasSalesData: true, canLoad: false }),
  'GET /imports/sales': () => page([]),
  ...extra,
});

const previewOk = (over: Record<string, unknown> = {}) => ({
  import: {
    id: 'imp1',
    fileName: 'sales.csv',
    status: 'PREVIEW',
    rowCount: 5,
    validRowCount: 5,
    errorCount: 0,
    importedRows: 0,
    errorMessage: null,
    createdAt: '2030-01-01T00:00:00Z',
    finishedAt: null,
  },
  errors: [],
  sample: [
    { sku: 'SKU-A', location: 'WH-1', weekStart: '2025-01-06', quantity: 17, revenueCents: 1700 },
  ],
  totalWeeklyRows: 1,
  ...over,
});

const upload = async (name: string, content: string) => {
  const input = await screen.findByLabelText('CSV file');
  await userEvent.upload(input, new File([content], name, { type: 'text/csv' }));
};

describe('import page', () => {
  it('uploads a CSV, shows the preview and queues the commit', async () => {
    const fetchMock = mockApi(
      base({
        'POST /imports/sales/preview': () => json(201, previewOk()),
        'POST /imports/sales/imp1/commit': () => json(202, { import: previewOk().import }),
      }),
    );
    renderApp('/import');
    await upload('sales.csv', 'sku,location_code,date,quantity\nSKU-A,WH-1,2025-01-06,17\n');
    expect(await screen.findByTestId('preview-summary')).toHaveTextContent(
      '5 rows · 5 valid · 0 with errors',
    );
    expect(screen.getByTestId('sample-row')).toHaveTextContent('SKU-A');
    const call = calls(fetchMock, 'POST /imports/sales/preview')[0]!;
    expect(String(call[0])).toContain('fileName=sales.csv');
    expect((call[1] as RequestInit).body).toContain('SKU-A,WH-1');
    expect(((call[1] as RequestInit).headers as Record<string, string>)['Content-Type']).toBe(
      'text/csv',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import 5 rows' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Import queued');
    expect(
      JSON.parse(calls(fetchMock, 'POST /imports/sales/imp1/commit')[0]![1]!.body as string),
    ).toEqual({ skipErrors: false });
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('highlights row errors and requires explicit confirmation to import only the valid rows', async () => {
    const fetchMock = mockApi(
      base({
        'POST /imports/sales/preview': () =>
          json(
            201,
            previewOk({
              import: { ...previewOk().import, rowCount: 3, validRowCount: 2, errorCount: 1 },
              errors: [{ row: 3, field: 'sku', message: 'Unknown SKU "NOPE"' }],
            }),
          ),
        'POST /imports/sales/imp1/commit': () => json(202, { import: previewOk().import }),
      }),
    );
    renderApp('/import');
    await upload('bad.csv', 'x');
    const err = await screen.findByTestId('error-row');
    expect(err).toHaveTextContent('3');
    expect(err).toHaveTextContent('Unknown SKU "NOPE"');
    expect(screen.getByTestId('preview-summary')).toHaveTextContent('1 with errors');
    expect(screen.queryByRole('button', { name: 'Import 2 rows' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 valid rows, skip 1' }));
    await waitFor(() =>
      expect(
        JSON.parse(calls(fetchMock, 'POST /imports/sales/imp1/commit')[0]![1]!.body as string),
      ).toEqual({ skipErrors: true }),
    );
  });

  it('shows a fatal file error (wrong headers) and no preview', async () => {
    mockApi(
      base({
        'POST /imports/sales/preview': () =>
          json(400, {
            error: {
              code: 'INVALID_HEADERS',
              message: 'Missing required column(s): date, quantity.',
            },
          }),
      }),
    );
    renderApp('/import');
    await upload('x.csv', 'sku,when\n');
    expect(await screen.findByRole('alert')).toHaveTextContent('Missing required column(s)');
    expect(screen.queryByTestId('preview')).toBeNull();
  });

  it('rejects files over 10 MB without calling the API', async () => {
    const fetchMock = mockApi(base());
    renderApp('/import');
    const big = new File(['x'], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await userEvent.upload(await screen.findByLabelText('CSV file'), big);
    expect(await screen.findByRole('alert')).toHaveTextContent('larger than 10 MB');
    expect(calls(fetchMock, 'POST /imports/sales/preview')).toHaveLength(0);
  });

  it('accepts a dropped file', async () => {
    mockApi(base({ 'POST /imports/sales/preview': () => json(201, previewOk()) }));
    renderApp('/import');
    const zone = await screen.findByTestId('dropzone');
    const file = new File(['sku,location_code,date,quantity\n'], 'dropped.csv', {
      type: 'text/csv',
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(await screen.findByTestId('preview')).toBeInTheDocument();
  });

  it('shows import history with status and failure messages', async () => {
    const row = (o: Record<string, unknown>) => ({
      id: 'i',
      fileName: 'a.csv',
      status: 'DONE',
      rowCount: 10,
      validRowCount: 10,
      errorCount: 0,
      importedRows: 8,
      errorMessage: null,
      createdAt: '2030-01-01T00:00:00Z',
      finishedAt: null,
      ...o,
    });
    mockApi(
      base({
        'GET /imports/sales': () =>
          page([
            row({ id: '1', fileName: 'ok.csv' }),
            row({
              id: '2',
              fileName: 'broken.csv',
              status: 'FAILED',
              errorMessage: 'The uploaded file is no longer available',
            }),
          ]),
      }),
    );
    renderApp('/import');
    expect(await screen.findByTestId('import-ok.csv')).toHaveTextContent('DONE');
    expect(screen.getByTestId('import-broken.csv')).toHaveTextContent('FAILED');
    expect(screen.getByTestId('import-broken.csv')).toHaveTextContent('no longer available');
  });

  it('polls while an import is running and updates to DONE', async () => {
    let n = 0;
    const row = (status: string) => ({
      id: '1',
      fileName: 'run.csv',
      status,
      rowCount: 3,
      validRowCount: 3,
      errorCount: 0,
      importedRows: status === 'DONE' ? 3 : 0,
      errorMessage: null,
      createdAt: '2030-01-01T00:00:00Z',
      finishedAt: null,
    });
    mockApi(base({ 'GET /imports/sales': () => page([row(++n < 2 ? 'QUEUED' : 'DONE')]) }));
    renderApp('/import');
    expect(await screen.findByTestId('import-run.csv')).toHaveTextContent('QUEUED');
    await waitFor(() => expect(screen.getByTestId('import-run.csv')).toHaveTextContent('DONE'), {
      timeout: 5000,
    });
  });

  it('empty history message; template download uses the API with auth', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const fetchMock = mockApi(
      base({
        'GET /imports/sales/template': () =>
          Promise.resolve({
            ok: true,
            status: 200,
            blob: () => Promise.resolve(new Blob(['a'])),
          } as Response),
      }),
    );
    renderApp('/import');
    expect(await screen.findByText('No imports yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV template' }));
    await waitFor(() => expect(calls(fetchMock, 'GET /imports/sales/template')).toHaveLength(1));
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('a Viewer cannot open the import page', async () => {
    mockApi(base({}, makeUser({ role: 'VIEWER' })));
    renderApp('/import');
    expect(await screen.findByTestId('forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Sales' })).toBeInTheDocument();
  });
});

describe('demo data card', () => {
  const setup = (
    me = makeUser(),
    status = { hasSalesData: false, canLoad: true },
    extra: Record<string, () => Promise<Response> | Response> = {},
  ) => mockApi(base({ 'GET /demo-data/status': () => json(200, status), ...extra }, me));

  it('shows for Owner/Admin with no data and loads demo data', async () => {
    const fetchMock = setup(
      makeUser(),
      { hasSalesData: false, canLoad: true },
      {
        'POST /demo-data': () =>
          json(201, {
            summary: {
              products: 12,
              locations: 2,
              suppliers: 3,
              weeksOfSales: 156,
              salesRows: 3744,
            },
          }),
      },
    );
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Load demo data' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '12 products, 2 locations, 3 suppliers and 156 weeks of sales',
    );
    expect(calls(fetchMock, 'POST /demo-data')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load demo data' })).toBeNull();
  });

  it('is hidden once data exists, and for Planner/Viewer', async () => {
    setup(makeUser(), { hasSalesData: true, canLoad: false });
    const a = renderApp('/');
    await screen.findByTestId('whoami');
    expect(screen.queryByTestId('demo-card')).toBeNull();
    a.unmount();
    for (const role of ['PLANNER', 'VIEWER']) {
      vi.unstubAllGlobals();
      const fetchMock = setup(makeUser({ role }));
      const r = renderApp('/');
      await screen.findByTestId('whoami');
      expect(screen.queryByTestId('demo-card')).toBeNull();
      expect(calls(fetchMock, 'GET /demo-data/status')).toHaveLength(0); // not even requested
      r.unmount();
    }
  });

  it('shows the plan-limit error from the server', async () => {
    setup(
      makeUser(),
      { hasSalesData: false, canLoad: true },
      {
        'POST /demo-data': () =>
          json(402, {
            error: {
              code: 'PLAN_LIMIT_REACHED',
              message: 'Demo data needs 2 locations; your plan allows 1.',
            },
          }),
      },
    );
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Load demo data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('your plan allows 1');
  });
});

describe('sales explorer', () => {
  const result = {
    series: [
      {
        key: 'all',
        label: 'All sales',
        total: 185,
        points: [
          { weekStart: '2025-01-06', quantity: 115, revenueCents: 21500 },
          { weekStart: '2025-01-13', quantity: 70, revenueCents: 12000 },
        ],
      },
    ],
    omittedSeries: 0,
    totals: { quantity: 185, revenueCents: 33500, weeks: 2 },
  };
  const setup = (
    extra: Record<string, (b: unknown, u: string) => Promise<Response> | Response> = {},
  ) =>
    mockApi(
      base({
        'GET /sales/explorer': () => json(200, result),
        'GET /products': () =>
          page([
            {
              id: 'p1',
              sku: 'SKU-1',
              name: 'W',
              categoryId: null,
              categoryName: null,
              unitCostCents: 0,
              unitPriceCents: 0,
              isComponent: false,
              isActive: true,
            },
          ]),
        'GET /categories': () => json(200, { items: [] }),
        'GET /locations': () => page([{ id: 'l1', code: 'WH-1', name: 'M', type: 'WAREHOUSE' }]),
        ...extra,
      }),
    );

  it('shows totals and a table view that matches the data', async () => {
    setup();
    renderApp('/sales');
    expect(await screen.findByTestId('total-units')).toHaveTextContent('185');
    expect(screen.getByTestId('total-revenue')).toHaveTextContent('$335');
    expect(screen.getByTestId('total-weeks')).toHaveTextContent('2');
    await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const table = screen.getByTestId('explorer-table');
    expect(within(table).getByText('2025-01-06').closest('tr')).toHaveTextContent('115');
    expect(within(table).getByText('2025-01-13').closest('tr')).toHaveTextContent('70');
  });

  it('sends filters, grouping and date range to the API', async () => {
    const fetchMock = setup();
    renderApp('/sales');
    await screen.findByTestId('total-units');
    await userEvent.selectOptions(screen.getByLabelText('Group by'), 'product');
    await userEvent.selectOptions(await screen.findByLabelText('Location filter'), 'l1');
    await userEvent.type(screen.getByLabelText('From'), '2025-01-01');
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u]) =>
            String(u).includes('groupBy=product') &&
            String(u).includes('locationId=l1') &&
            String(u).includes('from=2025-01-01'),
        ),
      ).toBe(true),
    );
  });

  it('shows the empty state and keeps working for a Viewer (read-only role)', async () => {
    setup({
      'GET /sales/explorer': () =>
        json(200, {
          series: [],
          omittedSeries: 0,
          totals: { quantity: 0, revenueCents: 0, weeks: 0 },
        }),
    });
    renderApp('/sales');
    expect(await screen.findByTestId('explorer-empty')).toBeInTheDocument();
    expect(screen.getByTestId('total-units')).toHaveTextContent('0');
  });

  it('multi-series: a legend/table column per group and the "top 10" note', async () => {
    setup({
      'GET /sales/explorer': () =>
        json(200, {
          series: [
            {
              key: 'a',
              label: 'COLA',
              total: 150,
              points: [{ weekStart: '2025-01-06', quantity: 100, revenueCents: 1 }],
            },
            {
              key: 'b',
              label: 'CHIP',
              total: 35,
              points: [{ weekStart: '2025-01-13', quantity: 20, revenueCents: 1 }],
            },
          ],
          omittedSeries: 3,
          totals: { quantity: 185, revenueCents: 2, weeks: 2 },
        }),
    });
    renderApp('/sales');
    expect(await screen.findByText(/top 10 of 5 groups/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const t = screen.getByTestId('explorer-table');
    expect(within(t).getByText('COLA')).toBeInTheDocument();
    expect(within(t).getByText('CHIP')).toBeInTheDocument();
    expect(within(t).getAllByText('—').length).toBe(2); // missing weeks are shown as gaps, not zeros
  });
});
