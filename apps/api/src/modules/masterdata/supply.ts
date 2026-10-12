import { Router } from 'express';
import {
  bomInputSchema,
  bomPatchSchema,
  inventoryInputSchema,
  openOrderInputSchema,
  openOrderPatchSchema,
  supplierInputSchema,
  supplierPatchSchema,
  supplierProductInputSchema,
  supplierProductPatchSchema,
  type BomNode,
  type InventoryDto,
  type OpenOrderDto,
  type SupplierDto,
  type SupplierProductDto,
} from '@supplycast/shared';
import type { Supplier, SupplierProduct, Product } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/client';
import type { ScopedClient } from '../../db/scoped';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';
import {
  buildBomTree,
  wouldCreateCycle,
  type BomEdge,
  type BomTreeNode,
} from '../../engines/planning/bom';
import { auditReq } from '../audit/service';
import { isUniqueViolation, num } from './common';

type Db = ScopedClient;

const toSupplierDto = (s: Supplier): SupplierDto => ({
  id: s.id,
  name: s.name,
  defaultLeadTimeDays: s.defaultLeadTimeDays,
  reliabilityPct: num(s.reliabilityPct),
});
const toSpDto = (
  sp: SupplierProduct & { supplier?: Supplier; product?: Product },
): SupplierProductDto => ({
  id: sp.id,
  supplierId: sp.supplierId,
  supplierName: sp.supplier?.name,
  productId: sp.productId,
  productSku: sp.product?.sku,
  productName: sp.product?.name,
  leadTimeDays: sp.leadTimeDays,
  minOrderQty: num(sp.minOrderQty),
  unitCostCents: sp.unitCostCents,
  weeklyCapacity: sp.weeklyCapacity === null ? null : num(sp.weeklyCapacity),
  isPrimary: sp.isPrimary,
});

async function mustFind<T>(p: Promise<T | null>, what: string): Promise<T> {
  const row = await p;
  if (!row) throw new HttpError(404, 'NOT_FOUND', `${what} not found`);
  return row;
}

export function supplyRouter(guards: Guards): Router {
  const router = Router();
  const read = guards.tenant('masterdata:read');
  const write = guards.tenant('masterdata:write');
  const invWrite = guards.tenant('inventory:write');
  const wrap = <T extends (...a: never[]) => Promise<unknown>>(fn: T) => fn;
  void wrap;

  // ---------------- Suppliers ----------------
  router.get('/suppliers', ...read, async (req, res, next) => {
    try {
      const p = paginationSchema.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.supplier.findMany({ orderBy: { name: 'asc' }, ...skipTake(p) }),
        req.db!.supplier.count(),
      ]);
      res.json(paged(rows.map(toSupplierDto), total, p));
    } catch (e) {
      next(e);
    }
  });
  router.get('/suppliers/:id', ...read, async (req, res, next) => {
    try {
      res.json({
        supplier: toSupplierDto(
          await mustFind(req.db!.supplier.findUnique({ where: { id: req.params.id } }), 'Supplier'),
        ),
      });
    } catch (e) {
      next(e);
    }
  });
  router.post('/suppliers', ...write, async (req, res, next) => {
    try {
      const input = supplierInputSchema.parse(req.body);
      const s = await req.db!.supplier.create({ data: input as never });
      await auditReq(req, 'supplier.created', 'Supplier', s.id, { name: s.name });
      res.status(201).json({ supplier: toSupplierDto(s) });
    } catch (e) {
      next(e);
    }
  });
  router.patch('/suppliers/:id', ...write, async (req, res, next) => {
    try {
      const input = supplierPatchSchema.parse(req.body);
      const s = await mustFind(
        req.db!.supplier.findUnique({ where: { id: req.params.id } }),
        'Supplier',
      );
      res.json({
        supplier: toSupplierDto(
          await req.db!.supplier.update({ where: { id: s.id }, data: input }),
        ),
      });
    } catch (e) {
      next(e);
    }
  });
  router.delete('/suppliers/:id', ...write, async (req, res, next) => {
    try {
      const s = await mustFind(
        req.db!.supplier.findUnique({ where: { id: req.params.id } }),
        'Supplier',
      );
      await req.db!.supplier.delete({ where: { id: s.id } });
      await auditReq(req, 'supplier.deleted', 'Supplier', s.id, { name: s.name });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Supplier ↔ product links ----------------
  async function setPrimary(db: Db, productId: string, keepId: string) {
    await db.supplierProduct.updateMany({
      where: { productId, id: { not: keepId } },
      data: { isPrimary: false },
    });
  }

  router.get('/suppliers/:id/products', ...read, async (req, res, next) => {
    try {
      const s = await mustFind(
        req.db!.supplier.findUnique({ where: { id: req.params.id } }),
        'Supplier',
      );
      const rows = await req.db!.supplierProduct.findMany({
        where: { supplierId: s.id },
        include: { product: true, supplier: true },
        orderBy: { createdAt: 'asc' },
      });
      res.json({ items: rows.map(toSpDto) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/products/:id/suppliers', ...read, async (req, res, next) => {
    try {
      const p = await mustFind(
        req.db!.product.findUnique({ where: { id: req.params.id } }),
        'Product',
      );
      const rows = await req.db!.supplierProduct.findMany({
        where: { productId: p.id },
        include: { product: true, supplier: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      });
      res.json({ items: rows.map(toSpDto) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/suppliers/:id/products', ...write, async (req, res, next) => {
    try {
      const input = supplierProductInputSchema.parse(req.body);
      const s = await mustFind(
        req.db!.supplier.findUnique({ where: { id: req.params.id } }),
        'Supplier',
      );
      const p = await mustFind(
        req.db!.product.findUnique({ where: { id: input.productId } }),
        'Product',
      );
      const hasPrimary = await req.db!.supplierProduct.count({
        where: { productId: p.id, isPrimary: true },
      });
      const created = await req.db!.supplierProduct.create({
        // The first supplier of a product becomes its primary automatically.
        data: {
          ...input,
          supplierId: s.id,
          isPrimary: input.isPrimary || hasPrimary === 0,
        } as never,
        include: { product: true, supplier: true },
      });
      if (created.isPrimary) await setPrimary(req.db!, p.id, created.id);
      res.status(201).json({ link: toSpDto(created) });
    } catch (e) {
      next(
        isUniqueViolation(e)
          ? new HttpError(409, 'LINK_EXISTS', 'This supplier already supplies this product')
          : e,
      );
    }
  });

  router.patch('/supplier-products/:id', ...write, async (req, res, next) => {
    try {
      const input = supplierProductPatchSchema.parse(req.body);
      const link = await mustFind(
        req.db!.supplierProduct.findUnique({ where: { id: req.params.id } }),
        'Supplier link',
      );
      const updated = await req.db!.supplierProduct.update({
        where: { id: link.id },
        data: input,
        include: { product: true, supplier: true },
      });
      if (input.isPrimary) await setPrimary(req.db!, link.productId, link.id);
      res.json({ link: toSpDto(updated) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/supplier-products/:id', ...write, async (req, res, next) => {
    try {
      const link = await mustFind(
        req.db!.supplierProduct.findUnique({ where: { id: req.params.id } }),
        'Supplier link',
      );
      await req.db!.supplierProduct.delete({ where: { id: link.id } });
      if (link.isPrimary) {
        const next1 = await req.db!.supplierProduct.findFirst({
          where: { productId: link.productId },
          orderBy: { createdAt: 'asc' },
        });
        if (next1)
          await req.db!.supplierProduct.update({
            where: { id: next1.id },
            data: { isPrimary: true },
          });
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Bill of materials ----------------
  const loadEdges = async (db: Db): Promise<(BomEdge & { id: string })[]> =>
    (await db.bomItem.findMany()).map((b) => ({
      id: b.id,
      parentId: b.parentProductId,
      componentId: b.componentProductId,
      quantityPer: num(b.quantityPer),
    }));

  router.get('/products/:id/bom', ...read, async (req, res, next) => {
    try {
      const root = await mustFind(
        req.db!.product.findUnique({ where: { id: req.params.id } }),
        'Product',
      );
      const edges = await loadEdges(req.db!);
      const tree = buildBomTree(edges, root.id);
      const ids = new Set<string>();
      const collect = (nodes: BomTreeNode[]) =>
        nodes.forEach((n) => (ids.add(n.productId), collect(n.children)));
      collect(tree);
      const products = await req.db!.product.findMany({ where: { id: { in: [...ids] } } });
      const byId = new Map(products.map((p) => [p.id, p]));
      const toNode = (n: BomTreeNode): BomNode => ({
        productId: n.productId,
        sku: byId.get(n.productId)?.sku ?? '?',
        name: byId.get(n.productId)?.name ?? '?',
        quantityPer: n.quantityPer,
        totalQuantity: n.totalQuantity,
        bomItemId: n.edgeId ?? null,
        children: n.children.map(toNode),
      });
      res.json({
        product: { id: root.id, sku: root.sku, name: root.name },
        tree: tree.map(toNode),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/bom', ...write, async (req, res, next) => {
    try {
      const input = bomInputSchema.parse(req.body);
      const [parent, component] = await Promise.all([
        mustFind(
          req.db!.product.findUnique({ where: { id: input.parentProductId } }),
          'Parent product',
        ),
        mustFind(
          req.db!.product.findUnique({ where: { id: input.componentProductId } }),
          'Component product',
        ),
      ]);
      if (wouldCreateCycle(await loadEdges(req.db!), parent.id, component.id)) {
        throw new HttpError(
          400,
          'BOM_CYCLE',
          `Adding ${component.sku} to ${parent.sku} would create a cycle (a product cannot contain itself, directly or indirectly)`,
        );
      }
      const item = await req.db!.bomItem.create({
        data: {
          parentProductId: parent.id,
          componentProductId: component.id,
          quantityPer: input.quantityPer,
        } as never,
      });
      res.status(201).json({
        item: {
          id: item.id,
          parentProductId: parent.id,
          componentProductId: component.id,
          quantityPer: num(item.quantityPer),
        },
      });
    } catch (e) {
      next(
        isUniqueViolation(e)
          ? new HttpError(409, 'BOM_EXISTS', 'This component is already in the bill of materials')
          : e,
      );
    }
  });

  router.patch('/bom/:id', ...write, async (req, res, next) => {
    try {
      const { quantityPer } = bomPatchSchema.parse(req.body);
      const item = await mustFind(
        req.db!.bomItem.findUnique({ where: { id: req.params.id } }),
        'BOM item',
      );
      const updated = await req.db!.bomItem.update({
        where: { id: item.id },
        data: { quantityPer },
      });
      res.json({ item: { id: updated.id, quantityPer: num(updated.quantityPer) } });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/bom/:id', ...write, async (req, res, next) => {
    try {
      const item = await mustFind(
        req.db!.bomItem.findUnique({ where: { id: req.params.id } }),
        'BOM item',
      );
      await req.db!.bomItem.delete({ where: { id: item.id } });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Inventory levels ----------------
  const invQuery = paginationSchema.extend({
    productId: z.string().max(64).optional(),
    locationId: z.string().max(64).optional(),
  });
  const toInvDto = (i: {
    id: string;
    productId: string;
    locationId: string;
    onHand: unknown;
    safetyStock: unknown;
    asOfDate: Date;
    product: Product;
    location: { code: string };
  }): InventoryDto => ({
    id: i.id,
    productId: i.productId,
    productSku: i.product.sku,
    productName: i.product.name,
    locationId: i.locationId,
    locationCode: i.location.code,
    onHand: num(i.onHand as number),
    safetyStock: num(i.safetyStock as number),
    asOfDate: i.asOfDate.toISOString(),
  });

  router.get('/inventory', ...read, async (req, res, next) => {
    try {
      const q = invQuery.parse(req.query);
      const where = {
        ...(q.productId && { productId: q.productId }),
        ...(q.locationId && { locationId: q.locationId }),
      };
      const [rows, total] = await Promise.all([
        req.db!.inventoryLevel.findMany({
          where,
          include: { product: true, location: true },
          orderBy: [{ product: { sku: 'asc' } }],
          ...skipTake(q),
        }),
        req.db!.inventoryLevel.count({ where }),
      ]);
      res.json(paged(rows.map(toInvDto), total, q));
    } catch (e) {
      next(e);
    }
  });

  router.put('/inventory', ...invWrite, async (req, res, next) => {
    try {
      const input = inventoryInputSchema.parse(req.body);
      const [product, location] = await Promise.all([
        mustFind(req.db!.product.findUnique({ where: { id: input.productId } }), 'Product'),
        mustFind(req.db!.location.findUnique({ where: { id: input.locationId } }), 'Location'),
      ]);
      const data = {
        onHand: input.onHand,
        safetyStock: input.safetyStock,
        asOfDate: input.asOfDate ?? new Date(),
      };
      const level = await req.db!.inventoryLevel.upsert({
        where: {
          tenantId_productId_locationId: {
            tenantId: req.tenantId!,
            productId: product.id,
            locationId: location.id,
          },
        },
        update: data,
        create: { productId: product.id, locationId: location.id, ...data } as never,
        include: { product: true, location: true },
      });
      res.json({ level: toInvDto(level) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/inventory/:id', ...invWrite, async (req, res, next) => {
    try {
      const level = await mustFind(
        req.db!.inventoryLevel.findUnique({ where: { id: req.params.id } }),
        'Inventory level',
      );
      await req.db!.inventoryLevel.delete({ where: { id: level.id } });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Open orders ----------------
  type OrderRow = Awaited<ReturnType<typeof prisma.openOrder.findFirstOrThrow>> & {
    product: Product;
    location: { code: string };
    supplier: Supplier | null;
  };
  const toOrderDto = (o: OrderRow): OpenOrderDto => ({
    id: o.id,
    productId: o.productId,
    productSku: o.product.sku,
    locationId: o.locationId,
    locationCode: o.location.code,
    supplierId: o.supplierId,
    supplierName: o.supplier?.name ?? null,
    quantity: num(o.quantity),
    expectedDate: o.expectedDate.toISOString(),
    // Late = expected before the start of today (UTC).
    isLate:
      o.expectedDate.getTime() <
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
  });
  const orderInclude = { product: true, location: true, supplier: true } as const;

  async function assertRefs(
    db: Db,
    v: { productId?: string; locationId?: string; supplierId?: string | null },
  ) {
    if (v.productId)
      await mustFind(db.product.findUnique({ where: { id: v.productId } }), 'Product');
    if (v.locationId)
      await mustFind(db.location.findUnique({ where: { id: v.locationId } }), 'Location');
    if (v.supplierId)
      await mustFind(db.supplier.findUnique({ where: { id: v.supplierId } }), 'Supplier');
  }

  router.get('/open-orders', ...read, async (req, res, next) => {
    try {
      const q = invQuery.extend({ late: z.enum(['true', 'false']).optional() }).parse(req.query);
      const today = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
      );
      const where = {
        ...(q.productId && { productId: q.productId }),
        ...(q.locationId && { locationId: q.locationId }),
        ...(q.late === 'true' && { expectedDate: { lt: today } }),
        ...(q.late === 'false' && { expectedDate: { gte: today } }),
      };
      const [rows, total] = await Promise.all([
        req.db!.openOrder.findMany({
          where,
          include: orderInclude,
          orderBy: { expectedDate: 'asc' },
          ...skipTake(q),
        }),
        req.db!.openOrder.count({ where }),
      ]);
      res.json(
        paged(
          rows.map((o) => toOrderDto(o as OrderRow)),
          total,
          q,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/open-orders', ...invWrite, async (req, res, next) => {
    try {
      const input = openOrderInputSchema.parse(req.body);
      await assertRefs(req.db!, input);
      const o = await req.db!.openOrder.create({
        data: { ...input, supplierId: input.supplierId ?? null } as never,
        include: orderInclude,
      });
      res.status(201).json({ order: toOrderDto(o as OrderRow) });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/open-orders/:id', ...invWrite, async (req, res, next) => {
    try {
      const input = openOrderPatchSchema.parse(req.body);
      const o = await mustFind(
        req.db!.openOrder.findUnique({ where: { id: req.params.id } }),
        'Open order',
      );
      await assertRefs(req.db!, input);
      const updated = await req.db!.openOrder.update({
        where: { id: o.id },
        data: input,
        include: orderInclude,
      });
      res.json({ order: toOrderDto(updated as OrderRow) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/open-orders/:id', ...invWrite, async (req, res, next) => {
    try {
      const o = await mustFind(
        req.db!.openOrder.findUnique({ where: { id: req.params.id } }),
        'Open order',
      );
      await req.db!.openOrder.delete({ where: { id: o.id } });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return router;
}
