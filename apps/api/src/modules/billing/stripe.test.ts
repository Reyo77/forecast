import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../db/client';
import { loadEnv } from '../../config/env';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import { createTenant, createUser } from '../../../tests/factories';
import { StripeGateway, verifyStripeSignature } from './gateway';

const SECRET = 'whsec_test_secret';
const NOW = new Date('2026-06-01T12:00:00Z');
const sign = (payload: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));

describe('verifyStripeSignature', () => {
  const payload = Buffer.from('{"a":1}');
  const t = Math.floor(NOW.getTime() / 1000);
  it('accepts a correct signature (also among several v1 entries)', () => {
    const good = sign(payload.toString(), SECRET, t);
    expect(verifyStripeSignature(payload, good, SECRET, NOW)).toBe(true);
    expect(verifyStripeSignature(payload, `${good},v1=${'0'.repeat(64)}`, SECRET, NOW)).toBe(true);
  });
  it('rejects wrong secret, tampered body, stale or future timestamps and malformed headers', () => {
    const good = sign(payload.toString(), SECRET, t);
    expect(verifyStripeSignature(payload, good, 'other', NOW)).toBe(false);
    expect(verifyStripeSignature(Buffer.from('{"a":2}'), good, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(payload, sign('{"a":1}', SECRET, t - 301), SECRET, NOW)).toBe(
      false,
    );
    expect(verifyStripeSignature(payload, sign('{"a":1}', SECRET, t + 301), SECRET, NOW)).toBe(
      false,
    );
    for (const h of [undefined, '', 'garbage', `t=${t}`, `v1=abc`, `t=x,v1=ab`, `t=${t},v1=zz`]) {
      expect(verifyStripeSignature(payload, h, SECRET, NOW)).toBe(false);
    }
  });
});

function fakeFetch(response: { ok: boolean; body: unknown } | Error) {
  return jest.fn(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, json: async () => response.body } as Response;
  }) as unknown as jest.MockedFunction<typeof fetch>;
}

describe('StripeGateway.createCheckout', () => {
  const req = {
    tenantId: 't1',
    planCode: 'pro',
    planName: 'Pro',
    amountCents: 19900,
    customerEmail: 'a@b.com',
    successUrl: 'http://app/billing?checkout=success',
    cancelUrl: 'http://app/billing?checkout=cancelled',
  };
  it('creates a Checkout Session with the plan amount and returns its url and id', async () => {
    const f = fakeFetch({
      ok: true,
      body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' },
    });
    const out = await new StripeGateway('sk_test_x', SECRET, f).createCheckout(req);
    expect(out).toEqual({ url: 'https://checkout.stripe.com/c/cs_1', reference: 'cs_1' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_x');
    const form = new URLSearchParams(init!.body as string);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('19900');
    expect(form.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(form.get('metadata[tenantId]')).toBe('t1');
    expect(form.get('metadata[planCode]')).toBe('pro');
    expect(form.get('success_url')).toBe(req.successUrl);
    expect(form.get('customer_email')).toBe('a@b.com');
  });
  it('maps provider failures and network errors to 502 without leaking details', async () => {
    await expect(
      new StripeGateway(
        'k',
        SECRET,
        fakeFetch({ ok: false, body: { error: { message: 'secret detail' } } }),
      ).createCheckout(req),
    ).rejects.toMatchObject({ status: 502, code: 'PAYMENT_PROVIDER_ERROR' });
    await expect(
      new StripeGateway('k', SECRET, fakeFetch({ ok: true, body: {} })).createCheckout(req),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      new StripeGateway('k', SECRET, fakeFetch(new Error('ECONNRESET'))).createCheckout(req),
    ).rejects.toMatchObject({ status: 502, message: 'The payment provider is unreachable' });
  });
});

const completed = (over: Record<string, unknown> = {}, objectOver: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        payment_status: 'paid',
        amount_total: 19900,
        metadata: { tenantId: 't1', planCode: 'pro' },
        ...objectOver,
      },
    },
    ...over,
  });

describe('StripeGateway.parseWebhook', () => {
  const gw = new StripeGateway('k', SECRET, fakeFetch({ ok: true, body: {} }));
  const parse = (body: string, sig?: string) =>
    gw.parseWebhook(Buffer.from(body), sig ?? sign(body));
  it('turns a paid checkout into payment.succeeded', () => {
    expect(parse(completed())).toEqual({
      type: 'payment.succeeded',
      reference: 'cs_1',
      tenantId: 't1',
      planCode: 'pro',
      amountCents: 19900,
    });
  });
  it('ignores unpaid sessions, other events and sessions without our metadata', () => {
    expect(parse(completed({}, { payment_status: 'unpaid' }))).toEqual({ type: 'ignored' });
    expect(parse(completed({ type: 'invoice.created' }))).toEqual({ type: 'ignored' });
    expect(parse(completed({}, { metadata: {} }))).toEqual({ type: 'ignored' });
    expect(parse(completed({}, { amount_total: undefined }))).toEqual({ type: 'ignored' });
  });
  it('rejects bad signatures and non-JSON bodies with 400', () => {
    expect(() => parse(completed(), 't=1,v1=00')).toThrow(/signature/);
    expect(() => parse('not json')).toThrow(/valid JSON/);
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
  it('defaults to simulated payments; stripe needs both keys', () => {
    expect(loadEnv(base).PAYMENT_PROVIDER).toBe('simulated');
    expect(() => loadEnv({ ...base, PAYMENT_PROVIDER: 'stripe' })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadEnv({ ...base, PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk' })).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
    expect(
      loadEnv({
        ...base,
        PAYMENT_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk',
        STRIPE_WEBHOOK_SECRET: 'wh',
      }).PAYMENT_PROVIDER,
    ).toBe('stripe');
  });
});

describe('billing with the Stripe gateway', () => {
  const fetchMock = fakeFetch({
    ok: true,
    body: { id: 'cs_live_1', url: 'https://checkout.stripe.com/c/cs_live_1' },
  });
  const app = createApp(
    { APP_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'test-access-secret' },
    {
      loginRateLimitMax: 1_000_000,
      paymentGateway: new StripeGateway('sk_test', SECRET, fetchMock),
    },
  );
  beforeEach(() => fetchMock.mockClear());

  async function trialOwner() {
    const res = await request(app).post('/auth/signup').send({
      companyName: 'Acme',
      name: 'Olive',
      email: 'owner@acme.com',
      password: 'Password123',
    });
    return { tenantId: res.body.user.tenantId as string, h: bearer(res.body.accessToken) };
  }
  const webhook = (body: string, sig = sign(body)) =>
    request(app)
      .post('/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', sig)
      .send(body);
  const paidBody = (
    tenantId: string,
    over: Record<string, unknown> = {},
    planCode = 'pro',
    ref = 'cs_live_1',
  ) => completed({}, { id: ref, metadata: { tenantId, planCode }, ...over });

  it('a paid upgrade returns the checkout url and changes nothing until the webhook arrives', async () => {
    const { tenantId, h } = await trialOwner();
    const res = await request(app).post('/billing/change-plan').set(h).send({ planCode: 'pro' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      result: 'CHECKOUT_REQUIRED',
      checkoutUrl: 'https://checkout.stripe.com/c/cs_live_1',
    });
    expect(res.body.subscription).toMatchObject({ status: 'TRIALING', simulatedPayments: false });
    expect(res.body.subscription.plan.code).toBe('starter');
    expect(await prisma.invoice.count({ where: { tenantId } })).toBe(0);
    const form = new URLSearchParams(fetchMock.mock.calls[0]![1]!.body as string);
    expect(form.get('metadata[tenantId]')).toBe(tenantId);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('19900');
    expect(form.get('customer_email')).toBe('owner@acme.com');
    expect(
      (await prisma.auditLog.findMany({ where: { tenantId } })).map((a) => a.action),
    ).toContain('billing.checkout_started');
  });

  it('the signed webhook activates the plan, writes a PAID invoice with the provider reference and notifies', async () => {
    const { tenantId, h } = await trialOwner();
    const res = await webhook(paidBody(tenantId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, applied: true });
    const sub = (await request(app).get('/billing/subscription').set(h)).body;
    expect(sub).toMatchObject({ status: 'ACTIVE', plan: { code: 'pro' } });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { tenantId } });
    expect(invoice).toMatchObject({ amountCents: 19900, status: 'PAID', externalRef: 'cs_live_1' });
    expect(
      (await prisma.notification.findMany({ where: { tenantId } })).find(
        (n) => n.type === 'billing.plan_changed',
      )?.body,
    ).toBe('Payment successful.');
    expect(
      (await prisma.auditLog.findMany({ where: { tenantId } })).map((a) => a.action),
    ).toContain('billing.plan_changed');
  });

  it('is idempotent: redelivering the same payment creates no second invoice or plan change', async () => {
    const { tenantId } = await trialOwner();
    const body = paidBody(tenantId);
    expect((await webhook(body)).body.applied).toBe(true);
    const again = await webhook(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });
    expect(await prisma.invoice.count({ where: { tenantId } })).toBe(1);
  });

  it('rejects forged, unsigned, stale and tampered webhooks (400) and applies nothing', async () => {
    const { tenantId, h } = await trialOwner();
    const body = paidBody(tenantId);
    expect((await webhook(body, sign(body, 'wrong-secret'))).status).toBe(400);
    expect((await webhook(body, 'nonsense')).status).toBe(400);
    expect(
      (
        await request(app)
          .post('/billing/webhook')
          .set('Content-Type', 'application/json')
          .send(body)
      ).status,
    ).toBe(400);
    expect(
      (await webhook(body, sign(body, SECRET, Math.floor(Date.now() / 1000) - 3600))).status,
    ).toBe(400);
    const sig = sign(body);
    expect((await webhook(paidBody(tenantId, { amount_total: 1 }), sig)).status).toBe(400);
    expect((await request(app).get('/billing/subscription').set(h)).body.plan.code).toBe('starter');
    expect(await prisma.invoice.count({ where: { tenantId } })).toBe(0);
  });

  it('never grants a plan when the paid amount differs from the plan price, or tenant/plan is unknown', async () => {
    const { tenantId, h } = await trialOwner();
    const cheap = await webhook(paidBody(tenantId, { amount_total: 100 }));
    expect(cheap.body).toEqual({ received: true, applied: false });
    const unknownTenant = await webhook(paidBody('no-such-tenant', {}, 'pro', 'cs_2'));
    expect(unknownTenant.body).toEqual({ received: true, applied: false });
    const unknownPlan = await webhook(paidBody(tenantId, {}, 'platinum', 'cs_3'));
    expect(unknownPlan.body).toEqual({ received: true, applied: false });
    expect((await request(app).get('/billing/subscription').set(h)).body.plan.code).toBe('starter');
    expect(await prisma.invoice.count()).toBe(0);
    expect(
      (await prisma.auditLog.findMany({ where: { action: 'billing.payment_unmatched' } })).length,
    ).toBe(3);
  });

  it('a paid session that cannot be applied is recorded for follow-up, not retried forever', async () => {
    const { tenantId } = await trialOwner();
    await prisma.plan.update({ where: { code: 'pro' }, data: { isActive: false } });
    const res = await webhook(paidBody(tenantId));
    expect(res.body).toEqual({ received: true, applied: false });
    expect(
      (await prisma.auditLog.findMany({ where: { tenantId } })).map((a) => a.action),
    ).toContain('billing.payment_unapplied');
  });

  it('ignores unrelated events with 200 so the provider stops retrying', async () => {
    const body = completed({ type: 'customer.created' });
    expect((await webhook(body)).body).toEqual({ received: true, ignored: true });
  });

  it('downgrades, Free and cancel never go through checkout', async () => {
    const t = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const h = tok(owner);
    const down = await request(app)
      .post('/billing/change-plan')
      .set(h)
      .send({ planCode: 'starter' });
    expect(down.body.result).toBe('SCHEDULED');
    expect((await request(app).post('/billing/cancel').set(h)).body.result).toBe('SCHEDULED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the existing error rules: same plan, unknown plan, Owner-only', async () => {
    const t = await createTenant({ plan: 'pro' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const admin = await createUser({ role: 'ADMIN', tenantId: t.id });
    expect(
      (await request(app).post('/billing/change-plan').set(tok(owner)).send({ planCode: 'pro' }))
        .body.error.code,
    ).toBe('ALREADY_ON_PLAN');
    expect(
      (await request(app).post('/billing/change-plan').set(tok(owner)).send({ planCode: 'nope' }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/billing/change-plan')
          .set(tok(admin))
          .send({ planCode: 'enterprise' })
      ).status,
    ).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failing provider returns 502 and leaves the subscription untouched', async () => {
    const failing = createApp(
      { APP_URL: 'http://localhost:5173', JWT_ACCESS_SECRET: 'test-access-secret' },
      {
        loginRateLimitMax: 1_000_000,
        paymentGateway: new StripeGateway('k', SECRET, fakeFetch(new Error('down'))),
      },
    );
    const t = await createTenant({ plan: 'starter' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const res = await request(failing)
      .post('/billing/change-plan')
      .set(tok(owner))
      .send({ planCode: 'pro' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } })).status,
    ).toBe('ACTIVE');
  });
});

describe('simulated mode (no gateway)', () => {
  it('upgrades still apply instantly and the webhook endpoint does not exist', async () => {
    const app = testApp();
    const t = await createTenant({ plan: 'starter' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const res = await request(app)
      .post('/billing/change-plan')
      .set(tok(owner))
      .send({ planCode: 'pro' });
    expect(res.body).toMatchObject({ result: 'APPLIED', paymentStatus: 'SUCCEEDED' });
    expect(res.body.subscription.simulatedPayments).toBe(true);
    expect(
      (
        await request(app)
          .post('/billing/webhook')
          .set('Content-Type', 'application/json')
          .send('{}')
      ).status,
    ).toBe(404);
  });
});
