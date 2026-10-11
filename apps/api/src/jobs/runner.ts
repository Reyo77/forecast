import type { Job, Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { logger } from '../config/logger';

export interface JobContext {
  now: Date;
}
export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

const handlers = new Map<string, JobHandler>();
export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 30_000;

export function registerJobHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export function enqueueJob(args: {
  type: string;
  tenantId?: string | null;
  payload?: Prisma.InputJsonValue;
  runAfter?: Date;
}) {
  return prisma.job.create({
    data: {
      type: args.type,
      tenantId: args.tenantId ?? null,
      payload: args.payload,
      runAfter: args.runAfter ?? new Date(),
    },
  });
}

/** Ensures exactly one pending/running job of a recurring type exists (survives restarts). */
export async function ensureRecurringJob(type: string, runAfter = new Date()) {
  const existing = await prisma.job.findFirst({
    where: { type, status: { in: ['PENDING', 'RUNNING'] } },
  });
  if (!existing) await enqueueJob({ type, runAfter });
}

/** Claims and runs one due job. Returns the job processed, or null when nothing was due. */
export async function runNextJob(now = new Date()): Promise<Job | null> {
  const candidate = await prisma.job.findFirst({
    where: { status: 'PENDING', runAfter: { lte: now } },
    orderBy: [{ runAfter: 'asc' }, { createdAt: 'asc' }],
  });
  if (!candidate) return null;
  const claimed = await prisma.job.updateMany({
    where: { id: candidate.id, status: 'PENDING' },
    data: { status: 'RUNNING', attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return runNextJob(now); // another worker took it
  const job = await prisma.job.findUniqueOrThrow({ where: { id: candidate.id } });
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
    await handler(job, { now });
    return await prisma.job.update({
      where: { id: job.id },
      data: { status: 'DONE', lastError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ jobId: job.id, type: job.type, err: message }, 'job failed');
    const final = job.attempts >= MAX_ATTEMPTS || !handler;
    return prisma.job.update({
      where: { id: job.id },
      data: {
        status: final ? 'FAILED' : 'PENDING',
        lastError: message.slice(0, 2000),
        runAfter: final ? job.runAfter : new Date(now.getTime() + BACKOFF_MS * job.attempts),
      },
    });
  }
}

export async function drainJobs(now = new Date(), limit = 100): Promise<number> {
  let n = 0;
  while (n < limit && (await runNextJob(now))) n++;
  return n;
}

/** Jobs left RUNNING by a crashed process are retried on start-up. */
export async function recoverStuckJobs() {
  await prisma.job.updateMany({ where: { status: 'RUNNING' }, data: { status: 'PENDING' } });
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

export function startWorker(intervalMs = 2000) {
  if (timer) return;
  void recoverStuckJobs();
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await drainJobs();
    } catch (err) {
      logger.error({ err }, 'worker tick failed');
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
