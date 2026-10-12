import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeUser, mockApi, renderApp } from './utils';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});
afterEach(() => vi.unstubAllGlobals());

const dashboardEmpty = {
  counts: { products: 0, locations: 0, suppliers: 0, lateOrders: 0 },
  sales: { records: 0, from: null, to: null },
  accuracy: null,
  upcomingStockouts: null,
  latestRuns: [],
  usage: [],
};

describe('dark mode', () => {
  it('toggles from the header, persists the choice and sets the dark class', async () => {
    mockApi({ ...loggedInAs(), 'GET /dashboard': () => json(200, dashboardEmpty) });
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('sc-theme')).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('sc-theme')).toBe('light');
  });

  it('starts in the saved theme', async () => {
    localStorage.setItem('sc-theme', 'dark');
    mockApi({ ...loggedInAs(), 'GET /dashboard': () => json(200, dashboardEmpty) });
    renderApp('/');
    await screen.findByRole('button', { name: 'Switch to light mode' });
    expect(document.documentElement).toHaveClass('dark');
  });

  it('settings page offers light / dark / system', async () => {
    mockApi(loggedInAs());
    renderApp('/settings');
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });
    await userEvent.click(within(group).getByRole('radio', { name: /Dark/ }));
    expect(document.documentElement).toHaveClass('dark');
    expect(within(group).getByRole('radio', { name: /Dark/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(group).getByRole('radio', { name: /Light/ }));
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByText('owner@acme.com')).toBeInTheDocument();
  });
});

describe('command palette', () => {
  it('opens with Ctrl+K, filters, navigates with Enter and closes with Escape', async () => {
    mockApi({
      ...loggedInAs(),
      'GET /dashboard': () => json(200, dashboardEmpty),
      'GET /insights/abc': () => json(200, { from: null, to: null, rows: [], summary: [] }),
    });
    renderApp('/');
    await screen.findByTestId('whoami');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByLabelText('Search commands');
    await userEvent.type(input, 'abc');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'ABC analysis' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await screen.findByLabelText('Search commands');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });

  it('only lists pages the role may see and shows "No matches"', async () => {
    mockApi(loggedInAs(makeUser({ role: 'VIEWER' })));
    renderApp('/settings');
    await screen.findByTestId('whoami');
    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const labels = within(await screen.findByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels.join('|')).not.toMatch(/Billing|Team|Audit/);
    expect(labels.join('|')).toMatch(/Reorder plan/);
    await userEvent.type(screen.getByLabelText('Search commands'), 'zzzz');
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
});

const plan = {
  run: { id: 'r1', asOf: '2026-06-01', horizonWeeks: 12 },
  items: [
    {
      sku: 'TEA',
      productName: 'Green Tea',
      locationCode: 'EAST',
      supplierName: 'Acme',
      orderDate: '2026-06-08',
      arrivalDate: '2026-06-22',
      quantity: 120,
      estCostCents: 24000,
      urgent: true,
    },
    {
      sku: 'BAR',
      productName: 'Protein Bar',
      locationCode: 'WEST',
      supplierName: null,
      orderDate: '2026-07-06',
      arrivalDate: '2026-07-20',
      quantity: 50.5,
      estCostCents: 10000,
      urgent: false,
    },
  ],
  totals: { orders: 2, units: 171, costCents: 34000, urgent: 1 },
};

describe('reorder plan page', () => {
  it('shows totals and orders, filters urgent and searches', async () => {
    mockApi({ ...loggedInAs(), 'GET /insights/reorder-plan': () => json(200, plan) });
    renderApp('/reorder');
    expect(await screen.findByRole('heading', { name: 'Reorder plan' })).toBeInTheDocument();
    expect(await screen.findByTestId('plan-orders')).toHaveTextContent('2');
    expect(screen.getByTestId('plan-urgent')).toHaveTextContent('1');
    expect(screen.getByTestId('plan-cost')).toHaveTextContent('$340');
    expect(screen.getByTestId('plan-row-TEA')).toHaveTextContent('Acme');
    expect(screen.getByTestId('plan-row-TEA')).toHaveTextContent('Now');
    expect(screen.getByTestId('plan-row-BAR')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Urgent only' }));
    expect(screen.queryByTestId('plan-row-BAR')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All orders' }));
    await userEvent.type(screen.getByLabelText('Search orders'), 'protein');
    expect(screen.queryByTestId('plan-row-TEA')).not.toBeInTheDocument();
    expect(screen.getByTestId('plan-row-BAR')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search orders'), 'zzz');
    expect(await screen.findByTestId('plan-empty')).toHaveTextContent('No orders match');
  });

  it('exports the CSV', async () => {
    const fn = mockApi({
      ...loggedInAs(),
      'GET /insights/reorder-plan': () => json(200, plan),
      'GET /insights/reorder-plan/export.csv': () =>
        Promise.resolve({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(new Blob(['a'])),
        } as Response),
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    renderApp('/reorder');
    await userEvent.click(await screen.findByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(calls(fn, 'GET /insights/reorder-plan/export.csv')).toHaveLength(1));
  });

  it('explains how to get a plan when no forecast exists', async () => {
    mockApi({
      ...loggedInAs(),
      'GET /insights/reorder-plan': () =>
        json(200, {
          run: null,
          items: [],
          totals: { orders: 0, units: 0, costCents: 0, urgent: 0 },
        }),
    });
    renderApp('/reorder');
    expect(await screen.findByTestId('no-plan')).toHaveTextContent('Run a forecast');
    expect(screen.queryByRole('button', { name: /Export CSV/ })).not.toBeInTheDocument();
  });
});

describe('ABC analysis page', () => {
  it('shows class summary and the ranked table', async () => {
    mockApi({
      ...loggedInAs(),
      'GET /insights/abc': () =>
        json(200, {
          from: '2025-06-09',
          to: '2026-06-01',
          summary: [
            { class: 'A', products: 1, revenueCents: 90000, sharePct: 90 },
            { class: 'B', products: 1, revenueCents: 9000, sharePct: 9 },
            { class: 'C', products: 0, revenueCents: 0, sharePct: 0 },
          ],
          rows: [
            {
              productId: 'p1',
              sku: 'BIG',
              name: 'Big seller',
              revenueCents: 90000,
              units: 900,
              sharePct: 90,
              cumulativePct: 90,
              class: 'A',
            },
            {
              productId: 'p2',
              sku: 'MID',
              name: 'Middle',
              revenueCents: 9000,
              units: 90,
              sharePct: 9,
              cumulativePct: 99,
              class: 'B',
            },
          ],
        }),
    });
    renderApp('/abc');
    expect(await screen.findByTestId('abc-A')).toHaveTextContent('90%');
    expect(screen.getByTestId('abc-B')).toHaveTextContent('1 product');
    const rows = within(screen.getByTestId('abc-table')).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('BIG');
    expect(rows[1]).toHaveTextContent('$900');
  });

  it('shows an empty state without sales', async () => {
    mockApi({
      ...loggedInAs(),
      'GET /insights/abc': () => json(200, { from: null, to: null, rows: [], summary: [] }),
    });
    renderApp('/abc');
    expect(await screen.findByTestId('abc-empty')).toHaveTextContent('Import sales');
  });
});

describe('role access to the new pages', () => {
  it('a viewer can open the reorder plan', async () => {
    mockApi({
      ...loggedInAs(makeUser({ role: 'VIEWER' })),
      'GET /insights/reorder-plan': () => json(200, plan),
    });
    renderApp('/reorder');
    expect(await screen.findByTestId('plan-orders')).toBeInTheDocument();
  });
});
