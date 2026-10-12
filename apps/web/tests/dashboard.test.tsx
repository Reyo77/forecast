import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeSub, makeUser, mockApi, page, renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

const usage = [
  { metric: 'users', limit: 5, current: 4 },
  { metric: 'skus', limit: 500, current: 12 },
  { metric: 'locations', limit: 3, current: 2 },
  { metric: 'scenarios', limit: 20, current: 1 },
  { metric: 'forecastRuns', limit: 100, current: 3 },
  { metric: 'aiRequests', limit: 300, current: 0 },
];
const dash = (o: Record<string, unknown> = {}) => ({
  counts: { products: 12, locations: 2, suppliers: 3, lateOrders: 1 },
  sales: { records: 3744, from: '2023-06-05', to: '2026-06-01' },
  accuracy: {
    runId: 'r1',
    date: '2026-06-02',
    wape: 0.123,
    seriesCount: 16,
    backtested: 14,
    models: [
      { model: 'holt_winters', count: 10 },
      { model: 'croston', count: 4 },
    ],
  },
  upcomingStockouts: [
    {
      sku: 'GFT-BOX',
      location: 'WH-EAST',
      firstStockoutDate: '2026-07-06',
      shortage: 40.5,
      revenueAtRiskCents: 150000,
    },
  ],
  latestRuns: [
    {
      id: 'r1',
      status: 'DONE',
      createdAt: '2026-06-02T00:00:00Z',
      horizonWeeks: 26,
      seriesDone: 16,
      seriesTotal: 16,
    },
  ],
  usage,
  ...o,
});
const base = (extra: Record<string, () => Promise<Response> | Response> = {}, me = makeUser()) => ({
  ...loggedInAs(me),
  'GET /billing/subscription': () => json(200, makeSub({ status: 'ACTIVE' })),
  'GET /demo-data/status': () => json(200, { hasSalesData: true, canLoad: false }),
  'GET /notifications': () =>
    json(200, { items: [], total: 0, page: 1, pageSize: 10, unreadCount: 0 }),
  ...extra,
});

describe('dashboard', () => {
  it('shows accuracy, upcoming stockouts, latest runs, usage vs plan and data counts', async () => {
    mockApi(base({ 'GET /dashboard': () => json(200, dash()) }));
    renderApp('/');
    expect(await screen.findByTestId('wape')).toHaveTextContent('87.7%');
    const acc = screen.getByTestId('card-accuracy');
    expect(acc).toHaveTextContent('14 of 16 series backtested');
    expect(acc).toHaveTextContent('Holt-Winters (seasonal): 10');
    expect(screen.getByTestId('stockout-GFT-BOX')).toHaveTextContent('2026-07-06');
    expect(screen.getByTestId('stockout-GFT-BOX')).toHaveTextContent('$1,500');
    expect(screen.getByTestId('card-runs')).toHaveTextContent('DONE · 16/16 series · 26 wk');
    expect(screen.getByTestId('dash-usage-users')).toHaveTextContent('4 / 5');
    expect(
      within(screen.getByTestId('card-usage')).getByRole('progressbar', { name: 'Users' }),
    ).toHaveAttribute('aria-valuenow', '80');
    expect(screen.getByTestId('card-data')).toHaveTextContent(
      '12 active products · 2 locations · 3 suppliers',
    );
    expect(screen.getByTestId('late-orders')).toHaveTextContent('1 open order(s) are late');
    expect(screen.queryByTestId('getting-started')).toBeNull();
  });

  it('shows a getting-started guide for an empty account and friendly placeholders', async () => {
    mockApi(
      base({
        'GET /dashboard': () =>
          json(
            200,
            dash({
              sales: { records: 0, from: null, to: null },
              accuracy: null,
              upcomingStockouts: null,
              latestRuns: [],
              counts: { products: 0, locations: 0, suppliers: 0, lateOrders: 0 },
            }),
          ),
      }),
    );
    renderApp('/');
    expect(await screen.findByTestId('getting-started')).toHaveTextContent(
      'Import your sales history',
    );
    expect(screen.queryByTestId('card-accuracy')).toBeNull();
  });

  it('handles no forecast yet / no stockouts', async () => {
    mockApi(
      base({ 'GET /dashboard': () => json(200, dash({ accuracy: null, upcomingStockouts: [] })) }),
    );
    renderApp('/');
    expect(await screen.findByText(/No finished forecast yet/)).toBeInTheDocument();
    expect(screen.getByText('No stockouts projected.')).toBeInTheDocument();
  });

  it('shows an error if the dashboard cannot load; Super Admin is sent to /admin', async () => {
    mockApi(
      base({
        'GET /dashboard': () => json(500, { error: { code: 'X', message: 'Dashboard exploded' } }),
      }),
    );
    const a = renderApp('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Dashboard exploded');
    a.unmount();
    vi.unstubAllGlobals();
    mockApi({
      ...base({}, makeUser({ role: 'SUPER_ADMIN', tenantId: null })),
      'GET /admin/metrics': () =>
        json(200, {
          tenantsByPlan: [],
          tenantsByStatus: [],
          totalTenants: 0,
          totalUsers: 0,
          mrrCents: 0,
          trials: { started: 0, converted: 0, conversionRate: 0 },
          aiRequestsPerDay: [],
          failedJobs: { count: 0, recent: [] },
        }),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Platform overview' })).toBeInTheDocument();
  });
});

describe('notification bell', () => {
  const items = [
    {
      id: 'n1',
      type: 'forecast.done',
      title: 'Forecast run finished',
      body: '16 series forecast.',
      readAt: null,
      createdAt: '2026-06-02T00:00:00Z',
    },
    {
      id: 'n2',
      type: 'billing.plan_changed',
      title: 'You are now on Pro',
      body: 'Payment successful (simulated).',
      readAt: '2026-06-01T00:00:00Z',
      createdAt: '2026-06-01T00:00:00Z',
    },
  ];
  it('shows the unread count, lists notifications and marks one read', async () => {
    let read = false;
    const fetchMock = mockApi(
      base({
        'GET /dashboard': () => json(200, dash()),
        'GET /notifications': () =>
          json(200, {
            items: items.map((n) => (n.id === 'n1' && read ? { ...n, readAt: 'x' } : n)),
            total: 2,
            page: 1,
            pageSize: 10,
            unreadCount: read ? 0 : 1,
          }),
        'POST /notifications/n1/read': () => {
          read = true;
          return json(200, { ok: true });
        },
      }),
    );
    renderApp('/');
    expect(await screen.findByTestId('unread-badge')).toHaveTextContent('1');
    await userEvent.click(screen.getByRole('button', { name: /Notifications, 1 unread/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(dialog).getByTestId('notification-n1')).toHaveTextContent(
      'Forecast run finished',
    );
    await userEvent.click(within(dialog).getByText('Forecast run finished'));
    await waitFor(() => expect(calls(fetchMock, 'POST /notifications/n1/read')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('unread-badge')).toBeNull());
  });

  it('mark all read, and the empty state', async () => {
    const fetchMock = mockApi(
      base({
        'GET /dashboard': () => json(200, dash()),
        'GET /notifications': () =>
          json(200, { items, total: 2, page: 1, pageSize: 10, unreadCount: 3 }),
        'POST /notifications/read-all': () => json(200, { updated: 1 }),
      }),
    );
    const a = renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: /Notifications, 3 unread/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(calls(fetchMock, 'POST /notifications/read-all')).toHaveLength(1));
    a.unmount();
    vi.unstubAllGlobals();
    mockApi(base({ 'GET /dashboard': () => json(200, dash()) }));
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: /Notifications, 0 unread/ }));
    expect(await screen.findByTestId('no-notifications')).toBeInTheDocument();
    expect(screen.queryByTestId('unread-badge')).toBeNull();
  });

  it('every tenant role gets the bell; Super Admin does not', async () => {
    mockApi(base({ 'GET /dashboard': () => json(200, dash()) }, makeUser({ role: 'VIEWER' })));
    renderApp('/');
    expect(await screen.findByRole('button', { name: /Notifications/ })).toBeInTheDocument();
  });
});

describe('delete company (Owner only)', () => {
  const members = [
    {
      id: 'u1',
      email: 'owner@acme.com',
      name: 'Olive',
      role: 'OWNER',
      isActive: true,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];
  const teamBase = (
    extra: Record<string, () => Promise<Response> | Response> = {},
    me = makeUser(),
  ) =>
    mockApi(
      base({ 'GET /users': () => page(members), 'GET /invites': () => page([]), ...extra }, me),
    );

  it('requires a password confirmation, then signs out', async () => {
    const fetchMock = teamBase({
      'DELETE /tenant': () => json(204),
      'POST /auth/logout': () => json(204),
    });
    renderApp('/team');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete this company…' }));
    const zone = screen.getByRole('region', { name: 'Danger zone' });
    await userEvent.type(within(zone).getByLabelText('Your password'), 'Password123');
    await userEvent.click(within(zone).getByRole('button', { name: 'Permanently delete company' }));
    await waitFor(() => expect(calls(fetchMock, 'DELETE /tenant')).toHaveLength(1));
    expect(JSON.parse(calls(fetchMock, 'DELETE /tenant')[0]![1]!.body as string)).toEqual({
      password: 'Password123',
    });
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
  });

  it('shows a wrong-password error and is absent for Admins', async () => {
    teamBase({
      'DELETE /tenant': () =>
        json(400, { error: { code: 'INVALID_PASSWORD', message: 'Password is incorrect' } }),
    });
    const a = renderApp('/team');
    await userEvent.click(await screen.findByRole('button', { name: 'Delete this company…' }));
    const zone = screen.getByRole('region', { name: 'Danger zone' });
    await userEvent.type(within(zone).getByLabelText('Your password'), 'nope');
    await userEvent.click(within(zone).getByRole('button', { name: 'Permanently delete company' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Password is incorrect');
    a.unmount();
    vi.unstubAllGlobals();
    teamBase({}, makeUser({ role: 'ADMIN', id: 'u9' }));
    renderApp('/team');
    await screen.findByRole('heading', { name: 'Team' });
    expect(screen.queryByRole('region', { name: 'Danger zone' })).toBeNull();
  });
});
