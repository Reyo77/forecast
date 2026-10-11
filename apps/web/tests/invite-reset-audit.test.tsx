import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeUser, mockApi, renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

const anon = { 'POST /auth/refresh': () => json(401, {}) };

describe('accept invite page', () => {
  it('shows an error without a token', async () => {
    mockApi(anon);
    renderApp('/accept-invite');
    expect(await screen.findByRole('alert')).toHaveTextContent('missing its token');
  });

  it('validates, submits the token and lands in the app as the invited role', async () => {
    const fetchMock = mockApi({
      ...anon,
      'POST /invites/accept': () =>
        json(201, { accessToken: 't', user: makeUser({ role: 'PLANNER', name: 'Pat' }) }),
      'GET /health': () => json(200, {}),
    });
    renderApp('/accept-invite?token=tok-1234567890');
    await userEvent.click(await screen.findByRole('button', { name: 'Join team' }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText('Your name'), 'Pat');
    await userEvent.type(screen.getByLabelText('Choose a password'), 'Password123');
    await userEvent.click(screen.getByRole('button', { name: 'Join team' }));
    expect(await screen.findByTestId('whoami')).toHaveTextContent('Pat (PLANNER)');
    expect(JSON.parse(calls(fetchMock, 'POST /invites/accept')[0]![1]!.body as string)).toEqual({
      token: 'tok-1234567890',
      name: 'Pat',
      password: 'Password123',
    });
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
  });

  it('shows the server error for an expired link', async () => {
    mockApi({
      ...anon,
      'POST /invites/accept': () =>
        json(400, {
          error: { code: 'INVALID_INVITE', message: 'This invite link is invalid or has expired' },
        }),
    });
    renderApp('/accept-invite?token=tok-1234567890');
    await userEvent.type(await screen.findByLabelText('Your name'), 'Pat');
    await userEvent.type(screen.getByLabelText('Choose a password'), 'Password123');
    await userEvent.click(screen.getByRole('button', { name: 'Join team' }));
    expect(
      await screen.findByText('This invite link is invalid or has expired'),
    ).toBeInTheDocument();
  });
});

describe('reset password page', () => {
  it('requires a token', async () => {
    mockApi(anon);
    renderApp('/reset-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('missing its token');
  });

  it('enforces password rules then resets', async () => {
    const fetchMock = mockApi({ ...anon, 'POST /auth/reset-password': () => json(204) });
    renderApp('/reset-password?token=reset-token-123');
    await userEvent.type(await screen.findByLabelText('New password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(calls(fetchMock, 'POST /auth/reset-password')).toHaveLength(0);
    await userEvent.clear(screen.getByLabelText('New password'));
    await userEvent.type(screen.getByLabelText('New password'), 'BrandNew12345');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your password was changed');
    expect(screen.getByRole('link', { name: 'Go to log in' })).toBeInTheDocument();
  });

  it('shows an invalid-link error from the server', async () => {
    mockApi({
      ...anon,
      'POST /auth/reset-password': () =>
        json(400, {
          error: {
            code: 'INVALID_RESET_TOKEN',
            message: 'This reset link is invalid or has expired',
          },
        }),
    });
    renderApp('/reset-password?token=reset-token-123');
    await userEvent.type(await screen.findByLabelText('New password'), 'BrandNew12345');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(
      await screen.findByText('This reset link is invalid or has expired'),
    ).toBeInTheDocument();
  });
});

describe('audit log page', () => {
  const row = (n: number) => ({
    id: `a${n}`,
    action: 'user.invited',
    entityType: 'Invite',
    entityId: 'i',
    metadata: { email: 'x@y.com' },
    createdAt: '2026-02-01T10:00:00Z',
    actor: { id: 'u1', name: 'Olive', email: 'owner@acme.com' },
  });

  it('renders rows, filters by action and paginates', async () => {
    const fetchMock = mockApi({
      ...loggedInAs(),
      'GET /audit-logs': (_b, url) => {
        const q = new URL(url, 'http://x').searchParams;
        return json(200, {
          items: q.get('action') === 'zzz' ? [] : [row(1), row(2)],
          total: q.get('action') === 'zzz' ? 0 : 60,
          page: Number(q.get('page')),
          pageSize: 25,
        });
      },
    });
    renderApp('/audit-log');
    expect(await screen.findAllByTestId('audit-row')).toHaveLength(2);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Action'), 'zzz');
    expect(await screen.findByText('No audit entries match.')).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('action=zzz'))).toBe(true),
    );
  });
});
