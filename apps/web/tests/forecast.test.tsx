import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeSub, makeUser, mockApi, page, renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

const run = (o: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'DONE',
  horizonWeeks: 26,
  method: 'AUTO',
  filters: {},
  progress: 100,
  seriesTotal: 3,
  seriesDone: 3,
  seriesFailed: 0,
  failures: null,
  asOfWeek: '2025-06-02',
  startedAt: '2025-06-03T00:00:00Z',
  finishedAt: '2025-06-03T00:01:00Z',
  error: null,
  createdAt: '2025-06-03T00:00:00Z',
  ...o,
});
const acc = (sku: string, loc: string, wape: number | null, model = 'holt') => ({
  productId: `p-${sku}`,
  productSku: sku,
  productName: `Name ${sku}`,
  locationId: `l-${loc}`,
  locationCode: loc,
  modelUsed: model,
  reason: 'backtest',
  mape: 0.1,
  wape,
  bias: -0.02,
});
const series = (o: Record<string, unknown> = {}) => ({
  product: { id: 'p-A', sku: 'A', name: 'Name A' },
  location: { id: 'l-EAST', code: 'EAST' },
  modelUsed: 'holt',
  accuracy: { mape: 0.123, wape: 0.087, bias: -0.021, reason: 'backtest' },
  history: [
    { weekStart: '2025-05-26', quantity: 100 },
    { weekStart: '2025-06-02', quantity: 110 },
  ],
  forecast: [
    {
      weekStart: '2025-06-09',
      quantity: 112.3,
      lower: 100,
      upper: 125,
      override: null,
      final: 112.3,
    },
    { weekStart: '2025-06-16', quantity: 115.1, lower: 101, upper: 130, override: 200, final: 200 },
  ],
  ...o,
});

const base = (
  extra: Record<string, (b: unknown, u: string) => Promise<Response> | Response> = {},
  me = makeUser(),
) => ({
  ...loggedInAs(me),
  'GET /billing/subscription': () => json(200, makeSub({ status: 'ACTIVE' })),
  'GET /categories': () =>
    json(200, { items: [{ id: 'c1', name: 'Snacks', parentId: null, productCount: 1 }] }),
  'GET /locations': () => page([{ id: 'l-EAST', code: 'EAST', name: 'East', type: 'WAREHOUSE' }]),
  'GET /products': () =>
    page([
      {
        id: 'p-A',
        sku: 'A',
        name: 'Name A',
        categoryId: null,
        categoryName: null,
        unitCostCents: 0,
        unitPriceCents: 0,
        isComponent: false,
        isActive: true,
      },
    ]),
  ...extra,
});

describe('forecasts page', () => {
  it('lists runs with status, progress and failed-series counts; empty state', async () => {
    mockApi(
      base({
        'GET /forecasts/runs': () =>
          page([
            run(),
            run({ id: 'r2', status: 'RUNNING', progress: 40, seriesDone: 1, method: 'holt' }),
            run({ id: 'r3', seriesFailed: 2, seriesDone: 1 }),
          ]),
      }),
    );
    const { unmount } = renderApp('/forecasts');
    expect(await screen.findByTestId('run-r1')).toHaveTextContent('DONE');
    expect(screen.getByTestId('run-r2')).toHaveTextContent('RUNNING');
    expect(within(screen.getByTestId('run-r2')).getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    expect(screen.getByTestId('run-r2')).toHaveTextContent('Holt (trend)');
    expect(screen.getByTestId('run-r3')).toHaveTextContent('2 failed');
    unmount();
    vi.unstubAllGlobals();
    mockApi(base({ 'GET /forecasts/runs': () => page([]) }));
    renderApp('/forecasts');
    expect(await screen.findByTestId('no-runs')).toBeInTheDocument();
  });

  it('starts a run with horizon, method and filters', async () => {
    const fetchMock = mockApi(
      base({
        'GET /forecasts/runs': () => page([]),
        'POST /forecasts/runs': () => json(202, { run: run({ status: 'PENDING', progress: 0 }) }),
      }),
    );
    renderApp('/forecasts');
    const form = await screen.findByRole('form', { name: 'New forecast run' });
    await within(form).findByRole('option', { name: 'Snacks' });
    await userEvent.clear(within(form).getByLabelText('Horizon (weeks)'));
    await userEvent.type(within(form).getByLabelText('Horizon (weeks)'), '12');
    await userEvent.selectOptions(within(form).getByLabelText('Method'), 'holt_winters');
    await userEvent.selectOptions(within(form).getByLabelText('Category filter'), 'c1');
    await userEvent.selectOptions(within(form).getByLabelText('Location filter'), 'l-EAST');
    await userEvent.click(within(form).getByRole('button', { name: 'Run forecast' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Forecast run started');
    expect(JSON.parse(calls(fetchMock, 'POST /forecasts/runs')[0]![1]!.body as string)).toEqual({
      horizonWeeks: 12,
      method: 'holt_winters',
      filters: { categoryId: 'c1', locationId: 'l-EAST' },
    });
  });

  it('shows 402 (limit) and 400 (no data) errors', async () => {
    let n = 0;
    mockApi(
      base({
        'GET /forecasts/runs': () => page([]),
        'POST /forecasts/runs': () =>
          ++n === 1
            ? json(402, {
                error: {
                  code: 'PLAN_LIMIT_REACHED',
                  message:
                    'Your plan allows 10 forecast runs this month. Upgrade your plan to continue.',
                },
              })
            : json(400, {
                error: {
                  code: 'NO_SALES_DATA',
                  message: 'There is no sales history for this selection.',
                },
              }),
      }),
    );
    renderApp('/forecasts');
    await userEvent.click(await screen.findByRole('button', { name: 'Run forecast' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upgrade your plan');
    await userEvent.click(screen.getByRole('button', { name: 'Run forecast' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no sales history'));
  });

  it('polls a running run until it completes', async () => {
    let n = 0;
    mockApi(
      base({
        'GET /forecasts/runs': () =>
          page([n++ < 1 ? run({ status: 'RUNNING', progress: 30 }) : run()]),
      }),
    );
    renderApp('/forecasts');
    expect(await screen.findByTestId('run-r1')).toHaveTextContent('RUNNING');
    await waitFor(() => expect(screen.getByTestId('run-r1')).toHaveTextContent('DONE'), {
      timeout: 5000,
    });
  });

  it('Viewers can see runs but have no run form', async () => {
    mockApi(base({ 'GET /forecasts/runs': () => page([run()]) }, makeUser({ role: 'VIEWER' })));
    renderApp('/forecasts');
    await screen.findByTestId('run-r1');
    expect(screen.queryByRole('form', { name: 'New forecast run' })).toBeNull();
  });
});

describe('forecast run page', () => {
  const setup = (
    extra: Record<string, (b: unknown, u: string) => Promise<Response> | Response> = {},
    me = makeUser(),
    r = run(),
  ) =>
    mockApi(
      base(
        {
          'GET /forecasts/runs/r1': () => json(200, { run: r }),
          'GET /forecasts/runs/r1/accuracy': () =>
            page([acc('A', 'EAST', 0.087), acc('B', 'EAST', 0.4, 'croston')]),
          'GET /forecasts/runs/r1/series': () => json(200, series()),
          'GET /forecasts/overrides': () =>
            page([
              {
                id: 'o1',
                productId: 'p-A',
                productSku: 'A',
                locationId: 'l-EAST',
                locationCode: 'EAST',
                weekStart: '2025-06-16',
                quantity: 200,
                reason: 'Promo',
                updatedAt: '2025-06-03T00:00:00Z',
              },
            ]),
          ...extra,
        },
        me,
      ),
    );

  it('shows the run summary, accuracy table and the selected series with model and metrics', async () => {
    setup();
    renderApp('/forecasts/r1');
    expect(await screen.findByTestId('run-summary')).toHaveTextContent(
      '26 weeks · automatic model selection · 3/3 series',
    );
    expect(await screen.findByTestId('acc-A-EAST')).toHaveTextContent('8.7%');
    expect(screen.getByTestId('acc-B-EAST')).toHaveTextContent('Croston');
    const summary = await screen.findByTestId('series-summary');
    expect(summary).toHaveTextContent('Holt (trend)');
    expect(summary).toHaveTextContent('WAPE 8.7%');
    expect(summary).toHaveTextContent('MAPE 12.3%');
    expect(summary).toHaveTextContent('bias -2.1%');
  });

  it('table view shows the forecast, interval and the override (different from the model value)', async () => {
    setup();
    renderApp('/forecasts/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'View as table' }));
    const row = screen.getByTestId('fc-2025-06-16');
    expect(row).toHaveTextContent('115.1');
    expect(row).toHaveTextContent('200');
    expect(screen.getByTestId('fc-2025-06-09')).toHaveTextContent('—');
    expect(screen.getByTestId('fc-2025-06-16').querySelector('.text-green-700')).not.toBeNull();
  });

  it('sorts the accuracy table via the API and switches series on row click', async () => {
    const fetchMock = setup();
    renderApp('/forecasts/r1');
    await screen.findByTestId('acc-A-EAST');
    await userEvent.click(screen.getByRole('button', { name: 'Sort by WAPE' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u]) => String(u).includes('sort=wape') && String(u).includes('order=asc'),
        ),
      ).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sort by SKU' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('sort=sku'))).toBe(true),
    );
    await userEvent.click(await screen.findByTestId('acc-B-EAST'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u]) => String(u).includes('productId=p-B') && String(u).includes('locationId=l-EAST'),
        ),
      ).toBe(true),
    );
  });

  it('saves an override with a required reason', async () => {
    const fetchMock = setup({ 'PUT /forecasts/overrides': () => json(200, { override: {} }) });
    renderApp('/forecasts/r1');
    const form = await screen.findByRole('form', { name: 'Add override' });
    await within(form).findByRole('option', { name: '2025-06-09' });
    await userEvent.selectOptions(within(form).getByLabelText('Week'), '2025-06-09');
    await userEvent.type(within(form).getByLabelText('Quantity'), '150');
    await userEvent.click(within(form).getByRole('button', { name: 'Override' }));
    expect(calls(fetchMock, 'PUT /forecasts/overrides')).toHaveLength(0); // reason is required (native validation)
    await userEvent.type(within(form).getByLabelText('Reason (required)'), 'Black Friday');
    await userEvent.click(within(form).getByRole('button', { name: 'Override' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Override saved');
    expect(JSON.parse(calls(fetchMock, 'PUT /forecasts/overrides')[0]![1]!.body as string)).toEqual(
      {
        productId: 'p-A',
        locationId: 'l-EAST',
        weekStart: '2025-06-09',
        quantity: 150,
        reason: 'Black Friday',
      },
    );
  });

  it('lists and removes overrides; shows server validation errors', async () => {
    const fetchMock = setup({
      'DELETE /forecasts/overrides/o1': () => json(204),
      'PUT /forecasts/overrides': () =>
        json(400, { error: { code: 'NOT_A_WEEK_START', message: 'Week must start on a Monday' } }),
    });
    renderApp('/forecasts/r1');
    const list = await screen.findByTestId('overrides');
    expect(within(list).getByTestId('override-2025-06-16')).toHaveTextContent(
      'EAST · 2025-06-16: 200 — Promo',
    );
    await userEvent.click(within(list).getByRole('button', { name: 'Remove override 2025-06-16' }));
    await waitFor(() => expect(calls(fetchMock, 'DELETE /forecasts/overrides/o1')).toHaveLength(1));
    const form = screen.getByRole('form', { name: 'Add override' });
    await within(form).findByRole('option', { name: '2025-06-09' });
    await userEvent.selectOptions(within(form).getByLabelText('Week'), '2025-06-09');
    await userEvent.type(within(form).getByLabelText('Quantity'), '1');
    await userEvent.type(within(form).getByLabelText('Reason (required)'), 'abc');
    await userEvent.click(within(form).getByRole('button', { name: 'Override' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Monday');
  });

  it('summing all locations disables overriding and explains why', async () => {
    setup({
      'GET /forecasts/runs/r1/series': (_b, u) =>
        json(
          200,
          u.includes('locationId=')
            ? series()
            : series({ location: null, accuracy: null, modelUsed: 'mixed' }),
        ),
    });
    renderApp('/forecasts/r1');
    await screen.findByRole('form', { name: 'Add override' });
    await userEvent.click(screen.getByRole('button', { name: 'Sum all locations' }));
    expect(
      await screen.findByText('Pick a single location to override a week.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add override' })).toBeNull();
    expect(await screen.findByTestId('series-summary')).toHaveTextContent('all locations');
  });

  it('a running run shows a progress bar and no accuracy yet; a Viewer has no override controls', async () => {
    setup({}, makeUser(), run({ status: 'RUNNING', progress: 55, seriesDone: 2 }));
    const a = renderApp('/forecasts/r1');
    expect(await screen.findByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '55');
    expect(screen.queryByTestId('accuracy-table')).toBeNull();
    a.unmount();
    vi.unstubAllGlobals();
    setup({}, makeUser({ role: 'VIEWER' }));
    renderApp('/forecasts/r1');
    await screen.findByTestId('series-summary');
    expect(screen.queryByRole('form', { name: 'Add override' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove override/ })).toBeNull();
  });

  it('shows per-series failures without hiding the finished results, and the run error when it fails', async () => {
    setup(
      {},
      makeUser(),
      run({
        seriesFailed: 1,
        seriesDone: 2,
        failures: [{ productId: 'p-X', locationId: 'l', error: 'model exploded' }],
      }),
    );
    const a = renderApp('/forecasts/r1');
    const box = await screen.findByTestId('failures');
    expect(box).toHaveTextContent('1 series could not be forecast');
    expect(box).toHaveTextContent('model exploded');
    expect(await screen.findByTestId('accuracy-table')).toBeInTheDocument();
    a.unmount();
    vi.unstubAllGlobals();
    setup(
      {},
      makeUser(),
      run({
        status: 'FAILED',
        error: 'Every series failed. First error: boom',
        progress: 100,
        seriesDone: 0,
      }),
    );
    renderApp('/forecasts/r1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Every series failed');
    expect(screen.queryByTestId('accuracy-table')).toBeNull();
  });

  it('exports CSV through the authenticated API', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const fetchMock = setup({
      'GET /forecasts/runs/r1/export.csv': () =>
        Promise.resolve({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(new Blob(['a,b'])),
        } as Response),
    });
    renderApp('/forecasts/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() =>
      expect(calls(fetchMock, 'GET /forecasts/runs/r1/export.csv')).toHaveLength(1),
    );
    expect(createObjectURL).toHaveBeenCalled();
  });
});
