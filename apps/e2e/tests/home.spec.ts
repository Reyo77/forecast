import { expect, test } from '@playwright/test';

test('home page loads and reaches the API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'SupplyCast' })).toBeVisible();
  await expect(page.getByTestId('api-status')).toHaveText('API: ok');
});
