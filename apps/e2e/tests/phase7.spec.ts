import { expect, test } from '@playwright/test';

// Runs against the deterministic offline AI (AI_PROVIDER=fake); the real Gemini is never contacted.
test('Phase 7: explain a forecast → build a scenario from a sentence → confirm levers → run → summarise risks → ask the assistant', async ({
  page,
}) => {
  const stamp = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(`Phase7 Co ${stamp}`);
  await page.getByLabel('Your name').fill('Ivy Owner');
  await page.getByLabel('Email').fill(`p7-${stamp}@example.com`);
  await page.getByLabel('Password').fill('Password123');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.getByRole('button', { name: 'Load demo data' }).click();
  await expect(page.getByText(/Demo data loaded/)).toBeVisible();

  // A finished forecast is the starting point for everything AI.
  await page.getByRole('link', { name: 'Forecasts' }).click();
  await page.getByLabel('Horizon (weeks)').fill('12');
  await page.getByRole('button', { name: 'Run forecast' }).click();
  const row = page.locator('[data-testid^="run-"]').first();
  await expect(row).toContainText('DONE', { timeout: 60000 });
  await row.getByRole('link').click();

  // 1) Explain this forecast (second click is served from the saved insight).
  await page.getByRole('button', { name: 'Explain this forecast' }).click();
  const explanation = page.getByTestId('explanation');
  await expect(explanation).toContainText('AI explanation');
  await expect(explanation.getByTestId('confidence')).toContainText('Confidence: MEDIUM');
  await expect(explanation).toContainText('Main drivers');
  await expect(explanation).toContainText('Caveats');
  await expect(explanation.getByTestId('cached')).toHaveCount(0);
  await page.getByRole('button', { name: 'Explain this forecast' }).click();
  await expect(page.getByTestId('cached')).toContainText('no quota used');

  // 2) Natural-language scenario: nothing is saved until the planner confirms.
  await page.getByRole('link', { name: 'Scenarios' }).click();
  await expect(page.getByTestId('no-scenarios')).toBeVisible();
  const builder = page.getByRole('region', { name: 'Describe a scenario' });
  const proposal = page.getByTestId('proposal');

  // An unknown supplier is shown as unresolved, never guessed — and still nothing is saved.
  await builder.getByLabel(/What if/).fill('What if Globex Foods is 2 weeks late');
  await builder.getByRole('button', { name: 'Propose levers' }).click();
  await expect(proposal.getByTestId('unresolved')).toContainText('supplier "Globex Foods"');
  await expect(proposal.getByTestId('proposed-lever')).toHaveCount(0);
  await expect(page.getByTestId('no-scenarios')).toBeVisible();

  // A clean sentence becomes two proposed levers using this account's real names.
  await builder
    .getByLabel(/What if/)
    .fill('What if Acme Supplies is 3 weeks late and demand for Snacks rises 15%');
  await builder.getByRole('button', { name: 'Propose levers' }).click();
  await expect(proposal.getByTestId('proposed-lever')).toHaveCount(2);
  await expect(proposal.getByTestId('proposed-lever').first()).toContainText(
    'Acme Supplies is 21 days late',
  );
  await expect(proposal.getByTestId('proposed-lever').nth(1)).toContainText(
    'Demand +15% for category Snacks',
  );
  await expect(proposal).toContainText('Nothing is saved until you confirm.');
  await expect(page.getByTestId('no-scenarios')).toBeVisible();

  // Review and edit: make it 4 weeks late, then confirm.
  await proposal.getByLabel(/Days late for/).fill('28');
  await proposal.getByLabel('Scenario name').fill('Acme late + snack surge');
  await proposal.getByRole('button', { name: 'Confirm and create scenario (2 levers)' }).click();
  await expect(page.getByRole('heading', { name: 'Acme late + snack surge' })).toBeVisible();
  await expect(page.getByTestId('lever')).toHaveCount(2);
  await expect(page.getByTestId('lever').first()).toContainText('Acme Supplies is 28 days late');

  // 3) Run it and summarise the risks.
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.getByTestId('kpi-cards')).toBeVisible({ timeout: 60000 });
  await page.getByRole('button', { name: 'Summarise risks' }).click();
  const summary = page.getByTestId('risk-summary');
  await expect(summary).toContainText('Executive summary');
  await expect(summary.getByTestId('severity')).toContainText('Risk:');
  await expect(summary.getByTestId('risk-actions').getByRole('listitem')).toHaveCount(3);

  // 4) The assistant panel.
  await page.getByRole('button', { name: 'Ask AI' }).click();
  const panel = page.getByRole('complementary', { name: 'AI assistant' });
  await panel.getByLabel('Your question').fill('Which products have the worst forecast accuracy?');
  await panel.getByRole('button', { name: 'Ask' }).click();
  await expect(panel.getByTestId('turn-assistant')).toBeVisible();
  await expect(panel.getByTestId('turn-user')).toContainText('worst forecast accuracy');
  await panel.getByRole('button', { name: 'Close assistant' }).click();
  await expect(panel).toHaveCount(0);

  // 5) AI usage is metered on the billing page: explain + builder×2 + risk + assistant = 5 requests.
  await page.getByRole('link', { name: 'Billing' }).click();
  await expect(page.getByTestId('usage-aiRequests')).toContainText(/\d+ \/ 300/);
  const used = Number(
    (await page.getByTestId('usage-aiRequests').innerText()).split('/')[0]!.trim(),
  );
  expect(used).toBe(5);

  // Viewers get no AI controls.
  await page.getByRole('link', { name: 'Team' }).click();
  await page.getByRole('button', { name: 'Invite user' }).click();
  await page.getByLabel('Email').fill(`viewer-${stamp}@example.com`);
  await page.getByLabel('Role').selectOption('VIEWER');
  await page.getByRole('button', { name: 'Create invite' }).click();
  const link = await page.getByTestId('copy-link').getByLabel('Link').inputValue();
  const viewerCtx = await page
    .context()
    .browser()!
    .newContext({ baseURL: new URL(page.url()).origin });
  const viewer = await viewerCtx.newPage();
  await viewer.goto(link);
  await viewer.getByLabel('Your name').fill('Vic Viewer');
  await viewer.getByLabel('Choose a password').fill('Password123');
  await viewer.getByRole('button', { name: 'Join team' }).click();
  await expect(viewer.getByTestId('whoami')).toContainText('VIEWER');
  await expect(viewer.getByRole('button', { name: 'Ask AI' })).toHaveCount(0);
  await viewer.goto('/forecasts');
  await viewer.locator('[data-testid^="run-"]').first().getByRole('link').click();
  await expect(viewer.getByTestId('series-summary')).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Explain this forecast' })).toHaveCount(0);
  await viewerCtx.close();
});
