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

export const createCategory = (
  tenantId: string,
  over: { name?: string; parentId?: string | null } = {},
) =>
  prisma.category.create({
    data: { tenantId, name: over.name ?? `Category ${next()}`, parentId: over.parentId ?? null },
  });

export const createProduct = (
  tenantId: string,
  over: {
    sku?: string;
    name?: string;
    categoryId?: string | null;
    isActive?: boolean;
    isComponent?: boolean;
    unitCostCents?: number;
    unitPriceCents?: number;
  } = {},
) => {
  const n = next();
  return prisma.product.create({
    data: {
      tenantId,
      sku: over.sku ?? `SKU-${n}`,
      name: over.name ?? `Product ${n}`,
      categoryId: over.categoryId ?? null,
      isActive: over.isActive ?? true,
      isComponent: over.isComponent ?? false,
      unitCostCents: over.unitCostCents ?? 500,
      unitPriceCents: over.unitPriceCents ?? 1000,
    },
  });
};

export const createLocation = (
  tenantId: string,
  over: { code?: string; name?: string; type?: 'WAREHOUSE' | 'STORE' | 'PLANT' } = {},
) => {
  const n = next();
  return prisma.location.create({
    data: {
      tenantId,
      code: over.code ?? `LOC-${n}`,
      name: over.name ?? `Location ${n}`,
      type: over.type ?? 'WAREHOUSE',
    },
  });
};

export const createSupplier = (
  tenantId: string,
  over: { name?: string; defaultLeadTimeDays?: number } = {},
) =>
  prisma.supplier.create({
    data: {
      tenantId,
      name: over.name ?? `Supplier ${next()}`,
      defaultLeadTimeDays: over.defaultLeadTimeDays ?? 14,
    },
  });

export const createSupplierProduct = (
  tenantId: string,
  supplierId: string,
  productId: string,
  over: { leadTimeDays?: number; isPrimary?: boolean } = {},
) =>
  prisma.supplierProduct.create({
    data: {
      tenantId,
      supplierId,
      productId,
      leadTimeDays: over.leadTimeDays ?? 14,
      isPrimary: over.isPrimary ?? false,
    },
  });

export const createBomItem = (
  tenantId: string,
  parentProductId: string,
  componentProductId: string,
  quantityPer = 1,
) =>
  prisma.bomItem.create({ data: { tenantId, parentProductId, componentProductId, quantityPer } });

export const createInventory = (
  tenantId: string,
  productId: string,
  locationId: string,
  onHand = 100,
  safetyStock = 10,
) =>
  prisma.inventoryLevel.create({ data: { tenantId, productId, locationId, onHand, safetyStock } });

export const createOpenOrder = (
  tenantId: string,
  productId: string,
  locationId: string,
  over: { quantity?: number; expectedDate?: Date; supplierId?: string | null } = {},
) =>
  prisma.openOrder.create({
    data: {
      tenantId,
      productId,
      locationId,
      quantity: over.quantity ?? 50,
      expectedDate: over.expectedDate ?? new Date(Date.now() + 7 * 86400_000),
      supplierId: over.supplierId ?? null,
    },
  });
