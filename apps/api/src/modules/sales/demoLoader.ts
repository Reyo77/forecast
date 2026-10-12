import { prisma } from '../../db/client';
import { HttpError } from '../../middleware/errors';
import { startOfWeekMonday } from '../../lib/time';
import { getEffectiveLimits } from '../billing/limits';
import { generateDemo } from './demo';

export const DEMO_SEED = 20260101;

/** Inserts the demo catalog, suppliers, BOMs, stock, open orders and weekly sales for a tenant. */
export async function loadDemoData(tenantId: string, now: Date) {
  const limits = await getEffectiveLimits(tenantId);
  const weeks = Math.max(26, Math.min(156, Math.floor((limits.historyMonths * 52) / 12)));
  const data = generateDemo({
    seed: DEMO_SEED,
    endDate: new Date(now.getTime() - 7 * 86400_000),
    weeks,
  });

  const [skuCount, locCount] = await Promise.all([
    prisma.product.count({ where: { tenantId, isActive: true } }),
    prisma.location.count({ where: { tenantId } }),
  ]);
  if (skuCount + data.products.length > limits.skus) {
    throw new HttpError(
      402,
      'PLAN_LIMIT_REACHED',
      `Demo data needs ${data.products.length} SKUs; your plan allows ${limits.skus}.`,
      { metric: 'skus', limit: limits.skus, current: skuCount, upgradeUrl: '/billing' },
    );
  }
  if (locCount + data.locations.length > limits.locations) {
    throw new HttpError(
      402,
      'PLAN_LIMIT_REACHED',
      `Demo data needs ${data.locations.length} locations; your plan allows ${limits.locations}.`,
      { metric: 'locations', limit: limits.locations, current: locCount, upgradeUrl: '/billing' },
    );
  }

  await prisma.$transaction(
    async (tx) => {
      const cats = new Map<string, string>();
      for (const c of data.categories.filter((c) => !c.parent)) {
        cats.set(c.name, (await tx.category.create({ data: { tenantId, name: c.name } })).id);
      }
      for (const c of data.categories.filter((c) => c.parent)) {
        cats.set(
          c.name,
          (
            await tx.category.create({
              data: { tenantId, name: c.name, parentId: cats.get(c.parent!)! },
            })
          ).id,
        );
      }
      const products = new Map<string, string>();
      for (const p of data.products) {
        const row = await tx.product.create({
          data: {
            tenantId,
            sku: p.sku,
            name: p.name,
            categoryId: cats.get(p.subCategory ?? p.category) ?? null,
            unitCostCents: p.unitCostCents,
            unitPriceCents: p.unitPriceCents,
            isComponent: p.isComponent,
          },
        });
        products.set(p.sku, row.id);
      }
      const locations = new Map<string, string>();
      for (const l of data.locations)
        locations.set(l.code, (await tx.location.create({ data: { tenantId, ...l } })).id);
      const suppliers = new Map<string, string>();
      for (const s of data.suppliers)
        suppliers.set(s.name, (await tx.supplier.create({ data: { tenantId, ...s } })).id);
      await tx.supplierProduct.createMany({
        data: data.supplierLinks.map((l) => ({
          tenantId,
          supplierId: suppliers.get(l.supplier)!,
          productId: products.get(l.sku)!,
          leadTimeDays: l.leadTimeDays,
          minOrderQty: l.minOrderQty,
          unitCostCents: l.unitCostCents,
          weeklyCapacity: l.weeklyCapacity,
          isPrimary: l.isPrimary,
        })),
      });
      await tx.bomItem.createMany({
        data: data.bom.map((b) => ({
          tenantId,
          parentProductId: products.get(b.parent)!,
          componentProductId: products.get(b.component)!,
          quantityPer: b.quantityPer,
        })),
      });
      await tx.inventoryLevel.createMany({
        data: data.inventory.map((i) => ({
          tenantId,
          productId: products.get(i.sku)!,
          locationId: locations.get(i.location)!,
          onHand: i.onHand,
          safetyStock: i.safetyStock,
        })),
      });
      const monday = startOfWeekMonday(now);
      await tx.openOrder.createMany({
        data: data.openOrders.map((o) => ({
          tenantId,
          productId: products.get(o.sku)!,
          locationId: locations.get(o.location)!,
          supplierId: suppliers.get(o.supplier)!,
          quantity: o.quantity,
          expectedDate: new Date(monday.getTime() + o.weeksFromNow * 7 * 86400_000),
        })),
      });
      for (let i = 0; i < data.sales.length; i += 1000) {
        await tx.salesRecord.createMany({
          data: data.sales.slice(i, i + 1000).map((s) => ({
            tenantId,
            productId: products.get(s.sku)!,
            locationId: locations.get(s.location)!,
            date: s.weekStart,
            quantity: s.quantity,
            revenueCents: s.revenueCents,
          })),
        });
      }
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  return {
    products: data.products.length,
    locations: data.locations.length,
    suppliers: data.suppliers.length,
    weeksOfSales: weeks,
    salesRows: data.sales.length,
  };
}
