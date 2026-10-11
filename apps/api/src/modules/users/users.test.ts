import request from 'supertest';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, loginAs, tokenFor } from '../../../tests/helpers/auth';
import { testApp, tokenFromLink } from '../../../tests/helpers/app';
import { createTenant, createUser, TEST_PASSWORD } from '../../../tests/factories';
import {
  expectRoleAccess,
  expectTenantIsolation,
  rolesWith,
} from '../../../tests/helpers/isolation';

const app = testApp();

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function team() {
  const tenant = await createTenant();
  const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
  const admin = await createUser({ role: 'ADMIN', tenantId: tenant.id });
  const planner = await createUser({ role: 'PLANNER', tenantId: tenant.id });
  const viewer = await createUser({ role: 'VIEWER', tenantId: tenant.id });
  return {
    tenant,
    owner,
    admin,
    planner,
    viewer,
    t: (u: { id: string; tenantId: string | null; role: never }) => tokenFor(u),
  };
}
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));

describe('GET /users', () => {
  it('lists only the caller’s tenant, paginated, without secrets', async () => {
    const { owner, admin } = await team();
    await createUser({ role: 'OWNER' }); // other tenant
    const res = await request(app).get('/users').set(tok(admin));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.items.map((u: { id: string }) => u.id)).toContain(owner.id);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|failedLogins/);
  });

  it('enforces roles and caps page size at 100', async () => {
    await expectRoleAccess({ app, method: 'get', path: '/users', allowed: rolesWith('team:read') });
    const { owner } = await team();
    expect((await request(app).get('/users?pageSize=101').set(tok(owner))).status).toBe(400);
    expect((await request(app).get('/users?page=0').set(tok(owner))).status).toBe(400);
    const res = await request(app).get('/users?pageSize=2&page=2').set(tok(owner));
    expect(res.body.items).toHaveLength(2);
  });
});

describe('POST /invites', () => {
  it('creates an invite and returns a one-time link; token is stored hashed', async () => {
    const { owner, tenant } = await team();
    const res = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'New@Example.com', role: 'PLANNER' });
    expect(res.status).toBe(201);
    expect(res.body.invite.email).toBe('new@example.com');
    const token = tokenFromLink(res.body.link);
    const row = await prisma.invite.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(row.tokenHash).not.toBe(token);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    expect(JSON.stringify(res.body.invite)).not.toContain(token);
  });

  it('role access: only Owner/Admin', async () => {
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/invites',
      body: { email: `x${Date.now()}@example.com`, role: 'VIEWER' },
      allowed: rolesWith('team:manage'),
    });
  });

  it.each([
    ['bad email', { email: 'nope', role: 'VIEWER' }],
    ['cannot invite an Owner', { email: 'a@b.com', role: 'OWNER' }],
    ['cannot invite a Super Admin', { email: 'a@b.com', role: 'SUPER_ADMIN' }],
    ['missing role', { email: 'a@b.com' }],
  ])('400: %s', async (_l, body) => {
    const { owner } = await team();
    expect((await request(app).post('/invites').set(tok(owner)).send(body)).status).toBe(400);
  });

  it('409 if a user with that email already exists (even in another tenant)', async () => {
    const { owner } = await team();
    const other = await createUser({ role: 'PLANNER' });
    const res = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: other.email, role: 'VIEWER' });
    expect(res.status).toBe(409);
  });

  it('re-inviting the same email replaces the earlier invite', async () => {
    const { owner } = await team();
    const first = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'dup@example.com', role: 'VIEWER' });
    await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'dup@example.com', role: 'PLANNER' });
    expect(await prisma.invite.count()).toBe(1);
    const accept = await request(app)
      .post('/invites/accept')
      .send({ token: tokenFromLink(first.body.link), name: 'X', password: 'Password123' });
    expect(accept.status).toBe(400);
  });

  it('ignores a client-supplied tenantId', async () => {
    const { owner, tenant } = await team();
    const other = await createTenant();
    await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'z@example.com', role: 'VIEWER', tenantId: other.id });
    expect((await prisma.invite.findFirstOrThrow()).tenantId).toBe(tenant.id);
  });
});

describe('GET/DELETE /invites', () => {
  async function invite(owner: Parameters<typeof tokenFor>[0], email = 'inv@example.com') {
    const r = await request(app).post('/invites').set(tok(owner)).send({ email, role: 'VIEWER' });
    return r.body as { invite: { id: string }; link: string };
  }

  it('lists pending invites for the tenant only (no tokens)', async () => {
    const { owner } = await team();
    const other = await createUser({ role: 'OWNER' });
    await invite(owner);
    await invite(other, 'other@example.com');
    const res = await request(app).get('/invites').set(tok(owner));
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ email: 'inv@example.com', expired: false });
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash/);
  });

  it('shows expired invites as expired', async () => {
    const { owner } = await team();
    await invite(owner);
    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get('/invites').set(tok(owner))).body.items[0].expired).toBe(true);
  });

  it('role access: GET for managers, DELETE for managers', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/invites',
      allowed: rolesWith('team:read'),
    });
    await expectRoleAccess({
      app,
      method: 'delete',
      path: '/invites/does-not-exist',
      allowed: rolesWith('team:manage'),
    });
  });

  it('revokes an invite; the link then stops working', async () => {
    const { owner } = await team();
    const { invite: inv, link } = await invite(owner);
    expect((await request(app).delete(`/invites/${inv.id}`).set(tok(owner))).status).toBe(204);
    const res = await request(app)
      .post('/invites/accept')
      .send({ token: tokenFromLink(link), name: 'N', password: 'Password123' });
    expect(res.status).toBe(400);
  });

  it('tenant isolation on DELETE', async () => {
    await expectTenantIsolation({
      app,
      method: 'delete',
      path: (id) => `/invites/${id}`,
      createResource: async (tenantId) =>
        prisma.invite.create({
          data: {
            tenantId,
            email: `iso${Date.now()}@example.com`,
            role: 'VIEWER',
            tokenHash: `h${Math.random()}`,
            expiresAt: new Date(Date.now() + 1e9),
          },
        }),
    });
  });
});

describe('POST /invites/accept', () => {
  async function pending(role: 'PLANNER' | 'ADMIN' = 'PLANNER') {
    const { owner, tenant } = await team();
    const r = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'joiner@example.com', role });
    return { token: tokenFromLink(r.body.link), tenant, owner };
  }

  it('creates the user in the inviting tenant with the invited role and logs them in', async () => {
    const { token, tenant } = await pending();
    const res = await request(app)
      .post('/invites/accept')
      .send({ token, name: 'Pat Planner', password: 'Password123' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'joiner@example.com',
      role: 'PLANNER',
      tenantId: tenant.id,
    });
    expect(res.headers['set-cookie']).toBeDefined();
    expect((await loginAs(app, 'joiner@example.com', 'Password123')).res.status).toBe(200);
  });

  it('a link can be used only once', async () => {
    const { token } = await pending();
    const body = { token, name: 'N', password: 'Password123' };
    expect((await request(app).post('/invites/accept').send(body)).status).toBe(201);
    const again = await request(app).post('/invites/accept').send(body);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_INVITE');
  });

  it('expired links fail', async () => {
    const { token } = await pending();
    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(
      (
        await request(app)
          .post('/invites/accept')
          .send({ token, name: 'N', password: 'Password123' })
      ).status,
    ).toBe(400);
  });

  it('unknown tokens fail with the same error', async () => {
    const res = await request(app)
      .post('/invites/accept')
      .send({ token: 'x'.repeat(40), name: 'N', password: 'Password123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INVITE');
  });

  it('fails when the tenant is suspended', async () => {
    const { token, tenant } = await pending();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { status: 'SUSPENDED' } });
    expect(
      (
        await request(app)
          .post('/invites/accept')
          .send({ token, name: 'N', password: 'Password123' })
      ).status,
    ).toBe(400);
  });

  it('validates name and password rules', async () => {
    const { token } = await pending();
    expect(
      (
        await request(app)
          .post('/invites/accept')
          .send({ token, name: '', password: 'Password123' })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).post('/invites/accept').send({ token, name: 'N', password: 'short' }))
        .status,
    ).toBe(400);
  });

  it('409 if the email registered elsewhere after the invite was sent', async () => {
    const { token } = await pending();
    await createUser({ email: 'joiner@example.com', role: 'OWNER' });
    expect(
      (
        await request(app)
          .post('/invites/accept')
          .send({ token, name: 'N', password: 'Password123' })
      ).status,
    ).toBe(409);
  });

  it('two concurrent accepts create only one user', async () => {
    const { token } = await pending();
    const body = { token, name: 'N', password: 'Password123' };
    const results = await Promise.all([
      request(app).post('/invites/accept').send(body),
      request(app).post('/invites/accept').send(body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await prisma.user.count({ where: { email: 'joiner@example.com' } })).toBe(1);
  });
});

describe('PATCH /users/:id', () => {
  it('Owner changes a role; Admin deactivates a user and their sessions die', async () => {
    const { owner, admin, planner } = await team();
    const roleRes = await request(app)
      .patch(`/users/${planner.id}`)
      .set(tok(owner))
      .send({ role: 'VIEWER' });
    expect(roleRes.status).toBe(200);
    expect(roleRes.body.user.role).toBe('VIEWER');

    const { cookie } = await loginAs(app, planner.email);
    const res = await request(app)
      .patch(`/users/${planner.id}`)
      .set(tok(admin))
      .send({ isActive: false });
    expect(res.body.user.isActive).toBe(false);
    expect((await request(app).post('/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
    expect((await loginAs(app, planner.email)).res.status).toBe(401);

    const back = await request(app)
      .patch(`/users/${planner.id}`)
      .set(tok(admin))
      .send({ isActive: true });
    expect(back.body.user.isActive).toBe(true);
  });

  it('role access', async () => {
    const target = await createUser({ role: 'VIEWER' });
    await expectRoleAccess({
      app,
      method: 'patch',
      path: `/users/${target.id}`,
      body: { role: 'PLANNER' },
      allowed: rolesWith('team:manage'),
    });
  });

  it('an Admin cannot touch the Owner (403); the Owner cannot be demoted or deactivated (400)', async () => {
    const { owner, admin } = await team();
    expect(
      (await request(app).patch(`/users/${owner.id}`).set(tok(admin)).send({ role: 'VIEWER' }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).patch(`/users/${owner.id}`).set(tok(admin)).send({ isActive: false }))
        .status,
    ).toBe(403);
    const self = await request(app)
      .patch(`/users/${owner.id}`)
      .set(tok(owner))
      .send({ isActive: false });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('OWNER_PROTECTED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).role).toBe('OWNER');
  });

  it('cannot change own role or deactivate self', async () => {
    const { admin } = await team();
    const res = await request(app)
      .patch(`/users/${admin.id}`)
      .set(tok(admin))
      .send({ role: 'VIEWER' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SELF_MODIFY');
  });

  it('validation: cannot set OWNER/SUPER_ADMIN; empty body rejected', async () => {
    const { owner, planner } = await team();
    for (const body of [{ role: 'OWNER' }, { role: 'SUPER_ADMIN' }, {}, { isActive: 'yes' }]) {
      expect(
        (await request(app).patch(`/users/${planner.id}`).set(tok(owner)).send(body)).status,
      ).toBe(400);
    }
  });

  it('tenant isolation', async () => {
    await expectTenantIsolation({
      app,
      method: 'patch',
      path: (id) => `/users/${id}`,
      body: { role: 'VIEWER' },
      createResource: (tenantId) => createUser({ tenantId, role: 'PLANNER' }),
    });
  });
});

describe('POST /users/:id/reset-link and POST /auth/reset-password', () => {
  it('generates a one-time link that sets a new password and kills sessions', async () => {
    const { admin, planner } = await team();
    const { cookie } = await loginAs(app, planner.email);
    const res = await request(app).post(`/users/${planner.id}/reset-link`).set(tok(admin));
    expect(res.status).toBe(201);
    const token = tokenFromLink(res.body.link);
    const row = await prisma.passwordResetToken.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(token);

    const reset = await request(app)
      .post('/auth/reset-password')
      .send({ token, newPassword: 'BrandNew12345' });
    expect(reset.status).toBe(204);
    expect((await request(app).post('/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
    expect((await loginAs(app, planner.email, TEST_PASSWORD)).res.status).toBe(401);
    expect((await loginAs(app, planner.email, 'BrandNew12345')).res.status).toBe(200);

    const reuse = await request(app)
      .post('/auth/reset-password')
      .send({ token, newPassword: 'AnotherOne12345' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('also unlocks a locked account', async () => {
    const { admin, planner } = await team();
    for (let i = 0; i < 5; i++) await loginAs(app, planner.email, 'WrongPass999');
    expect((await loginAs(app, planner.email)).res.status).toBe(423);
    const link = (await request(app).post(`/users/${planner.id}/reset-link`).set(tok(admin))).body
      .link;
    await request(app)
      .post('/auth/reset-password')
      .send({ token: tokenFromLink(link), newPassword: 'BrandNew12345' });
    expect((await loginAs(app, planner.email, 'BrandNew12345')).res.status).toBe(200);
  });

  it('expired and unknown tokens fail; password rules apply', async () => {
    const { admin, planner } = await team();
    const link = (await request(app).post(`/users/${planner.id}/reset-link`).set(tok(admin))).body
      .link;
    const token = tokenFromLink(link);
    expect(
      (await request(app).post('/auth/reset-password').send({ token, newPassword: 'short' }))
        .status,
    ).toBe(400);
    await prisma.passwordResetToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (
        await request(app)
          .post('/auth/reset-password')
          .send({ token, newPassword: 'BrandNew12345' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/auth/reset-password')
          .send({ token: 'y'.repeat(40), newPassword: 'BrandNew12345' })
      ).status,
    ).toBe(400);
  });

  it('a new link invalidates the previous one', async () => {
    const { admin, planner } = await team();
    const a = tokenFromLink(
      (await request(app).post(`/users/${planner.id}/reset-link`).set(tok(admin))).body.link,
    );
    await request(app).post(`/users/${planner.id}/reset-link`).set(tok(admin));
    expect(
      (
        await request(app)
          .post('/auth/reset-password')
          .send({ token: a, newPassword: 'BrandNew12345' })
      ).status,
    ).toBe(400);
  });

  it('Admin cannot generate a link for the Owner; Owner can', async () => {
    const { admin, owner } = await team();
    expect((await request(app).post(`/users/${owner.id}/reset-link`).set(tok(admin))).status).toBe(
      403,
    );
    expect((await request(app).post(`/users/${owner.id}/reset-link`).set(tok(owner))).status).toBe(
      201,
    );
  });

  it('role access and tenant isolation', async () => {
    const target = await createUser({ role: 'VIEWER' });
    await expectRoleAccess({
      app,
      method: 'post',
      path: `/users/${target.id}/reset-link`,
      allowed: rolesWith('team:manage'),
    });
    await expectTenantIsolation({
      app,
      method: 'post',
      path: (id) => `/users/${id}/reset-link`,
      createResource: (tenantId) => createUser({ tenantId, role: 'PLANNER' }),
    });
  });
});

describe('POST /tenant/transfer-ownership', () => {
  it('transfers ownership: new Owner, old Owner becomes Admin', async () => {
    const { owner, admin } = await team();
    const res = await request(app)
      .post('/tenant/transfer-ownership')
      .set(tok(owner))
      .send({ userId: admin.id, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe('OWNER');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).role).toBe('ADMIN');
    expect(await prisma.user.count({ where: { tenantId: owner.tenantId, role: 'OWNER' } })).toBe(1);
    // The former Owner immediately loses Owner-only powers.
    const again = await request(app)
      .post('/tenant/transfer-ownership')
      .set(tok(owner))
      .send({ userId: admin.id, password: TEST_PASSWORD });
    expect(again.status).toBe(403);
  });

  it('only the Owner may call it', async () => {
    await expectRoleAccess({
      app,
      method: 'post',
      path: '/tenant/transfer-ownership',
      body: { userId: 'x', password: 'y' },
      allowed: rolesWith('tenant:transfer-ownership'),
    });
  });

  it('requires the correct password, a real active teammate, and not self', async () => {
    const { owner, planner } = await team();
    expect(
      (
        await request(app)
          .post('/tenant/transfer-ownership')
          .set(tok(owner))
          .send({ userId: planner.id, password: 'wrongwrong1' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/tenant/transfer-ownership')
          .set(tok(owner))
          .send({ userId: owner.id, password: TEST_PASSWORD })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/tenant/transfer-ownership')
          .set(tok(owner))
          .send({ userId: 'nope', password: TEST_PASSWORD })
      ).status,
    ).toBe(404);
    await prisma.user.update({ where: { id: planner.id }, data: { isActive: false } });
    expect(
      (
        await request(app)
          .post('/tenant/transfer-ownership')
          .set(tok(owner))
          .send({ userId: planner.id, password: TEST_PASSWORD })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).post('/tenant/transfer-ownership').set(tok(owner)).send({})).status,
    ).toBe(400);
  });

  it('cannot transfer to a user in another tenant (404)', async () => {
    const { owner } = await team();
    const outsider = await createUser({ role: 'ADMIN' });
    const res = await request(app)
      .post('/tenant/transfer-ownership')
      .set(tok(owner))
      .send({ userId: outsider.id, password: TEST_PASSWORD });
    expect(res.status).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: outsider.id } })).role).toBe(
      'ADMIN',
    );
  });
});
