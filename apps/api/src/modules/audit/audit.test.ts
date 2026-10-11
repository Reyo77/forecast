import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp, tokenFromLink } from '../../../tests/helpers/app';
import { createTenant, createUser, TEST_PASSWORD } from '../../../tests/factories';
import { expectRoleAccess, rolesWith } from '../../../tests/helpers/isolation';
import { audit } from './service';

const app = testApp();
beforeEach(resetDb);
afterAll(() => prisma.$disconnect());
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));

describe('audit trail from Feature 1.4 actions', () => {
  it('records invite, accept, role change, deactivate, reset link/use, ownership transfer, signup, password change', async () => {
    const signup = await request(app).post('/auth/signup').send({
      companyName: 'Audit Co',
      name: 'Olive',
      email: 'olive@example.com',
      password: 'Password123',
    });
    const owner = signup.body.user;
    const o = bearer(signup.body.accessToken);

    const inv = await request(app)
      .post('/invites')
      .set(o)
      .send({ email: 'p@example.com', role: 'PLANNER' });
    const acc = await request(app)
      .post('/invites/accept')
      .send({ token: tokenFromLink(inv.body.link), name: 'P', password: 'Password123' });
    const pid = acc.body.user.id;
    await request(app).patch(`/users/${pid}`).set(o).send({ role: 'VIEWER' });
    await request(app).patch(`/users/${pid}`).set(o).send({ isActive: false });
    await request(app).patch(`/users/${pid}`).set(o).send({ isActive: true });
    const rl = await request(app).post(`/users/${pid}/reset-link`).set(o);
    await request(app)
      .post('/auth/reset-password')
      .send({ token: tokenFromLink(rl.body.link), newPassword: 'BrandNew12345' });
    const inv2 = await request(app)
      .post('/invites')
      .set(o)
      .send({ email: 'q@example.com', role: 'VIEWER' });
    await request(app).delete(`/invites/${inv2.body.invite.id}`).set(o);
    await request(app)
      .post('/auth/change-password')
      .set(o)
      .send({ currentPassword: 'Password123', newPassword: 'Password4567' });
    await request(app)
      .post('/tenant/transfer-ownership')
      .set(o)
      .send({ userId: pid, password: 'Password4567' });

    const actions = (await prisma.auditLog.findMany({ where: { tenantId: owner.tenantId } })).map(
      (a) => a.action,
    );
    for (const a of [
      'tenant.created',
      'user.invited',
      'invite.accepted',
      'user.role_changed',
      'user.deactivated',
      'user.reactivated',
      'user.reset_link_created',
      'auth.password_reset',
      'invite.revoked',
      'auth.password_changed',
      'tenant.ownership_transferred',
    ]) {
      expect(actions).toContain(a);
    }
  });

  it('never stores tokens or passwords in metadata', async () => {
    const owner = await createUser({ role: 'OWNER' });
    const r = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'm@example.com', role: 'VIEWER' });
    const dump = JSON.stringify(await prisma.auditLog.findMany());
    expect(dump).not.toContain(tokenFromLink(r.body.link));
    expect(dump).not.toContain(TEST_PASSWORD);
  });

  it('a failing audit write does not throw', async () => {
    await expect(
      audit({ tenantId: 'missing-tenant-fk', actorId: null }, 'x', 'Y'),
    ).resolves.toBeUndefined();
  });
});

describe('GET /audit-logs', () => {
  async function seed() {
    const tenant = await createTenant();
    const other = await createTenant();
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
    const admin = await createUser({ role: 'ADMIN', tenantId: tenant.id });
    await audit({ tenantId: tenant.id, actorId: owner.id }, 'user.invited', 'Invite', 'i1');
    await audit({ tenantId: tenant.id, actorId: admin.id }, 'user.role_changed', 'User', 'u1');
    await audit({ tenantId: tenant.id, actorId: owner.id }, 'user.role_changed', 'User', 'u2');
    await audit({ tenantId: other.id, actorId: null }, 'secret.other.tenant', 'X');
    return { tenant, other, owner, admin };
  }

  it('Owner/Admin see only their tenant’s log, newest first, with actor info', async () => {
    const { owner } = await seed();
    const res = await request(app).get('/audit-logs').set(tok(owner));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain('secret.other.tenant');
    expect(res.body.items[0].actor).toMatchObject({ id: owner.id });
  });

  it('filters by action, actor and date range', async () => {
    const { owner, admin } = await seed();
    const byAction = await request(app).get('/audit-logs?action=user.role').set(tok(owner));
    expect(byAction.body.total).toBe(2);
    const byActor = await request(app).get(`/audit-logs?actorId=${admin.id}`).set(tok(owner));
    expect(byActor.body.total).toBe(1);
    const future = new Date(Date.now() + 86400_000).toISOString();
    expect(
      (
        await request(app)
          .get(`/audit-logs?from=${encodeURIComponent(future)}`)
          .set(tok(owner))
      ).body.total,
    ).toBe(0);
    expect(
      (
        await request(app)
          .get(`/audit-logs?to=${encodeURIComponent(future)}`)
          .set(tok(owner))
      ).body.total,
    ).toBe(3);
    expect((await request(app).get('/audit-logs?from=not-a-date').set(tok(owner))).status).toBe(
      400,
    );
  });

  it('paginates (max 100)', async () => {
    const { owner } = await seed();
    expect(
      (await request(app).get('/audit-logs?pageSize=2').set(tok(owner))).body.items,
    ).toHaveLength(2);
    expect((await request(app).get('/audit-logs?pageSize=500').set(tok(owner))).status).toBe(400);
  });

  it('a tenant user cannot widen scope with ?tenantId=', async () => {
    const { owner, other } = await seed();
    const res = await request(app).get(`/audit-logs?tenantId=${other.id}`).set(tok(owner));
    expect(res.body.total).toBe(3);
  });

  it('Super Admin sees all tenants and can filter by tenant', async () => {
    const { other } = await seed();
    const sa = await createUser({ role: 'SUPER_ADMIN' });
    expect((await request(app).get('/audit-logs').set(tok(sa))).body.total).toBe(4);
    expect(
      (await request(app).get(`/audit-logs?tenantId=${other.id}`).set(tok(sa))).body.total,
    ).toBe(1);
  });

  it('Planner and Viewer get 403; anonymous 401', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/audit-logs',
      allowed: rolesWith('audit:read'),
    });
  });
});
