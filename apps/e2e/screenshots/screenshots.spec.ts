import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const out = (name: string) => path.resolve(__dirname, '../../../docs/screenshots', `${name}.png`);
const email = process.env.DEMO_EMAIL ?? 'demo@supplycast.local';
const password = process.env.DEMO_PASSWORD ?? 'DemoPass12345';

async function api(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      const { accessToken } = await r.json();
      const res = await fetch(`/api${u}`, {
        method: m as string,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
      });
      return res.status === 204 ? null : res.json();
    },
    [method, url, body] as const,
  );
}

test('README screenshots from the demo tenant', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('whoami')).toBeVisible();

  // Make sure there is a finished forecast and two scenarios to show.
  let runs = (await api(page, 'GET', '/forecasts/runs?pageSize=1')).items as {
    id: string;
    status: string;
  }[];
  if (!runs.length || runs[0]!.status !== 'DONE') {
    await api(page, 'POST', '/forecasts/runs', { horizonWeeks: 26, method: 'AUTO', filters: {} });
    await expect
      .poll(
        async () =>
          (await api(page, 'GET', '/forecasts/runs?pageSize=1')).items[0]?.status as string,
        { timeout: 120_000 },
      )
      .toBe('DONE');
    runs = (await api(page, 'GET', '/forecasts/runs?pageSize=1')).items;
  }
  const runId = runs[0]!.id;
  const existing = (await api(page, 'GET', '/scenarios?pageSize=100')).items as {
    name: string;
    id: string;
  }[];
  if (existing.length < 2) {
    const suppliers = (await api(page, 'GET', '/suppliers?pageSize=100')).items as {
      id: string;
      name: string;
    }[];
    const acme = suppliers.find((s) => s.name === 'Acme Supplies')!;
    const a = (
      await api(page, 'POST', '/scenarios', {
        name: 'Acme Supplies 3 weeks late',
        baseForecastRunId: runId,
      })
    ).scenario.id;
    await api(page, 'POST', `/scenarios/${a}/levers`, {
      type: 'SUPPLIER_DELAY',
      target: { supplierId: acme.id },
      params: { extraDays: 21 },
    });
    await api(page, 'POST', `/scenarios/${a}/run`);
    const b = (
      await api(page, 'POST', '/scenarios', { name: 'Demand +25%', baseForecastRunId: runId })
    ).scenario.id;
    await api(page, 'POST', `/scenarios/${b}/levers`, {
      type: 'DEMAND_CHANGE',
      target: { scope: 'ALL' },
      params: { percent: 25 },
    });
    await api(page, 'POST', `/scenarios/${b}/run`);
    await expect
      .poll(
        async () =>
          ((await api(page, 'GET', '/scenarios?pageSize=100')).items as { status: string }[]).every(
            (s) => s.status === 'READY',
          ),
        { timeout: 120_000 },
      )
      .toBe(true);
  }
  const scenarios = (await api(page, 'GET', '/scenarios?pageSize=100')).items as {
    id: string;
    name: string;
  }[];

  await page.goto('/');
  await expect(page.getByTestId('card-accuracy')).toBeVisible();
  await page.screenshot({ path: out('dashboard'), fullPage: true });

  await page.goto('/sales');
  await page.getByLabel('Group by').selectOption('category');
  await expect(page.getByRole('img', { name: 'Line chart of weekly sales' })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out('sales-explorer'), fullPage: true });

  await page.goto(`/forecasts/${runId}`);
  await expect(page.getByTestId('series-summary')).toBeVisible();
  await page.getByTestId('acc-GFT-BOX-WH-EAST').click();
  await expect(page.getByTestId('series-summary')).toContainText('GFT-BOX');
  await page.waitForTimeout(800);
  await page.screenshot({ path: out('forecast'), fullPage: true });

  await page.goto(`/scenarios/${scenarios[0]!.id}`);
  await expect(page.getByTestId('kpi-cards')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out('scenario'), fullPage: true });

  await page.goto(
    `/scenarios/compare?ids=${scenarios
      .slice(0, 2)
      .map((s) => s.id)
      .join(',')}`,
  );
  await expect(page.getByTestId('kpi-compare')).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out('scenario-compare'), fullPage: true });

  await page.goto('/billing');
  await expect(page.getByTestId('current-plan')).toBeVisible();
  await page.screenshot({ path: out('billing'), fullPage: true });
  await page.goto('/products');
  await expect(page.getByTestId('product-GFT-BOX')).toBeVisible();
  await page.screenshot({ path: out('products'), fullPage: true });
  await page.goto('/pricing');
  await expect(page.getByTestId('plan-pro')).toBeVisible();
  await page.screenshot({ path: out('pricing'), fullPage: true });
});
