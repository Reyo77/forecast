import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../app';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, loginAs } from '../../../tests/helpers/auth';
import { createUser, TEST_PASSWORD } from '../../../tests/factories';
import { seedSuperAdmin } from '../../db/seed';

const config = { APP_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'test-access-secret' };
const app = createApp(config, { loginRateLimitMax: 100000 });

const signupBody = {
  companyName: 'Acme Supplies',
  name: 'Ada Owner',
  email: 'ada@acme.com',
  password: 'Password123',
};

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe('POST /auth/signup', () => {
  it('creates tenant + owner in one go and sets a refresh cookie', async () => {
    const res = await request(app).post('/auth/signup').send(signupBody);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ada@acme.com', role: 'OWNER' });
    expect(res.body.accessToken).toEqual(expect.any(String));
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: res.body.user.tenantId } });
    expect(tenant.name).toBe('Acme Supplies');
    expect(tenant.slug).toBe('acme-supplies');
  });

  it('never returns the password or its hash', async () => {
    const res = await request(app).post('/auth/signup').send(signupBody);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('rejects a duplicate email (case-insensitive) with 409 and creates no tenant', async () => {
    await request(app).post('/auth/signup').send(signupBody);
    const res = await request(app)
      .post('/auth/signup')
      .send({ ...signupBody, companyName: 'Other', email: 'ADA@acme.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    expect(await prisma.tenant.count()).toBe(1);
  });

  it('gives a second company with the same name a distinct slug', async () => {
    await request(app).post('/auth/signup').send(signupBody);
    const res = await request(app)
      .post('/auth/signup')
      .send({ ...signupBody, email: 'b@acme.com' });
    expect(res.status).toBe(201);
    const slugs = (await prisma.tenant.findMany()).map((t) => t.slug).sort();
    expect(slugs).toEqual(['acme-supplies', 'acme-supplies-2']);
  });

  it.each([
    ['short password', { password: 'Ab1' }],
    ['no number', { password: 'abcdefghijkl' }],
    ['no letter', { password: '1234567890123' }],
    ['bad email', { email: 'nope' }],
    ['missing company', { companyName: '' }],
    ['missing name', { name: '' }],
  ])('returns 400 for %s', async (_label, patch) => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ ...signupBody, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('ignores a client-supplied role or tenantId', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ ...signupBody, role: 'SUPER_ADMIN', tenantId: 'x' });
    expect(res.body.user.role).toBe('OWNER');
    expect(res.body.user.tenantId).not.toBe('x');
  });
});

describe('POST /auth/login', () => {
  it('logs in with correct credentials', async () => {
    const user = await createUser({ role: 'ADMIN' });
    const { res, cookie } = await loginAs(app, user.email);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, role: 'ADMIN', tenantId: user.tenantId });
    expect(cookie).toBeDefined();
  });

  it('is case-insensitive on email', async () => {
    const user = await createUser({ email: 'mixed@example.com' });
    const { res } = await loginAs(app, 'MIXED@example.com');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it('gives the same 401 for wrong password and unknown email', async () => {
    const user = await createUser();
    const wrong = await loginAs(app, user.email, 'WrongPass999');
    const unknown = await loginAs(app, 'ghost@example.com');
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    expect(wrong.res.body).toEqual(unknown.res.body);
  });

  it('rejects deactivated users', async () => {
    const user = await createUser({ isActive: false });
    expect((await loginAs(app, user.email)).res.status).toBe(401);
  });

  it('returns 400 for a missing body', async () => {
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(400);
  });

  describe('lockout', () => {
    afterEach(() => jest.useRealTimers());

    it('locks for 15 minutes after 5 failures, even for the right password', async () => {
      const user = await createUser();
      for (let i = 0; i < 5; i++) {
        expect((await loginAs(app, user.email, 'WrongPass999')).res.status).toBe(401);
      }
      const locked = await loginAs(app, user.email);
      expect(locked.res.status).toBe(423);
      expect(locked.res.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('unlocks after 15 minutes', async () => {
      const user = await createUser();
      for (let i = 0; i < 5; i++) await loginAs(app, user.email, 'WrongPass999');
      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      expect((await loginAs(app, user.email)).res.status).toBe(200);
    });

    it('resets the failure counter on success', async () => {
      const user = await createUser();
      for (let i = 0; i < 4; i++) await loginAs(app, user.email, 'WrongPass999');
      await loginAs(app, user.email);
      for (let i = 0; i < 4; i++) await loginAs(app, user.email, 'WrongPass999');
      expect((await loginAs(app, user.email)).res.status).toBe(200);
    });
  });

  it('is rate limited', async () => {
    const limited = createApp(config, { loginRateLimitMax: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await request(limited).post('/auth/login').send({ email: 'a@b.com', password: 'x' }))
          .status,
      );
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token and returns a new access token', async () => {
    const user = await createUser();
    const { cookie } = await loginAs(app, user.email);
    const res = await request(app).post('/auth/refresh').set('Cookie', cookie!);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    const newCookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(newCookie.split(';')[0]).not.toBe(cookie!.split(';')[0]);
  });

  it('returns 401 with no cookie', async () => {
    const res = await request(app).post('/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await request(app).post('/auth/refresh').set('Cookie', 'refresh_token=nope');
    expect(res.status).toBe(401);
  });

  it('detects reuse of a rotated token and revokes all of the user’s tokens', async () => {
    const user = await createUser();
    const { cookie: first } = await loginAs(app, user.email);
    const rotated = await request(app).post('/auth/refresh').set('Cookie', first!);
    const second = (rotated.headers['set-cookie'] as unknown as string[])[0]!;

    const reuse = await request(app).post('/auth/refresh').set('Cookie', first!);
    expect(reuse.status).toBe(401);

    // The legitimately rotated token is now dead too.
    const afterReuse = await request(app).post('/auth/refresh').set('Cookie', second);
    expect(afterReuse.status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('rejects expired refresh tokens', async () => {
    const user = await createUser();
    const { cookie } = await loginAs(app, user.email);
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
  });

  it('stores only a hash of the token', async () => {
    const user = await createUser();
    const { cookie } = await loginAs(app, user.email);
    const raw = cookie!.split(';')[0]!.split('=')[1]!;
    const rows = await prisma.refreshToken.findMany();
    expect(rows.every((r) => r.tokenHash !== raw)).toBe(true);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token', async () => {
    const user = await createUser();
    const { cookie } = await loginAs(app, user.email);
    const out = await request(app).post('/auth/logout').set('Cookie', cookie!);
    expect(out.status).toBe(204);
    expect((await request(app).post('/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
  });

  it('succeeds even when not logged in', async () => {
    expect((await request(app).post('/auth/logout')).status).toBe(204);
  });
});

describe('GET /auth/me', () => {
  it('returns the current user', async () => {
    const user = await createUser({ role: 'VIEWER' });
    const { token } = await loginAs(app, user.email);
    const res = await request(app).get('/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, role: 'VIEWER' });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('returns 401 without a token', async () => {
    expect((await request(app).get('/auth/me')).status).toBe(401);
  });

  it('returns 401 TOKEN_EXPIRED for an expired access token', async () => {
    const user = await createUser();
    const expired = jwt.sign(
      { sub: user.id, tenantId: user.tenantId, role: user.role },
      'test-access-secret',
      {
        expiresIn: -10,
      },
    );
    const res = await request(app).get('/auth/me').set(bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns 401 for a token signed with another secret', async () => {
    const user = await createUser();
    const forged = jwt.sign({ sub: user.id, role: 'SUPER_ADMIN' }, 'wrong-secret');
    expect((await request(app).get('/auth/me').set(bearer(forged))).status).toBe(401);
  });

  it('returns 401 once the user is deactivated', async () => {
    const user = await createUser();
    const { token } = await loginAs(app, user.email);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await request(app).get('/auth/me').set(bearer(token))).status).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  it('changes the password, revokes old sessions and returns a new one', async () => {
    const user = await createUser();
    const { token, cookie } = await loginAs(app, user.email);
    const res = await request(app)
      .post('/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'NewPassword456' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect((await request(app).post('/auth/refresh').set('Cookie', cookie!)).status).toBe(401);
    expect((await loginAs(app, user.email, TEST_PASSWORD)).res.status).toBe(401);
    expect((await loginAs(app, user.email, 'NewPassword456')).res.status).toBe(200);
  });

  it('rejects a wrong current password', async () => {
    const user = await createUser();
    const { token } = await loginAs(app, user.email);
    const res = await request(app)
      .post('/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: 'Nope12345678', newPassword: 'NewPassword456' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('enforces password rules on the new password', async () => {
    const user = await createUser();
    const { token } = await loginAs(app, user.email);
    const res = await request(app)
      .post('/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'short1' });
    expect(res.status).toBe(400);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post('/auth/change-password')
      .send({ currentPassword: 'x', newPassword: 'NewPassword456' });
    expect(res.status).toBe(401);
  });
});

describe('seedSuperAdmin', () => {
  it('creates a tenant-less Super Admin who can log in, and is idempotent', async () => {
    await seedSuperAdmin('Root@Supplycast.local', 'RootPass12345');
    await seedSuperAdmin('root@supplycast.local', 'RootPass12345');
    expect(await prisma.user.count()).toBe(1);
    const { res } = await loginAs(app, 'root@supplycast.local', 'RootPass12345');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'SUPER_ADMIN', tenantId: null });
  });
});
