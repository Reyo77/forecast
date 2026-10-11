import type { Role } from '@supplycast/shared';
import { prisma } from '../../src/db/client';
import { hashPassword } from '../../src/modules/auth/service';
import { ensureDefaultPlans } from '../../src/modules/billing/plans';
import { addMonths } from '../../src/lib/time';

export const TEST_PASSWORD = 'Password123';

let counter = 0;
const next = () => ++counter;

export async function createTenant(
  overrides: { name?: string; status?: 'ACTIVE' | 'SUSPENDED'; plan?: string } = {},
) {
  const n = next();
  const tenant = await prisma.tenant.create({
    data: {
      name: overrides.name ?? `Tenant ${n}`,
      slug: `tenant-${n}-${Date.now()}`,
      status: overrides.status,
    },
  });
  await ensureDefaultPlans();
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: overrides.plan ?? 'pro' } });
  const now = new Date();
  await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: 'ACTIVE',
      periodStart: now,
      periodEnd: addMonths(now, 1),
    } as never,
  });
  return tenant;
}

export async function createUser(
  opts: {
    role?: Role;
    tenantId?: string | null;
    email?: string;
    password?: string;
    isActive?: boolean;
  } = {},
) {
  const role = opts.role ?? 'PLANNER';
  const tenantId =
    opts.tenantId !== undefined
      ? opts.tenantId
      : role === 'SUPER_ADMIN'
        ? null
        : (await createTenant()).id;
  return prisma.user.create({
    data: {
      email: opts.email ?? `user${next()}@example.com`,
      name: `User ${counter}`,
      passwordHash: await hashPassword(opts.password ?? TEST_PASSWORD),
      role,
      tenantId,
      isActive: opts.isActive ?? true,
    },
  });
}
