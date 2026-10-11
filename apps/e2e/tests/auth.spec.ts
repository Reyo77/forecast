import { expect, test } from '@playwright/test';

const password = 'Password123';

test('signup → reload keeps session → logout → login → change password', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Company name').fill('E2E Company');
  await page.getByLabel('Your name').fill('Eve Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();

  await expect(page.getByTestId('whoami')).toHaveText('Eve Owner (OWNER)');
  await expect(page.getByTestId('api-status')).toHaveText('API: ok');

  // The httpOnly refresh cookie restores the session after a full reload.
  await page.reload();
  await expect(page.getByTestId('whoami')).toHaveText('Eve Owner (OWNER)');

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);

  // Wrong password shows an error.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('WrongPass999');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');

  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('whoami')).toBeVisible();

  await page.getByRole('link', { name: 'Change password' }).click();
  await page.getByLabel('Current password').fill(password);
  await page.getByLabel('New password').fill('NewPassword456');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status')).toContainText('Password changed');

  await page.getByRole('link', { name: 'Back to home' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('NewPassword456');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('whoami')).toBeVisible();
});
