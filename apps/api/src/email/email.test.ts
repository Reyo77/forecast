import request from 'supertest';
import nodemailer from 'nodemailer';
import { createApp } from '../app';
import { prisma } from '../db/client';
import { loadEnv } from '../config/env';
import { resetDb } from '../../tests/helpers/db';
import { bearer, tokenFor } from '../../tests/helpers/auth';
import { createTenant, createUser } from '../../tests/factories';
import { LogMailer, SmtpMailer, trySend } from './mailers';
import { inviteEmail, passwordResetEmail, welcomeEmail } from './templates';
import type { Mailer } from './types';

/** Records like LogMailer but counts as a real delivery. */
class TestMailer extends LogMailer {
  readonly delivers = true;
}

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const appWith = (mailer: Mailer) =>
  createApp(
    { APP_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'test-access-secret' },
    { loginRateLimitMax: 1_000_000, mailer },
  );
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));
const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

describe('templates', () => {
  it('invite email names the company, inviter and role and carries the link in text and html', () => {
    const m = inviteEmail({
      to: 'a@b.com',
      companyName: 'Acme',
      inviterName: 'Olive',
      role: 'PLANNER',
      link: 'https://app/accept-invite?token=abc',
      expiresInDays: 7,
    });
    expect(m.to).toBe('a@b.com');
    expect(m.subject).toBe('Olive invited you to Acme on SupplyCast');
    expect(m.text).toContain('https://app/accept-invite?token=abc');
    expect(m.text).toContain('as planner');
    expect(m.html).toContain('href="https://app/accept-invite?token=abc"');
    expect(m.html).toContain('expires in 7 days');
  });

  it('escapes HTML in user-controlled values (company, names, link)', () => {
    const evil = '<script>alert(1)</script>"&';
    const m = inviteEmail({
      to: 'a@b.com',
      companyName: evil,
      inviterName: evil,
      role: 'VIEWER',
      link: 'https://x/?a="><img src=x>',
      expiresInDays: 7,
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img src=x>');
    expect(m.html).toContain('&lt;script&gt;');
    const w = welcomeEmail({ to: 'a@b.com', name: evil, companyName: evil, appUrl: 'https://x' });
    expect(w.html).not.toContain('<script>');
    const r = passwordResetEmail({
      to: 'a@b.com',
      name: evil,
      link: 'https://x',
      expiresInHours: 24,
    });
    expect(r.html).not.toContain('<script>');
  });

  it('reset and welcome emails contain their call to action', () => {
    expect(
      passwordResetEmail({
        to: 'a@b.com',
        name: 'Ann',
        link: 'https://x/r?token=t',
        expiresInHours: 24,
      }),
    ).toMatchObject({ subject: 'Reset your SupplyCast password' });
    const w = welcomeEmail({
      to: 'a@b.com',
      name: 'Ann',
      companyName: 'Co',
      appUrl: 'https://app',
    });
    expect(w.subject).toContain('Welcome');
    expect(w.text).toContain('https://app');
  });
});

describe('mailers', () => {
  it('LogMailer keeps the last 100 messages and delivers nothing', async () => {
    const m = new LogMailer();
    for (let i = 0; i < 105; i++)
      await m.send({ to: `u${i}@x.com`, subject: 's', text: 't', html: 'h' });
    expect(m.outbox).toHaveLength(100);
    expect(m.outbox[0]!.to).toBe('u5@x.com');
  });

  it('SmtpMailer hands the message to the transport with the configured From', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const spy = jest.spyOn(transport, 'sendMail');
    await new SmtpMailer({ from: 'SupplyCast <hi@x.com>' }, transport).send({
      to: 'a@b.com',
      subject: 'Subj',
      text: 'plain',
      html: '<p>html</p>',
    });
    expect(spy).toHaveBeenCalledWith({
      from: 'SupplyCast <hi@x.com>',
      to: 'a@b.com',
      subject: 'Subj',
      text: 'plain',
      html: '<p>html</p>',
    });
  });

  it('trySend returns true on success and false (never throws) on failure', async () => {
    const msg = { to: 'a@b.com', subject: 's', text: 't', html: 'h' };
    expect(await trySend(new TestMailer(), msg)).toBe(true);
    expect(await trySend(new LogMailer(), msg)).toBe(false); // recorded only, not delivered
    const broken: Mailer = { delivers: true, send: () => Promise.reject(new Error('SMTP down')) };
    expect(await trySend(broken, msg)).toBe(false);
  });
});

describe('environment', () => {
  const base = {
    DATABASE_URL: 'mysql://x',
    DATABASE_URL_TEST: 'mysql://x',
    JWT_ACCESS_SECRET: 'a',
    JWT_REFRESH_SECRET: 'b',
    APP_URL: 'http://localhost:5173',
    API_URL: 'http://localhost:4000',
    GEMINI_API_KEY: 'k',
    GEMINI_MODEL: 'm',
    SIMULATED_PAYMENTS: 'true',
    SUPER_ADMIN_EMAIL: 'a@b.com',
    SUPER_ADMIN_PASSWORD: 'pw',
  } as NodeJS.ProcessEnv;

  it('defaults to the log driver; smtp requires a host', () => {
    expect(loadEnv(base).EMAIL_PROVIDER).toBe('log');
    expect(() => loadEnv({ ...base, EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_HOST/);
    const ok = loadEnv({
      ...base,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.x.com',
      SMTP_SECURE: 'true',
    });
    expect(ok).toMatchObject({ SMTP_HOST: 'smtp.x.com', SMTP_PORT: 587, SMTP_SECURE: true });
  });
});

describe('emails sent by the API', () => {
  it('POST /invites emails the invitee with the same link as the response', async () => {
    const mailer = new TestMailer();
    const app = appWith(mailer);
    const tenant = await createTenant({ plan: 'pro', name: 'Acme Foods' });
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id, name: 'Olive Owner' });
    const res = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'new@example.com', role: 'PLANNER' });
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(true);
    expect(mailer.outbox).toHaveLength(1);
    const mail = mailer.outbox[0]!;
    expect(mail.to).toBe('new@example.com');
    expect(mail.subject).toBe('Olive Owner invited you to Acme Foods on SupplyCast');
    expect(mail.text).toContain(tokenOf(res.body.link));
  });

  it('a mail outage does not fail the invite; emailed is false and the link still works', async () => {
    const app = appWith({ delivers: true, send: () => Promise.reject(new Error('SMTP down')) });
    const tenant = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
    const res = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'x@example.com', role: 'VIEWER' });
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(false);
    expect(res.body.link).toContain('/accept-invite?token=');
    expect(await prisma.invite.count()).toBe(1);
  });

  it('with the log driver emailed is false (nothing reaches an inbox) but the message is recorded', async () => {
    const mailer = new LogMailer();
    const app = appWith(mailer);
    const tenant = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
    const res = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: 'log@example.com', role: 'VIEWER' });
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(false);
    expect(mailer.outbox).toHaveLength(1);
  });

  it('a rejected invite (duplicate email) sends nothing', async () => {
    const mailer = new TestMailer();
    const app = appWith(mailer);
    const tenant = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
    const existing = await createUser({ role: 'PLANNER', tenantId: tenant.id });
    const res = await request(app)
      .post('/invites')
      .set(tok(owner))
      .send({ email: existing.email, role: 'PLANNER' });
    expect(res.status).toBe(409);
    expect(mailer.outbox).toHaveLength(0);
  });

  it('POST /users/:id/reset-link emails the target user', async () => {
    const mailer = new TestMailer();
    const app = appWith(mailer);
    const tenant = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: tenant.id });
    const planner = await createUser({ role: 'PLANNER', tenantId: tenant.id, name: 'Pat Planner' });
    const res = await request(app).post(`/users/${planner.id}/reset-link`).set(tok(owner));
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(true);
    expect(mailer.outbox[0]).toMatchObject({
      to: planner.email,
      subject: 'Reset your SupplyCast password',
    });
    expect(mailer.outbox[0]!.text).toContain(tokenOf(res.body.link));
    expect(mailer.outbox[0]!.text).toContain('Pat Planner');
  });

  it('signup sends a welcome email without delaying or failing the signup', async () => {
    const mailer = new TestMailer();
    const res = await request(appWith(mailer)).post('/auth/signup').send({
      companyName: 'Welcome Co',
      name: 'Wendy',
      email: 'wendy@example.com',
      password: 'Password123',
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setImmediate(r));
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]).toMatchObject({ to: 'wendy@example.com' });
    expect(mailer.outbox[0]!.subject).toContain('Welcome');
    expect(mailer.outbox[0]!.html).toContain('Welcome Co');

    const failing = appWith({ delivers: true, send: () => Promise.reject(new Error('down')) });
    const ok = await request(failing).post('/auth/signup').send({
      companyName: 'Other Co',
      name: 'Omar',
      email: 'omar@example.com',
      password: 'Password123',
    });
    expect(ok.status).toBe(201);
  });

  it('no email is sent for a failed signup (validation / duplicate)', async () => {
    const mailer = new TestMailer();
    const app = appWith(mailer);
    expect((await request(app).post('/auth/signup').send({ companyName: 'X' })).status).toBe(400);
    expect(mailer.outbox).toHaveLength(0);
  });
});
