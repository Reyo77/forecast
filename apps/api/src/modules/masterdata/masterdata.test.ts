import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import {
  createBomItem,
  createCategory,
  createInventory,
  createLocation,
  createOpenOrder,
  createProduct,
  createSupplier,
  createSupplierProduct,
  createTenant,
  createUser,
} from '../../../tests/factories';
import {
  expectRoleAccess,
  expectTenantIsolation,
  rolesWith,
} from '../../../tests/helpers/isolation';
import { registerDeleteGuard } from './common';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function ctx(plan = 'pro') {
  const tenant = await createTenant({ plan });
  const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
  return { tenant, owner, h: tok(owner), tid: tenant.id };
}

describe('categories', () => {
  it('creates, lists with product counts, renames, deletes (two levels max)', async () => {
    const { owner, h, tid } = await ctx();
    const top = (await request(app).post('/categories').set(h).send({ name: 'Food' })).body
      .category;
    const sub = (
      await request(app).post('/categories').set(h).send({ name: 'Snacks', parentId: top.id })
    ).body.category;
    await createProduct(tid, { categoryId: sub.id });
    const list = await request(app).get('/categories').set(h);
    expect(list.body.items.find((c: { id: string }) => c.id === sub.id)).toMatchObject({
      parentId: top.id,
      productCount: 1,
    });
    expect(
      (await request(app).patch(`/categories/${top.id}`).set(h).send({ name: 'Foods' })).body
        .category.name,
    ).toBe('Foods');
    const deep = await request(app)
      .post('/categories')
      .set(h)
      .send({ name: 'Chips', parentId: sub.id });
    expect(deep.status).toBe(400);
    expect(deep.body.error.code).toBe('CATEGORY_DEPTH');
    expect((await request(app).delete(`/categories/${top.id}`).set(h)).status).toBe(409); // has a child
    expect((await request(app).delete(`/categories/${sub.id}`).set(h)).status).toBe(409); // has a product
    const empty = (await request(app).post('/categories').set(h).send({ name: 'Empty' })).body
      .category;
    expect((await request(app).delete(`/categories/${empty.id}`).set(h)).status).toBe(204);
    void owner;
  });

  it('validation and uniqueness', async () => {
    const { tid, h } = await ctx();
    expect((await request(app).post('/categories').set(h).send({ name: '' })).status).toBe(400);
    expect(
      (
        await request(app)
          .post('/categories')
          .set(h)
          .send({ name: 'x'.repeat(81) })
      ).status,
    ).toBe(400);
    await request(app).post('/categories').set(h).send({ name: 'Dup' });
    expect((await request(app).post('/categories').set(h).send({ name: 'Dup' })).status).toBe(409);
    const other = await createTenant();
    const foreign = await createCategory(other.id);
    expect(
      (await request(app).post('/categories').set(h).send({ name: 'Child', parentId: foreign.id }))
        .status,
    ).toBe(404);
    const a = await createCategory(tid);
    const b = await createCategory(tid, { parentId: a.id });
    expect(
      (await request(app).patch(`/categories/${a.id}`).set(h).send({ parentId: b.id })).status,
    ).toBe(400);
    const c = await createCategory(tid);
    expect(
      (await request(app).patch(`/categories/${a.id}`).set(h).send({ parentId: c.id })).status,
    ).toBe(400); // a has a child
  });

  it('roles, 401 and tenant isolation', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/categories',
      allowed: rolesWith('masterdata:read'),
    });
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/categories',
      body: { name: `c${Date.now()}` },
      allowed: rolesWith('masterdata:write'),
    });
    for (const method of ['patch', 'delete'] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/categories/${id}`,
        body: method === 'patch' ? { name: 'x' } : undefined,
        createResource: (t) => createCategory(t),
      });
    }
  });
});

describe('products', () => {
  const body = { sku: 'ABC-1', name: 'Widget', unitCostCents: 250, unitPriceCents: 499 };

  it('creates, reads, updates and lists with search / category / active filters and pagination', async () => {
    const { h, tid } = await ctx();
    const cat = await createCategory(tid, { name: 'Tools' });
    const created = await request(app)
      .post('/products')
      .set(h)
      .send({ ...body, categoryId: cat.id });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({
      sku: 'ABC-1',
      categoryName: 'Tools',
      isActive: true,
      isComponent: false,
    });
    const id = created.body.product.id;
    expect((await request(app).get(`/products/${id}`).set(h)).body.product.name).toBe('Widget');
    expect(
      (
        await request(app)
          .patch(`/products/${id}`)
          .set(h)
          .send({ name: 'Widget 2', isComponent: true })
      ).body.product,
    ).toMatchObject({ name: 'Widget 2', isComponent: true });
    await createProduct(tid, { sku: 'ZZZ-9', name: 'Gadget', isActive: false });
    await createProduct(tid, { sku: 'ZZZ-8', name: 'Gizmo' });
    const get = async (qs: string) => (await request(app).get(`/products?${qs}`).set(h)).body;
    expect((await get('')).total).toBe(3);
    expect((await get('q=ZZZ')).total).toBe(2);
    expect((await get('q=gadget')).items[0].sku).toBe('ZZZ-9');
    expect((await get(`categoryId=${cat.id}`)).total).toBe(1);
    expect((await get('isActive=false')).items.map((p: { sku: string }) => p.sku)).toEqual([
      'ZZZ-9',
    ]);
    expect((await get('isComponent=true')).total).toBe(1);
    expect((await get('pageSize=2&page=2')).items).toHaveLength(1);
    expect((await request(app).get('/products?pageSize=101').set(h)).status).toBe(400);
  });

  it('a parent category filter includes its sub-categories', async () => {
    const { h, tid } = await ctx();
    const top = await createCategory(tid);
    const sub = await createCategory(tid, { parentId: top.id });
    await createProduct(tid, { categoryId: sub.id });
    await createProduct(tid);
    expect((await request(app).get(`/products?categoryId=${top.id}`).set(h)).body.total).toBe(1);
  });

  it('SKU is unique per tenant (409) but reusable across tenants', async () => {
    const a = await ctx();
    const b = await ctx();
    expect((await request(app).post('/products').set(a.h).send(body)).status).toBe(201);
    const dup = await request(app).post('/products').set(a.h).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SKU_EXISTS');
    expect((await request(app).post('/products').set(b.h).send(body)).status).toBe(201);
    const other = await createProduct(a.tid, { sku: 'OTHER' });
    expect(
      (await request(app).patch(`/products/${other.id}`).set(a.h).send({ sku: 'ABC-1' })).status,
    ).toBe(409);
  });

  it.each([
    ['missing sku', { ...body, sku: '' }],
    ['missing name', { ...body, name: '' }],
    ['negative cost', { ...body, unitCostCents: -1 }],
    ['fractional cents', { ...body, unitPriceCents: 1.5 }],
    ['sku too long', { ...body, sku: 'x'.repeat(65) }],
    ['bad flag type', { ...body, isActive: 'yes' }],
  ])('400: %s', async (_l, b) => {
    const { h } = await ctx();
    expect((await request(app).post('/products').set(h).send(b)).status).toBe(400);
  });

  it('rejects another tenant’s category (404) and ignores a client tenantId', async () => {
    const a = await ctx();
    const other = await createTenant();
    const foreign = await createCategory(other.id);
    expect(
      (
        await request(app)
          .post('/products')
          .set(a.h)
          .send({ ...body, categoryId: foreign.id })
      ).status,
    ).toBe(404);
    const res = await request(app)
      .post('/products')
      .set(a.h)
      .send({ ...body, tenantId: other.id });
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: res.body.product.id } })).tenantId,
    ).toBe(a.tid);
  });

  it('enforces the SKU plan limit with 402, counting only active products', async () => {
    const { h, tid } = await ctx('free');
    await prisma.subscription.update({
      where: { tenantId: tid },
      data: { customLimits: { skus: 2 } },
    });
    await createProduct(tid, { sku: 'A' });
    await createProduct(tid, { sku: 'B', isActive: false });
    expect(
      (
        await request(app)
          .post('/products')
          .set(h)
          .send({ ...body, sku: 'C' })
      ).status,
    ).toBe(201);
    const blocked = await request(app)
      .post('/products')
      .set(h)
      .send({ ...body, sku: 'D' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.details).toMatchObject({ metric: 'skus', limit: 2, current: 2 });
    // inactive products don't use a seat
    expect(
      (
        await request(app)
          .post('/products')
          .set(h)
          .send({ ...body, sku: 'E', isActive: false })
      ).status,
    ).toBe(201);
    // reactivating takes one
    const inactive = await prisma.product.findFirstOrThrow({ where: { tenantId: tid, sku: 'B' } });
    expect(
      (await request(app).patch(`/products/${inactive.id}`).set(h).send({ isActive: true })).status,
    ).toBe(402);
    const act = await prisma.product.findFirstOrThrow({ where: { tenantId: tid, sku: 'A' } });
    await request(app).patch(`/products/${act.id}`).set(h).send({ isActive: false });
    expect(
      (await request(app).patch(`/products/${inactive.id}`).set(h).send({ isActive: true })).status,
    ).toBe(200);
  });

  it('concurrent creates cannot exceed the SKU limit', async () => {
    const { h, tid } = await ctx('free');
    await prisma.subscription.update({
      where: { tenantId: tid },
      data: { customLimits: { skus: 5 } },
    });
    const res = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request(app)
          .post('/products')
          .set(h)
          .send({ ...body, sku: `P${i}` }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(5);
    expect(res.filter((r) => r.status === 402)).toHaveLength(7);
    expect(await prisma.product.count({ where: { tenantId: tid } })).toBe(5);
  });

  it('cannot delete a product with history or in a BOM (deactivate instead); can delete a clean one', async () => {
    const { h, tid } = await ctx();
    const clean = await createProduct(tid);
    expect((await request(app).delete(`/products/${clean.id}`).set(h)).status).toBe(204);

    const parent = await createProduct(tid);
    const comp = await createProduct(tid, { isComponent: true });
    await createBomItem(tid, parent.id, comp.id);
    for (const p of [parent, comp]) {
      const r = await request(app).delete(`/products/${p.id}`).set(h);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('PRODUCT_IN_USE');
    }

    const sold = await createProduct(tid);
    registerDeleteGuard('product', async (_t, id) =>
      id === sold.id ? 'This product has sales history.' : null,
    );
    const r = await request(app).delete(`/products/${sold.id}`).set(h);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/sales history.*Deactivate it instead/);
    expect(
      (await request(app).patch(`/products/${sold.id}`).set(h).send({ isActive: false })).body
        .product.isActive,
    ).toBe(false);
  });

  it('roles: read for all tenant roles, write for Owner/Admin; isolation on GET/PATCH/DELETE', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/products',
      allowed: rolesWith('masterdata:read'),
    });
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/products',
      body: { ...body, sku: `s${Date.now()}` },
      allowed: rolesWith('masterdata:write'),
    });
    for (const method of ['get', 'patch', 'delete'] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/products/${id}`,
        body: method === 'patch' ? { name: 'x' } : undefined,
        createResource: (t) => createProduct(t),
      });
    }
  });
});

describe('locations', () => {
  const body = { code: 'WH-1', name: 'Main warehouse', type: 'WAREHOUSE' };

  it('CRUD, type validation, list pagination', async () => {
    const { h } = await ctx();
    const c = await request(app).post('/locations').set(h).send(body);
    expect(c.status).toBe(201);
    expect(c.body.location).toMatchObject({ code: 'WH-1', type: 'WAREHOUSE' });
    expect(
      (
        await request(app)
          .patch(`/locations/${c.body.location.id}`)
          .set(h)
          .send({ type: 'STORE', name: 'Shop' })
      ).body.location,
    ).toMatchObject({ type: 'STORE', name: 'Shop' });
    await request(app)
      .post('/locations')
      .set(h)
      .send({ ...body, code: 'PL-1', type: 'PLANT' });
    const list = await request(app).get('/locations').set(h);
    expect(list.body.items.map((l: { code: string }) => l.code)).toEqual(['PL-1', 'WH-1']);
    expect(
      (
        await request(app)
          .post('/locations')
          .set(h)
          .send({ ...body, code: 'X', type: 'MOON' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/locations')
          .set(h)
          .send({ ...body, code: '' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/locations')
          .set(h)
          .send({ code: 'NOTYPE', name: 'Defaults to warehouse' })
      ).body.location.type,
    ).toBe('WAREHOUSE');
    expect((await request(app).delete(`/locations/${c.body.location.id}`).set(h)).status).toBe(204);
  });

  it('code is unique per tenant but reusable across tenants', async () => {
    const a = await ctx();
    const b = await ctx();
    await request(app).post('/locations').set(a.h).send(body);
    const dup = await request(app).post('/locations').set(a.h).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LOCATION_EXISTS');
    expect((await request(app).post('/locations').set(b.h).send(body)).status).toBe(201);
  });

  it('enforces the location plan limit (Free = 1) with 402', async () => {
    const { h } = await ctx('free');
    expect((await request(app).post('/locations').set(h).send(body)).status).toBe(201);
    const res = await request(app)
      .post('/locations')
      .set(h)
      .send({ ...body, code: 'WH-2' });
    expect(res.status).toBe(402);
    expect(res.body.error.details).toMatchObject({ metric: 'locations', limit: 1, current: 1 });
  });

  it('delete guard blocks locations that have history', async () => {
    const { h, tid } = await ctx();
    const loc = await createLocation(tid);
    registerDeleteGuard('location', async (_t, id) =>
      id === loc.id ? 'This location has sales history.' : null,
    );
    expect((await request(app).delete(`/locations/${loc.id}`).set(h)).status).toBe(409);
  });

  it('roles and isolation', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/locations',
      allowed: rolesWith('masterdata:read'),
    });
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/locations',
      body: { ...body, code: `c${Date.now()}` },
      allowed: rolesWith('masterdata:write'),
    });
    for (const method of ['patch', 'delete'] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/locations/${id}`,
        body: method === 'patch' ? { name: 'x' } : undefined,
        createResource: (t) => createLocation(t),
      });
    }
  });
});

describe('suppliers and supplier-product links', () => {
  const body = { name: 'Acme Supplies', defaultLeadTimeDays: 21, reliabilityPct: 92.5 };

  it('supplier CRUD with lead time 1–365 and reliability 0–100', async () => {
    const { h } = await ctx();
    const c = await request(app).post('/suppliers').set(h).send(body);
    expect(c.status).toBe(201);
    expect(c.body.supplier).toMatchObject({
      name: 'Acme Supplies',
      defaultLeadTimeDays: 21,
      reliabilityPct: 92.5,
    });
    const id = c.body.supplier.id;
    expect(
      (await request(app).patch(`/suppliers/${id}`).set(h).send({ defaultLeadTimeDays: 30 })).body
        .supplier.defaultLeadTimeDays,
    ).toBe(30);
    expect((await request(app).get('/suppliers').set(h)).body.total).toBe(1);
    expect((await request(app).get(`/suppliers/${id}`).set(h)).status).toBe(200);
    for (const bad of [
      { defaultLeadTimeDays: 0 },
      { defaultLeadTimeDays: 366 },
      { defaultLeadTimeDays: 1.5 },
      { reliabilityPct: 101 },
      { reliabilityPct: -1 },
      { name: '' },
    ]) {
      expect(
        (
          await request(app)
            .post('/suppliers')
            .set(h)
            .send({ ...body, ...bad })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(app)
          .post('/suppliers')
          .set(h)
          .send({ ...body, defaultLeadTimeDays: 1 })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post('/suppliers')
          .set(h)
          .send({ ...body, defaultLeadTimeDays: 365 })
      ).status,
    ).toBe(201);
    expect((await request(app).delete(`/suppliers/${id}`).set(h)).status).toBe(204);
  });

  it('roles and isolation', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/suppliers',
      allowed: rolesWith('masterdata:read'),
    });
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/suppliers',
      body,
      allowed: rolesWith('masterdata:write'),
    });
    for (const method of ['get', 'patch', 'delete'] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/suppliers/${id}`,
        body: method === 'patch' ? { name: 'x' } : undefined,
        createResource: (t) => createSupplier(t),
      });
    }
    await expectTenantIsolation({
      app,
      method: 'get',
      path: (id) => `/suppliers/${id}/products`,
      createResource: (t) => createSupplier(t),
    });
  });

  it('links a product with lead time, MOQ, cost and capacity; first supplier becomes primary', async () => {
    const { h, tid } = await ctx();
    const s1 = await createSupplier(tid, { name: 'S1' });
    const s2 = await createSupplier(tid, { name: 'S2' });
    const p = await createProduct(tid);
    const l1 = await request(app).post(`/suppliers/${s1.id}/products`).set(h).send({
      productId: p.id,
      leadTimeDays: 10,
      minOrderQty: 25,
      unitCostCents: 300,
      weeklyCapacity: 500,
    });
    expect(l1.status).toBe(201);
    expect(l1.body.link).toMatchObject({
      leadTimeDays: 10,
      minOrderQty: 25,
      unitCostCents: 300,
      weeklyCapacity: 500,
      isPrimary: true,
    });
    const l2 = await request(app)
      .post(`/suppliers/${s2.id}/products`)
      .set(h)
      .send({ productId: p.id, leadTimeDays: 20 });
    expect(l2.body.link).toMatchObject({ isPrimary: false, minOrderQty: 1, weeklyCapacity: null });
    const forProduct = await request(app).get(`/products/${p.id}/suppliers`).set(h);
    expect(forProduct.body.items.map((x: { supplierName: string }) => x.supplierName)).toEqual([
      'S1',
      'S2',
    ]);
    // marking S2 primary un-marks S1 (exactly one primary)
    await request(app)
      .patch(`/supplier-products/${l2.body.link.id}`)
      .set(h)
      .send({ isPrimary: true });
    const after = await prisma.supplierProduct.findMany({
      where: { productId: p.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(after.map((x) => x.isPrimary)).toEqual([false, true]);
    // deleting the primary promotes the remaining one
    await request(app).delete(`/supplier-products/${l2.body.link.id}`).set(h);
    expect(
      (await prisma.supplierProduct.findFirstOrThrow({ where: { productId: p.id } })).isPrimary,
    ).toBe(true);
    expect((await request(app).get(`/suppliers/${s1.id}/products`).set(h)).body.items).toHaveLength(
      1,
    );
  });

  it('validates lead time 1–365, rejects duplicates and cross-tenant products', async () => {
    const { h, tid } = await ctx();
    const s = await createSupplier(tid);
    const p = await createProduct(tid);
    for (const lt of [0, 366, 2.5]) {
      expect(
        (
          await request(app)
            .post(`/suppliers/${s.id}/products`)
            .set(h)
            .send({ productId: p.id, leadTimeDays: lt })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(app)
          .post(`/suppliers/${s.id}/products`)
          .set(h)
          .send({ productId: p.id, leadTimeDays: 5, weeklyCapacity: 0 })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/suppliers/${s.id}/products`)
          .set(h)
          .send({ productId: p.id, leadTimeDays: 5 })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post(`/suppliers/${s.id}/products`)
          .set(h)
          .send({ productId: p.id, leadTimeDays: 5 })
      ).status,
    ).toBe(409);
    const other = await createTenant();
    const foreign = await createProduct(other.id);
    expect(
      (
        await request(app)
          .post(`/suppliers/${s.id}/products`)
          .set(h)
          .send({ productId: foreign.id, leadTimeDays: 5 })
      ).status,
    ).toBe(404);
  });

  it('link roles and isolation on PATCH/DELETE', async () => {
    const t = await createTenant();
    const s = await createSupplier(t.id);
    const p = await createProduct(t.id);
    await expectRoleAccess({
      app,
      method: 'post',
      path: `/suppliers/${s.id}/products`,
      body: { productId: p.id, leadTimeDays: 5 },
      allowed: rolesWith('masterdata:write'),
      roles: ['VIEWER', 'PLANNER'],
    });
    for (const method of ['patch', 'delete'] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/supplier-products/${id}`,
        body: method === 'patch' ? { leadTimeDays: 9 } : undefined,
        createResource: async (tenantId) =>
          createSupplierProduct(
            tenantId,
            (await createSupplier(tenantId)).id,
            (await createProduct(tenantId)).id,
          ),
      });
    }
  });
});

describe('bill of materials', () => {
  async function trio() {
    const c = await ctx();
    const [a, b, d] = await Promise.all([
      createProduct(c.tid, { sku: 'A' }),
      createProduct(c.tid, { sku: 'B', isComponent: true }),
      createProduct(c.tid, { sku: 'C', isComponent: true }),
    ]);
    return { ...c, a, b, c2: d };
  }
  const add = (h: Record<string, string>, parent: string, comp: string, q = 1) =>
    request(app)
      .post('/bom')
      .set(h)
      .send({ parentProductId: parent, componentProductId: comp, quantityPer: q });

  it('adds components and returns a multi-level tree with total quantities', async () => {
    const { h, a, b, c2 } = await trio();
    expect((await add(h, a.id, b.id, 2)).status).toBe(201);
    expect((await add(h, b.id, c2.id, 3)).status).toBe(201);
    const tree = await request(app).get(`/products/${a.id}/bom`).set(h);
    expect(tree.status).toBe(200);
    expect(tree.body.tree).toHaveLength(1);
    expect(tree.body.tree[0]).toMatchObject({ sku: 'B', quantityPer: 2, totalQuantity: 2 });
    expect(tree.body.tree[0].children[0]).toMatchObject({
      sku: 'C',
      quantityPer: 3,
      totalQuantity: 6,
    });
    expect((await request(app).get(`/products/${c2.id}/bom`).set(h)).body.tree).toEqual([]);
  });

  it('rejects self, direct and indirect cycles with BOM_CYCLE', async () => {
    const { h, a, b, c2 } = await trio();
    const self = await add(h, a.id, a.id);
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('BOM_CYCLE');
    await add(h, a.id, b.id);
    await add(h, b.id, c2.id);
    expect((await add(h, b.id, a.id)).body.error.code).toBe('BOM_CYCLE');
    const indirect = await add(h, c2.id, a.id);
    expect(indirect.status).toBe(400);
    expect(indirect.body.error.message).toMatch(/cycle/);
    expect(await prisma.bomItem.count()).toBe(2);
  });

  it('rejects duplicates, bad quantities and cross-tenant products; supports patch and delete', async () => {
    const { h, a, b } = await trio();
    const first = await add(h, a.id, b.id, 2);
    expect((await add(h, a.id, b.id, 3)).status).toBe(409);
    for (const q of [0, -1]) expect((await add(h, a.id, b.id, q)).status).toBe(400);
    const other = await createTenant();
    const foreign = await createProduct(other.id);
    expect((await add(h, a.id, foreign.id)).status).toBe(404);
    expect((await add(h, foreign.id, a.id)).status).toBe(404);
    const id = first.body.item.id;
    expect(
      (await request(app).patch(`/bom/${id}`).set(h).send({ quantityPer: 4.5 })).body.item
        .quantityPer,
    ).toBe(4.5);
    expect((await request(app).patch(`/bom/${id}`).set(h).send({ quantityPer: 0 })).status).toBe(
      400,
    );
    expect((await request(app).delete(`/bom/${id}`).set(h)).status).toBe(204);
    expect(await prisma.bomItem.count()).toBe(0);
  });

  it('roles and isolation', async () => {
    const { a, b } = await trio();
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/bom',
      body: { parentProductId: a.id, componentProductId: b.id, quantityPer: 1 },
      allowed: rolesWith('masterdata:write'),
      roles: ['VIEWER', 'PLANNER'],
    });
    await expectRoleAccess({
      app,
      method: 'get',
      path: `/products/${a.id}/bom`,
      allowed: rolesWith('masterdata:read'),
    });
    await expectTenantIsolation({
      app,
      method: 'get',
      path: (id) => `/products/${id}/bom`,
      createResource: (t) => createProduct(t),
    });
    for (const method of ['patch', 'delete'] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/bom/${id}`,
        body: method === 'patch' ? { quantityPer: 2 } : undefined,
        createResource: async (tenantId) =>
          createBomItem(
            tenantId,
            (await createProduct(tenantId)).id,
            (await createProduct(tenantId)).id,
          ),
      });
    }
  });
});

describe('inventory levels', () => {
  it('upserts per product/location, lists with filters, deletes', async () => {
    const { h, tid } = await ctx();
    const p = await createProduct(tid, { sku: 'INV-1' });
    const p2 = await createProduct(tid, { sku: 'INV-2' });
    const l = await createLocation(tid, { code: 'WH' });
    const first = await request(app)
      .put('/inventory')
      .set(h)
      .send({ productId: p.id, locationId: l.id, onHand: 120.5, safetyStock: 20 });
    expect(first.status).toBe(200);
    expect(first.body.level).toMatchObject({
      onHand: 120.5,
      safetyStock: 20,
      productSku: 'INV-1',
      locationCode: 'WH',
    });
    const again = await request(app)
      .put('/inventory')
      .set(h)
      .send({ productId: p.id, locationId: l.id, onHand: 80 });
    expect(again.body.level.id).toBe(first.body.level.id);
    expect(again.body.level).toMatchObject({ onHand: 80, safetyStock: 0 });
    await request(app)
      .put('/inventory')
      .set(h)
      .send({ productId: p2.id, locationId: l.id, onHand: 5 });
    expect((await request(app).get('/inventory').set(h)).body.total).toBe(2);
    expect((await request(app).get(`/inventory?productId=${p.id}`).set(h)).body.total).toBe(1);
    expect(
      (await request(app).get(`/inventory?locationId=${l.id}&pageSize=1`).set(h)).body.items,
    ).toHaveLength(1);
    expect((await request(app).delete(`/inventory/${first.body.level.id}`).set(h)).status).toBe(
      204,
    );
  });

  it('rejects negative stock and bad references', async () => {
    const { h, tid } = await ctx();
    const p = await createProduct(tid);
    const l = await createLocation(tid);
    for (const patch of [{ onHand: -1 }, { safetyStock: -5 }, { onHand: 'many' }]) {
      expect(
        (
          await request(app)
            .put('/inventory')
            .set(h)
            .send({ productId: p.id, locationId: l.id, onHand: 1, ...patch })
        ).status,
      ).toBe(400);
    }
    const other = await createTenant();
    const fp = await createProduct(other.id);
    const fl = await createLocation(other.id);
    expect(
      (
        await request(app)
          .put('/inventory')
          .set(h)
          .send({ productId: fp.id, locationId: l.id, onHand: 1 })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .put('/inventory')
          .set(h)
          .send({ productId: p.id, locationId: fl.id, onHand: 1 })
      ).status,
    ).toBe(404);
    expect(await prisma.inventoryLevel.count()).toBe(0);
  });

  it('roles: Planner may write inventory, Viewer may not; isolation', async () => {
    const t = await createTenant();
    const p = await createProduct(t.id);
    const l = await createLocation(t.id);
    await expectRoleAccess({
      app,
      method: 'put',
      path: '/inventory',
      body: { productId: p.id, locationId: l.id, onHand: 1 },
      allowed: rolesWith('inventory:write'),
      roles: ['PLANNER', 'VIEWER'],
    });
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/inventory',
      allowed: rolesWith('masterdata:read'),
    });
    await expectTenantIsolation({
      app,
      method: 'delete',
      path: (id) => `/inventory/${id}`,
      createResource: async (tenantId) =>
        createInventory(
          tenantId,
          (await createProduct(tenantId)).id,
          (await createLocation(tenantId)).id,
        ),
    });
  });
});

describe('open orders', () => {
  it('creates, lists, flags late orders, filters, patches and deletes', async () => {
    const { h, tid } = await ctx();
    const p = await createProduct(tid);
    const l = await createLocation(tid);
    const s = await createSupplier(tid, { name: 'Acme' });
    const future = new Date(Date.now() + 5 * 86400_000);
    const past = new Date(Date.now() - 5 * 86400_000);
    const ok = await request(app).post('/open-orders').set(h).send({
      productId: p.id,
      locationId: l.id,
      supplierId: s.id,
      quantity: 100,
      expectedDate: future.toISOString(),
    });
    expect(ok.status).toBe(201);
    expect(ok.body.order).toMatchObject({ quantity: 100, supplierName: 'Acme', isLate: false });
    const late = await request(app)
      .post('/open-orders')
      .set(h)
      .send({ productId: p.id, locationId: l.id, quantity: 10, expectedDate: past.toISOString() });
    expect(late.body.order).toMatchObject({ isLate: true, supplierName: null });
    expect(
      (await request(app).get('/open-orders').set(h)).body.items.map(
        (o: { isLate: boolean }) => o.isLate,
      ),
    ).toEqual([true, false]);
    expect((await request(app).get('/open-orders?late=true').set(h)).body.total).toBe(1);
    expect((await request(app).get('/open-orders?late=false').set(h)).body.total).toBe(1);
    const patched = await request(app)
      .patch(`/open-orders/${late.body.order.id}`)
      .set(h)
      .send({ expectedDate: future.toISOString(), quantity: 12 });
    expect(patched.body.order).toMatchObject({ isLate: false, quantity: 12 });
    expect((await request(app).delete(`/open-orders/${ok.body.order.id}`).set(h)).status).toBe(204);
  });

  it('validates quantity, dates and references', async () => {
    const { h, tid } = await ctx();
    const p = await createProduct(tid);
    const l = await createLocation(tid);
    const base = {
      productId: p.id,
      locationId: l.id,
      quantity: 5,
      expectedDate: new Date().toISOString(),
    };
    for (const bad of [
      { quantity: 0 },
      { quantity: -3 },
      { expectedDate: 'not-a-date' },
      { productId: '' },
    ]) {
      expect(
        (
          await request(app)
            .post('/open-orders')
            .set(h)
            .send({ ...base, ...bad })
        ).status,
      ).toBe(400);
    }
    const other = await createTenant();
    const fs = await createSupplier(other.id);
    expect(
      (
        await request(app)
          .post('/open-orders')
          .set(h)
          .send({ ...base, supplierId: fs.id })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/open-orders')
          .set(h)
          .send({ ...base, productId: (await createProduct(other.id)).id })
      ).status,
    ).toBe(404);
  });

  it('roles and isolation', async () => {
    const t = await createTenant();
    const p = await createProduct(t.id);
    const l = await createLocation(t.id);
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/open-orders',
      body: {
        productId: p.id,
        locationId: l.id,
        quantity: 1,
        expectedDate: new Date().toISOString(),
      },
      allowed: rolesWith('inventory:write'),
      roles: ['PLANNER', 'VIEWER'],
    });
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/open-orders',
      allowed: rolesWith('masterdata:read'),
    });
    for (const method of ['patch', 'delete'] as const) {
      await expectTenantIsolation({
        app,
        method,
        path: (id) => `/open-orders/${id}`,
        body: method === 'patch' ? { quantity: 2 } : undefined,
        createResource: async (tenantId) =>
          createOpenOrder(
            tenantId,
            (await createProduct(tenantId)).id,
            (await createLocation(tenantId)).id,
          ),
      });
    }
  });

  it('deleting a supplier keeps its orders (supplier cleared); deleting a product cascades its links', async () => {
    const { h, tid } = await ctx();
    const p = await createProduct(tid);
    const l = await createLocation(tid);
    const s = await createSupplier(tid);
    await createSupplierProduct(tid, s.id, p.id);
    const o = await createOpenOrder(tid, p.id, l.id, { supplierId: s.id });
    await request(app).delete(`/suppliers/${s.id}`).set(h);
    expect(
      (await prisma.openOrder.findUniqueOrThrow({ where: { id: o.id } })).supplierId,
    ).toBeNull();
    expect(await prisma.supplierProduct.count()).toBe(0);
    await createInventory(tid, p.id, l.id);
    await request(app).delete(`/products/${p.id}`).set(h);
    expect(await prisma.inventoryLevel.count()).toBe(0);
    expect(await prisma.openOrder.count()).toBe(0);
  });
});
