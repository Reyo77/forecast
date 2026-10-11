import fs from 'node:fs';
import path from 'node:path';
import { prisma } from './client';
import { scoped, TENANT_SCOPED_MODELS } from './scoped';
import { resetDb } from '../../tests/helpers/db';
import { createTenant, createUser } from '../../tests/factories';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function twoTenants() {
  const a = await createTenant();
  const b = await createTenant();
  const ua = await createUser({ tenantId: a.id, email: 'a@x.com' });
  const ub = await createUser({ tenantId: b.id, email: 'b@x.com' });
  return { a, b, ua, ub };
}

describe('scoped(tenantId)', () => {
  it('refuses an empty tenantId', () => {
    expect(() => scoped('')).toThrow();
  });

  it('filters reads (findMany, findFirst, findUnique, count)', async () => {
    const { a, ua, ub } = await twoTenants();
    const db = scoped(a.id);
    expect((await db.user.findMany()).map((u) => u.id)).toEqual([ua.id]);
    expect(await db.user.count()).toBe(1);
    expect(await db.user.findFirst({ where: { id: ub.id } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: ub.id } })).toBeNull();
    expect((await db.user.findUnique({ where: { id: ua.id } }))?.id).toBe(ua.id);
  });

  it('cannot update or delete another tenant’s rows', async () => {
    const { a, ub } = await twoTenants();
    const db = scoped(a.id);
    await expect(
      db.user.update({ where: { id: ub.id }, data: { name: 'hacked' } }),
    ).rejects.toThrow();
    expect(
      (await db.user.updateMany({ where: { id: ub.id }, data: { name: 'hacked' } })).count,
    ).toBe(0);
    await expect(db.user.delete({ where: { id: ub.id } })).rejects.toThrow();
    expect((await db.user.deleteMany({ where: { id: ub.id } })).count).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ub.id } })).name).not.toBe('hacked');
  });

  it('can update and delete its own rows', async () => {
    const { a, ua } = await twoTenants();
    const db = scoped(a.id);
    expect((await db.user.update({ where: { id: ua.id }, data: { name: 'New' } })).name).toBe(
      'New',
    );
    await db.user.delete({ where: { id: ua.id } });
    expect(await prisma.user.findUnique({ where: { id: ua.id } })).toBeNull();
  });

  it('forces tenantId on create, ignoring a client-supplied one', async () => {
    const { a, b } = await twoTenants();
    const created = await scoped(a.id).user.create({
      data: { email: 'new@x.com', name: 'N', passwordHash: 'h', role: 'VIEWER', tenantId: b.id },
    });
    expect(created.tenantId).toBe(a.id);
  });

  it('forces tenantId on createMany', async () => {
    const { a, b } = await twoTenants();
    await scoped(a.id).user.createMany({
      data: [
        { email: 'm1@x.com', name: 'M1', passwordHash: 'h', role: 'VIEWER', tenantId: b.id },
        { email: 'm2@x.com', name: 'M2', passwordHash: 'h', role: 'VIEWER' },
      ],
    });
    const rows = await prisma.user.findMany({ where: { email: { in: ['m1@x.com', 'm2@x.com'] } } });
    expect(rows.map((r) => r.tenantId)).toEqual([a.id, a.id]);
  });

  it('cannot move a row to another tenant via update', async () => {
    const { a, b, ua } = await twoTenants();
    await scoped(a.id).user.update({ where: { id: ua.id }, data: { tenantId: b.id } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ua.id } })).tenantId).toBe(a.id);
  });

  it('scopes upsert', async () => {
    const { a, ub } = await twoTenants();
    const db = scoped(a.id);
    // Matches Tenant B's row by id but is scoped to A, so it takes the create branch instead of touching B.
    await db.user
      .upsert({
        where: { id: ub.id },
        create: { email: 'ups@x.com', name: 'U', passwordHash: 'h', role: 'VIEWER' },
        update: { name: 'hacked' },
      })
      .catch(() => undefined);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ub.id } })).name).not.toBe('hacked');
  });

  it('lists every Prisma model that has a tenantId column', () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const tenantModels = [...schema.matchAll(/model (\w+) \{([^}]*)\}/g)]
      .filter(([, , body]) => /^\s*tenantId\s/m.test(body!))
      .map(([, name]) => name!);
    for (const m of tenantModels) expect(TENANT_SCOPED_MODELS.has(m)).toBe(true);
  });
});
