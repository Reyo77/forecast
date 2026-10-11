import request from 'supertest';
import { DEFAULT_PLANS } from '@supplycast/shared';
import { prisma } from '../../db/client';
import { resetDb } from '../../../tests/helpers/db';
import { bearer, tokenFor } from '../../../tests/helpers/auth';
import { testApp } from '../../../tests/helpers/app';
import { createTenant, createUser } from '../../../tests/factories';
import {
  expectRoleAccess,
  expectTenantIsolation,
  rolesWith,
} from '../../../tests/helpers/isolation';
import { addMonths, DAY_MS } from '../../lib/time';
import { runBillingMaintenance } from './subscription';
import { createPaidInvoice, calculateMrr, formatInvoiceNumber } from './invoices';
import { ensureDefaultPlans } from './plans';

const app = testApp();
const tok = (u: Parameters<typeof tokenFor>[0]) => bearer(tokenFor(u));

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

async function signupTenant(email = 'owner@acme.com') {
  const res = await request(app)
    .post('/auth/signup')
    .send({ companyName: 'Acme', name: 'Olive', email, password: 'Password123' });
  return {
    owner: res.body.user,
    token: res.body.accessToken as string,
    h: bearer(res.body.accessToken),
  };
}
const superAdmin = () => createUser({ role: 'SUPER_ADMIN' });

describe('Feature 2.1: plans', () => {
  it('GET /plans is public and lists the seeded active public plans in order', async () => {
    const res = await request(app).get('/plans');
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: { code: string }) => p.code)).toEqual([
      'free',
      'starter',
      'pro',
      'enterprise',
    ]);
    const starter = res.body.items.find((p: { code: string }) => p.code === 'starter');
    expect(starter.priceCents).toBe(4900);
    expect(starter.limits).toEqual(DEFAULT_PLANS[1]!.limits);
  });

  it('hides deactivated and non-public plans from the pricing page', async () => {
    await ensureDefaultPlans();
    await prisma.plan.update({ where: { code: 'starter' }, data: { isActive: false } });
    await prisma.plan.update({ where: { code: 'pro' }, data: { isPublic: false } });
    const res = await request(app).get('/plans');
    expect(res.body.items.map((p: { code: string }) => p.code)).toEqual(['free', 'enterprise']);
  });

  it('only a Super Admin can read or edit plans (every tenant role gets 403, anonymous 401)', async () => {
    await ensureDefaultPlans();
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'free' } });
    await expectRoleAccess({ app, method: 'get', path: '/admin/plans', allowed: [] });
    await expectRoleAccess({ app, method: 'post', path: '/admin/plans', body: {}, allowed: [] });
    await expectRoleAccess({
      app,
      method: 'patch',
      path: `/admin/plans/${plan.id}`,
      body: { name: 'X' },
      allowed: [],
    });
    await expectRoleAccess({ app, method: 'delete', path: `/admin/plans/${plan.id}`, allowed: [] });
    const sa = await superAdmin();
    expect((await request(app).get('/admin/plans').set(tok(sa))).status).toBe(200);
  });

  const newPlan = {
    code: 'team',
    name: 'Team',
    priceCents: 9900,
    limits: DEFAULT_PLANS[1]!.limits,
  };

  it('Super Admin creates, edits, deactivates and deletes a plan (audited)', async () => {
    const sa = await superAdmin();
    const created = await request(app).post('/admin/plans').set(tok(sa)).send(newPlan);
    expect(created.status).toBe(201);
    expect(created.body.plan).toMatchObject({ code: 'team', isActive: true, isPublic: true });
    const id = created.body.plan.id;

    const edited = await request(app)
      .patch(`/admin/plans/${id}`)
      .set(tok(sa))
      .send({ priceCents: 12900, limits: { ...newPlan.limits, users: 8 } });
    expect(edited.body.plan.priceCents).toBe(12900);
    expect(edited.body.plan.limits.users).toBe(8);

    await request(app).patch(`/admin/plans/${id}`).set(tok(sa)).send({ isActive: false });
    expect(
      (await request(app).get('/plans')).body.items.map((p: { code: string }) => p.code),
    ).not.toContain('team');

    expect((await request(app).delete(`/admin/plans/${id}`).set(tok(sa))).status).toBe(204);
    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['plan.created', 'plan.updated', 'plan.deleted']),
    );
  });

  it.each([
    ['bad code', { ...newPlan, code: 'Bad Code!' }],
    ['negative price', { ...newPlan, priceCents: -1 }],
    ['missing limits', { ...newPlan, limits: undefined }],
    ['non-integer limit', { ...newPlan, limits: { ...newPlan.limits, users: 1.5 } }],
    ['negative limit', { ...newPlan, limits: { ...newPlan.limits, skus: -5 } }],
    ['unknown limit key is stripped but missing key fails', { ...newPlan, limits: { users: 1 } }],
  ])('400: %s', async (_l, body) => {
    const sa = await superAdmin();
    expect((await request(app).post('/admin/plans').set(tok(sa)).send(body)).status).toBe(400);
  });

  it('409 on duplicate code; 404 on unknown plan; empty patch rejected', async () => {
    const sa = await superAdmin();
    await request(app).post('/admin/plans').set(tok(sa)).send(newPlan);
    expect((await request(app).post('/admin/plans').set(tok(sa)).send(newPlan)).status).toBe(409);
    expect(
      (await request(app).patch('/admin/plans/nope').set(tok(sa)).send({ name: 'x' })).status,
    ).toBe(404);
    expect((await request(app).delete('/admin/plans/nope').set(tok(sa))).status).toBe(404);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'team' } });
    expect((await request(app).patch(`/admin/plans/${plan.id}`).set(tok(sa)).send({})).status).toBe(
      400,
    );
  });

  it('cannot delete a plan that has subscriptions (or a pending downgrade to it)', async () => {
    const sa = await superAdmin();
    await createTenant({ plan: 'starter' });
    const starter = await prisma.plan.findUniqueOrThrow({ where: { code: 'starter' } });
    const res = await request(app).delete(`/admin/plans/${starter.id}`).set(tok(sa));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_IN_USE');
    const t = await createTenant({ plan: 'pro' });
    const free = await prisma.plan.findUniqueOrThrow({ where: { code: 'free' } });
    await prisma.subscription.update({
      where: { tenantId: t.id },
      data: { pendingPlanId: free.id },
    });
    expect((await request(app).delete(`/admin/plans/${free.id}`).set(tok(sa))).status).toBe(409);
  });

  it('plan edits change limits for existing tenants immediately (data-driven)', async () => {
    const sa = await superAdmin();
    const t = await createTenant({ plan: 'free' });
    const owner = await createUser({ role: 'OWNER', tenantId: t.id });
    const before = await request(app).get('/billing/subscription').set(tok(owner));
    expect(before.body.limits.users).toBe(2);
    const free = await prisma.plan.findUniqueOrThrow({ where: { code: 'free' } });
    await request(app)
      .patch(`/admin/plans/${free.id}`)
      .set(tok(sa))
      .send({ limits: { ...DEFAULT_PLANS[0]!.limits, users: 9 } });
    expect(
      (await request(app).get('/billing/subscription').set(tok(owner))).body.limits.users,
    ).toBe(9);
  });
});

describe('Feature 2.2: subscriptions and trial', () => {
  it('signup creates a 14-day Starter trial', async () => {
    const { owner, h } = await signupTenant();
    const res = await request(app).get('/billing/subscription').set(h);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'TRIALING',
      trialDaysLeft: 14,
      simulatedPayments: true,
    });
    expect(res.body.plan.code).toBe('starter');
    expect(res.body.usage.find((u: { metric: string }) => u.metric === 'users')).toEqual({
      metric: 'users',
      limit: 5,
      current: 1,
    });
    expect(owner.tenantId).toBeTruthy();
  });

  it('GET /billing/subscription: Owner/Admin only; tenant isolation applies (own tenant only)', async () => {
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/billing/subscription',
      allowed: rolesWith('billing:read'),
    });
  });

  it('trial days left counts down', async () => {
    const { owner } = await signupTenant();
    await prisma.subscription.update({
      where: { tenantId: owner.tenantId },
      data: { trialEndsAt: new Date(Date.now() + 3 * DAY_MS - 1000) },
    });
    const view = await request(app)
      .get('/billing/subscription')
      .set(bearer(tokenFor(owner)));
    expect(view.body.trialDaysLeft).toBe(3);
  });

  describe('trial expiry (fixed clock)', () => {
    it('moves expired trials to Free, notifies owners/admins, and leaves live trials alone', async () => {
      const a = await signupTenant('a@acme.com');
      const b = await signupTenant('b@acme.com');
      const base = new Date('2030-01-10T00:00:00Z');
      await prisma.subscription.update({
        where: { tenantId: a.owner.tenantId },
        data: { trialEndsAt: new Date('2030-01-09T00:00:00Z') },
      });
      await prisma.subscription.update({
        where: { tenantId: b.owner.tenantId },
        data: { trialEndsAt: new Date('2030-02-01T00:00:00Z') },
      });
      const summary = await runBillingMaintenance(base);
      expect(summary.trialsEnded).toBe(1);
      const subA = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: a.owner.tenantId },
        include: { plan: true },
      });
      expect(subA).toMatchObject({ status: 'ACTIVE' });
      expect(subA.plan.code).toBe('free');
      expect(subA.periodEnd).toEqual(addMonths(base, 1));
      const subB = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: b.owner.tenantId },
        include: { plan: true },
      });
      expect(subB.status).toBe('TRIALING');
      const notes = await prisma.notification.findMany({ where: { tenantId: a.owner.tenantId } });
      expect(notes.map((n) => n.type)).toEqual(['billing.trial_ended']);
      expect(await prisma.notification.count({ where: { tenantId: b.owner.tenantId } })).toBe(0);
      // idempotent
      expect((await runBillingMaintenance(base)).trialsEnded).toBe(0);
    });
  });

  describe('POST /billing/change-plan', () => {
    it('only the Owner may change plans', async () => {
      await expectRoleAccess({
        app,
        method: 'post',
        path: '/billing/change-plan',
        body: { planCode: 'free' },
        allowed: rolesWith('billing:manage'),
      });
    });

    it('trial → paid plan applies immediately, says payment successful, and creates a PAID invoice', async () => {
      const { owner, h } = await signupTenant();
      const res = await request(app).post('/billing/change-plan').set(h).send({ planCode: 'pro' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ result: 'APPLIED', paymentStatus: 'SUCCEEDED' });
      expect(res.body.message).toMatch(/Payment successful/);
      expect(res.body.subscription.plan.code).toBe('pro');
      expect(res.body.subscription.status).toBe('ACTIVE');
      expect(res.body.invoice).toMatchObject({
        amountCents: 19900,
        status: 'PAID',
        planName: 'Pro',
      });
      expect(res.body.invoice.number).toMatch(/^INV-\d{4}-000001$/);
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: owner.tenantId },
      });
      expect(sub.convertedAt).not.toBeNull();
      expect(
        (await prisma.notification.findMany({ where: { tenantId: owner.tenantId } })).map(
          (n) => n.type,
        ),
      ).toContain('billing.plan_changed');
    });

    it('trial → Starter (same plan) is a purchase, not an error', async () => {
      const { h } = await signupTenant();
      const res = await request(app)
        .post('/billing/change-plan')
        .set(h)
        .send({ planCode: 'starter' });
      expect(res.body).toMatchObject({ result: 'APPLIED', paymentStatus: 'SUCCEEDED' });
      expect(res.body.subscription.trialDaysLeft).toBeNull();
    });

    it('trial → Free ends the trial immediately with no invoice', async () => {
      const { owner, h } = await signupTenant();
      const res = await request(app).post('/billing/change-plan').set(h).send({ planCode: 'free' });
      expect(res.body.result).toBe('APPLIED');
      expect(res.body.subscription.plan.code).toBe('free');
      expect(await prisma.invoice.count({ where: { tenantId: owner.tenantId } })).toBe(0);
    });

    it('upgrade is immediate; downgrade is scheduled for period end and can be undone', async () => {
      const t = await createTenant({ plan: 'starter' });
      const owner = await createUser({ role: 'OWNER', tenantId: t.id });
      const h = tok(owner);
      const up = await request(app).post('/billing/change-plan').set(h).send({ planCode: 'pro' });
      expect(up.body.result).toBe('APPLIED');
      const down = await request(app)
        .post('/billing/change-plan')
        .set(h)
        .send({ planCode: 'starter' });
      expect(down.body.result).toBe('SCHEDULED');
      expect(down.body.subscription.plan.code).toBe('pro');
      expect(down.body.subscription.pendingPlan.code).toBe('starter');
      const undo = await request(app).post('/billing/change-plan').set(h).send({ planCode: 'pro' });
      expect(undo.body.result).toBe('UNCHANGED');
      expect(undo.body.subscription.pendingPlan).toBeNull();
    });

    it('downgrade is blocked when usage exceeds the new plan, with a clear list', async () => {
      const t = await createTenant({ plan: 'pro' });
      const owner = await createUser({ role: 'OWNER', tenantId: t.id });
      for (let i = 0; i < 5; i++) await createUser({ role: 'VIEWER', tenantId: t.id }); // 6 users > Free's 2
      const res = await request(app)
        .post('/billing/change-plan')
        .set(tok(owner))
        .send({ planCode: 'free' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DOWNGRADE_BLOCKED');
      expect(res.body.error.details.overages).toEqual([
        { metric: 'users', label: 'Users', limit: 2, current: 6, reduceBy: 4 },
      ]);
      expect(res.body.error.message).toMatch(/Users by 4/);
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } });
      expect(sub.pendingPlanId).toBeNull();
    });

    it('rejects same plan (400), unknown/inactive/custom plans (400), bad body (400)', async () => {
      const t = await createTenant({ plan: 'pro' });
      const owner = await createUser({ role: 'OWNER', tenantId: t.id });
      const h = tok(owner);
      expect(
        (await request(app).post('/billing/change-plan').set(h).send({ planCode: 'pro' })).body
          .error.code,
      ).toBe('ALREADY_ON_PLAN');
      expect(
        (await request(app).post('/billing/change-plan').set(h).send({ planCode: 'nope' })).body
          .error.code,
      ).toBe('PLAN_UNAVAILABLE');
      expect(
        (await request(app).post('/billing/change-plan').set(h).send({ planCode: 'enterprise' }))
          .body.error.code,
      ).toBe('PLAN_UNAVAILABLE');
      await prisma.plan.update({ where: { code: 'starter' }, data: { isActive: false } });
      expect(
        (await request(app).post('/billing/change-plan').set(h).send({ planCode: 'starter' }))
          .status,
      ).toBe(400);
      expect((await request(app).post('/billing/change-plan').set(h).send({})).status).toBe(400);
    });

    it('plan change clears Enterprise custom limits', async () => {
      const t = await createTenant({ plan: 'enterprise' });
      await prisma.subscription.update({
        where: { tenantId: t.id },
        data: { customLimits: { users: 500 } },
      });
      const owner = await createUser({ role: 'OWNER', tenantId: t.id });
      await request(app).post('/billing/change-plan').set(tok(owner)).send({ planCode: 'pro' });
      expect(
        (await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } })).customLimits,
      ).toBeNull();
    });
  });

  describe('POST /billing/cancel', () => {
    it('schedules a move to Free at period end; renewal job then applies it', async () => {
      const t = await createTenant({ plan: 'starter' });
      const owner = await createUser({ role: 'OWNER', tenantId: t.id });
      const res = await request(app).post('/billing/cancel').set(tok(owner));
      expect(res.body.result).toBe('SCHEDULED');
      expect(res.body.subscription.status).toBe('CANCELED');
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } });
      const summary = await runBillingMaintenance(new Date(sub.periodEnd.getTime() + 1000));
      expect(summary.downgraded).toBe(1);
      const after = await prisma.subscription.findUniqueOrThrow({
        where: { tenantId: t.id },
        include: { plan: true },
      });
      expect(after).toMatchObject({ status: 'ACTIVE', pendingPlanId: null });
      expect(after.plan.code).toBe('free');
      expect(await prisma.invoice.count({ where: { tenantId: t.id } })).toBe(0);
    });

    it('is Owner-only, 400 on Free, blocked when over limits', async () => {
      await expectRoleAccess({
        app,
        method: 'post',
        path: '/billing/cancel',
        allowed: rolesWith('billing:manage'),
      });
      const free = await createTenant({ plan: 'free' });
      const fo = await createUser({ role: 'OWNER', tenantId: free.id });
      expect((await request(app).post('/billing/cancel').set(tok(fo))).status).toBe(400);
      const pro = await createTenant({ plan: 'pro' });
      const po = await createUser({ role: 'OWNER', tenantId: pro.id });
      for (let i = 0; i < 3; i++) await createUser({ role: 'VIEWER', tenantId: pro.id });
      expect((await request(app).post('/billing/cancel').set(tok(po))).status).toBe(409);
    });

    it('cancelling during a trial moves to Free immediately', async () => {
      const { h } = await signupTenant();
      const res = await request(app).post('/billing/cancel').set(h);
      expect(res.body.subscription.plan.code).toBe('free');
    });
  });

  describe('renewals', () => {
    it('renewing a paid plan rolls the period and creates a PAID invoice; Free rolls without one', async () => {
      const paid = await createTenant({ plan: 'pro' });
      const free = await createTenant({ plan: 'free' });
      const subs = await prisma.subscription.findMany();
      const due = new Date(Math.max(...subs.map((s) => s.periodEnd.getTime())) + 1000);
      const summary = await runBillingMaintenance(due);
      expect(summary.renewed).toBe(1);
      const invoices = await prisma.invoice.findMany();
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ tenantId: paid.id, status: 'PAID', amountCents: 19900 });
      for (const t of [paid, free]) {
        const s = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } });
        expect(s.periodEnd.getTime()).toBeGreaterThan(due.getTime());
      }
      // Running again in the same period does nothing.
      expect((await runBillingMaintenance(due)).renewed).toBe(0);
    });
  });

  describe('Super Admin: PATCH /admin/tenants/:id/subscription', () => {
    it('sets Enterprise custom limits that the tenant then gets', async () => {
      const sa = await superAdmin();
      const t = await createTenant({ plan: 'free' });
      const owner = await createUser({ role: 'OWNER', tenantId: t.id });
      const res = await request(app)
        .patch(`/admin/tenants/${t.id}/subscription`)
        .set(tok(sa))
        .send({ planCode: 'enterprise', customLimits: { users: 250, skus: 123456 } });
      expect(res.status).toBe(200);
      expect(res.body.plan.code).toBe('enterprise');
      expect(res.body.limits).toMatchObject({ users: 250, skus: 123456, locations: 100 });
      expect(
        (await request(app).get('/billing/subscription').set(tok(owner))).body.limits.users,
      ).toBe(250);
      const cleared = await request(app)
        .patch(`/admin/tenants/${t.id}/subscription`)
        .set(tok(sa))
        .send({ customLimits: null });
      expect(cleared.body.limits.users).toBe(100);
      expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
        'admin.subscription_updated',
      );
    });

    it('is Super Admin only; validates input; 404 for unknown tenant', async () => {
      const t = await createTenant();
      await expectRoleAccess({
        app,
        method: 'patch',
        path: `/admin/tenants/${t.id}/subscription`,
        body: { status: 'ACTIVE' },
        allowed: [],
      });
      const sa = await superAdmin();
      expect(
        (await request(app).patch(`/admin/tenants/${t.id}/subscription`).set(tok(sa)).send({}))
          .status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .patch(`/admin/tenants/${t.id}/subscription`)
            .set(tok(sa))
            .send({ planCode: 'ghost' })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .patch(`/admin/tenants/${t.id}/subscription`)
            .set(tok(sa))
            .send({ customLimits: { users: -1 } })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .patch('/admin/tenants/nope/subscription')
            .set(tok(sa))
            .send({ status: 'ACTIVE' })
        ).status,
      ).toBe(404);
    });
  });
});

describe('Feature 2.4: invoices (payments are simulated, instantly PAID)', () => {
  async function paidTenant() {
    const { owner, h } = await signupTenant();
    await request(app).post('/billing/change-plan').set(h).send({ planCode: 'pro' });
    return { owner, h };
  }

  it('lists and shows the tenant’s invoices; roles Owner/Admin only', async () => {
    const { h } = await paidTenant();
    const list = await request(app).get('/billing/invoices').set(h);
    expect(list.body.total).toBe(1);
    const inv = list.body.items[0];
    const detail = await request(app).get(`/billing/invoices/${inv.id}`).set(h);
    expect(detail.body.invoice.number).toBe(inv.number);
    expect(detail.body.billedTo).toBe('Acme');
    await expectRoleAccess({
      app,
      method: 'get',
      path: '/billing/invoices',
      allowed: rolesWith('billing:read'),
    });
  });

  it('tenant isolation on GET /billing/invoices/:id', async () => {
    await expectTenantIsolation({
      app,
      method: 'get',
      path: (id) => `/billing/invoices/${id}`,
      createResource: async (tenantId) => {
        const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } });
        const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId } });
        return prisma.$transaction((tx) =>
          createPaidInvoice(tx, {
            tenantId,
            subscriptionId: sub.id,
            plan,
            periodStart: new Date(),
            periodEnd: addMonths(new Date(), 1),
            now: new Date(),
          }),
        );
      },
    });
  });

  it('invoice numbers are sequential, unique under concurrency, and per-year', async () => {
    const t = await createTenant({ plan: 'pro' });
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'pro' } });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t.id } });
    const mk = (now: Date) =>
      prisma.$transaction((tx) =>
        createPaidInvoice(tx, {
          tenantId: t.id,
          subscriptionId: sub.id,
          plan,
          periodStart: now,
          periodEnd: addMonths(now, 1),
          now,
        }),
      );
    const now = new Date('2031-05-05T00:00:00Z');
    const made = await Promise.all(Array.from({ length: 12 }, () => mk(now)));
    const numbers = made.map((i) => i.number).sort();
    expect(new Set(numbers).size).toBe(12);
    expect(numbers[0]).toBe('INV-2031-000001');
    expect(numbers[11]).toBe('INV-2031-000012');
    expect((await mk(new Date('2032-01-01T00:00:00Z'))).number).toBe('INV-2032-000001');
    expect(formatInvoiceNumber(2026, 123)).toBe('INV-2026-000123');
  });

  it('Super Admin can void an invoice (audited); void is final; tenants cannot', async () => {
    const { h } = await paidTenant();
    const inv = (await request(app).get('/billing/invoices').set(h)).body.items[0];
    const sa = await superAdmin();
    await expectRoleAccess({
      app,
      method: 'patch',
      path: `/admin/invoices/${inv.id}`,
      body: { status: 'VOID' },
      allowed: [],
    });
    const res = await request(app)
      .patch(`/admin/invoices/${inv.id}`)
      .set(tok(sa))
      .send({ status: 'VOID' });
    expect(res.body.invoice.status).toBe('VOID');
    expect(
      (await request(app).patch(`/admin/invoices/${inv.id}`).set(tok(sa)).send({ status: 'PAID' }))
        .status,
    ).toBe(409);
    expect(
      (await request(app).patch(`/admin/invoices/${inv.id}`).set(tok(sa)).send({ status: 'NOPE' }))
        .status,
    ).toBe(400);
    expect(
      (await request(app).patch('/admin/invoices/missing').set(tok(sa)).send({ status: 'VOID' }))
        .status,
    ).toBe(404);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain(
      'admin.invoice_updated',
    );
  });
});

describe('MRR calculation', () => {
  const now = new Date('2030-06-15T00:00:00Z');
  const inv = (
    tenantId: string,
    amountCents: number,
    start: string,
    end: string,
    status = 'PAID',
  ) => ({ tenantId, amountCents, status, periodStart: new Date(start), periodEnd: new Date(end) });

  it('sums the current PAID invoice per tenant', () => {
    expect(
      calculateMrr(
        [inv('a', 4900, '2030-06-01', '2030-07-01'), inv('b', 19900, '2030-06-10', '2030-07-10')],
        now,
      ),
    ).toBe(24800);
  });
  it('ignores VOID, PENDING, expired and future invoices', () => {
    expect(
      calculateMrr(
        [
          inv('a', 4900, '2030-06-01', '2030-07-01', 'VOID'),
          inv('b', 100, '2030-06-01', '2030-07-01', 'PENDING'),
          inv('c', 100, '2030-04-01', '2030-05-01'),
          inv('d', 100, '2030-07-01', '2030-08-01'),
        ],
        now,
      ),
    ).toBe(0);
  });
  it('counts only the latest period per tenant (upgrade mid-period does not double count)', () => {
    expect(
      calculateMrr(
        [inv('a', 4900, '2030-06-01', '2030-07-01'), inv('a', 19900, '2030-06-10', '2030-07-10')],
        now,
      ),
    ).toBe(19900);
  });
  it('is 0 with no invoices', () => expect(calculateMrr([], now)).toBe(0));
});
