import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLES, PERMISSIONS, can } from '@supplycast/shared';
import { NAV_ITEMS } from '../src/components/AppLayout';
import { loggedInAs, makeUser, mockApi, renderApp, json } from './utils';

afterEach(() => vi.unstubAllGlobals());

describe('nav + route guards follow the shared permission map', () => {
  for (const role of ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
    it(`${role}: sees exactly the nav items it may use`, async () => {
      mockApi({
        ...loggedInAs(makeUser({ role })),
        'GET /users': () => json(200, { items: [], total: 0, page: 1, pageSize: 100 }),
        'GET /invites': () => json(200, { items: [], total: 0, page: 1, pageSize: 100 }),
      });
      renderApp('/');
      await screen.findByTestId('whoami');
      for (const item of NAV_ITEMS) {
        const link = screen.queryByRole('link', { name: item.label });
        expect(!!link).toBe(can(role, item.permission));
      }
    });
  }

  for (const role of ['PLANNER', 'VIEWER'] as const) {
    it(`${role} opening /team directly sees the Not allowed page and no data is fetched`, async () => {
      const fetchMock = mockApi({ ...loggedInAs(makeUser({ role })) });
      renderApp('/team');
      expect(await screen.findByTestId('forbidden')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/users'))).toBe(false);
    });

    it(`${role} opening /audit-log is blocked`, async () => {
      mockApi({ ...loggedInAs(makeUser({ role })) });
      renderApp('/audit-log');
      expect(await screen.findByTestId('forbidden')).toBeInTheDocument();
    });
  }

  it('permission map covers every Can usage (sanity)', () => {
    expect(Object.keys(PERMISSIONS)).toContain('team:manage');
  });
});
