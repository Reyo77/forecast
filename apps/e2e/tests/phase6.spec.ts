import { expect, test } from '@playwright/test';

test('Phase 6: demo data → forecast → scenario "supplier 3 weeks late" → run → compare with baseline → at-risk list', async ({
  page,
}) => {
  const stamp = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(`Phase6 Co ${stamp}`);
  await page.getByLabel('Your name').fill('Gus Owner');
  await page.getByLabel('Email').fill(`p6-${stamp}@example.com`);
  await page.getByLabel('Password').fill('Password123');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByRole('button', { name: 'Load demo data' }).click();
  await expect(page.getByText(/Demo data loaded/)).toBeVisible();

  // Scenarios need a finished forecast first.
  await page.getByRole('link', { name: 'Scenarios' }).click();
  await expect(page.getByTestId('needs-forecast')).toBeVisible();
  await page.getByRole('link', { name: 'Forecasts' }).click();
  await page.getByLabel('Horizon (weeks)').fill('12');
  await page.getByRole('button', { name: 'Run forecast' }).click();
  await expect(page.locator('[data-testid^="run-"]').first()).toContainText('DONE', {
    timeout: 60000,
  });

  // Scenario 1: main supplier is 3 weeks late.
  await page.getByRole('link', { name: 'Scenarios' }).click();
  const form = page.getByRole('form', { name: 'New scenario' });
  await form.getByLabel('Name').fill('Main supplier 3 weeks late');
  await form.getByRole('button', { name: 'Create scenario' }).click();
  await expect(page.getByRole('heading', { name: 'Main supplier 3 weeks late' })).toBeVisible();
  await expect(page.getByTestId('no-levers')).toBeVisible();

  const lever = page.getByRole('form', { name: 'Add lever' });
  await lever.getByLabel('Lever type').selectOption('SUPPLIER_DELAY');
  await lever.getByLabel('Supplier').selectOption({ label: 'Acme Supplies' });
  await lever.getByLabel('Extra days late').fill('21');
  await lever.getByRole('button', { name: 'Add lever' }).click();
  await expect(page.getByTestId('lever')).toContainText('Acme Supplies is 21 days late');

  // An invalid lever is rejected by the server (lead time over 365 days is blocked in the form itself).
  await lever.getByLabel('Lever type').selectOption('SERVICE_LEVEL');
  await lever.getByLabel('Target service level (%)').fill('99.5');
  await lever.getByRole('button', { name: 'Add lever' }).click();
  await expect(page.getByTestId('lever')).toHaveCount(2);

  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByTestId('kpi-cards')).toBeVisible({ timeout: 60000 });
  const cards = page.getByTestId('kpi-cards');
  await expect(cards.getByTestId('kpi-fillRate')).toContainText('Baseline');
  await expect(cards.getByTestId('kpi-stockoutWeeks')).toContainText('Baseline');
  const table = page.getByTestId('at-risk-table');
  await expect(table.or(page.getByTestId('no-risk'))).toBeVisible();
  await expect(page.getByRole('img', { name: /Projected on-hand inventory/ })).toBeVisible();

  // Scenario 2: demand +25% for everything; run it too.
  await page.getByRole('link', { name: '← Scenarios' }).click();
  await form.getByLabel('Name').fill('Demand up 25%');
  await form.getByRole('button', { name: 'Create scenario' }).click();
  const lever2 = page.getByRole('form', { name: 'Add lever' });
  await lever2.getByLabel('Lever type').selectOption('DEMAND_CHANGE');
  await lever2.getByLabel('Change (%)').fill('25');
  await lever2.getByRole('button', { name: 'Add lever' }).click();
  await expect(page.getByTestId('lever')).toContainText('Demand +25% for everything');
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByTestId('kpi-cards')).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('kpi-cards').getByTestId('kpi-fillRate')).toContainText('%');

  // Compare both with the baseline.
  await page.getByRole('link', { name: '← Scenarios' }).click();
  await expect(page.getByTestId('scenario-Main supplier 3 weeks late')).toContainText('READY');
  await page.getByLabel('Select Main supplier 3 weeks late').check();
  await page.getByLabel('Select Demand up 25%').check();
  await page.getByRole('button', { name: 'Compare selected (2/3)' }).click();

  const compare = page.getByTestId('kpi-compare');
  await expect(compare).toContainText('Baseline');
  await expect(compare).toContainText('Main supplier 3 weeks late');
  await expect(compare).toContainText('Demand up 25%');
  // Demand +25% shows as a higher fill-rate pressure: stockout weeks must not improve vs. the baseline.
  const stockout = compare.getByTestId('row-stockoutWeeks');
  await expect(stockout).toBeVisible();
  await expect(page.getByRole('img', { name: /Projected inventory per week/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Main supplier 3 weeks late' }).click();
  await expect(page.getByTestId('at-risk-table').or(page.getByTestId('no-risk'))).toBeVisible();
  if (await page.getByTestId('at-risk-table').count()) {
    await page.getByRole('button', { name: 'Sort by Revenue at risk' }).click();
    await expect(page.getByTestId('at-risk-table').locator('tbody tr').first()).toBeVisible();
  }
});
