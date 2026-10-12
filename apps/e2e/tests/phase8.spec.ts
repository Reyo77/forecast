import { expect, test } from '@playwright/test';

test('Phase 8: dashboard, notifications, security basics and deleting a company', async ({
  page,
}) => {
  const stamp = Date.now();
  const email = `p8-${stamp}@example.com`;
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(`Phase8 Co ${stamp}`);
  await page.getByLabel('Your name').fill('Hal Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('Password123');
  await page.getByRole('button', { name: 'Sign up' }).click();

  // New accounts get a getting-started guide.
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('getting-started')).toBeVisible();
  await page.getByRole('button', { name: 'Load demo data' }).click();
  await expect(page.getByText(/Demo data loaded/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('getting-started')).toHaveCount(0);
  await expect(page.getByTestId('card-data')).toContainText(
    '12 active products · 2 locations · 3 suppliers',
  );
  await expect(page.getByTestId('card-accuracy')).toContainText('No finished forecast yet');
  await expect(page.getByTestId('card-usage')).toBeVisible();

  // A forecast run finishes in the background and notifies the person who started it.
  await page.getByRole('link', { name: 'Forecasts' }).click();
  await page.getByLabel('Horizon (weeks)').fill('12');
  await page.getByRole('button', { name: 'Run forecast' }).click();
  await expect(page.locator('[data-testid^="run-"]').first()).toContainText('DONE', {
    timeout: 60000,
  });
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByTestId('unread-badge')).toHaveText('1', { timeout: 40000 });
  await page.getByRole('button', { name: /Notifications, 1 unread/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Notifications' });
  await expect(dialog).toContainText('Forecast run finished');
  await dialog.getByText('Forecast run finished').click();
  await expect(page.getByTestId('unread-badge')).toHaveCount(0);

  // The dashboard now shows accuracy, stockouts, runs and usage.
  await page.reload();
  await expect(page.getByTestId('wape')).toContainText('%');
  await expect(page.getByTestId('card-accuracy')).toContainText('series backtested');
  await expect(page.getByTestId('card-stockouts')).toBeVisible();
  await expect(page.getByTestId('card-runs')).toContainText('DONE');
  await expect(page.getByTestId('dash-usage-forecastRuns')).toContainText('1 / 100');

  // Security basics: the API refuses unauthenticated and over-sized list requests.
  const statuses = await page.evaluate(async () => {
    const anon = await fetch('/api/users');
    const refresh = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    const { accessToken } = await refresh.json();
    const big = await fetch('/api/products?pageSize=500', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return [anon.status, big.status];
  });
  expect(statuses).toEqual([401, 400]);

  // Owner can delete the company; afterwards the account is unavailable.
  await page.getByRole('link', { name: 'Team' }).click();
  await page.getByRole('button', { name: 'Delete this company…' }).click();
  const zone = page.getByRole('region', { name: 'Danger zone' });
  await zone.getByLabel('Your password').fill('wrong-password-1');
  await zone.getByRole('button', { name: 'Permanently delete company' }).click();
  await expect(page.getByRole('alert')).toContainText('Password is incorrect');
  await zone.getByLabel('Your password').fill('Password123');
  await zone.getByRole('button', { name: 'Permanently delete company' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('Password123');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('suspended')).toContainText('Account unavailable');
});
