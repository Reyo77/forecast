import { Router } from 'express';
import { z } from 'zod';
import {
  categoryInputSchema,
  categoryPatchSchema,
  locationInputSchema,
  locationPatchSchema,
  productInputSchema,
  productPatchSchema,
  type CategoryDto,
  type LocationDto,
  type ProductDto,
} from '@supplycast/shared';
import type { Product, Category, Location } from '@prisma/client';
import { prisma } from '../../db/client';
import type { ScopedClient } from '../../db/scoped';
import { HttpError } from '../../middleware/errors';
import type { Guards } from '../../middleware/guards';
import { paged, paginationSchema, skipTake } from '../../lib/pagination';
import { auditReq } from '../audit/service';
import { createWithinLimit, registerLiveCounter } from '../billing/limits';
import { assertDeletable, isUniqueViolation } from './common';

registerLiveCounter('skus', (tenantId, db) =>
  db.product.count({ where: { tenantId, isActive: true } }),
);
registerLiveCounter('locations', (tenantId, db) => db.location.count({ where: { tenantId } }));

export const toProductDto = (p: Product & { category?: Category | null }): ProductDto => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  categoryId: p.categoryId,
  categoryName: p.category?.name ?? null,
  unitCostCents: p.unitCostCents,
  unitPriceCents: p.unitPriceCents,
  isComponent: p.isComponent,
  isActive: p.isActive,
});
export const toLocationDto = (l: Location): LocationDto => ({
  id: l.id,
  code: l.code,
  name: l.name,
  type: l.type,
});

const pageDefault100 = paginationSchema.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
});

const productQuery = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().max(64).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  isComponent: z.enum(['true', 'false']).optional(),
});

export function catalogRouter(guards: Guards): Router {
  const router = Router();
  const read = guards.tenant('masterdata:read');
  const write = guards.tenant('masterdata:write');

  // ---------------- Categories (two levels max) ----------------
  async function assertValidParent(
    db: ScopedClient,
    parentId: string | null | undefined,
    selfId?: string,
  ) {
    if (!parentId) return;
    const parent = await db.category.findUnique({ where: { id: parentId } });
    if (!parent) throw new HttpError(404, 'NOT_FOUND', 'Parent category not found');
    if (parent.parentId)
      throw new HttpError(400, 'CATEGORY_DEPTH', 'Categories can only be two levels deep');
    if (selfId && parent.id === selfId)
      throw new HttpError(400, 'CATEGORY_DEPTH', 'A category cannot be its own parent');
  }

  router.get('/categories', ...read, async (req, res, next) => {
    try {
      const p = pageDefault100.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.category.findMany({
          orderBy: [{ name: 'asc' }],
          include: { _count: { select: { products: true } } },
          ...skipTake(p),
        }),
        req.db!.category.count(),
      ]);
      const items: CategoryDto[] = rows.map((c) => ({
        id: c.id,
        name: c.name,
        parentId: c.parentId,
        productCount: c._count.products,
      }));
      res.json(paged(items, total, p));
    } catch (e) {
      next(e);
    }
  });

  router.post('/categories', ...write, async (req, res, next) => {
    try {
      const input = categoryInputSchema.parse(req.body);
      await assertValidParent(req.db!, input.parentId);
      const dup = await req.db!.category.findFirst({
        where: { name: input.name, parentId: input.parentId ?? null },
      });
      if (dup)
        throw new HttpError(
          409,
          'CATEGORY_EXISTS',
          'A category with this name already exists here',
        );
      const c = await req.db!.category.create({
        data: { name: input.name, parentId: input.parentId ?? null } as never,
      });
      await auditReq(req, 'category.created', 'Category', c.id, { name: c.name });
      res
        .status(201)
        .json({ category: { id: c.id, name: c.name, parentId: c.parentId, productCount: 0 } });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/categories/:id', ...write, async (req, res, next) => {
    try {
      const input = categoryPatchSchema.parse(req.body);
      const existing = await req.db!.category.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { children: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Category not found');
      if (input.parentId !== undefined) {
        await assertValidParent(req.db!, input.parentId, existing.id);
        if (input.parentId && existing._count.children > 0)
          throw new HttpError(
            400,
            'CATEGORY_DEPTH',
            'A category with sub-categories cannot become a sub-category',
          );
      }
      const c = await req.db!.category.update({ where: { id: existing.id }, data: input });
      res.json({ category: { id: c.id, name: c.name, parentId: c.parentId } });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/categories/:id', ...write, async (req, res, next) => {
    try {
      const existing = await req.db!.category.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { children: true, products: true } } },
      });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Category not found');
      if (existing._count.children || existing._count.products) {
        throw new HttpError(
          409,
          'CATEGORY_IN_USE',
          'Move or delete its sub-categories and products first',
        );
      }
      await req.db!.category.delete({ where: { id: existing.id } });
      await auditReq(req, 'category.deleted', 'Category', existing.id, { name: existing.name });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Products ----------------
  async function assertCategory(db: ScopedClient, id: string | null | undefined) {
    if (id && !(await db.category.findUnique({ where: { id } })))
      throw new HttpError(404, 'NOT_FOUND', 'Category not found');
  }

  router.get('/products', ...read, async (req, res, next) => {
    try {
      const q = productQuery.parse(req.query);
      const where = {
        ...(q.q && { OR: [{ sku: { contains: q.q } }, { name: { contains: q.q } }] }),
        ...(q.categoryId && {
          // A top-level category also matches its sub-categories.
          OR: [{ categoryId: q.categoryId }, { category: { parentId: q.categoryId } }],
        }),
        ...(q.isActive && { isActive: q.isActive === 'true' }),
        ...(q.isComponent && { isComponent: q.isComponent === 'true' }),
      };
      const [rows, total] = await Promise.all([
        req.db!.product.findMany({
          where,
          orderBy: { sku: 'asc' },
          include: { category: true },
          ...skipTake(q),
        }),
        req.db!.product.count({ where }),
      ]);
      res.json(paged(rows.map(toProductDto), total, q));
    } catch (e) {
      next(e);
    }
  });

  router.get('/products/:id', ...read, async (req, res, next) => {
    try {
      const p = await req.db!.product.findUnique({
        where: { id: req.params.id },
        include: { category: true },
      });
      if (!p) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
      res.json({ product: toProductDto(p) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/products', ...write, async (req, res, next) => {
    try {
      const input = productInputSchema.parse(req.body);
      await assertCategory(req.db!, input.categoryId);
      const create = (tx: typeof prisma) =>
        tx.product.create({
          data: { ...input, categoryId: input.categoryId ?? null, tenantId: req.tenantId! },
          include: { category: true },
        });
      const p = input.isActive
        ? await createWithinLimit(req.tenantId!, 'skus', (tx) => create(tx as typeof prisma))
        : await create(prisma);
      await auditReq(req, 'product.created', 'Product', p.id, { sku: p.sku });
      res.status(201).json({ product: toProductDto(p) });
    } catch (e) {
      next(
        isUniqueViolation(e)
          ? new HttpError(409, 'SKU_EXISTS', 'A product with this SKU already exists')
          : e,
      );
    }
  });

  router.patch('/products/:id', ...write, async (req, res, next) => {
    try {
      const input = productPatchSchema.parse(req.body);
      const existing = await req.db!.product.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
      await assertCategory(req.db!, input.categoryId);
      const update = (db: { product: typeof prisma.product }) =>
        db.product.update({ where: { id: existing.id }, data: input, include: { category: true } });
      // Reactivating takes a SKU seat.
      const p =
        input.isActive === true && !existing.isActive
          ? await createWithinLimit(req.tenantId!, 'skus', (tx) => update(tx as typeof prisma))
          : await update(req.db! as never);
      res.json({ product: toProductDto(p) });
    } catch (e) {
      next(
        isUniqueViolation(e)
          ? new HttpError(409, 'SKU_EXISTS', 'A product with this SKU already exists')
          : e,
      );
    }
  });

  router.delete('/products/:id', ...write, async (req, res, next) => {
    try {
      const existing = await req.db!.product.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
      const inBom = await req.db!.bomItem.count({
        where: { OR: [{ parentProductId: existing.id }, { componentProductId: existing.id }] },
      });
      if (inBom)
        throw new HttpError(
          409,
          'PRODUCT_IN_USE',
          'This product is part of a bill of materials. Remove it there or deactivate it instead.',
        );
      await assertDeletable('product', req.tenantId!, existing.id);
      await req.db!.product.delete({ where: { id: existing.id } });
      await auditReq(req, 'product.deleted', 'Product', existing.id, { sku: existing.sku });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---------------- Locations ----------------
  router.get('/locations', ...read, async (req, res, next) => {
    try {
      const p = paginationSchema.parse(req.query);
      const [rows, total] = await Promise.all([
        req.db!.location.findMany({ orderBy: { code: 'asc' }, ...skipTake(p) }),
        req.db!.location.count(),
      ]);
      res.json(paged(rows.map(toLocationDto), total, p));
    } catch (e) {
      next(e);
    }
  });

  router.post('/locations', ...write, async (req, res, next) => {
    try {
      const input = locationInputSchema.parse(req.body);
      const l = await createWithinLimit(req.tenantId!, 'locations', (tx) =>
        (tx as typeof prisma).location.create({ data: { ...input, tenantId: req.tenantId! } }),
      );
      await auditReq(req, 'location.created', 'Location', l.id, { code: l.code });
      res.status(201).json({ location: toLocationDto(l) });
    } catch (e) {
      next(
        isUniqueViolation(e)
          ? new HttpError(409, 'LOCATION_EXISTS', 'A location with this code already exists')
          : e,
      );
    }
  });

  router.patch('/locations/:id', ...write, async (req, res, next) => {
    try {
      const input = locationPatchSchema.parse(req.body);
      const existing = await req.db!.location.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Location not found');
      res.json({
        location: toLocationDto(
          await req.db!.location.update({ where: { id: existing.id }, data: input }),
        ),
      });
    } catch (e) {
      next(
        isUniqueViolation(e)
          ? new HttpError(409, 'LOCATION_EXISTS', 'A location with this code already exists')
          : e,
      );
    }
  });

  router.delete('/locations/:id', ...write, async (req, res, next) => {
    try {
      const existing = await req.db!.location.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Location not found');
      await assertDeletable('location', req.tenantId!, existing.id);
      await req.db!.location.delete({ where: { id: existing.id } });
      await auditReq(req, 'location.deleted', 'Location', existing.id, { code: existing.code });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return router;
}
