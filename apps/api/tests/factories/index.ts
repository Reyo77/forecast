import type { Role } from '@supplycast/shared';
import { prisma } from '../../src/db/client';
import { hashPassword } from '../../src/modules/auth/service';

export const TEST_PASSWORD = 'Password123';

let counter = 0;
const next = () => ++counter;

export function createTenant(overrides: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  const n = next();
  return prisma.tenant.create({
    data: {
      name: overrides.name ?? `Tenant ${n}`,
      slug: `tenant-${n}-${Date.now()}`,
      status: overrides.status,
    },
  });
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
