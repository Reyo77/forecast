import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeSub, makeUser, mockApi, page, renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

const explainOut = {
  explanation: 'Demand is trending up and follows a yearly pattern.',
  drivers: ['Upward trend', 'Seasonality'],
  confidence: 'MEDIUM',
  caveats: ['Only 12 weeks backtested'],
};
const riskOut = {
  summary: 'Fill rate falls to 81% and revenue is exposed.',
  severity: 'HIGH',
  actions: ['Expedite open orders', 'Raise safety stock', 'Add a backup supplier'],
};

const base = (
  extra: Record<string, (b: unknown, u: string) => Promise<Response> | Response> = {},
  me = makeUser(),
) => ({
  ...loggedInAs(me),
  'GET /billing/subscription': () => json(200, makeSub({ status: 'ACTIVE' })),
  'GET /demo-data/status': () => json(200, { hasSalesData: true, canLoad: false }),
  ...extra,
});

const run = {
  id: 'r1',
  status: 'DONE',
  horizonWeeks: 26,
  method: 'AUTO',
  filters: {},
  progress: 100,
  seriesTotal: 2,
  seriesDone: 2,
  seriesFailed: 0,
  failures: null,
  asOfWeek: '2025-06-02',
  startedAt: null,
  finishedAt: null,
  error: null,
  createdAt: '2025-06-03T00:00:00Z',
};
const series = (o = {}) => ({
  product: { id: 'p-A', sku: 'A', name: 'Name A' },
  location: { id: 'l1', code: 'EAST' },
  modelUsed: 'holt',
  accuracy: null,
  history: [],
  forecast: [
    { weekStart: '2025-06-09', quantity: 10, lower: 8, upper: 12, override: null, final: 10 },
  ],
  ...o,
});
const acc = (sku: string) => ({
  productId: `p-${sku}`,
  productSku: sku,
  productName: sku,
  locationId: 'l1',
  locationCode: 'EAST',
  modelUsed: 'holt',
  reason: 'backtest',
  mape: 0.1,
  wape: 0.1,
  bias: 0,
});

describe('explain this forecast', () => {
  const setup = (
    extra: Record<string, (b: unknown, u: string) => Promise<Response> | Response> = {},
    me = makeUser(),
  ) =>
    mockApi(
      base(
        {
          'GET /forecasts/runs/r1': () => json(200, { run }),
          'GET /forecasts/runs/r1/accuracy': () => page([acc('A'), acc('B')]),
          'GET /forecasts/runs/r1/series': () => json(200, series()),
          'GET /forecasts/overrides': () => page([]),
          'GET /locations': () => page([{ id: 'l1', code: 'EAST', name: 'E', type: 'WAREHOUSE' }]),
          ...extra,
        },
        me,
      ),
    );

  it('shows the explanation, drivers, confidence and caveats; repeated clicks say it is saved', async () => {
    let n = 0;
    const fetchMock = setup({
      'POST /ai/explain-forecast': () => json(200, { result: explainOut, cached: n++ > 0 }),
    });
    renderApp('/forecasts/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'Explain this forecast' }));
    const card = await screen.findByTestId('explanation');
    expect(card).toHaveTextContent('Demand is trending up');
    expect(within(card).getByTestId('confidence')).toHaveTextContent('Confidence: MEDIUM');
    expect(card).toHaveTextContent('Upward trend');
    expect(card).toHaveTextContent('Only 12 weeks backtested');
    expect(within(card).queryByTestId('cached')).toBeNull();
    expect(
      JSON.parse(calls(fetchMock, 'POST /ai/explain-forecast')[0]![1]!.body as string),
    ).toEqual({ runId: 'r1', productId: 'p-A', locationId: 'l1' });
    await userEvent.click(screen.getByRole('button', { name: 'Explain this forecast' }));
    await waitFor(() => expect(screen.getByTestId('cached')).toHaveTextContent('no quota used'));
  });

  it('hides a stale explanation when another product is selected', async () => {
    setup({ 'POST /ai/explain-forecast': () => json(200, { result: explainOut, cached: false }) });
    renderApp('/forecasts/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'Explain this forecast' }));
    await screen.findByTestId('explanation');
    await userEvent.click(screen.getByTestId('acc-B-EAST'));
    await waitFor(() => expect(screen.queryByTestId('explanation')).toBeNull());
  });

  it('shows plan-limit and AI-unavailable errors', async () => {
    let n = 0;
    setup({
      'POST /ai/explain-forecast': () =>
        ++n === 1
          ? json(402, {
              error: {
                code: 'PLAN_LIMIT_REACHED',
                message: 'Your plan allows 20 AI requests. Upgrade your plan to continue.',
              },
            })
          : json(504, {
              error: {
                code: 'AI_TIMEOUT',
                message: 'The AI service took too long to answer. Please try again.',
              },
            }),
    });
    renderApp('/forecasts/r1');
    await userEvent.click(await screen.findByRole('button', { name: 'Explain this forecast' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upgrade your plan');
    await userEvent.click(screen.getByRole('button', { name: 'Explain this forecast' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('took too long'));
  });

  it('Viewers cannot use AI features (no button, no assistant)', async () => {
    setup({}, makeUser({ role: 'VIEWER' }));
    renderApp('/forecasts/r1');
    await screen.findByTestId('series-summary');
    expect(screen.queryByRole('button', { name: 'Explain this forecast' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });
});

describe('scenario risk summary', () => {
  const doneRun = {
    id: 'run1',
    scenarioId: 's1',
    status: 'DONE',
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2025-06-03T00:00:00Z',
    levers: [],
    kpis: {
      baseline: {
        stockoutWeeks: 1,
        fillRate: 0.98,
        avgInventoryValueCents: 1,
        revenueAtRiskCents: 1,
        plannedOrders: 1,
        totalDemand: 1,
        totalShortage: 1,
      },
      scenario: {
        stockoutWeeks: 5,
        fillRate: 0.81,
        avgInventoryValueCents: 1,
        revenueAtRiskCents: 2,
        plannedOrders: 1,
        totalDemand: 1,
        totalShortage: 2,
      },
    },
    atRisk: { baseline: [], scenario: [] },
    totals: { baseline: [], scenario: [] },
  };
  it('Summarise risks shows the executive summary, severity and 3–5 actions', async () => {
    const fetchMock = mockApi(
      base({
        'GET /scenarios/s1': () =>
          json(200, {
            scenario: {
              id: 's1',
              name: 'S',
              description: null,
              baseForecastRunId: 'r1',
              status: 'READY',
              createdAt: '',
              updatedAt: '',
              leverCount: 0,
              latestKpis: null,
            },
            levers: [],
            latestRun: doneRun,
          }),
        'POST /ai/risk-summary': () => json(200, { result: riskOut, cached: false }),
      }),
    );
    renderApp('/scenarios/s1');
    await userEvent.click(await screen.findByRole('button', { name: 'Summarise risks' }));
    const card = await screen.findByTestId('risk-summary');
    expect(card).toHaveTextContent('Fill rate falls to 81%');
    expect(within(card).getByTestId('severity')).toHaveTextContent('Risk: HIGH');
    expect(within(card).getAllByRole('listitem')).toHaveLength(3);
    expect(JSON.parse(calls(fetchMock, 'POST /ai/risk-summary')[0]![1]!.body as string)).toEqual({
      scenarioRunId: 'run1',
    });
  });
});

describe('natural-language scenario builder', () => {
  const proposal = {
    interpretation: 'Supplier is late and snack demand rises.',
    baseForecastRunId: 'r1',
    levers: [
      {
        lever: {
          type: 'SUPPLIER_DELAY',
          target: { supplierId: 'sup1' },
          params: { extraDays: 21 },
        },
        summary: 'Supplier delay: Acme Supplies is 21 days late',
      },
      {
        lever: {
          type: 'DEMAND_CHANGE',
          target: { scope: 'CATEGORY', id: 'c1' },
          params: { percent: 15 },
        },
        summary: 'Demand change: Demand +15% for category Snacks',
      },
    ],
    unresolved: ['supplier "Globex" was not found in your data'],
  };
  const setup = (
    extra: Record<string, (b: unknown, u: string) => Promise<Response> | Response> = {},
  ) =>
    mockApi(
      base({
        'GET /scenarios': () => page([]),
        'GET /forecasts/runs': () => page([run]),
        'POST /ai/scenario-from-text': () => json(200, proposal),
        'POST /scenarios': () =>
          json(201, {
            scenario: {
              id: 'new1',
              name: 'x',
              description: null,
              baseForecastRunId: 'r1',
              status: 'DRAFT',
              createdAt: '',
              updatedAt: '',
              leverCount: 0,
              latestKpis: null,
            },
          }),
        'POST /scenarios/new1/levers': () => json(201, { lever: {} }),
        'GET /scenarios/new1': () =>
          json(200, {
            scenario: {
              id: 'new1',
              name: 'Builder',
              description: null,
              baseForecastRunId: 'r1',
              status: 'DRAFT',
              createdAt: '',
              updatedAt: '',
              leverCount: 2,
              latestKpis: null,
            },
            levers: [],
            latestRun: null,
          }),
        ...extra,
      }),
    );

  it('proposes levers for review, flags unmatched names, and saves nothing until confirmed', async () => {
    const fetchMock = setup();
    renderApp('/scenarios');
    const box = await screen.findByRole('region', { name: 'Describe a scenario' });
    await userEvent.type(
      within(box).getByLabelText(/What if/),
      'Acme Supplies is 3 weeks late and Globex too',
    );
    await userEvent.click(within(box).getByRole('button', { name: 'Propose levers' }));
    const prop = await screen.findByTestId('proposal');
    expect(within(prop).getAllByTestId('proposed-lever')).toHaveLength(2);
    expect(within(prop).getByTestId('unresolved')).toHaveTextContent('Globex');
    expect(within(prop).getByText('Nothing is saved until you confirm.')).toBeInTheDocument();
    expect(calls(fetchMock, 'POST /scenarios')).toHaveLength(0);
    expect(calls(fetchMock, 'POST /scenarios/new1/levers')).toHaveLength(0);
  });

  it('lets the planner edit a value and discard a lever, then confirm creates the scenario and its levers', async () => {
    const fetchMock = setup();
    renderApp('/scenarios');
    const box = await screen.findByRole('region', { name: 'Describe a scenario' });
    await userEvent.type(within(box).getByLabelText(/What if/), 'Acme Supplies is 3 weeks late');
    await userEvent.click(within(box).getByRole('button', { name: 'Propose levers' }));
    const days = await screen.findByLabelText(
      'Days late for Supplier delay: Acme Supplies is 21 days late',
    );
    await userEvent.clear(days);
    await userEvent.type(days, '28');
    await userEvent.click(screen.getByRole('button', { name: /Discard Demand change/ }));
    const name = screen.getByLabelText('Scenario name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Builder');
    await userEvent.click(
      screen.getByRole('button', { name: 'Confirm and create scenario (1 lever)' }),
    );
    expect(await screen.findByRole('heading', { name: 'Builder' })).toBeInTheDocument();
    expect(JSON.parse(calls(fetchMock, 'POST /scenarios')[0]![1]!.body as string)).toEqual({
      name: 'Builder',
      baseForecastRunId: 'r1',
    });
    const levers = calls(fetchMock, 'POST /scenarios/new1/levers');
    expect(levers).toHaveLength(1);
    expect(JSON.parse(levers[0]![1]!.body as string)).toEqual({
      type: 'SUPPLIER_DELAY',
      target: { supplierId: 'sup1' },
      params: { extraDays: 28 },
    });
  });

  it('service level is edited as a percentage and sent as a fraction', async () => {
    const fetchMock = setup({
      'POST /ai/scenario-from-text': () =>
        json(200, {
          ...proposal,
          levers: [
            {
              lever: { type: 'SERVICE_LEVEL', target: {}, params: { serviceLevel: 0.97 } },
              summary: 'Service level: Target service level 97.0%',
            },
          ],
          unresolved: [],
        }),
    });
    renderApp('/scenarios');
    const box = await screen.findByRole('region', { name: 'Describe a scenario' });
    await userEvent.type(within(box).getByLabelText(/What if/), 'raise service level');
    await userEvent.click(within(box).getByRole('button', { name: 'Propose levers' }));
    const input = await screen.findByLabelText(/Service level % for/);
    expect(input).toHaveValue(97);
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    await userEvent.click(screen.getByRole('button', { name: /Confirm and create scenario/ }));
    await waitFor(() => expect(calls(fetchMock, 'POST /scenarios/new1/levers')).toHaveLength(1));
    expect(
      JSON.parse(calls(fetchMock, 'POST /scenarios/new1/levers')[0]![1]!.body as string).params
        .serviceLevel,
    ).toBeCloseTo(0.99, 6);
  });

  it('says so when nothing could be built, shows AI errors, and can be dismissed', async () => {
    setup({
      'POST /ai/scenario-from-text': () =>
        json(200, {
          interpretation: '',
          baseForecastRunId: 'r1',
          levers: [],
          unresolved: ['the moon'],
        }),
    });
    const a = renderApp('/scenarios');
    const box = await screen.findByRole('region', { name: 'Describe a scenario' });
    await userEvent.type(within(box).getByLabelText(/What if/), 'something odd');
    await userEvent.click(within(box).getByRole('button', { name: 'Propose levers' }));
    expect(
      await screen.findByText('No levers could be built from that sentence.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm and create/ })).toBeNull();
    a.unmount();
    vi.unstubAllGlobals();
    setup({
      'POST /ai/scenario-from-text': () =>
        json(502, {
          error: {
            code: 'AI_INVALID_RESPONSE',
            message: 'The AI returned an answer in an unexpected format. Please try again.',
          },
        }),
    });
    renderApp('/scenarios');
    const box2 = await screen.findByRole('region', { name: 'Describe a scenario' });
    await userEvent.type(within(box2).getByLabelText(/What if/), 'something odd');
    await userEvent.click(within(box2).getByRole('button', { name: 'Propose levers' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected format');
  });

  it('is hidden for Viewers and when no forecast has finished', async () => {
    mockApi(
      base(
        { 'GET /scenarios': () => page([]), 'GET /forecasts/runs': () => page([run]) },
        makeUser({ role: 'VIEWER' }),
      ),
    );
    const a = renderApp('/scenarios');
    await screen.findByTestId('no-scenarios');
    expect(screen.queryByRole('region', { name: 'Describe a scenario' })).toBeNull();
    a.unmount();
    vi.unstubAllGlobals();
    mockApi(base({ 'GET /scenarios': () => page([]), 'GET /forecasts/runs': () => page([]) }));
    renderApp('/scenarios');
    await screen.findByTestId('needs-forecast');
    expect(screen.queryByRole('region', { name: 'Describe a scenario' })).toBeNull();
  });
});

describe('assistant panel', () => {
  it('opens from the header, answers questions with the lookups used, and sends conversation history', async () => {
    const fetchMock = mockApi(
      base({
        'POST /ai/assistant': (b) =>
          json(
            200,
            (b as { question: string }).question.includes('accuracy')
              ? {
                  answer: 'SKU-9 has the worst accuracy (55% WAPE).',
                  toolCalls: [{ name: 'getWorstAccuracy', args: { limit: 5 }, ok: true }],
                }
              : { answer: 'Its model is naive.', toolCalls: [] },
          ),
      }),
    );
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('complementary', { name: 'AI assistant' });
    await userEvent.type(
      within(panel).getByLabelText('Your question'),
      'Which products have the worst forecast accuracy?',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Ask' }));
    expect(
      await within(panel).findByText('SKU-9 has the worst accuracy (55% WAPE).'),
    ).toBeInTheDocument();
    expect(within(panel).getByTestId('tools-used')).toHaveTextContent(
      'Looked up: getWorstAccuracy',
    );
    await userEvent.type(within(panel).getByLabelText('Your question'), 'And its model?');
    await userEvent.click(within(panel).getByRole('button', { name: 'Ask' }));
    expect(await within(panel).findByText('Its model is naive.')).toBeInTheDocument();
    const second = JSON.parse(calls(fetchMock, 'POST /ai/assistant')[1]![1]!.body as string);
    expect(second.history).toEqual([
      { role: 'user', text: 'Which products have the worst forecast accuracy?' },
      { role: 'assistant', text: 'SKU-9 has the worst accuracy (55% WAPE).' },
    ]);
    await userEvent.click(within(panel).getByRole('button', { name: 'Close assistant' }));
    expect(screen.queryByRole('complementary', { name: 'AI assistant' })).toBeNull();
  });

  it('shows quota and service errors inside the conversation', async () => {
    mockApi(
      base({
        'POST /ai/assistant': () =>
          json(402, {
            error: {
              code: 'PLAN_LIMIT_REACHED',
              message: 'Your plan allows 20 AI requests. Upgrade your plan to continue.',
            },
          }),
      }),
    );
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('complementary', { name: 'AI assistant' });
    await userEvent.type(within(panel).getByLabelText('Your question'), 'How are sales?');
    await userEvent.click(within(panel).getByRole('button', { name: 'Ask' }));
    expect(await within(panel).findByText(/Upgrade your plan/)).toBeInTheDocument();
  });

  it('ignores questions that are too short; hidden for Viewers and while impersonating', async () => {
    const fetchMock = mockApi(
      base({ 'POST /ai/assistant': () => json(200, { answer: 'x', toolCalls: [] }) }),
    );
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
    const panel = screen.getByRole('complementary', { name: 'AI assistant' });
    await userEvent.type(within(panel).getByLabelText('Your question'), 'hi');
    await userEvent.click(within(panel).getByRole('button', { name: 'Ask' }));
    expect(calls(fetchMock, 'POST /ai/assistant')).toHaveLength(0);
  });
});
