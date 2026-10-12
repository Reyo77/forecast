import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lib from '../src/lib';
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

vi.mock('../src/lib', async (orig) => ({
  ...(await orig<typeof import('../src/lib')>()),
  redirectTo: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(lib.redirectTo).mockClear();
});

const invoice = {
  id: 'inv1',
  number: 'INV-2030-000001',
  amountCents: 19900,
  status: 'PAID',
  description: 'Pro plan (monthly)',
  planName: 'Pro',
  periodStart: '2030-01-01T00:00:00Z',
  periodEnd: '2030-02-01T00:00:00Z',
  paidAt: '2030-01-01T00:00:00Z',
  createdAt: '2030-01-01T00:00:00Z',
};

describe('public pricing page', () => {
  it('shows data-driven plans with prices and limits to anonymous visitors', async () => {
    mockApi({
      'POST /auth/refresh': () => json(401, {}),
      'GET /plans': () => json(200, { items: PLANS }),
    });
    renderApp('/pricing');
    expect(await screen.findByTestId('plan-pro')).toHaveTextContent('$199');
    expect(screen.getByTestId('plan-starter')).toHaveTextContent('500');
    expect(screen.getByTestId('plan-enterprise')).toHaveTextContent('Custom');
    expect(screen.getByText(/Payments are simulated/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Try|Start free/ }).length).toBeGreaterThan(0);
  });
});

describe('billing page', () => {
  function setup(
    sub = makeSub(),
    extra: Record<string, () => Promise<Response>> = {},
    me = makeUser(),
  ) {
    return mockApi({
      ...loggedInAs(me),
      'GET /billing/subscription': () => json(200, sub),
      'GET /plans': () => json(200, { items: PLANS }),
      ...extra,
    });
  }

  it('shows the trial banner, plan, usage bars and the simulated-payments notice', async () => {
    setup();
    renderApp('/billing');
    expect(await screen.findByTestId('trial-banner')).toHaveTextContent('9 days left');
    expect(screen.getByTestId('simulated-notice')).toHaveTextContent('Payments are simulated');
    expect(screen.getByTestId('usage-users')).toHaveTextContent('4 / 5 · almost full');
    expect(screen.getByTestId('usage-locations')).toHaveTextContent('3 / 3 · limit reached');
    expect(screen.getByRole('progressbar', { name: 'Users' })).toHaveAttribute(
      'aria-valuenow',
      '80',
    );
    expect(screen.getByTestId('current-plan')).toHaveTextContent('Starter');
  });

  it('choosing a plan applies it instantly and says "Payment successful" with the invoice', async () => {
    let current = makeSub();
    const fetchMock = mockApi({
      ...loggedInAs(makeUser()),
      'GET /billing/subscription': () => json(200, current),
      'GET /plans': () => json(200, { items: PLANS }),
      'POST /billing/change-plan': () => {
        current = makeSub({
          status: 'ACTIVE',
          plan: PLANS[2],
          trialEndsAt: null,
          trialDaysLeft: null,
        });
        return json(200, {
          result: 'APPLIED',
          paymentStatus: 'SUCCEEDED',
          message: 'Payment successful. You are now on Pro.',
          invoice,
          subscription: current,
        });
      },
    });
    renderApp('/billing');
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Pro' }));
    const box = await screen.findByTestId('change-result');
    expect(box).toHaveTextContent('Payment successful');
    expect(box).toHaveTextContent('INV-2030-000001');
    expect(
      JSON.parse(calls(fetchMock, 'POST /billing/change-plan')[0]![1]!.body as string),
    ).toEqual({ planCode: 'pro' });
    await waitFor(() => expect(screen.getByTestId('current-plan')).toHaveTextContent('Pro'));
    expect(screen.queryByTestId('trial-banner')).toBeNull();
  });

  it('a blocked downgrade lists what must be reduced', async () => {
    setup(makeSub({ status: 'ACTIVE', plan: PLANS[2], trialDaysLeft: null }), {
      'POST /billing/change-plan': () =>
        json(409, {
          error: {
            code: 'DOWNGRADE_BLOCKED',
            message: 'You are over the Free plan limits.',
            details: {
              overages: [{ metric: 'users', label: 'Users', limit: 2, current: 6, reduceBy: 4 }],
            },
          },
        }),
    });
    renderApp('/billing');
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Free' }));
    const err = await screen.findByTestId('change-error');
    expect(err).toHaveTextContent('over the Free plan limits');
    expect(err).toHaveTextContent('Users: you have 6, the new plan allows 2 — reduce by 4');
  });

  it('shows a scheduled downgrade and lets the owner keep the current plan', async () => {
    const fetchMock = setup(
      makeSub({ status: 'ACTIVE', plan: PLANS[2], pendingPlan: PLANS[1], trialDaysLeft: null }),
      {
        'POST /billing/change-plan': () =>
          json(200, {
            result: 'UNCHANGED',
            message: 'Scheduled change cancelled. You stay on Pro.',
            subscription: makeSub({ status: 'ACTIVE', plan: PLANS[2], trialDaysLeft: null }),
          }),
      },
    );
    renderApp('/billing');
    expect(await screen.findByTestId('pending-plan')).toHaveTextContent('move to Starter');
    await userEvent.click(screen.getByRole('button', { name: 'Keep Pro' }));
    await waitFor(() => expect(calls(fetchMock, 'POST /billing/change-plan')).toHaveLength(1));
    expect(await screen.findByTestId('change-result')).toHaveTextContent('stay on Pro');
  });

  it('cancels a paid plan', async () => {
    setup(makeSub({ status: 'ACTIVE', plan: PLANS[2], trialDaysLeft: null }), {
      'POST /billing/cancel': () =>
        json(200, {
          result: 'SCHEDULED',
          message: 'Your plan will be cancelled on 2030-02-01',
          subscription: makeSub({
            status: 'CANCELED',
            plan: PLANS[2],
            pendingPlan: PLANS[0],
            trialDaysLeft: null,
          }),
        }),
    });
    renderApp('/billing');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel plan' }));
    expect(await screen.findByTestId('change-result')).toHaveTextContent('will be cancelled');
  });

  it('an Admin can see billing but has no plan-change buttons; Planner cannot open it', async () => {
    setup(makeSub(), {}, makeUser({ role: 'ADMIN' }));
    const { unmount } = renderApp('/billing');
    await screen.findByTestId('current-plan');
    expect(screen.queryByRole('button', { name: /^Choose/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel plan' })).toBeNull();
    unmount();
    vi.unstubAllGlobals();
    setup(makeSub(), {}, makeUser({ role: 'PLANNER' }));
    renderApp('/billing');
    expect(await screen.findByTestId('forbidden')).toBeInTheDocument();
  });

  it('global trial banner appears for Owner/Admin on any page', async () => {
    setup();
    renderApp('/');
    expect(await screen.findByTestId('trial-banner-global')).toHaveTextContent(
      'Starter trial: 9 days left',
    );
  });
});

describe('invoices', () => {
  it('lists invoices and shows a printable invoice with a simulated-payment note', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    mockApi({
      ...loggedInAs(),
      'GET /billing/invoices': () => page([invoice]),
      'GET /billing/invoices/inv1': () => json(200, { invoice, billedTo: 'Acme Co' }),
      'GET /billing/subscription': () => json(200, makeSub({ status: 'ACTIVE' })),
    });
    renderApp('/billing/invoices');
    const row = await screen.findByTestId('invoice-row');
    expect(row).toHaveTextContent('$199');
    await userEvent.click(within(row).getByRole('link', { name: 'INV-2030-000001' }));
    const doc = await screen.findByTestId('invoice');
    expect(doc).toHaveTextContent('Billed to: Acme Co');
    expect(doc).toHaveTextContent('Payment simulated');
    await userEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
  });

  it('empty state', async () => {
    mockApi({
      ...loggedInAs(),
      'GET /billing/invoices': () => page([]),
      'GET /billing/subscription': () => json(200, makeSub()),
    });
    renderApp('/billing/invoices');
    expect(await screen.findByText(/No invoices yet/)).toBeInTheDocument();
  });
});

describe('billing page with a real payment provider', () => {
  const liveSub = (over: Record<string, unknown> = {}) =>
    makeSub({ simulatedPayments: false, ...over });
  const setupLive = (subs: unknown[], extra: Record<string, () => Promise<Response>> = {}) => {
    let i = 0;
    return mockApi({
      ...loggedInAs(makeUser()),
      'GET /billing/subscription': () => json(200, subs[Math.min(i++, subs.length - 1)]),
      'GET /plans': () => json(200, { items: PLANS }),
      ...extra,
    });
  };

  it('shows the secure-checkout note instead of the simulated notice', async () => {
    setupLive([liveSub()]);
    renderApp('/billing');
    expect(await screen.findByTestId('secure-notice')).toHaveTextContent('secure hosted checkout');
    expect(screen.queryByTestId('simulated-notice')).not.toBeInTheDocument();
  });

  it('sends the browser to the checkout url when a purchase needs payment', async () => {
    const fn = setupLive([liveSub()], {
      'POST /billing/change-plan': () =>
        json(200, {
          result: 'CHECKOUT_REQUIRED',
          checkoutUrl: 'https://checkout.stripe.com/c/cs_1',
          message: 'Continue to secure checkout for the Pro plan.',
          subscription: liveSub(),
        }),
    });
    renderApp('/billing');
    await userEvent.click(await within(await screen.findByTestId('plan-pro')).findByRole('button'));
    await waitFor(() =>
      expect(lib.redirectTo).toHaveBeenCalledWith('https://checkout.stripe.com/c/cs_1'),
    );
    expect(calls(fn, 'POST /billing/change-plan')).toHaveLength(1);
    expect(screen.queryByTestId('change-result')).not.toBeInTheDocument();
  });

  it('after returning from checkout it confirms once the webhook has activated the plan', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setupLive([
      liveSub(),
      liveSub(),
      liveSub({ status: 'ACTIVE', plan: PLANS[2], trialDaysLeft: null }),
    ]);
    renderApp('/billing?checkout=success');
    expect(await screen.findByTestId('checkout-return')).toHaveTextContent(
      'confirming your payment',
    );
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2100);
    await waitFor(() =>
      expect(screen.getByTestId('checkout-return')).toHaveTextContent(
        'Payment successful. You are now on Pro',
      ),
    );
  });

  it('shows a cancelled notice when the user backs out of checkout', async () => {
    setupLive([liveSub()]);
    renderApp('/billing?checkout=cancelled');
    expect(await screen.findByTestId('checkout-cancelled')).toHaveTextContent(
      'No payment was made',
    );
  });
});
