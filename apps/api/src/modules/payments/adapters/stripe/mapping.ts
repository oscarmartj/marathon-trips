// Pure parts of the Stripe adapter (plan docs/plans/3.3-stripe-adapter-ledger.md, sections 5.3 to 5.5): status and error
// mapping, the webhook signature and the event parser. No network, no clock of their own, never Stripe's messages.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NormalisedEvent, ProviderErrorCode, ProviderPayment, ProviderPaymentStatus, ProviderRefund, ProviderRefundStatus } from '../../core/provider';

export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
export const STRIPE_TOLERANCE_SECONDS = 300;
/** Anything longer is not a Stripe signature header (several v1 values while a secret rolls fit easily). */
export const STRIPE_SIGNATURE_MAX = 4096;

/** Opaque Stripe ids: up to 255 characters (docs.stripe.com/api-versions); prefixes are not relied on except where said. */
const ID = /^[A-Za-z0-9_]{1,255}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A Stripe amount (an integer in the currency's smallest unit) as a bigint, or null if it is not one. */
export function stripeAmount(v: unknown): bigint | null {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null;
  return BigInt(v);
}

/** The Checkout Session status table (plan 3.3, 5.3). `piStatus` is the PaymentIntent's when known. */
export function sessionStatus(session: { status?: unknown; payment_status?: unknown }, piStatus?: string | null): ProviderPaymentStatus | null {
  switch (session.status) {
    case 'open':
      return 'requires_action';
    case 'expired':
      return 'cancelled';
    case 'complete':
      if (session.payment_status === 'paid') return 'succeeded';
      if (session.payment_status === 'unpaid' || session.payment_status === 'no_payment_required') {
        return piStatus === 'requires_payment_method' || piStatus === 'canceled' ? 'failed' : 'pending';
      }
      return null;
    default:
      return null;
  }
}

/** A Checkout Session object as our ProviderPayment, or null if it is not one we can read. */
export function sessionToPayment(o: unknown, override?: ProviderPaymentStatus): ProviderPayment | null {
  if (!isObj(o) || o.object !== 'checkout.session' || !ID.test(str(o.id) ?? '')) return null;
  const amount = stripeAmount(o.amount_total);
  const currency = str(o.currency);
  if (amount === null || !currency || !/^[a-z]{3}$/.test(currency)) return null;
  const pi = o.payment_intent;
  const piStatus = isObj(pi) ? str(pi.status) ?? null : null;
  const status = override ?? sessionStatus(o, piStatus);
  if (!status) return null;
  const meta = isObj(o.metadata) ? o.metadata : {};
  const ours = str(meta.mt_payment_id) ?? str(o.client_reference_id);
  const url = str(o.url);
  const failure = isObj(pi) && isObj(pi.last_payment_error) ? str(pi.last_payment_error.code) : undefined;
  return {
    ref: o.id as string,
    status,
    amount: { amountMinor: amount, currency: currency.toUpperCase() },
    ...(ours ? { ourPaymentId: ours } : {}),
    ...(status === 'requires_action' && url ? { nextAction: { type: 'redirect' as const, url } } : {}),
    ...(status === 'failed' ? { failureCode: failure && /^[a-z0-9_]{1,64}$/.test(failure) ? failure : 'payment_failed' } : {}),
  };
}

/** The PaymentIntent id of a session, expanded or not. */
export function sessionPaymentIntentId(o: unknown): string | null {
  if (!isObj(o)) return null;
  const pi = o.payment_intent;
  const id = isObj(pi) ? str(pi.id) : str(pi);
  return id && ID.test(id) ? id : null;
}

export function refundStatus(s: unknown): ProviderRefundStatus | null {
  switch (s) {
    case 'pending':
    case 'requires_action':
      return 'pending';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
    default:
      return null;
  }
}

export function refundToProvider(o: unknown): ProviderRefund | null {
  if (!isObj(o) || o.object !== 'refund' || !ID.test(str(o.id) ?? '')) return null;
  const amount = stripeAmount(o.amount);
  const currency = str(o.currency);
  const status = refundStatus(o.status);
  const pi = isObj(o.payment_intent) ? str(o.payment_intent.id) : str(o.payment_intent);
  if (amount === null || !currency || !/^[a-z]{3}$/.test(currency) || !status || !pi || !ID.test(pi)) return null;
  const meta = isObj(o.metadata) ? o.metadata : {};
  const ours = str(meta.mt_refund_id);
  const reason = str(o.failure_reason);
  return {
    ref: o.id as string, status, amount: { amountMinor: amount, currency: currency.toUpperCase() }, paymentRef: pi,
    ...(ours ? { ourRefundId: ours } : {}),
    ...(status === 'failed' ? { failureCode: reason && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : 'refund_failed' } : {}),
  };
}

/** Event types the adapter reads (plan 3.3, 5.3); everything else is `unsupported`. */
const SESSION_EVENTS: Readonly<Record<string, ProviderPaymentStatus | undefined>> = {
  'checkout.session.completed': undefined,
  'checkout.session.async_payment_succeeded': 'succeeded',
  'checkout.session.async_payment_failed': 'failed',
  'checkout.session.expired': 'cancelled',
};
const REFUND_EVENTS = new Set(['refund.created', 'refund.updated', 'refund.failed']);

/** A Stripe event body (already verified) as our NormalisedEvent; null if it cannot be read. Never throws. */
export function parseStripeEvent(body: unknown): NormalisedEvent | null {
  if (!isObj(body) || body.object !== 'event') return null;
  const id = str(body.id);
  const type = str(body.type);
  if (!id || !ID.test(id) || !type || !/^[a-z0-9_.]{1,100}$/.test(type) || typeof body.created !== 'number' || !Number.isSafeInteger(body.created)) return null;
  const base = { providerEventId: id, type, occurredAt: new Date(body.created * 1000) };
  const object = isObj(body.data) ? body.data.object : undefined;
  if (type in SESSION_EVENTS) {
    const payment = sessionToPayment(object, SESSION_EVENTS[type]);
    return payment ? { ...base, kind: 'payment', payment } : null;
  }
  if (REFUND_EVENTS.has(type)) {
    const refund = refundToProvider(object);
    return refund ? { ...base, kind: 'refund', refund } : null;
  }
  return { ...base, kind: 'unsupported' };
}

export type SignatureVerdict = { ok: true } | { ok: false; code: 'bad_signature' | 'stale_timestamp' };

/**
 * The Stripe-Signature check (plan 3.3, 5.4): HMAC-SHA256 of `<t>.<raw body>` with the endpoint secret, compared in
 * constant time with every v1 value; v0 is ignored; more than 300 s from `now` either way is stale.
 */
export function verifyStripeSignature(header: string | undefined, rawBody: Buffer, secret: string, now: Date): SignatureVerdict {
  if (!header || header.length > STRIPE_SIGNATURE_MAX || !secret) return { ok: false, code: 'bad_signature' };
  let t: number | null = null;
  const v1: Buffer[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) v1.push(Buffer.from(v, 'hex'));
  }
  if (t === null || v1.length === 0) return { ok: false, code: 'bad_signature' };
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  if (!v1.some((given) => given.length === expected.length && timingSafeEqual(given, expected))) return { ok: false, code: 'bad_signature' };
  if (Math.abs(now.getTime() / 1000 - t) > STRIPE_TOLERANCE_SECONDS) return { ok: false, code: 'stale_timestamp' };
  return { ok: true };
}

/** A Stripe-Signature header for a body (tests and the sandbox subject sign events with the endpoint secret). */
export function signStripe(secret: string, rawBody: Buffer, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex')}`;
}

export type StripeErrorKind = { code: ProviderErrorCode; retryable: boolean } | 'idempotency_error';

/** The error table (plan 3.3, 5.5). Only the HTTP status and Stripe's error type are read, never the message. */
export function stripeError(status: number, body: unknown): StripeErrorKind {
  const type = isObj(body) && isObj(body.error) ? str(body.error.type) : undefined;
  if (status === 400 && type === 'idempotency_error') return 'idempotency_error';
  if (status === 401 || status === 403) return { code: 'provider_auth_failed', retryable: false };
  if (status === 404) return { code: 'provider_not_found', retryable: false };
  if (status === 409 || status === 429) return { code: 'provider_busy', retryable: true };
  if (status >= 500) return { code: 'provider_unavailable', retryable: true };
  if (status >= 400) return { code: 'provider_rejected', retryable: false };
  return { code: 'provider_unavailable', retryable: true };
}
