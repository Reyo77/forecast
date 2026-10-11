import { DAY_MS } from '../lib/time';
import { runBillingMaintenance } from '../modules/billing/subscription';
import { enqueueJob, ensureRecurringJob, registerJobHandler } from './runner';

export const BILLING_DAILY = 'billing.daily';

export function registerCoreJobHandlers() {
  registerJobHandler(BILLING_DAILY, async (_job, { now }) => {
    await runBillingMaintenance(now);
    await enqueueJob({ type: BILLING_DAILY, runAfter: new Date(now.getTime() + DAY_MS) });
  });
}

export async function scheduleRecurringJobs() {
  await ensureRecurringJob(BILLING_DAILY);
}
