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
