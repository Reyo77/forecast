/**
 * Load test: forecast run on 1,000 SKUs × 3 locations × 3 years of weekly sales (3,000 series).
 * Uses the dev database and removes everything it creates. Run: npm run loadtest -w apps/api
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { prisma } from '../src/db/client';
import { addMonths } from '../src/lib/time';
import { ensureDefaultPlans } from '../src/modules/billing/plans';
import { createRun, processForecastRun } from '../src/modules/forecast/service';
import { processScenarioRun } from '../src/modules/scenarios/service';
import { createRng } from '../src/modules/sales/demo';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const SKUS = Number(process.env.LOAD_SKUS ?? 1000);
const LOCATIONS = 3;
const WEEKS = 156;
const WEEK = 7 * 86400_000;

const ms = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

async function main() {
  await ensureDefaultPlans();
  const pro = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } });
  const now = new Date();
  const tenant = await prisma.tenant.create({
    data: { name: 'Load test', slug: `loadtest-${now.getTime()}` },
  });
  await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: pro.id,
      status: 'ACTIVE',
      periodStart: now,
      periodEnd: addMonths(now, 1),
      customLimits: { skus: 10000, locations: 20, forecastRuns: 1000 },
    },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `loadtest-${now.getTime()}@example.com`,
      name: 'LT',
      role: 'OWNER',
      passwordHash: 'x',
    },
  });
  try {
    let t = Date.now();
    const locations = await Promise.all(
      Array.from({ length: LOCATIONS }, (_, i) =>
        prisma.location.create({
          data: { tenantId: tenant.id, code: `L${i}`, name: `Location ${i}` },
        }),
      ),
    );
    await prisma.product.createMany({
      data: Array.from({ length: SKUS }, (_, i) => ({
        tenantId: tenant.id,
        sku: `SKU-${String(i).padStart(5, '0')}`,
        name: `Product ${i}`,
        unitCostCents: 200,
        unitPriceCents: 500,
      })),
    });
    const products = await prisma.product.findMany({
      where: { tenantId: tenant.id },
      select: { id: true },
    });
    const rng = createRng(42);
    const end = Date.UTC(2026, 5, 1);
    let rows: {
      tenantId: string;
      productId: string;
      locationId: string;
      date: Date;
      quantity: number;
      revenueCents: number;
    }[] = [];
    let total = 0;
    const flush = async () => {
      if (rows.length) await prisma.salesRecord.createMany({ data: rows });
      total += rows.length;
      rows = [];
    };
    for (const p of products) {
      const base = 20 + rng.next() * 200;
      const amp = rng.next() * 0.5;
      const trend = (rng.next() - 0.4) * 0.3;
      for (const l of locations) {
        for (let w = 0; w < WEEKS; w++) {
          const q = Math.max(
            0,
            Math.round(
              base * (1 + amp * Math.sin((2 * Math.PI * w) / 52) + (trend * w) / 100) +
                rng.normal() * base * 0.08,
            ),
          );
          rows.push({
            tenantId: tenant.id,
            productId: p.id,
            locationId: l.id,
            date: new Date(end - (WEEKS - 1 - w) * WEEK),
            quantity: q,
            revenueCents: q * 500,
          });
          if (rows.length >= 5000) await flush();
        }
      }
    }
    await flush();
    console.log(
      `Seeded ${SKUS} SKUs × ${LOCATIONS} locations × ${WEEKS} weeks = ${total.toLocaleString()} sales rows in ${ms(t)}`,
    );

    t = Date.now();
    const run = await createRun(tenant.id, user.id, {
      horizonWeeks: 26,
      method: 'AUTO',
      filters: {},
    });
    await processForecastRun(run.id);
    const done = await prisma.forecastRun.findUniqueOrThrow({ where: { id: run.id } });
    const results = await prisma.forecastResult.count({ where: { runId: run.id } });
    console.log(
      `Forecast run: ${done.status}, ${done.seriesDone}/${done.seriesTotal} series (${done.seriesFailed} failed), ${results.toLocaleString()} result rows in ${ms(t)}`,
    );
    console.log(`Peak RSS: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);

    // A scenario on top of the same forecast (demand +20%) to time the planning engine too.
    t = Date.now();
    const scenario = await prisma.scenario.create({
      data: { tenantId: tenant.id, name: 'LT', baseForecastRunId: run.id },
    });
    await prisma.scenarioLever.create({
      data: {
        tenantId: tenant.id,
        scenarioId: scenario.id,
        type: 'DEMAND_CHANGE',
        target: { scope: 'ALL' },
        params: { percent: 20 },
      },
    });
    const sr = await prisma.scenarioRun.create({
      data: {
        tenantId: tenant.id,
        scenarioId: scenario.id,
        levers: [{ type: 'DEMAND_CHANGE', target: { scope: 'ALL' }, params: { percent: 20 } }],
      },
    });
    await processScenarioRun(sr.id);
    console.log(`Scenario run (3,000 nodes × 26 weeks × 2 variants): ${ms(t)}`);
  } finally {
    await prisma.tenant.delete({ where: { id: tenant.id } });
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
