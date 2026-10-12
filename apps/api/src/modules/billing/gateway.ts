import crypto from 'node:crypto';
import { HttpError } from '../../middleware/errors';

export interface CheckoutRequest {
  tenantId: string;
  planCode: string;
  planName: string;
  amountCents: number;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export type GatewayEvent =
  | {
      type: 'payment.succeeded';
      /** Provider reference of the payment; stored on the invoice so replays are no-ops. */
      reference: string;
      tenantId: string;
      planCode: string;
      amountCents: number;
    }
  | { type: 'ignored' };

/** A hosted-checkout payment provider. Card data never touches this server. */
export interface PaymentGateway {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<{ url: string; reference: string }>;
  /** Verifies the signature of a webhook delivery and translates it. Throws 400 if it is not authentic. */
  parseWebhook(rawBody: Buffer, signature: string | undefined, now?: Date): GatewayEvent;
}

const TOLERANCE_SECONDS = 300;

/** Stripe's `Stripe-Signature` scheme: `t=<unix>,v1=<hmac_sha256(secret, "t.payload")>[,v1=...]`. */
export function verifyStripeSignature(
  payload: Buffer,
  header: string | undefined,
  secret: string,
  now = new Date(),
): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(payload).digest();
  return sigs.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe';
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createCheckout(req: CheckoutRequest) {
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      customer_email: req.customerEmail,
      client_reference_id: req.tenantId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(req.amountCents),
      'line_items[0][price_data][product_data][name]': `SupplyCast ${req.planName} (monthly)`,
      'metadata[tenantId]': req.tenantId,
      'metadata[planCode]': req.planCode,
    });
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
    } catch {
      throw new HttpError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider is unreachable');
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string };
    if (!res.ok || !body.id || !body.url) {
      throw new HttpError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not start the checkout');
    }
    return { url: body.url, reference: body.id };
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined, now = new Date()): GatewayEvent {
    if (!verifyStripeSignature(rawBody, signature, this.webhookSecret, now)) {
      throw new HttpError(400, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
    }
    let event: {
      type?: string;
      data?: {
        object?: {
          id?: string;
          payment_status?: string;
          amount_total?: number;
          metadata?: { tenantId?: string; planCode?: string };
        };
      };
    };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'Webhook body is not valid JSON');
    }
    const o = event.data?.object;
    if (
      event.type === 'checkout.session.completed' &&
      o?.payment_status === 'paid' &&
      o.id &&
      o.metadata?.tenantId &&
      o.metadata.planCode &&
      typeof o.amount_total === 'number'
    ) {
      return {
        type: 'payment.succeeded',
        reference: o.id,
        tenantId: o.metadata.tenantId,
        planCode: o.metadata.planCode,
        amountCents: o.amount_total,
      };
    }
    return { type: 'ignored' };
  }
}
