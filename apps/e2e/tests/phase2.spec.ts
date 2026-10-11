import { expect, test, type Page } from '@playwright/test';

const password = 'Password123';
const adminEmail = process.env.SUPER_ADMIN_EMAIL!;
const adminPassword = process.env.SUPER_ADMIN_PASSWORD!;

const money = (text: string) => Number(text.replace(/[^0-9.]/g, ''));

async function login(page: Page, email: string, pw: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(pw);
  await page.getByRole('button', { name: 'Log in' }).click();
}

test('Phase 2: trial → upgrade to Pro (instant, "payment successful") → MRR → suspend → blocked', async ({
  page,
  browser,
}) => {
  const stamp = Date.now();
  const company = `Phase2 Co ${stamp}`;
  const email = `p2-${stamp}@example.com`;

  // Public pricing page is data-driven and reachable without logging in.
  await page.goto('/pricing');
  await expect(page.getByTestId('plan-pro')).toContainText('$199');
  await expect(page.getByTestId('plan-free')).toContainText('$0');
  await expect(page.getByTestId('plan-enterprise')).toContainText('Custom');

  // Super Admin baseline MRR (separate browser context).
  const adminCtx = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const admin = await adminCtx.newPage();
  await login(admin, adminEmail, adminPassword);
  await expect(admin.getByRole('heading', { name: 'Platform overview' })).toBeVisible();
  const before = money(await admin.getByTestId('tile-mrr').innerText());

  // New tenant starts on a 14-day Starter trial.
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(company);
  await page.getByLabel('Your name').fill('Pat Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByTestId('trial-banner-global')).toContainText('14 days left');
  await page.getByRole('link', { name: 'Billing' }).click();
  await expect(page.getByTestId('trial-banner')).toContainText('14 days left');
  await expect(page.getByTestId('simulated-notice')).toBeVisible();
  await expect(page.getByTestId('usage-users')).toContainText('1 / 5');

  // Choosing Pro applies it immediately and says payment successful.
  await page.getByRole('button', { name: 'Choose Pro' }).click();
  await expect(page.getByTestId('change-result')).toContainText('Payment successful');
  await expect(page.getByTestId('current-plan')).toContainText('Pro');
  await expect(page.getByTestId('trial-banner')).toHaveCount(0);
  await expect(page.getByTestId('usage-users')).toContainText('1 / 20');

  // The invoice exists and is printable.
  await page.getByRole('link', { name: 'View invoices' }).click();
  await page.getByTestId('invoice-row').getByRole('link').click();
  await expect(page.getByTestId('invoice')).toContainText('Billed to: ' + company);
  await expect(page.getByTestId('invoice')).toContainText('$199');
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();

  // Super Admin sees MRR rise by $199 and finds the tenant.
  await admin.reload();
  await expect
    .poll(async () => money(await admin.getByTestId('tile-mrr').innerText()))
    .toBe(before + 199);
  await admin.getByRole('link', { name: 'Tenants' }).click();
  await admin.getByLabel('Search').fill(company);
  await expect(admin.getByTestId('tenant-row')).toHaveCount(1);
  await admin.getByTestId('tenant-row').getByRole('link').click();
  await expect(admin.getByTestId('sub-summary')).toContainText('Pro');

  // Read-only impersonation: banner shown, writes refused by the API.
  await admin.getByRole('button', { name: 'View as owner (read-only)' }).click();
  await expect(admin.getByTestId('impersonation-banner')).toContainText(company);
  await admin.getByRole('link', { name: 'Team' }).click();
  await expect(admin.getByRole('heading', { name: 'Team' })).toBeVisible();
  await admin.getByRole('button', { name: 'Invite user' }).click();
  await admin.getByLabel('Email').fill(`blocked-${stamp}@example.com`);
  await admin.getByRole('button', { name: 'Create invite' }).click();
  await expect(
    admin.getByRole('alert').filter({ hasText: 'Read-only impersonation' }),
  ).toBeVisible();
  await admin.getByTestId('impersonation-banner').getByRole('button', { name: 'Exit' }).click();
  await expect(admin.getByTestId('impersonation-banner')).toHaveCount(0);
  await expect(admin.getByTestId('whoami')).toContainText('SUPER_ADMIN');

  // Suspension takes effect on the tenant's next request.
  await admin.goto('/admin/tenants');
  await admin.getByLabel('Search').fill(company);
  await admin.getByTestId('tenant-row').getByRole('link').click();
  await admin.getByRole('button', { name: 'Suspend' }).click();
  await expect(admin.getByTestId('tenant-status')).toContainText('SUSPENDED');
  await page.getByRole('link', { name: 'Billing' }).click();
  await expect(page.getByTestId('suspended')).toBeVisible();

  // Reactivate restores access.
  await admin.getByRole('button', { name: 'Reactivate' }).click();
  await expect(admin.getByTestId('tenant-status')).toContainText('ACTIVE');
  await page.reload();
  await expect(page.getByTestId('whoami')).toBeVisible();
  await page.getByRole('link', { name: 'Billing' }).click();
  await expect(page.getByTestId('current-plan')).toContainText('Pro');
  await adminCtx.close();
});

test('downgrade is blocked while over the new plan’s limits, with a clear list', async ({
  page,
}) => {
  const stamp = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(`Down Co ${stamp}`);
  await page.getByLabel('Your name').fill('Dee Owner');
  await page.getByLabel('Email').fill(`down-${stamp}@example.com`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByRole('link', { name: 'Billing' }).click();
  await page.getByRole('button', { name: 'Choose Pro' }).click();
  await expect(page.getByTestId('change-result')).toContainText('Payment successful');

  // Invite 2 users (3 total) so Free (2 users) no longer fits.
  await page.getByRole('link', { name: 'Team' }).click();
  for (const n of ['a', 'b']) {
    await page.getByRole('button', { name: 'Invite user' }).click();
    await page.getByLabel('Email').fill(`${n}-${stamp}@example.com`);
    await page.getByRole('button', { name: 'Create invite' }).click();
    await expect(page.getByTestId(`invite-${n}-${stamp}@example.com`)).toBeVisible();
  }
  await page.getByRole('link', { name: 'Billing' }).click();
  await page.getByRole('button', { name: 'Choose Free' }).click();
  await expect(page.getByTestId('change-error')).toContainText(
    'Users: you have 3, the new plan allows 2',
  );
  await expect(page.getByTestId('current-plan')).toContainText('Pro');
});

test('Free plan blocks the 3rd seat with an upgrade message (402)', async ({ page }) => {
  const stamp = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(`Free Co ${stamp}`);
  await page.getByLabel('Your name').fill('Fay Owner');
  await page.getByLabel('Email').fill(`free-${stamp}@example.com`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByRole('link', { name: 'Billing' }).click();
  await page.getByRole('button', { name: 'Choose Free' }).click();
  await expect(page.getByTestId('current-plan')).toContainText('Free');
  await page.getByRole('link', { name: 'Team' }).click();
  await page.getByRole('button', { name: 'Invite user' }).click();
  await page.getByLabel('Email').fill(`one-${stamp}@example.com`);
  await page.getByRole('button', { name: 'Create invite' }).click();
  await expect(page.getByTestId(`invite-one-${stamp}@example.com`)).toBeVisible();
  await page.getByRole('button', { name: 'Invite user' }).click();
  await page.getByLabel('Email').fill(`two-${stamp}@example.com`);
  await page.getByRole('button', { name: 'Create invite' }).click();
  await expect(page.getByRole('alert')).toContainText('Upgrade your plan');
});
