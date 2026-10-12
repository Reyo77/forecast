import { expect, test } from '@playwright/test';

test('Phase 9: landing page → sign up → dark mode → command palette → reorder plan → ABC analysis → settings', async ({
  page,
}) => {
  const stamp = Date.now();
  // Marketing landing page for visitors, 404 for unknown URLs.
  await page.goto('/');
  await expect(page.getByTestId('landing')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Know what to buy/ })).toBeVisible();
  await page.getByRole('link', { name: 'Terms' }).click();
  await expect(page.getByRole('heading', { name: 'Terms of Service' })).toBeVisible();
  await page.goto('/definitely-not-a-page');
  await expect(page.getByTestId('not-found')).toBeVisible();

  await page.goto('/');
  await page.getByRole('link', { name: 'Start your free trial' }).click();
  await page.getByLabel('Company name').fill(`Phase9 Co ${stamp}`);
  await page.getByLabel('Your name').fill('Nia Owner');
  await page.getByLabel('Email').fill(`p9-${stamp}@example.com`);
  await page.getByLabel('Password').fill('Password123');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();

  // Dark mode: toggles, persists across reload.
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();

  // Empty states before there is data.
  await page.getByRole('button', { name: 'Load demo data' }).click();
  await expect(page.getByText(/Demo data loaded/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Forecasts' }).click();
  await page.goto('/reorder');
  await expect(page.getByTestId('no-plan')).toBeVisible();
  await page.getByRole('link', { name: 'Forecasts' }).first().click();
  await page.getByLabel('Horizon (weeks)').fill('12');
  await page.getByRole('button', { name: 'Run forecast' }).click();
  await expect(page.locator('[data-testid^="run-"]').first()).toContainText('DONE', {
    timeout: 60000,
  });

  // Command palette jumps to the reorder plan.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search commands').fill('reorder');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Reorder plan' })).toBeVisible();
  await expect(page.getByTestId('plan-table')).toBeVisible();
  await expect(page.getByTestId('plan-orders')).not.toContainText(/^Purchase orders0/);
  await page.getByRole('button', { name: 'Urgent only' }).click();
  await page.getByRole('button', { name: 'All orders' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export CSV/ }).click();
  expect((await download).suggestedFilename()).toBe('reorder-plan.csv');

  // ABC analysis.
  await page.getByRole('link', { name: 'ABC analysis' }).click();
  await expect(page.getByTestId('abc-A')).toBeVisible();
  await expect(page.getByTestId('abc-table').getByRole('row').nth(1)).toBeVisible();

  // Settings: switch theme back to light, log out lands on the landing page.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Nia Renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Profile updated.')).toBeVisible();
  await expect(page.getByTestId('whoami')).toContainText('Nia Renamed (OWNER)');
  await page.reload();
  await expect(page.getByTestId('whoami')).toContainText('Nia Renamed');
  await page.getByRole('radio', { name: /Light/ }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
});
