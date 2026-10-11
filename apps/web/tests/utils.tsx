import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../src/App';
import { tokenStore } from '../src/api/client';

export const json = (status: number, body?: unknown) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

export const makeUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'owner@acme.com',
  name: 'Olive Owner',
  role: 'OWNER',
  tenantId: 't1',
  ...over,
});

type Handler = (body: unknown, url: string) => Promise<Response> | Response;

/** Routes keyed as "METHOD /path" (path without /api and without query). Unmatched calls 404. */
export function mockApi(routes: Record<string, Handler>) {
  tokenStore.set(null);
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const path = url.replace('/api', '').split('?')[0];
    const key = `${init?.method ?? 'GET'} ${path}`;
    const h = routes[key];
    if (!h) return json(404, { error: { code: 'NOT_FOUND', message: `no mock for ${key}` } });
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return Promise.resolve(h(body, url));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const calls = (fn: ReturnType<typeof vi.fn>, key: string) =>
  fn.mock.calls.filter(
    ([u, i]) =>
      `${(i as RequestInit | undefined)?.method ?? 'GET'} ${String(u).replace('/api', '').split('?')[0]}` ===
      key,
  );

export function renderApp(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const loggedInAs = (user = makeUser()) => ({
  'POST /auth/refresh': () => json(200, { accessToken: 'tok', user }),
  'GET /health': () => json(200, {}),
});

export const page = (items: unknown[]) =>
  json(200, { items, total: items.length, page: 1, pageSize: 100 });

export const PLANS = [
  {
    id: 'p1',
    code: 'free',
    name: 'Free',
    priceCents: 0,
    isActive: true,
    isPublic: true,
    isCustom: false,
    sortOrder: 1,
    limits: {
      users: 2,
      skus: 50,
      locations: 1,
      scenarios: 3,
      forecastRuns: 10,
      aiRequests: 20,
      historyMonths: 12,
    },
  },
  {
    id: 'p2',
    code: 'starter',
    name: 'Starter',
    priceCents: 4900,
    isActive: true,
    isPublic: true,
    isCustom: false,
    sortOrder: 2,
    limits: {
      users: 5,
      skus: 500,
      locations: 3,
      scenarios: 20,
      forecastRuns: 100,
      aiRequests: 300,
      historyMonths: 36,
    },
  },
  {
    id: 'p3',
    code: 'pro',
    name: 'Pro',
    priceCents: 19900,
    isActive: true,
    isPublic: true,
    isCustom: false,
    sortOrder: 3,
    limits: {
      users: 20,
      skus: 5000,
      locations: 10,
      scenarios: 100,
      forecastRuns: 1000,
      aiRequests: 2000,
      historyMonths: 60,
    },
  },
  {
    id: 'p4',
    code: 'enterprise',
    name: 'Enterprise',
    priceCents: 0,
    isActive: true,
    isPublic: true,
    isCustom: true,
    sortOrder: 4,
    limits: {
      users: 100,
      skus: 100000,
      locations: 100,
      scenarios: 1000,
      forecastRuns: 10000,
      aiRequests: 20000,
      historyMonths: 120,
    },
  },
];

export const makeSub = (over: Record<string, unknown> = {}) => ({
  status: 'TRIALING',
  plan: PLANS[1],
  trialEndsAt: '2030-01-15T00:00:00Z',
  trialDaysLeft: 9,
  periodStart: '2030-01-01T00:00:00Z',
  periodEnd: '2030-01-15T00:00:00Z',
  pendingPlan: null,
  limits: PLANS[1]!.limits,
  usage: [
    { metric: 'users', limit: 5, current: 4 },
    { metric: 'skus', limit: 500, current: 10 },
    { metric: 'locations', limit: 3, current: 3 },
    { metric: 'scenarios', limit: 20, current: 0 },
    { metric: 'forecastRuns', limit: 100, current: 0 },
    { metric: 'aiRequests', limit: 300, current: 0 },
  ],
  simulatedPayments: true,
  ...over,
});
