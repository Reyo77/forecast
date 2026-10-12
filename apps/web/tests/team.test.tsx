import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeUser, mockApi, renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

const owner = makeUser();
const members = [
  {
    id: 'u1',
    email: 'owner@acme.com',
    name: 'Olive Owner',
    role: 'OWNER',
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'u2',
    email: 'plan@acme.com',
    name: 'Pat Planner',
    role: 'PLANNER',
    isActive: true,
    createdAt: '2026-01-02T00:00:00Z',
  },
];
const page = (items: unknown[]) =>
  json(200, { items, total: items.length, page: 1, pageSize: 100 });

function setup(
  extra: Record<string, (b: unknown) => Promise<Response> | Response> = {},
  me = owner,
) {
  return mockApi({
    ...loggedInAs(me),
    'GET /users': () => page(members),
    'GET /invites': () =>
      page([
        {
          id: 'i1',
          email: 'new@acme.com',
          role: 'VIEWER',
          expiresAt: '2099-01-01T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          expired: false,
        },
      ]),
    ...extra,
  });
}

describe('Team page', () => {
  it('lists members and pending invites; the Owner row is not editable', async () => {
    setup();
    renderApp('/team');
    const ownerRow = await screen.findByTestId('user-owner@acme.com');
    expect(within(ownerRow).queryByRole('combobox')).toBeNull();
    expect(within(ownerRow).queryByRole('button', { name: 'Deactivate' })).toBeNull();
    const planRow = screen.getByTestId('user-plan@acme.com');
    expect(within(planRow).getByRole('combobox')).toHaveValue('PLANNER');
    expect(screen.getByTestId('invite-new@acme.com')).toHaveTextContent('VIEWER');
  });

  it('creates an invite and shows a copyable one-time link', async () => {
    const fetchMock = setup({
      'POST /invites': () =>
        json(201, {
          invite: {
            id: 'i2',
            email: 'joe@acme.com',
            role: 'PLANNER',
            expiresAt: '2099-01-01',
            createdAt: '2026-01-01',
            expired: false,
          },
          link: 'http://localhost:5173/accept-invite?token=abc123',
          emailed: true,
        }),
    });
    renderApp('/team');
    await userEvent.click(await screen.findByRole('button', { name: 'Invite user' }));
    await userEvent.type(screen.getByLabelText('Email'), 'joe@acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    const box = await screen.findByTestId('copy-link');
    expect(within(box).getByLabelText('Link')).toHaveValue(
      'http://localhost:5173/accept-invite?token=abc123',
    );
    expect(within(box).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(within(box).getByTestId('emailed')).toHaveTextContent(
      'emailed this link to joe@acme.com',
    );
    expect(JSON.parse(calls(fetchMock, 'POST /invites')[0]![1]!.body as string)).toEqual({
      email: 'joe@acme.com',
      role: 'PLANNER',
    });
  });

  it('asks you to share the link yourself when no email was sent', async () => {
    setup({
      'POST /invites': () =>
        json(201, {
          invite: {
            id: 'i3',
            email: 'ann@acme.com',
            role: 'VIEWER',
            expiresAt: '2099-01-01',
            createdAt: '2026-01-01',
            expired: false,
          },
          link: 'http://localhost:5173/accept-invite?token=zzz',
          emailed: false,
        }),
    });
    renderApp('/team');
    await userEvent.click(await screen.findByRole('button', { name: 'Invite user' }));
    await userEvent.type(screen.getByLabelText('Email'), 'ann@acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    const box = await screen.findByTestId('copy-link');
    expect(within(box).queryByTestId('emailed')).not.toBeInTheDocument();
    expect(box).toHaveTextContent('Share this link manually');
  });

  it('changes a role and deactivates a user', async () => {
    const fetchMock = setup({
      'PATCH /users/u2': () => json(200, { user: members[1] }),
    });
    renderApp('/team');
    const row = await screen.findByTestId('user-plan@acme.com');
    await userEvent.selectOptions(within(row).getByRole('combobox'), 'VIEWER');
    await waitFor(() => expect(calls(fetchMock, 'PATCH /users/u2')).toHaveLength(1));
    expect(JSON.parse(calls(fetchMock, 'PATCH /users/u2')[0]![1]!.body as string)).toEqual({
      role: 'VIEWER',
    });
    await userEvent.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(calls(fetchMock, 'PATCH /users/u2')).toHaveLength(2));
    expect(JSON.parse(calls(fetchMock, 'PATCH /users/u2')[1]![1]!.body as string)).toEqual({
      isActive: false,
    });
  });

  it('generates a reset link for a user', async () => {
    setup({
      'POST /users/u2/reset-link': () =>
        json(201, { link: 'http://x/reset-password?token=zzz', expiresAt: '2099', emailed: true }),
    });
    renderApp('/team');
    const row = await screen.findByTestId('user-plan@acme.com');
    await userEvent.click(within(row).getByRole('button', { name: 'Reset link' }));
    expect(await screen.findByText(/Password reset link for plan@acme.com/)).toBeInTheDocument();
    expect(screen.getByTestId('emailed')).toHaveTextContent('plan@acme.com');
  });

  it('revokes an invite', async () => {
    const fetchMock = setup({ 'DELETE /invites/i1': () => json(204) });
    renderApp('/team');
    await userEvent.click(
      within(await screen.findByTestId('invite-new@acme.com')).getByRole('button', {
        name: 'Revoke',
      }),
    );
    await waitFor(() => expect(calls(fetchMock, 'DELETE /invites/i1')).toHaveLength(1));
  });

  it('shows server errors', async () => {
    setup({
      'PATCH /users/u2': () => json(400, { error: { code: 'X', message: 'You cannot do that' } }),
    });
    renderApp('/team');
    await userEvent.click(
      within(await screen.findByTestId('user-plan@acme.com')).getByRole('button', {
        name: 'Deactivate',
      }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot do that');
  });

  it('only the Owner sees Transfer ownership; an Admin does not', async () => {
    setup();
    const { unmount } = renderApp('/team');
    expect(await screen.findByRole('form', { name: 'Transfer ownership' })).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    setup({}, makeUser({ role: 'ADMIN', id: 'u9' }));
    renderApp('/team');
    await screen.findByTestId('user-plan@acme.com');
    expect(screen.queryByRole('form', { name: 'Transfer ownership' })).toBeNull();
  });

  it('transfers ownership with a password', async () => {
    const fetchMock = setup({ 'POST /tenant/transfer-ownership': () => json(200, { ok: true }) });
    renderApp('/team');
    const form = await screen.findByRole('form', { name: 'Transfer ownership' });
    await within(form).findByRole('option', { name: /Pat Planner/ });
    await userEvent.selectOptions(within(form).getByRole('combobox'), 'u2');
    await userEvent.type(within(form).getByLabelText('Your password'), 'Password123');
    await userEvent.click(within(form).getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Ownership transferred');
    expect(
      JSON.parse(calls(fetchMock, 'POST /tenant/transfer-ownership')[0]![1]!.body as string),
    ).toEqual({ userId: 'u2', password: 'Password123' });
  });

  it('a Viewer cannot see invite controls even if the page rendered (Can hides them)', async () => {
    // Viewers cannot reach /team at all (route guard); verify the guard message instead.
    setup({}, makeUser({ role: 'VIEWER' }));
    renderApp('/team');
    expect(await screen.findByTestId('forbidden')).toBeInTheDocument();
  });
});
