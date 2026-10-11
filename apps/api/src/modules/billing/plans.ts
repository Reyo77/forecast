import { DEFAULT_PLANS, limitsSchema, type Limits, type PlanDto } from '@supplycast/shared';
import type { Plan } from '@prisma/client';
import { prisma } from '../../db/client';
import type { Tx } from '../../db/tx';

export function toPlanDto(p: Plan): PlanDto {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    priceCents: p.priceCents,
    limits: limitsSchema.parse(p.limits),
    isActive: p.isActive,
    isPublic: p.isPublic,
    isCustom: p.isCustom,
    sortOrder: p.sortOrder,
  };
}

/** Creates the four default plans if they are missing. Existing (possibly edited) plans are left alone. */
export async function ensureDefaultPlans(db: Tx = prisma): Promise<void> {
  for (const p of DEFAULT_PLANS) {
    await db.plan.upsert({ where: { code: p.code }, update: {}, create: { ...p } });
  }
}

export async function getPlanByCode(code: string, db: Tx = prisma): Promise<Plan | null> {
  let plan = await db.plan.findUnique({ where: { code } });
  if (!plan && DEFAULT_PLANS.some((d) => d.code === code)) {
    await ensureDefaultPlans(db);
    plan = await db.plan.findUnique({ where: { code } });
  }
  return plan;
}

export const FALLBACK_LIMITS: Limits = DEFAULT_PLANS[0]!.limits;
