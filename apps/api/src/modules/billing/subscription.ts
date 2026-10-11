import { Prisma, type Plan, type Subscription } from '@prisma/client';
import {
  COUNT_METRICS,
  METRIC_LABELS,
  limitsSchema,
  type InvoiceDto,
  type Limits,
  type Metric,
  type SubscriptionDto,
} from '@supplycast/shared';
import { prisma } from '../../db/client';
import type { Tx } from '../../db/tx';
import { HttpError } from '../../middleware/errors';
import { addMonths, DAY_MS } from '../../lib/time';
import { notifyAdmins } from '../notifications/service';
import { createPaidInvoice, toInvoiceDto } from './invoices';
import { currentUsage, getEffectiveLimits, getUsageLines } from './limits';
import { ensureDefaultPlans, getPlanByCode, toPlanDto } from './plans';

export const TRIAL_DAYS = 14;

export async function createTrialSubscription(
  tx: Tx,
  tenantId: string,
  now = new Date(),
): Promise<Subscription> {
  const starter = await getPlanByCode('starter', tx);
  if (!starter) throw new Error('Starter plan missing');
  const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
  return tx.subscription.create({
    data: {
      tenantId,
      planId: starter.id,
      status: 'TRIALING',
      periodStart: now,
      periodEnd: trialEndsAt,
      trialEndsAt,
    } as never,
  });
}

export async function getSubscriptionView(
  tenantId: string,
  simulatedPayments: boolean,
  now = new Date(),
): Promise<SubscriptionDto> {
  const sub = await prisma.subscription.findUnique({
    where: { tenantId },
    include: { plan: true, pendingPlan: true },
  });
  if (!sub) throw new HttpError(404, 'NOT_FOUND', 'No subscription found');
  const trialMs =
    sub.status === 'TRIALING' && sub.trialEndsAt ? sub.trialEndsAt.getTime() - now.getTime() : null;
  return {
    status: sub.status,
    plan: toPlanDto(sub.plan),
    trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
    trialDaysLeft: trialMs === null ? null : Math.max(0, Math.ceil(trialMs / DAY_MS)),
    periodStart: sub.periodStart.toISOString(),
    periodEnd: sub.periodEnd.toISOString(),
    pendingPlan: sub.pendingPlan ? toPlanDto(sub.pendingPlan) : null,
    limits: await getEffectiveLimits(tenantId),
    usage: await getUsageLines(tenantId, now),
    simulatedPayments,
  };
}

export interface Overage {
  metric: Metric;
  label: string;
  limit: number;
  current: number;
  reduceBy: number;
}

/** Count-based usage that would exceed the target plan's limits. */
export async function findOverages(
  tenantId: string,
  target: Limits,
  now = new Date(),
): Promise<Overage[]> {
  const out: Overage[] = [];
  for (const metric of COUNT_METRICS) {
    const current = await currentUsage(tenantId, metric, now);
    if (current > target[metric]) {
      out.push({
        metric,
        label: METRIC_LABELS[metric],
        limit: target[metric],
        current,
        reduceBy: current - target[metric],
      });
    }
  }
  return out;
}

async function assertCanDowngrade(tenantId: string, target: Plan, now: Date) {
  const overages = await findOverages(tenantId, limitsSchema.parse(target.limits), now);
  if (overages.length) {
    throw new HttpError(
      409,
      'DOWNGRADE_BLOCKED',
      `You are over the ${target.name} plan limits. Reduce: ${overages.map((o) => `${o.label} by ${o.reduceBy}`).join(', ')}.`,
      { overages },
    );
  }
}

export interface ChangeResult {
  result: 'APPLIED' | 'SCHEDULED' | 'UNCHANGED';
  paymentStatus?: 'SUCCEEDED';
  message: string;
  invoice?: InvoiceDto;
}

/** Plans a tenant may pick for itself. Custom/inactive/private plans are assigned by the Super Admin. */
function assertSelectable(plan: Plan | null): asserts plan is Plan {
  if (!plan || !plan.isActive || !plan.isPublic || plan.isCustom) {
    throw new HttpError(400, 'PLAN_UNAVAILABLE', 'That plan is not available');
  }
}

export async function changePlan(
  tenantId: string,
  planCode: string,
  now = new Date(),
): Promise<ChangeResult> {
  await ensureDefaultPlans();
  const target = await getPlanByCode(planCode);
  assertSelectable(target);
  const sub = await prisma.subscription.findUnique({
    where: { tenantId },
    include: { plan: true },
  });
  if (!sub) throw new HttpError(404, 'NOT_FOUND', 'No subscription found');

  const startPaid = async (plan: Plan, status: 'ACTIVE', converted: boolean) =>
    prisma.$transaction(async (tx) => {
      const periodEnd = addMonths(now, 1);
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: {
          planId: plan.id,
          pendingPlanId: null,
          status,
          periodStart: now,
          periodEnd,
          customLimits: Prisma.DbNull,
          ...(converted && { convertedAt: now }),
        },
      });
      const invoice =
        plan.priceCents > 0
          ? await createPaidInvoice(tx, {
              tenantId,
              subscriptionId: sub.id,
              plan,
              periodStart: now,
              periodEnd,
              now,
            })
          : null;
      return { updated, invoice };
    });

  // Trial: picking a paid plan buys it now; picking Free ends the trial now.
  if (sub.status === 'TRIALING') {
    if (target.priceCents > 0) {
      const { invoice } = await startPaid(target, 'ACTIVE', true);
      await notifyAdmins(
        tenantId,
        'billing.plan_changed',
        `You are now on ${target.name}`,
        'Payment successful (simulated).',
      );
      return {
        result: 'APPLIED',
        paymentStatus: 'SUCCEEDED',
        message: `Payment successful. You are now on ${target.name}.`,
        invoice: invoice ? toInvoiceDto(invoice) : undefined,
      };
    }
    await assertCanDowngrade(tenantId, target, now);
    await startPaid(target, 'ACTIVE', false);
    return { result: 'APPLIED', message: `Your trial ended. You are now on ${target.name}.` };
  }

  if (target.id === sub.planId) {
    if (sub.pendingPlanId || sub.status === 'CANCELED') {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { pendingPlanId: null, status: 'ACTIVE' },
      });
      return {
        result: 'UNCHANGED',
        message: `Scheduled change cancelled. You stay on ${target.name}.`,
      };
    }
    throw new HttpError(400, 'ALREADY_ON_PLAN', `You are already on the ${target.name} plan`);
  }

  if (target.priceCents > sub.plan.priceCents) {
    const { invoice } = await startPaid(target, 'ACTIVE', false);
    await notifyAdmins(
      tenantId,
      'billing.plan_changed',
      `You are now on ${target.name}`,
      'Payment successful (simulated).',
    );
    return {
      result: 'APPLIED',
      paymentStatus: 'SUCCEEDED',
      message: `Payment successful. You are now on ${target.name}.`,
      invoice: invoice ? toInvoiceDto(invoice) : undefined,
    };
  }

  // Downgrade: only if usage fits, and it takes effect at the end of the paid period.
  await assertCanDowngrade(tenantId, target, now);
  await prisma.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: target.id } });
  return {
    result: 'SCHEDULED',
    message: `You will move to ${target.name} on ${sub.periodEnd.toISOString().slice(0, 10)}.`,
  };
}

export async function cancelSubscription(
  tenantId: string,
  now = new Date(),
): Promise<ChangeResult> {
  const free = await getPlanByCode('free');
  if (!free) throw new Error('Free plan missing');
  const sub = await prisma.subscription.findUnique({
    where: { tenantId },
    include: { plan: true },
  });
  if (!sub) throw new HttpError(404, 'NOT_FOUND', 'No subscription found');
  if (sub.status === 'TRIALING') return changePlan(tenantId, 'free', now);
  if (sub.planId === free.id)
    throw new HttpError(400, 'ALREADY_ON_PLAN', 'You are already on the Free plan');
  await assertCanDowngrade(tenantId, free, now);
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { pendingPlanId: free.id, status: 'CANCELED' },
  });
  return {
    result: 'SCHEDULED',
    message: `Your plan will be cancelled on ${sub.periodEnd.toISOString().slice(0, 10)} and you will move to Free.`,
  };
}

export interface MaintenanceSummary {
  trialsEnded: number;
  renewed: number;
  downgraded: number;
}

/** Daily job body: end expired trials, then renew/roll periods and apply scheduled downgrades. */
export async function runBillingMaintenance(now = new Date()): Promise<MaintenanceSummary> {
  const free = await getPlanByCode('free');
  if (!free) throw new Error('Free plan missing');
  const summary: MaintenanceSummary = { trialsEnded: 0, renewed: 0, downgraded: 0 };

  const trials = await prisma.subscription.findMany({
    where: { status: 'TRIALING', trialEndsAt: { lte: now } },
  });
  for (const sub of trials) {
    const claimed = await prisma.subscription.updateMany({
      where: { id: sub.id, status: 'TRIALING' },
      data: {
        planId: free.id,
        status: 'ACTIVE',
        periodStart: now,
        periodEnd: addMonths(now, 1),
        pendingPlanId: null,
      },
    });
    if (claimed.count !== 1) continue;
    summary.trialsEnded++;
    await notifyAdmins(
      sub.tenantId,
      'billing.trial_ended',
      'Your trial has ended',
      'You are now on the Free plan. Upgrade any time from the Billing page.',
    );
  }

  const due = await prisma.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'CANCELED', 'PAST_DUE'] }, periodEnd: { lte: now } },
    include: { plan: true, pendingPlan: true },
  });
  for (const sub of due) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.subscription.updateMany({
        where: { id: sub.id, periodEnd: sub.periodEnd },
        data: { updatedAt: now },
      });
      if (claimed.count !== 1) return;
      const plan = sub.pendingPlan ?? sub.plan;
      if (sub.pendingPlan) summary.downgraded++;
      let periodStart = sub.periodEnd;
      let periodEnd = addMonths(periodStart, 1);
      while (periodEnd <= now) {
        periodStart = periodEnd;
        periodEnd = addMonths(periodStart, 1);
      }
      await tx.subscription.update({
        where: { id: sub.id },
        data: { planId: plan.id, pendingPlanId: null, status: 'ACTIVE', periodStart, periodEnd },
      });
      if (plan.priceCents > 0) {
        await createPaidInvoice(tx, {
          tenantId: sub.tenantId,
          subscriptionId: sub.id,
          plan,
          periodStart,
          periodEnd,
          now,
          description: `${plan.name} plan renewal (simulated payment)`,
        });
        summary.renewed++;
      }
      if (sub.pendingPlan) {
        await notifyAdmins(
          sub.tenantId,
          'billing.downgraded',
          `You are now on ${plan.name}`,
          'Your scheduled plan change took effect.',
          tx,
        );
      }
    });
  }
  return summary;
}
