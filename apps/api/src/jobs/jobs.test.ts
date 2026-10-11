import { prisma } from '../db/client';
import { resetDb } from '../../tests/helpers/db';
import { createTenant } from '../../tests/factories';
import { addMonths, DAY_MS } from '../lib/time';
import { BILLING_DAILY, registerCoreJobHandlers, scheduleRecurringJobs } from './handlers';
import {
  drainJobs,
  enqueueJob,
  ensureRecurringJob,
  MAX_ATTEMPTS,
  recoverStuckJobs,
  registerJobHandler,
  runNextJob,
} from './runner';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const now = new Date('2030-01-10T00:00:00Z');

describe('job runner', () => {
  it('runs due jobs in order and marks them DONE', async () => {
    const seen: string[] = [];
    registerJobHandler('t.ok', async (job) => void seen.push((job.payload as { n: string }).n));
    await enqueueJob({
      type: 't.ok',
      payload: { n: 'second' },
      runAfter: new Date(now.getTime() - 1000),
    });
    await enqueueJob({
      type: 't.ok',
      payload: { n: 'first' },
      runAfter: new Date(now.getTime() - 5000),
    });
    await enqueueJob({
      type: 't.ok',
      payload: { n: 'later' },
      runAfter: new Date(now.getTime() + 60000),
    });
    expect(await drainJobs(now)).toBe(2);
    expect(seen).toEqual(['first', 'second']);
    expect(await prisma.job.count({ where: { status: 'DONE' } })).toBe(2);
    expect(await prisma.job.count({ where: { status: 'PENDING' } })).toBe(1);
    expect(await runNextJob(now)).toBeNull();
  });

  it('retries a failing job with backoff, then marks it FAILED with the error message', async () => {
    registerJobHandler('t.fail', async () => {
      throw new Error('kaboom');
    });
    await enqueueJob({ type: 't.fail', runAfter: now });
    let t = now;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const job = await runNextJob(t);
      expect(job).not.toBeNull();
      expect(job!.attempts).toBe(i);
      expect(job!.lastError).toBe('kaboom');
      if (i < MAX_ATTEMPTS) {
        expect(job!.status).toBe('PENDING');
        expect(await runNextJob(t)).toBeNull(); // not due yet (backoff)
        t = new Date(job!.runAfter.getTime() + 1);
      } else {
        expect(job!.status).toBe('FAILED');
      }
    }
    expect(await runNextJob(new Date(t.getTime() + DAY_MS))).toBeNull();
  });

  it('fails jobs with no registered handler immediately', async () => {
    await enqueueJob({ type: 't.unknown', runAfter: now });
    const job = await runNextJob(now);
    expect(job!.status).toBe('FAILED');
    expect(job!.lastError).toMatch(/No handler/);
  });

  it('two workers never process the same job twice', async () => {
    let runs = 0;
    registerJobHandler('t.once', async () => {
      runs++;
    });
    await enqueueJob({ type: 't.once', runAfter: now });
    await Promise.all([runNextJob(now), runNextJob(now), runNextJob(now)]);
    expect(runs).toBe(1);
  });

  it('recovers jobs left RUNNING by a crash', async () => {
    const j = await prisma.job.create({ data: { type: 't.ok', status: 'RUNNING' } });
    await recoverStuckJobs();
    expect((await prisma.job.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('PENDING');
  });

  it('ensureRecurringJob creates a single pending job', async () => {
    await ensureRecurringJob('t.recurring');
    await ensureRecurringJob('t.recurring');
    expect(await prisma.job.count({ where: { type: 't.recurring' } })).toBe(1);
  });
});

describe('billing.daily job', () => {
  it('ends expired trials, applies renewals and re-schedules itself 24h later', async () => {
    registerCoreJobHandlers();
    const trial = await createTenant({ plan: 'starter' });
    await prisma.subscription.update({
      where: { tenantId: trial.id },
      data: { status: 'TRIALING', trialEndsAt: new Date(now.getTime() - 1000) },
    });
    const paid = await createTenant({ plan: 'pro' });
    await prisma.subscription.update({
      where: { tenantId: paid.id },
      data: { periodStart: addMonths(now, -1), periodEnd: new Date(now.getTime() - 1000) },
    });
    await scheduleRecurringJobs();
    await prisma.job.updateMany({ data: { runAfter: now } });

    const job = await runNextJob(now);
    expect(job!.status).toBe('DONE');
    expect(
      (
        await prisma.subscription.findUniqueOrThrow({
          where: { tenantId: trial.id },
          include: { plan: true },
        })
      ).plan.code,
    ).toBe('free');
    expect(await prisma.invoice.count({ where: { tenantId: paid.id } })).toBe(1);
    const next = await prisma.job.findFirstOrThrow({
      where: { type: BILLING_DAILY, status: 'PENDING' },
    });
    expect(next.runAfter.getTime()).toBe(now.getTime() + DAY_MS);
  });
});
