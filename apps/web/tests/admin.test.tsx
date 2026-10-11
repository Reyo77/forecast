import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calls,
  json,
  loggedInAs,
  makeSub,
  makeUser,
  mockApi,
  PLANS,
  page,
  renderApp,
} from './utils';

afterEach(() => vi.unstubAllGlobals());

const sa = makeUser({
  id: 'sa1',
  role: 'SUPER_ADMIN',
  tenantId: null,
  name: 'Root',
  email: 'root@x.com',
});
const metrics = {
  tenantsByPlan: [
    { code: 'pro', plan: 'Pro', count: 2 },
    { code: 'free', plan: 'Free', count: 3 },
  ],
  tenantsByStatus: [{ status: 'ACTIVE', count: 5 }],
  totalTenants: 5,
  totalUsers: 12,
  mrrCents: 39800,
  trials: { started: 4, converted: 1, conversionRate: 0.25 },
  aiRequestsPerDay: [{ date: '2030-01-01', count: 3 }],
  failedJobs: {
    count: 1,
    recent: [{ id: 'j1', type: 'forecast.run', lastError: 'boom', updatedAt: '2030-01-01' }],
  },
};
const tenantRow = {
  id: 't1',
  name: 'Alpha Foods',
  slug: 'alpha',
  status: 'ACTIVE',
  createdAt: '2030-01-01T00:00:00Z',
  userCount: 3,
  plan: { code: 'pro', name: 'Pro' },
  subscriptionStatus: 'ACTIVE',
  lastActivityAt: '2030-01-05T00:00:00Z',
};
const detail = (status = 'ACTIVE') => ({
  tenant: {
    id: 't1',
    name: 'Alpha Foods',
    slug: 'alpha',
    status,
    createdAt: '2030-01-01T00:00:00Z',
  },
  users: [
    {
      id: 'u1',
      email: 'owner@alpha.com',
      name: 'Olive',
      role: 'OWNER',
      isActive: true,
      lastLoginAt: null,
    },
  ],
  invoices: [
    {
      id: 'i1',
      number: 'INV-2030-000001',
      amountCents: 19900,
      status: 'PAID',
      planName: 'Pro',
      description: 'd',
      periodStart: '2030-01-01',
      periodEnd: '2030-02-01',
      paidAt: null,
      createdAt: '2030-01-01',
    },
  ],
  subscription: makeSub({ status: 'ACTIVE', plan: PLANS[2], trialDaysLeft: null }),
  customLimits: null,
});

describe('Super Admin console', () => {
  it('lands on the platform overview with KPIs, charts (with table view) and failed jobs', async () => {
    mockApi({ ...loggedInAs(sa), 'GET /admin/metrics': () => json(200, metrics) });
    renderApp('/');
    expect(await screen.findByTestId('tile-mrr')).toHaveTextContent('$398');
    expect(screen.getByTestId('tile-conversion')).toHaveTextContent('25% (1/4)');
    expect(screen.getByTestId('tile-failed-jobs')).toHaveTextContent('1');
    expect(screen.getByText('forecast.run: boom')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'View as table' })[0]!);
    expect(within(screen.getByTestId('plan-table')).getByText('Pro')).toBeInTheDocument();
    // Super Admin has no tenant nav (no Team / Billing)
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Tenants' })).toBeInTheDocument();
  });

  it('tenant users cannot open /admin', async () => {
    mockApi({ ...loggedInAs(makeUser({ role: 'OWNER' })) });
    renderApp('/admin');
    expect(await screen.findByTestId('forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tenants' })).toBeNull();
  });

  it('lists tenants and filters via query params', async () => {
    const fetchMock = mockApi({ ...loggedInAs(sa), 'GET /admin/tenants': () => page([tenantRow]) });
    renderApp('/admin/tenants');
    expect(await screen.findByTestId('tenant-row')).toHaveTextContent('Alpha Foods');
    await userEvent.type(screen.getByLabelText('Search'), 'alp');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'SUSPENDED');
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u]) => String(u).includes('search=alp') && String(u).includes('status=SUSPENDED'),
        ),
      ).toBe(true),
    );
  });

  it('tenant detail: suspend, reset link, subscription edit, void invoice', async () => {
    const fetchMock = mockApi({
      ...loggedInAs(sa),
      'GET /admin/tenants/t1': () => json(200, detail()),
      'POST /admin/tenants/t1/suspend': () => json(200, {}),
      'POST /admin/tenants/t1/owner-reset-link': () =>
        json(201, { link: 'http://x/reset-password?token=abc', ownerEmail: 'owner@alpha.com' }),
      'PATCH /admin/tenants/t1/subscription': () => json(200, {}),
      'PATCH /admin/invoices/i1': () => json(200, {}),
    });
    renderApp('/admin/tenants/t1');
    await screen.findByRole('heading', { name: 'Alpha Foods' });
    await userEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Tenant suspended');
    await userEvent.click(screen.getByRole('button', { name: 'Owner reset link' }));
    expect(await screen.findByTestId('copy-link')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Plan'), 'enterprise');
    await userEvent.type(screen.getByLabelText('Users limit'), '250');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls(fetchMock, 'PATCH /admin/tenants/t1/subscription')).toHaveLength(1),
    );
    expect(
      JSON.parse(calls(fetchMock, 'PATCH /admin/tenants/t1/subscription')[0]![1]!.body as string),
    ).toEqual({ planCode: 'enterprise', customLimits: { users: 250 } });
    await userEvent.click(
      within(screen.getByTestId('inv-INV-2030-000001')).getByRole('button', { name: 'Void' }),
    );
    await waitFor(() => expect(calls(fetchMock, 'PATCH /admin/invoices/i1')).toHaveLength(1));
  });

  it('a suspended tenant offers Reactivate', async () => {
    mockApi({ ...loggedInAs(sa), 'GET /admin/tenants/t1': () => json(200, detail('SUSPENDED')) });
    renderApp('/admin/tenants/t1');
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
  });

  it('impersonation shows a banner, hides admin nav, and Exit restores the Super Admin', async () => {
    const owner = makeUser({ role: 'OWNER', name: 'Olive' });
    let restored = false;
    mockApi({
      'POST /auth/refresh': () =>
        json(200, { accessToken: restored ? 'sa-tok2' : 'sa-tok', user: sa }),
      'GET /health': () => json(200, {}),
      'GET /admin/tenants/t1': () => json(200, detail()),
      'POST /admin/tenants/t1/impersonate': () =>
        json(200, { accessToken: 'imp-tok', user: owner, tenantName: 'Alpha Foods' }),
      'GET /billing/subscription': () => json(200, makeSub({ status: 'ACTIVE' })),
      'GET /admin/metrics': () => json(200, metrics),
    });
    renderApp('/admin/tenants/t1');
    await userEvent.click(await screen.findByRole('button', { name: 'View as owner (read-only)' }));
    const banner = await screen.findByTestId('impersonation-banner');
    expect(banner).toHaveTextContent('Alpha Foods');
    expect(banner).toHaveTextContent('read-only');
    expect(screen.getByTestId('whoami')).toHaveTextContent('Olive (OWNER)');
    expect(screen.queryByRole('link', { name: 'Tenants' })).toBeNull();
    restored = true;
    await userEvent.click(within(banner).getByRole('button', { name: 'Exit' }));
    await waitFor(() => expect(screen.queryByTestId('impersonation-banner')).toBeNull());
    expect(screen.getByTestId('whoami')).toHaveTextContent('Root (SUPER_ADMIN)');
  });

  it('plans editor: lists, edits price and deletes with server errors surfaced', async () => {
    const fetchMock = mockApi({
      ...loggedInAs(sa),
      'GET /admin/plans': () =>
        json(200, {
          items: PLANS.map((p) => ({ ...p, subscriberCount: p.code === 'pro' ? 2 : 0 })),
        }),
      'PATCH /admin/plans/p3': () => json(200, {}),
      'DELETE /admin/plans/p3': () =>
        json(409, {
          error: {
            code: 'PLAN_IN_USE',
            message: '2 subscription(s) use this plan. Deactivate it instead.',
          },
        }),
    });
    renderApp('/admin/plans');
    const card = await screen.findByTestId('admin-plan-pro');
    expect(card).toHaveTextContent('$199');
    await userEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const price = screen.getByLabelText('Price (USD / month)');
    await userEvent.clear(price);
    await userEvent.type(price, '249');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(fetchMock, 'PATCH /admin/plans/p3')).toHaveLength(1));
    expect(
      JSON.parse(calls(fetchMock, 'PATCH /admin/plans/p3')[0]![1]!.body as string).priceCents,
    ).toBe(24900);
    await userEvent.click(
      within(await screen.findByTestId('admin-plan-pro')).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Deactivate it instead');
  });
});

describe('suspended tenant UI', () => {
  it('shows the suspended screen when the API reports TENANT_SUSPENDED', async () => {
    mockApi({
      ...loggedInAs(makeUser({ role: 'OWNER' })),
      'GET /billing/subscription': () =>
        json(403, {
          error: { code: 'TENANT_SUSPENDED', message: 'This account has been suspended' },
        }),
    });
    renderApp('/');
    expect(await screen.findByTestId('suspended')).toHaveTextContent('Account suspended');
  });
});
