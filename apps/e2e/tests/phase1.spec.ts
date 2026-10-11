import { expect, test, type Page } from '@playwright/test';

const password = 'Password123';

async function signup(page: Page, email: string, company = 'E2E Co') {
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(company);
  await page.getByLabel('Your name').fill('Olive Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByTestId('whoami')).toHaveText('Olive Owner (OWNER)');
}

test('signup → session survives reload → logout/login → change password', async ({ page }) => {
  const email = `auth-${Date.now()}@example.com`;
  await signup(page, email);
  await page.reload();
  await expect(page.getByTestId('whoami')).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
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
  await expect(page.getByText('Password changed')).toBeVisible();
});

test('Phase 1: invite a Planner by link, planner cannot see Team; reset link; audit log', async ({
  page,
  browser,
}) => {
  const stamp = Date.now();
  const ownerEmail = `owner-${stamp}@example.com`;
  const plannerEmail = `planner-${stamp}@example.com`;
  await signup(page, ownerEmail);

  // Owner invites a Planner and copies the one-time link.
  await page.getByRole('link', { name: 'Team' }).click();
  await page.getByRole('button', { name: 'Invite user' }).click();
  await page.getByLabel('Email').fill(plannerEmail);
  await page.getByLabel('Role').selectOption('PLANNER');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const link = await page.getByTestId('copy-link').getByLabel('Link').inputValue();
  expect(link).toContain('/accept-invite?token=');
  await expect(page.getByTestId(`invite-${plannerEmail}`)).toBeVisible();

  // Planner accepts in a brand-new browser context (no shared cookies).
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const planner = await ctx.newPage();
  await planner.goto(link);
  await planner.getByLabel('Your name').fill('Pat Planner');
  await planner.getByLabel('Choose a password').fill(password);
  await planner.getByRole('button', { name: 'Join team' }).click();
  await expect(planner.getByTestId('whoami')).toHaveText('Pat Planner (PLANNER)');
  await expect(planner.getByRole('link', { name: 'Team' })).toHaveCount(0);
  await expect(planner.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
  await planner.goto('/team');
  await expect(planner.getByTestId('forbidden')).toBeVisible();

  // The API blocks the Planner even when the UI is bypassed.
  const status = await planner.evaluate(async () => {
    const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    const { accessToken } = await r.json();
    const res = await fetch('/api/users', { headers: { Authorization: `Bearer ${accessToken}` } });
    return res.status;
  });
  expect(status).toBe(403);

  // The link is single-use.
  const ctx2 = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const again = await ctx2.newPage();
  await again.goto(link);
  await again.getByLabel('Your name').fill('Someone');
  await again.getByLabel('Choose a password').fill(password);
  await again.getByRole('button', { name: 'Join team' }).click();
  await expect(again.getByRole('alert')).toContainText('invalid or has expired');
  await ctx2.close();

  // Owner sees the member, changes the role, generates a reset link that the Planner uses.
  await page.reload();
  const row = page.getByTestId(`user-${plannerEmail}`);
  await expect(row).toBeVisible();
  await row.getByRole('combobox').selectOption('VIEWER');
  await expect(row.getByRole('combobox')).toHaveValue('VIEWER');
  await row.getByRole('button', { name: 'Reset link' }).click();
  const resetLink = await page.getByTestId('copy-link').getByLabel('Link').inputValue();
  expect(resetLink).toContain('/reset-password?token=');

  const ctx3 = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const resetPage = await ctx3.newPage();
  await resetPage.goto(resetLink);
  await resetPage.getByLabel('New password').fill('ResetPass12345');
  await resetPage.getByRole('button', { name: 'Set new password' }).click();
  await expect(resetPage.getByText('Your password was changed')).toBeVisible();
  await resetPage.getByRole('link', { name: 'Go to log in' }).click();
  await resetPage.getByLabel('Email').fill(plannerEmail);
  await resetPage.getByLabel('Password').fill('ResetPass12345');
  await resetPage.getByRole('button', { name: 'Log in' }).click();
  await expect(resetPage.getByTestId('whoami')).toHaveText('Pat Planner (VIEWER)');
  await ctx3.close();

  // Owner deactivates the user: the planner's old session stops working.
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await expect(row).toContainText('Deactivated');
  await planner.reload();
  await expect(planner).toHaveURL(/\/login$/);
  await ctx.close();

  // Audit log shows the trail.
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByTestId('audit-row').first()).toBeVisible();
  const body = await page.getByRole('main').innerText();
  for (const a of [
    'user.invited',
    'invite.accepted',
    'user.role_changed',
    'user.reset_link_created',
    'auth.password_reset',
    'user.deactivated',
  ]) {
    expect(body).toContain(a);
  }
  await page.getByLabel('Action').fill('user.role');
  await expect(page.getByTestId('audit-row')).toHaveCount(1);
});
