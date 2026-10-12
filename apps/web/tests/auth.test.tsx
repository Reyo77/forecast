import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../src/App';
import { tokenStore } from '../src/api/client';

const user = { id: 'u1', email: 'a@b.com', name: 'Ada', role: 'OWNER', tenantId: 't1' };
const json = (status: number, body?: unknown) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

function mockFetch(routes: Record<string, (body: unknown) => Promise<Response>>) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('/api', '')}`;
    const handler = routes[key];
    if (!handler) return json(404, { error: { code: 'NOT_FOUND', message: `no mock ${key}` } });
    return handler(init?.body ? JSON.parse(init.body as string) : undefined);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('auth UI', () => {
  beforeEach(() => tokenStore.set(null));
  afterEach(() => vi.unstubAllGlobals());

  it('redirects anonymous visitors to the login page', async () => {
    mockFetch({ 'POST /auth/refresh': () => json(401, { error: { code: 'X', message: 'no' } }) });
    renderAt('/products');
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
  });

  it('shows the marketing landing page to anonymous visitors at the root', async () => {
    mockFetch({ 'POST /auth/refresh': () => json(401, { error: { code: 'X', message: 'no' } }) });
    renderAt('/');
    expect(await screen.findByTestId('landing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start your free trial' })).toHaveAttribute(
      'href',
      '/signup',
    );
    expect(screen.getAllByRole('link', { name: 'Log in' })[0]).toHaveAttribute('href', '/login');
  });

  it('unknown URLs show the 404 page', async () => {
    mockFetch({ 'POST /auth/refresh': () => json(401, { error: { code: 'X', message: 'no' } }) });
    renderAt('/no/such/page');
    expect(await screen.findByTestId('not-found')).toBeInTheDocument();
  });

  it('restores a session from the refresh cookie and shows the home page', async () => {
    mockFetch({
      'POST /auth/refresh': () => json(200, { accessToken: 'tok', user }),
      'GET /health': () => json(200, { status: 'ok' }),
    });
    renderAt('/');
    expect(await screen.findByTestId('whoami')).toHaveTextContent('Ada (OWNER)');
  });

  it('shows validation errors on signup without calling the API', async () => {
    const fetchMock = mockFetch({ 'POST /auth/refresh': () => json(401, {}) });
    renderAt('/signup');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign up' }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/signup'))).toBe(false);
  });

  it('logs in and shows server errors', async () => {
    let attempts = 0;
    mockFetch({
      'POST /auth/refresh': () => json(401, {}),
      'POST /auth/login': () =>
        ++attempts === 1
          ? json(401, {
              error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
            })
          : json(200, { accessToken: 'tok', user }),
      'GET /health': () => json(200, {}),
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Password123');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByTestId('whoami')).toBeInTheDocument();
  });

  it('signs up a new company', async () => {
    const fetchMock = mockFetch({
      'POST /auth/refresh': () => json(401, {}),
      'POST /auth/signup': () => json(201, { accessToken: 'tok', user }),
      'GET /health': () => json(200, {}),
    });
    renderAt('/signup');
    await userEvent.type(await screen.findByLabelText('Company name'), 'Acme');
    await userEvent.type(screen.getByLabelText('Your name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Password123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByTestId('whoami')).toBeInTheDocument();
    const body = JSON.parse(
      fetchMock.mock.calls.find(([u]) => String(u).includes('/auth/signup'))![1]!.body as string,
    );
    expect(body).toMatchObject({ companyName: 'Acme', email: 'a@b.com' });
  });

  it('logs out and returns to the login page', async () => {
    mockFetch({
      'POST /auth/refresh': () => json(200, { accessToken: 'tok', user }),
      'GET /health': () => json(200, {}),
      'POST /auth/logout': () => json(204),
    });
    renderAt('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
  });

  it('changes the password', async () => {
    mockFetch({
      'POST /auth/refresh': () => json(200, { accessToken: 'tok', user }),
      'POST /auth/change-password': () => json(200, { accessToken: 'tok2', user }),
    });
    renderAt('/change-password');
    await userEvent.type(await screen.findByLabelText('Current password'), 'Password123');
    await userEvent.type(screen.getByLabelText('New password'), 'NewPassword456');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Password changed'));
  });
});

describe('session restore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a single refresh request even when the effect runs twice (StrictMode)', async () => {
    const fetchMock = mockFetch({
      'POST /auth/refresh': () => json(200, { accessToken: 'tok', user }),
      'GET /health': () => json(200, {}),
    });
    render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter initialEntries={['/change-password']}>
            <App />
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });
});
