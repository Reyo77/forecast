import { DAY_MS } from '../lib/time';
import { runBillingMaintenance } from '../modules/billing/subscription';
import { processSalesImport } from '../modules/sales/service';
import { FORECAST_RUN_JOB, processForecastRun } from '../modules/forecast/service';
import { enqueueJob, ensureRecurringJob, registerJobHandler } from './runner';

export const BILLING_DAILY = 'billing.daily';

export const SALES_IMPORT = 'sales.import';

export function registerCoreJobHandlers() {
  registerJobHandler(FORECAST_RUN_JOB, async (job, { now }) => {
    await processForecastRun((job.payload as { runId: string }).runId, { now });
  });
  registerJobHandler(SALES_IMPORT, async (job, { now }) => {
    await processSalesImport((job.payload as { importId: string }).importId, now);
  });
  registerJobHandler(BILLING_DAILY, async (_job, { now }) => {
    await runBillingMaintenance(now);
    await enqueueJob({ type: BILLING_DAILY, runAfter: new Date(now.getTime() + DAY_MS) });
  });
}

export async function scheduleRecurringJobs() {
  await ensureRecurringJob(BILLING_DAILY);
}
