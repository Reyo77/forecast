import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeSub, makeUser, mockApi, page, renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

const kpis = (o: Record<string, number> = {}) => ({
  stockoutWeeks: 2,
  fillRate: 0.9,
  avgInventoryValueCents: 100000,
  revenueAtRiskCents: 50000,
  plannedOrders: 4,
  totalDemand: 1000,
  totalShortage: 100,
  ...o,
});
const risk = (sku: string, week: number, shortage: number, rev: number) => ({
  productId: `p-${sku}`,
  productSku: sku,
  productName: `Name ${sku}`,
  locationId: 'l1',
  locationCode: 'EAST',
  firstStockoutWeek: week,
  firstStockoutDate: '2025-07-07',
  shortage,
  revenueAtRiskCents: rev,
});
const scenario = (o: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Supplier late',
  description: null,
  baseForecastRunId: 'r1',
  status: 'READY',
  createdAt: '2025-06-03T00:00:00Z',
  updatedAt: '2025-06-03T00:00:00Z',
  leverCount: 1,
  latestKpis: { baseline: kpis(), scenario: kpis({ fillRate: 0.8 }) },
  ...o,
});
const lever = {
  id: 'lv1',
  type: 'SUPPLIER_DELAY',
  target: { supplierId: 'sup1' },
  params: { extraDays: 21 },
  summary: 'Supplier delay: Acme is 21 days late',
};
const doneRun = (o: Record<string, unknown> = {}) => ({
  id: 'run1',
  scenarioId: 's1',
  status: 'DONE',
  error: null,
  startedAt: null,
  finishedAt: null,
  createdAt: '2025-06-03T00:00:00Z',
  levers: [lever],
  kpis: {
    baseline: kpis(),
    scenario: kpis({
      stockoutWeeks: 5,
      fillRate: 0.82,
      revenueAtRiskCents: 90000,
      avgInventoryValueCents: 80000,
      plannedOrders: 6,
      totalShortage: 180,
    }),
  },
  atRisk: {
    baseline: [risk('B', 6, 10, 1000)],
    scenario: [risk('A', 2, 50, 20000), risk('B', 1, 120, 9000), risk('C', 4, 10, 50000)],
  },
  totals: {
    baseline: [{ weekStart: '2025-06-09', demand: 10, onHand: 100, shortage: 0 }],
    scenario: [{ weekStart: '2025-06-09', demand: 10, onHand: 80, shortage: 5 }],
  },
  ...o,
});

const base = (
  extra: Record<string, (b: unknown, u: string) => Promise<Response> | Response> = {},
  me = makeUser(),
) => ({
  ...loggedInAs(me),
  'GET /billing/subscription': () => json(200, makeSub({ status: 'ACTIVE' })),
  'GET /forecasts/runs': () =>
    page([
      {
        id: 'r1',
        status: 'DONE',
        horizonWeeks: 26,
        method: 'AUTO',
        filters: {},
        progress: 100,
        seriesTotal: 16,
        seriesDone: 16,
        seriesFailed: 0,
        failures: null,
        asOfWeek: '2025-06-02',
        startedAt: null,
        finishedAt: null,
        error: null,
        createdAt: '2025-06-03T00:00:00Z',
      },
    ]),
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
  'GET /categories': () =>
    json(200, { items: [{ id: 'c1', name: 'Snacks', parentId: null, productCount: 1 }] }),
  'GET /locations': () => page([{ id: 'l1', code: 'EAST', name: 'East', type: 'WAREHOUSE' }]),
  'GET /suppliers': () =>
    page([{ id: 'sup1', name: 'Acme', defaultLeadTimeDays: 14, reliabilityPct: 95 }]),
  'GET /suppliers/sup1/products': () =>
    json(200, {
      items: [
        {
          id: 'link1',
          supplierId: 'sup1',
          productId: 'p-A',
          productSku: 'A',
          productName: 'Name A',
          leadTimeDays: 14,
          minOrderQty: 1,
          unitCostCents: 0,
          weeklyCapacity: null,
          isPrimary: true,
        },
      ],
    }),
  ...extra,
});

describe('scenarios list', () => {
  it('lists scenarios with status, lever counts and fill rate vs baseline', async () => {
    mockApi(
      base({
        'GET /scenarios': () =>
          page([
            scenario(),
            scenario({ id: 's2', name: 'Fresh', status: 'DRAFT', leverCount: 0, latestKpis: null }),
          ]),
      }),
    );
    renderApp('/scenarios');
    const row = await screen.findByTestId('scenario-Supplier late');
    expect(row).toHaveTextContent('READY');
    expect(row).toHaveTextContent('80.0% (baseline 90.0%)');
    expect(screen.getByTestId('scenario-Fresh')).toHaveTextContent('—');
  });

  it('creates a scenario from a finished forecast and opens it', async () => {
    const fetchMock = mockApi(
      base({
        'GET /scenarios': () => page([]),
        'POST /scenarios': () =>
          json(201, {
            scenario: scenario({
              id: 'new1',
              name: 'My what-if',
              status: 'DRAFT',
              leverCount: 0,
              latestKpis: null,
            }),
          }),
        'GET /scenarios/new1': () =>
          json(200, {
            scenario: scenario({
              id: 'new1',
              name: 'My what-if',
              status: 'DRAFT',
              leverCount: 0,
              latestKpis: null,
            }),
            levers: [],
            latestRun: null,
          }),
      }),
    );
    renderApp('/scenarios');
    expect(await screen.findByTestId('no-scenarios')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'New scenario' });
    await within(form).findByRole('option', { name: /26 wk/ });
    await userEvent.type(within(form).getByLabelText('Name'), 'My what-if');
    await userEvent.click(within(form).getByRole('button', { name: 'Create scenario' }));
    expect(await screen.findByRole('heading', { name: 'My what-if' })).toBeInTheDocument();
    expect(JSON.parse(calls(fetchMock, 'POST /scenarios')[0]![1]!.body as string)).toEqual({
      name: 'My what-if',
      baseForecastRunId: 'r1',
    });
    expect(screen.getByTestId('no-levers')).toBeInTheDocument();
  });

  it('asks for a forecast first when none is finished; shows the 402 limit error', async () => {
    mockApi(base({ 'GET /scenarios': () => page([]), 'GET /forecasts/runs': () => page([]) }));
    const a = renderApp('/scenarios');
    expect(await screen.findByTestId('needs-forecast')).toBeInTheDocument();
    a.unmount();
    vi.unstubAllGlobals();
    mockApi(
      base({
        'GET /scenarios': () => page([]),
        'POST /scenarios': () =>
          json(402, {
            error: {
              code: 'PLAN_LIMIT_REACHED',
              message: 'Your plan allows 3 saved scenarios. Upgrade your plan to continue.',
            },
          }),
      }),
    );
    renderApp('/scenarios');
    const form = await screen.findByRole('form', { name: 'New scenario' });
    await within(form).findByRole('option', { name: /26 wk/ });
    await userEvent.type(within(form).getByLabelText('Name'), 'x');
    await userEvent.click(within(form).getByRole('button', { name: 'Create scenario' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upgrade your plan');
  });

  it('selects up to 3 scenarios for comparison', async () => {
    mockApi(
      base({
        'GET /scenarios': () =>
          page(['a', 'b', 'c', 'd'].map((n, i) => scenario({ id: `s${i}`, name: `Sc ${n}` }))),
        'GET /scenarios/compare': () =>
          json(200, { baseline: { kpis: kpis(), atRisk: [], totals: [] }, scenarios: [] }),
      }),
    );
    renderApp('/scenarios');
    for (const n of ['a', 'b', 'c'])
      await userEvent.click(await screen.findByLabelText(`Select Sc ${n}`));
    expect(screen.getByLabelText('Select Sc d')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Compare selected (3/3)' })).toBeEnabled();
  });

  it('a Viewer can read but not create', async () => {
    mockApi(base({ 'GET /scenarios': () => page([scenario()]) }, makeUser({ role: 'VIEWER' })));
    renderApp('/scenarios');
    await screen.findByTestId('scenario-Supplier late');
    expect(screen.queryByRole('form', { name: 'New scenario' })).toBeNull();
  });
});

describe('scenario page', () => {
  const setup = (
    extra: Record<string, (b: unknown, u: string) => Promise<Response> | Response> = {},
    me = makeUser(),
    latestRun: unknown = doneRun(),
  ) =>
    mockApi(
      base(
        {
          'GET /scenarios/s1': () =>
            json(200, { scenario: scenario(), levers: [lever], latestRun }),
          'GET /scenario-runs/run1/series': () =>
            json(200, {
              product: { sku: 'A', name: 'Name A' },
              weeks: [
                {
                  weekStart: '2025-06-09',
                  baseline: { demand: 10, receipts: 0, onHand: 100, shortage: 0 },
                  scenario: { demand: 10, receipts: 0, onHand: 80, shortage: 5 },
                },
              ],
            }),
          ...extra,
        },
        me,
      ),
    );

  it('shows levers in plain English and KPI cards with deltas against the baseline', async () => {
    setup();
    renderApp('/scenarios/s1');
    expect((await screen.findAllByTestId('lever'))[0]).toHaveTextContent('Acme is 21 days late');
    const cards = await screen.findByTestId('kpi-cards');
    expect(within(cards).getByTestId('kpi-fillRate')).toHaveTextContent('82.0%');
    expect(within(cards).getByTestId('kpi-fillRate')).toHaveTextContent('Baseline 90.0%');
    expect(within(cards).getByTestId('delta-fillRate')).toHaveTextContent('worse');
    expect(within(cards).getByTestId('delta-stockoutWeeks')).toHaveTextContent('+3');
    expect(within(cards).getByTestId('delta-stockoutWeeks')).toHaveTextContent('worse');
    expect(within(cards).getByTestId('delta-avgInventoryValueCents')).toHaveTextContent('better');
    expect(within(cards).getByTestId('kpi-revenueAtRiskCents')).toHaveTextContent('$900');
  });

  it('at-risk products are sortable by first stockout, shortage and revenue', async () => {
    setup();
    renderApp('/scenarios/s1');
    const table = await screen.findByTestId('at-risk-table');
    const order = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.getAttribute('data-testid'));
    expect(order()).toEqual(['risk-B-EAST', 'risk-A-EAST', 'risk-C-EAST']); // by first stockout week asc
    await userEvent.click(within(table).getByRole('button', { name: 'Sort by Shortage' }));
    expect(order()).toEqual(['risk-B-EAST', 'risk-A-EAST', 'risk-C-EAST']); // 120, 50, 10 desc
    await userEvent.click(within(table).getByRole('button', { name: 'Sort by Revenue at risk' }));
    expect(order()).toEqual(['risk-C-EAST', 'risk-A-EAST', 'risk-B-EAST']); // 50000, 20000, 9000
    await userEvent.click(within(table).getByRole('button', { name: 'Sort by Revenue at risk' }));
    expect(order()).toEqual(['risk-B-EAST', 'risk-A-EAST', 'risk-C-EAST']); // toggles to ascending
  });

  it('adds a SUPPLIER_DELAY lever with the right JSON and removes a lever', async () => {
    const fetchMock = setup({
      'POST /scenarios/s1/levers': () => json(201, { lever }),
      'DELETE /scenarios/s1/levers/lv1': () => json(204),
    });
    renderApp('/scenarios/s1');
    const form = await screen.findByRole('form', { name: 'Add lever' });
    await within(form).findByRole('option', { name: 'Acme' });
    await userEvent.selectOptions(within(form).getByLabelText('Supplier'), 'sup1');
    await userEvent.clear(within(form).getByLabelText('Extra days late'));
    await userEvent.type(within(form).getByLabelText('Extra days late'), '21');
    await userEvent.type(within(form).getByLabelText('From'), '2025-06-23');
    await userEvent.click(within(form).getByRole('button', { name: 'Add lever' }));
    await waitFor(() => expect(calls(fetchMock, 'POST /scenarios/s1/levers')).toHaveLength(1));
    expect(
      JSON.parse(calls(fetchMock, 'POST /scenarios/s1/levers')[0]![1]!.body as string),
    ).toEqual({
      type: 'SUPPLIER_DELAY',
      target: { supplierId: 'sup1' },
      params: { extraDays: 21, startDate: '2025-06-23' },
    });
    await userEvent.click((await screen.findAllByRole('button', { name: /Remove lever/ }))[0]!);
    await waitFor(() =>
      expect(calls(fetchMock, 'DELETE /scenarios/s1/levers/lv1')).toHaveLength(1),
    );
  });

  it.each([
    [
      'Demand change',
      { type: 'DEMAND_CHANGE', target: { scope: 'ALL' }, params: { percent: 15 } },
      async (f: HTMLElement) => {
        await userEvent.clear(within(f).getByLabelText('Change (%)'));
        await userEvent.type(within(f).getByLabelText('Change (%)'), '15');
      },
    ],
    [
      'Service level',
      { type: 'SERVICE_LEVEL', target: {}, params: { serviceLevel: 0.99 } },
      async (f: HTMLElement) => {
        await userEvent.clear(within(f).getByLabelText('Target service level (%)'));
        await userEvent.type(within(f).getByLabelText('Target service level (%)'), '99');
      },
    ],
    [
      'Capacity cap',
      { type: 'CAPACITY_CAP', target: { supplierId: 'sup1' }, params: { weeklyQuantity: 100 } },
      async (f: HTMLElement) => {
        await within(f).findByRole('option', { name: 'Acme' });
        await userEvent.selectOptions(within(f).getByLabelText('Supplier'), 'sup1');
      },
    ],
    [
      'Lead time change',
      {
        type: 'LEAD_TIME_CHANGE',
        target: { supplierProductId: 'link1' },
        params: { leadTimeDays: 28 },
      },
      async (f: HTMLElement) => {
        await within(f).findByRole('option', { name: 'Acme' });
        await userEvent.selectOptions(within(f).getByLabelText('Supplier'), 'sup1');
        await within(f).findByRole('option', { name: 'A' });
        await userEvent.selectOptions(within(f).getByLabelText('Product'), 'link1');
      },
    ],
    [
      'Price change',
      {
        type: 'PRICE_CHANGE',
        target: { scope: 'PRODUCT', id: 'p-A' },
        params: { percent: 10, elasticity: 1 },
      },
      async (f: HTMLElement) => {
        await userEvent.selectOptions(within(f).getByLabelText('Applies to'), 'PRODUCT');
        await within(f).findByRole('option', { name: 'A' });
        await userEvent.selectOptions(within(f).getByLabelText('Product'), 'p-A');
      },
    ],
  ])('builds the %s lever correctly', async (label, expected, fill) => {
    const fetchMock = setup({ 'POST /scenarios/s1/levers': () => json(201, { lever }) });
    renderApp('/scenarios/s1');
    const form = await screen.findByRole('form', { name: 'Add lever' });
    await userEvent.selectOptions(within(form).getByLabelText('Lever type'), label);
    await fill(form);
    await userEvent.click(within(form).getByRole('button', { name: 'Add lever' }));
    await waitFor(() => expect(calls(fetchMock, 'POST /scenarios/s1/levers')).toHaveLength(1));
    expect(
      JSON.parse(calls(fetchMock, 'POST /scenarios/s1/levers')[0]![1]!.body as string),
    ).toEqual(expected);
  });

  it('shows server validation errors for a lever', async () => {
    setup({
      'POST /scenarios/s1/levers': () =>
        json(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid input' } }),
    });
    renderApp('/scenarios/s1');
    const form = await screen.findByRole('form', { name: 'Add lever' });
    await within(form).findByRole('option', { name: 'Acme' });
    await userEvent.selectOptions(within(form).getByLabelText('Supplier'), 'sup1');
    await userEvent.click(within(form).getByRole('button', { name: 'Add lever' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid input');
  });

  it('runs the scenario and polls until results appear', async () => {
    let polls = 0;
    const fetchMock = setup({
      'POST /scenarios/s1/run': () =>
        json(202, { run: doneRun({ status: 'PENDING', kpis: null, atRisk: null, totals: null }) }),
      'GET /scenarios/s1': () =>
        json(
          200,
          polls++ < 1
            ? { scenario: scenario({ status: 'DRAFT' }), levers: [lever], latestRun: null }
            : { scenario: scenario(), levers: [lever], latestRun: doneRun() },
        ),
    });
    renderApp('/scenarios/s1');
    await userEvent.click(await screen.findByRole('button', { name: 'Run scenario' }));
    await waitFor(() => expect(calls(fetchMock, 'POST /scenarios/s1/run')).toHaveLength(1));
    expect(
      await screen.findByTestId('kpi-cards', undefined, { timeout: 6000 }),
    ).toBeInTheDocument();
  });

  it('shows a failed run’s error, and a draft warning when levers changed after the run', async () => {
    setup(
      {},
      makeUser(),
      doneRun({
        status: 'FAILED',
        error: 'The base forecast run has no results',
        kpis: null,
        atRisk: null,
        totals: null,
      }),
    );
    const a = renderApp('/scenarios/s1');
    expect(await screen.findByRole('alert')).toHaveTextContent('no results');
    expect(screen.queryByTestId('kpi-cards')).toBeNull();
    a.unmount();
    vi.unstubAllGlobals();
    mockApi(
      base({
        'GET /scenarios/s1': () =>
          json(200, {
            scenario: scenario({ status: 'DRAFT' }),
            levers: [lever],
            latestRun: doneRun(),
          }),
        'GET /scenario-runs/run1/series': () =>
          json(200, { product: { sku: 'A', name: 'A' }, weeks: [] }),
      }),
    );
    renderApp('/scenarios/s1');
    expect(await screen.findByText(/Levers changed since this run/)).toBeInTheDocument();
  });

  it('a Viewer sees results but no lever or run controls', async () => {
    setup({}, makeUser({ role: 'VIEWER' }));
    renderApp('/scenarios/s1');
    await screen.findByTestId('kpi-cards');
    expect(screen.queryByRole('form', { name: 'Add lever' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run scenario' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove lever/ })).toBeNull();
  });

  it('says so when nothing is at risk', async () => {
    setup({}, makeUser(), doneRun({ atRisk: { baseline: [], scenario: [] } }));
    renderApp('/scenarios/s1');
    expect(await screen.findByTestId('no-risk')).toBeInTheDocument();
  });
});

describe('comparison page', () => {
  const compare = {
    baseline: {
      kpis: kpis(),
      atRisk: [],
      totals: [
        { weekStart: '2025-06-09', demand: 10, onHand: 100, shortage: 0 },
        { weekStart: '2025-06-16', demand: 10, onHand: 90, shortage: 0 },
      ],
    },
    scenarios: [
      {
        id: 's1',
        name: 'Late supplier',
        runId: 'run1',
        kpis: kpis({ fillRate: 0.7, stockoutWeeks: 6, revenueAtRiskCents: 90000 }),
        atRisk: [risk('A', 2, 50, 20000), risk('B', 1, 120, 9000)],
        totals: [
          { weekStart: '2025-06-09', demand: 10, onHand: 80, shortage: 0 },
          { weekStart: '2025-06-16', demand: 10, onHand: 60, shortage: 0 },
        ],
        levers: [lever],
      },
      {
        id: 's2',
        name: 'Demand up',
        kpis: kpis({ fillRate: 0.95, stockoutWeeks: 0, revenueAtRiskCents: 0 }),
        runId: 'run2',
        atRisk: [],
        totals: [
          { weekStart: '2025-06-09', demand: 12, onHand: 100, shortage: 0 },
          { weekStart: '2025-06-16', demand: 12, onHand: 95, shortage: 0 },
        ],
        levers: [],
      },
    ],
  };

  it('compares baseline and scenarios side by side with differences and verdicts', async () => {
    mockApi(base({ 'GET /scenarios/compare': () => json(200, compare) }));
    renderApp('/scenarios/compare?ids=s1,s2');
    const t = await screen.findByTestId('kpi-compare');
    expect(within(t).getByTestId('cell-fillRate-Late supplier')).toHaveTextContent('70.0%');
    expect(within(t).getByTestId('cell-fillRate-Late supplier')).toHaveTextContent('worse');
    expect(within(t).getByTestId('cell-fillRate-Demand up')).toHaveTextContent('better');
    expect(within(t).getByTestId('cell-stockoutWeeks-Late supplier')).toHaveTextContent('+4');
    expect(within(t).getByTestId('cell-stockoutWeeks-Demand up')).toHaveTextContent('−2');
    expect(within(t).getByTestId('row-revenueAtRiskCents')).toHaveTextContent('$500');
    expect(screen.getByRole('img', { name: /Projected inventory per week/ })).toBeInTheDocument();
  });

  it('switches the at-risk table between scenarios and lists the levers behind each', async () => {
    mockApi(base({ 'GET /scenarios/compare': () => json(200, compare) }));
    renderApp('/scenarios/compare?ids=s1,s2');
    expect(await screen.findByTestId('risk-A-EAST')).toBeInTheDocument();
    expect(screen.getByText(/Acme is 21 days late/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Demand up' }));
    expect(await screen.findByTestId('no-risk')).toBeInTheDocument();
  });

  it('explains mismatched bases and requires at least one scenario', async () => {
    mockApi(
      base({
        'GET /scenarios/compare': () =>
          json(409, {
            error: {
              code: 'DIFFERENT_BASE',
              message: 'These scenarios use different base forecast runs',
            },
          }),
      }),
    );
    const a = renderApp('/scenarios/compare?ids=s1,s2');
    expect(await screen.findByRole('alert')).toHaveTextContent('different base forecast runs');
    a.unmount();
    renderApp('/scenarios/compare');
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one scenario');
  });
});
