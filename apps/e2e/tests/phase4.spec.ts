import { expect, test } from '@playwright/test';

function lastMonday(): string {
  const d = new Date(Date.now() - 7 * 86400_000);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow))
    .toISOString()
    .slice(0, 10);
}
const csv = (rows: string[]) =>
  Buffer.from(`sku,location_code,date,quantity,revenue\n${rows.join('\n')}\n`);

test('Phase 4: demo data → explorer → CSV with errors → fix and re-upload → commit (replaces) → chart', async ({
  page,
}) => {
  const stamp = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(`Phase4 Co ${stamp}`);
  await page.getByLabel('Your name').fill('Dan Owner');
  await page.getByLabel('Email').fill(`p4-${stamp}@example.com`);
  await page.getByLabel('Password').fill('Password123');
  await page.getByRole('button', { name: 'Sign up' }).click();

  // Demo data: one click, then the button disappears.
  await page.getByRole('button', { name: 'Load demo data' }).click();
  await expect(
    page.getByText(/Demo data loaded: 12 products, 2 locations, 3 suppliers/),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Load demo data' })).toHaveCount(0);

  // Explorer shows the generated history, grouped by category.
  await page.getByRole('link', { name: 'Sales' }).click();
  await expect(page.getByTestId('total-weeks')).toContainText('156');
  await page.getByLabel('Group by').selectOption('category');
  await page.getByRole('button', { name: 'View as table' }).click();
  await expect(page.getByTestId('explorer-table')).toContainText('Snacks');
  await expect(page.getByTestId('explorer-table')).toContainText('Beverages');
  await page.getByRole('button', { name: 'Show chart' }).click();
  await expect(page.getByRole('img', { name: 'Line chart of weekly sales' })).toBeVisible();

  // Upload a CSV with problems → preview highlights them.
  const week = lastMonday();
  await page.getByRole('link', { name: 'Import' }).click();
  await page.getByLabel('CSV file').setInputFiles({
    name: 'sales-bad.csv',
    mimeType: 'text/csv',
    buffer: csv([
      `SNK-CHIP,WH-EAST,${week},7777,100.00`,
      `NOPE-SKU,WH-EAST,${week},5,1`,
      `SNK-CHIP,WH-EAST,2025-02-30,5,1`,
    ]),
  });
  await expect(page.getByTestId('preview-summary')).toContainText('1 valid');
  await expect(page.getByTestId('preview-summary')).toContainText('2 with errors');
  await expect(page.getByTestId('error-row')).toHaveCount(2);
  await expect(page.getByTestId('error-row').first()).toContainText('Unknown SKU "NOPE-SKU"');
  await expect(page.getByTestId('error-row').nth(1)).toContainText('Invalid date');
  await expect(page.getByRole('button', { name: /Import 1 valid rows, skip 2/ })).toBeVisible();

  // Fix and re-upload → clean preview → commit runs in the background.
  await page.getByLabel('CSV file').setInputFiles({
    name: 'sales-fixed.csv',
    mimeType: 'text/csv',
    buffer: csv([`SNK-CHIP,WH-EAST,${week},7000,100.00`, `SNK-CHIP,WH-EAST,${week},777,0`]),
  });
  await expect(page.getByTestId('preview-summary')).toContainText('0 with errors');
  await expect(page.getByTestId('sample-row')).toContainText('7777');
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('Import queued')).toBeVisible();
  await expect(page.getByTestId('import-sales-fixed.csv')).toContainText('DONE', {
    timeout: 15000,
  });
  await expect(page.getByTestId('import-sales-fixed.csv')).toContainText('1'); // one weekly record written

  // The imported week replaced (not added to) the demo value.
  await page.getByRole('link', { name: 'Sales' }).click();
  await page.getByLabel('Product filter').selectOption({ label: 'SNK-CHIP' });
  await page.getByLabel('Location filter').selectOption({ label: 'WH-EAST' });
  await page.getByLabel('From').fill(week);
  await expect(page.getByTestId('total-units')).toContainText('7,777');
  await expect(page.getByTestId('total-weeks')).toContainText('1');

  // Re-importing the same week is idempotent.
  await page.getByRole('link', { name: 'Import' }).click();
  await page.getByLabel('CSV file').setInputFiles({
    name: 'again.csv',
    mimeType: 'text/csv',
    buffer: csv([`SNK-CHIP,WH-EAST,${week},7777,100.00`]),
  });
  await page.getByRole('button', { name: 'Import 1 rows' }).click();
  await expect(page.getByTestId('import-again.csv')).toContainText('DONE', { timeout: 15000 });
  await page.getByRole('link', { name: 'Sales' }).click();
  await page.getByLabel('Product filter').selectOption({ label: 'SNK-CHIP' });
  await page.getByLabel('Location filter').selectOption({ label: 'WH-EAST' });
  await page.getByLabel('From').fill(week);
  await expect(page.getByTestId('total-units')).toContainText('7,777');

  // Wrong headers are rejected outright.
  await page.getByRole('link', { name: 'Import' }).click();
  await page.getByLabel('CSV file').setInputFiles({
    name: 'headers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('sku,when\nA,B\n'),
  });
  await expect(page.getByRole('alert')).toContainText('Missing required column');

  // A product with sales history cannot be deleted.
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByTestId('product-SNK-CHIP').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('alert')).toContainText('sales history');
});
