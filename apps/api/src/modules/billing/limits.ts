import type { RequestHandler } from 'express';
import {
  COUNT_METRICS,
  customLimitsSchema,
  limitsSchema,
  METRICS,
  METRIC_LABELS,
  type Limits,
  type Metric,
  type UsageLine,
} from '@supplycast/shared';
import { prisma } from '../../db/client';
import type { Tx } from '../../db/tx';
import { HttpError } from '../../middleware/errors';
import { periodStartOf } from '../../lib/time';
import { notifyAdmins } from '../notifications/service';
import { FALLBACK_LIMITS } from './plans';

type Counter = (tenantId: string, db: Tx) => Promise<number>;

/**
 * Count-based metrics are measured from live rows. Features register their counter when their
 * module loads (SKUs, locations, scenarios); unregistered metrics count as 0.
 */
const liveCounters = new Map<Metric, Counter>();
export function registerLiveCounter(metric: Metric, fn: Counter) {
  liveCounters.set(metric, fn);
}

registerLiveCounter('users', async (tenantId, db) => {
  const [active, pending] = await Promise.all([
    db.user.count({ where: { tenantId, isActive: true } }),
    db.invite.count({ where: { tenantId, acceptedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  return active + pending;
});

export async function getEffectiveLimits(tenantId: string, db: Tx = prisma): Promise<Limits> {
  const sub = await db.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
  if (!sub) return FALLBACK_LIMITS;
  const base = limitsSchema.parse(sub.plan.limits);
  const custom = sub.customLimits ? customLimitsSchema.parse(sub.customLimits) : {};
  return { ...base, ...custom };
}

export async function currentUsage(
  tenantId: string,
  metric: Metric,
  now = new Date(),
  db: Tx = prisma,
): Promise<number> {
  if ((COUNT_METRICS as readonly string[]).includes(metric)) {
    return (await liveCounters.get(metric)?.(tenantId, db)) ?? 0;
  }
  const row = await db.usageCounter.findFirst({
    where: { tenantId, metric, periodStart: periodStartOf(now) },
  });
  return row?.count ?? 0;
}

export async function getUsageLines(
  tenantId: string,
  now = new Date(),
  db: Tx = prisma,
): Promise<UsageLine[]> {
  const limits = await getEffectiveLimits(tenantId, db);
  return Promise.all(
    METRICS.map(async (metric) => ({
      metric,
      limit: limits[metric],
      current: await currentUsage(tenantId, metric, now, db),
    })),
  );
}

function limitError(metric: Metric, limit: number, current: number) {
  return new HttpError(
    402,
    'PLAN_LIMIT_REACHED',
    `Your plan allows ${limit} ${METRIC_LABELS[metric].toLowerCase()}. Upgrade your plan to continue.`,
    { metric, limit, current, upgradeUrl: '/billing' },
  );
}

/** Serialises limit-sensitive work per tenant by locking the tenant row for the transaction. */
export async function withTenantLock<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM Tenant WHERE id = ${tenantId} FOR UPDATE`;
      return fn(tx);
    },
    { timeout: 15000 },
  );
}

async function notifyThresholds(
  tenantId: string,
  metric: Metric,
  limit: number,
  before: number,
  after: number,
  now: Date,
) {
  if (limit <= 0) return;
  for (const level of [80, 100]) {
    const crossed = (before * 100) / limit < level && (after * 100) / limit >= level;
    if (!crossed) continue;
    const type = `usage.${metric}.${level}`;
    const already = await prisma.notification.findFirst({
      where: { tenantId, type, createdAt: { gte: periodStartOf(now) } },
    });
    if (already) continue;
    await notifyAdmins(
      tenantId,
      type,
      `${METRIC_LABELS[metric]} at ${level}% of your plan`,
      level === 100
        ? `You have reached your plan limit of ${limit}. Upgrade to keep going.`
        : `You have used ${after} of ${limit}. Consider upgrading soon.`,
    );
  }
}

/**
 * Atomically creates something that counts against a count-based limit (users, SKUs, locations,
 * scenarios): locks the tenant, checks live usage, runs `create`, commits. Concurrent requests
 * cannot overshoot the limit.
 */
export async function createWithinLimit<T>(
  tenantId: string,
  metric: Metric,
  create: (tx: Tx) => Promise<T>,
  opts: { by?: number; now?: Date; beforeCount?: (tx: Tx) => Promise<void> } = {},
): Promise<T> {
  const by = opts.by ?? 1;
  const now = opts.now ?? new Date();
  const out = await withTenantLock(tenantId, async (tx) => {
    await opts.beforeCount?.(tx);
    const limit = (await getEffectiveLimits(tenantId, tx))[metric];
    const before = await currentUsage(tenantId, metric, now, tx);
    if (before + by > limit) throw limitError(metric, limit, before);
    const result = await create(tx);
    return { result, limit, before, after: before + by };
  });
  await notifyThresholds(tenantId, metric, out.limit, out.before, out.after, now);
  return out.result;
}

/**
 * Atomically reserves period usage (forecast runs, AI requests). Returns a `release` function
 * to give the unit back if the work failed (so only successful work is billed).
 */
export async function reserveUsage(
  tenantId: string,
  metric: Metric,
  opts: { by?: number; now?: Date; db?: Tx } = {},
): Promise<{ release: () => Promise<void> }> {
  const by = opts.by ?? 1;
  const now = opts.now ?? new Date();
  const periodStart = periodStartOf(now);
  const run = async (tx: Tx) => {
    const limit = (await getEffectiveLimits(tenantId, tx))[metric];
    await tx.usageCounter.upsert({
      where: { tenantId_metric_periodStart: { tenantId, metric, periodStart } },
      update: {},
      create: { tenantId, metric, periodStart, count: 0 },
    });
    const row = await tx.usageCounter.findFirstOrThrow({
      where: { tenantId, metric, periodStart },
    });
    if (row.count + by > limit) throw limitError(metric, limit, row.count);
    await tx.usageCounter.update({ where: { id: row.id }, data: { count: { increment: by } } });
    return { limit, before: row.count, after: row.count + by };
  };
  const out = opts.db
    ? await run(opts.db) // caller already holds the tenant lock inside its own transaction
    : await withTenantLock(tenantId, run);
  await notifyThresholds(tenantId, metric, out.limit, out.before, out.after, now);
  return {
    release: async () => {
      await prisma.usageCounter.updateMany({
        where: { tenantId, metric, periodStart, count: { gte: by } },
        data: { count: { decrement: by } },
      });
    },
  };
}

/** Plain increment for usage that was already checked (kept for completeness). */
export async function incrementUsage(
  tenantId: string,
  metric: Metric,
  by = 1,
  now = new Date(),
): Promise<void> {
  const periodStart = periodStartOf(now);
  await prisma.usageCounter.upsert({
    where: { tenantId_metric_periodStart: { tenantId, metric, periodStart } },
    update: { count: { increment: by } },
    create: { tenantId, metric, periodStart, count: by },
  });
}

/** Middleware: fail fast with 402 when the tenant is already at its limit for `metric`. */
export function checkLimit(metric: Metric, by = 1): RequestHandler {
  return async (req, _res, next) => {
    try {
      const tenantId = req.tenantId;
      if (!tenantId)
        throw new HttpError(403, 'TENANT_REQUIRED', 'This action requires a tenant account');
      const limit = (await getEffectiveLimits(tenantId))[metric];
      const current = await currentUsage(tenantId, metric);
      if (current + by > limit) throw limitError(metric, limit, current);
      next();
    } catch (err) {
      next(err);
    }
  };
}
