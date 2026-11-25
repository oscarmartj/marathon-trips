// Airwallex's objects in our terms (plan docs/plans/9.2-airwallex.md, sections 4, 6.5, 7, 8, 19 and 20). Pure functions:
// no network, no clock of their own. Every Airwallex fact used here is UNVERIFIED until the sandbox run (plan §3).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NormalisedEvent, ProviderPayment, ProviderRefund, ProviderRefundStatus, WebhookVerification } from '../../core/provider';
import { AIRWALLEX_CURRENCIES, fromAirwallexAmount } from './money';
import { parseExact } from './json';

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Our payment reference (plan 4, D3): the order id we give Airwallex, `mt-<our payment id>-<attempt createdAt, Unix
 * seconds>`. Both the checkout session (payment_intent_data.merchant_order_id) and the PaymentIntent carry it.
 */
export const AIRWALLEX_REF = /^mt-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9]{10})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A PaymentIntent id (A23: the documented example is `int_…`). */
export const INTENT_ID = /^int_[A-Za-z0-9]{1,64}$/;
/** Ids we put in a URL path: no separator, no dot. */
export const PATH_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** An event id we name in a rejection row (plan 20.4). */
const EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function refFor(paymentId: string, createdAt: Date): string | null {
  const id = paymentId.toLowerCase();
  const t = Math.floor(createdAt.getTime() / 1000);
  if (!UUID.test(id) || !Number.isSafeInteger(t) || t < 1_000_000_000 || t > 9_999_999_999) return null;
  return `mt-${id}-${t}`;
}

export function parseRef(ref: string): { paymentId: string; createdAtS: number } | null {
  const m = AIRWALLEX_REF.exec(ref);
  return m ? { paymentId: m[1]!, createdAtS: Number(m[2]) } : null;
}

// ---- Webhook signatures (plan 7, 19.7 and 20.6) ----

export const AIRWALLEX_TIMESTAMP_HEADER = 'x-timestamp';
export const AIRWALLEX_SIGNATURE_HEADER = 'x-signature';
export const WEBHOOK_TOLERANCE_MS = 300_000;

/** The signature Airwallex sends: HMAC-SHA256, hex, of the raw x-timestamp text followed by the raw body. */
export function signAirwallex(secret: string, timestamp: string, body: Buffer): string {
  return createHmac('sha256', secret).update(timestamp).update(body).digest('hex');
}

/** The event id a body claims, if plausible: for the rejection row (plan 20.4). Never throws. */
export function claimedEventId(rawBody: Buffer): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    const id = isObj(parsed) ? parsed.id : undefined;
    return typeof id === 'string' && EVENT_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Checks the headers, the signature (constant time) and the timestamp (A9: 13 digits ms, 10 digits s). No network. */
export function verifySignature(secret: string, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): { ok: true } | { ok: false; code: 'bad_signature' | 'stale_timestamp' | 'malformed' } {
  const ts = headers[AIRWALLEX_TIMESTAMP_HEADER];
  const sig = headers[AIRWALLEX_SIGNATURE_HEADER];
  if (typeof ts !== 'string' || typeof sig !== 'string') return { ok: false, code: 'malformed' };
  if (!/^(?:[0-9]{10}|[0-9]{13})$/.test(ts) || !/^[0-9A-Fa-f]{64}$/.test(sig)) return { ok: false, code: 'malformed' };
  if (secret.length === 0) return { ok: false, code: 'bad_signature' };
  const expected = Buffer.from(signAirwallex(secret, ts, rawBody), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: 'bad_signature' };
  const at = ts.length === 13 ? Number(ts) : Number(ts) * 1000;
  if (Math.abs(now.getTime() - at) > WEBHOOK_TOLERANCE_MS) return { ok: false, code: 'stale_timestamp' };
  return { ok: true };
}

// ---- Payments (plan 6.5 and 20.1) ----

export type SessionStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
const SESSION_STATUSES: readonly string[] = ['ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED'];
export const MONEY_INTENT_STATUSES: readonly string[] = ['REQUIRES_CAPTURE', 'PENDING', 'PENDING_REVIEW', 'SUCCEEDED'];
export const OPEN_INTENT_STATUSES: readonly string[] = ['REQUIRES_PAYMENT_METHOD', 'REQUIRES_CUSTOMER_ACTION'];
const INTENT_STATUSES: readonly string[] = [...MONEY_INTENT_STATUSES, ...OPEN_INTENT_STATUSES, 'CANCELLED'];

export interface SessionView {
  id: string;
  status: SessionStatus;
  ref: string;
  url?: string;
  amountMinor: bigint;
  currency: string;
}

export interface IntentView {
  id: string;
  status: string;
  ref: string;
  amountMinor: bigint;
  currency: string;
}

/** A session of ours, read whole (status, our ref in both places, our amount); null if any part is unreadable. */
export function sessionView(o: unknown): SessionView | null {
  if (!isObj(o)) return null;
  const id = str(o.id);
  const status = str(o.status);
  const meta = isObj(o.metadata) ? o.metadata : undefined;
  const moid = isObj(o.payment_intent_data) ? str(o.payment_intent_data.merchant_order_id) : undefined;
  const ref = str(meta?.mt_ref);
  if (!id || !PATH_ID.test(id) || !status || !SESSION_STATUSES.includes(status) || !ref || !AIRWALLEX_REF.test(ref) || moid !== ref) return null;
  const minor = str(meta?.mt_amount_minor);
  const currency = str(o.currency);
  // Only AUD is readable (plan 20.7).
  if (!minor || !/^[1-9][0-9]{0,11}$/.test(minor) || !currency || !AIRWALLEX_CURRENCIES.includes(currency)) return null;
  const url = str(o.url);
  return { id, status: status as SessionStatus, ref, ...(status === 'ACTIVE' && url ? { url } : {}), amountMinor: BigInt(minor), currency };
}

/** A PaymentIntent of ours (its own merchant_order_id is the ref); null if unreadable or not ours. */
export function intentView(o: unknown): IntentView | null {
  if (!isObj(o)) return null;
  const id = str(o.id);
  const status = str(o.status);
  const ref = str(o.merchant_order_id);
  const currency = str(o.currency);
  const amountMinor = fromAirwallexAmount(o.amount, currency);
  if (!id || !INTENT_ID.test(id) || !status || !INTENT_STATUSES.includes(status) || !ref || !AIRWALLEX_REF.test(ref) || amountMinor === null || !currency) return null;
  return { id, status, ref, amountMinor, currency };
}

const ourPaymentIdOf = (ref: string): string | undefined => parseRef(ref)?.paymentId;

/**
 * Our view of a payment from its intent (if any) and its session (if found), plan 20.1. Null: the pair cannot be read
 * as a state (it contradicts A3): the caller answers "unknown", never a guess.
 */
export function paymentOf(session: SessionView | null, intent: IntentView | null): ProviderPayment | null {
  const base = (ref: string, amountMinor: bigint, currency: string) => ({ ref, amount: { amountMinor, currency }, ...(ourPaymentIdOf(ref) ? { ourPaymentId: ourPaymentIdOf(ref)! } : {}) });
  const waiting = (ref: string, amountMinor: bigint, currency: string): ProviderPayment => ({
    ...base(ref, amountMinor, currency), status: 'requires_action',
    ...(session?.status === 'ACTIVE' && session.url ? { nextAction: { type: 'redirect' as const, url: session.url } } : {}),
  });
  if (intent) {
    if (MONEY_INTENT_STATUSES.includes(intent.status)) return { ...base(intent.ref, intent.amountMinor, intent.currency), status: intent.status === 'SUCCEEDED' ? 'succeeded' : 'pending' };
    // An open intent is never read as ended, whatever the session says (plan 20.1): the core's settle cancels it.
    if (OPEN_INTENT_STATUSES.includes(intent.status)) return waiting(intent.ref, intent.amountMinor, intent.currency);
    // CANCELLED: what the session says decides between "paid nothing after checkout" and "ended unpaid".
    if (!session) return null;
    if (session.status === 'COMPLETED') return { ...base(intent.ref, intent.amountMinor, intent.currency), status: 'failed', failureCode: 'provider_cancelled' };
    if (session.status === 'ACTIVE') return waiting(intent.ref, intent.amountMinor, intent.currency);
    return { ...base(intent.ref, intent.amountMinor, intent.currency), status: 'cancelled' };
  }
  if (!session) return null;
  if (session.status === 'ACTIVE') return waiting(session.ref, session.amountMinor, session.currency);
  if (session.status === 'CANCELLED' || session.status === 'EXPIRED') return { ...base(session.ref, session.amountMinor, session.currency), status: 'cancelled' };
  return null;
}

// ---- Refunds (plan 8) ----

export interface RefundView extends ProviderRefund {
  intentId: string;
  /** sha256 of our idempotency key, from the metadata (lookup by key). */
  keyHash?: string;
  /** Our ref from the metadata, unchecked: the caller checks it against the intent before using it. */
  metaRef?: string;
  /**
   * Whether the object carried a `metadata` object at all (code review 9.2, point 1). Without one, nothing says whether
   * it is ours: the caller reads it again, and otherwise treats it as unknown, never as "not ours".
   */
  metadataPresent: boolean;
}

/** D5: money counts as gone only once SETTLED; RECEIVED and ACCEPTED are pending. */
const REFUND_STATUS: Readonly<Record<string, ProviderRefundStatus>> = { RECEIVED: 'pending', ACCEPTED: 'pending', SETTLED: 'succeeded', FAILED: 'failed' };

export function refundView(o: unknown): RefundView | null {
  if (!isObj(o)) return null;
  const id = str(o.id);
  const intentId = str(o.payment_intent_id);
  const currency = str(o.currency);
  const amountMinor = fromAirwallexAmount(o.amount, currency);
  const status = REFUND_STATUS[str(o.status) ?? ''];
  if (!id || !PATH_ID.test(id) || !intentId || !INTENT_ID.test(intentId) || amountMinor === null || !currency || !status) return null;
  const metadataPresent = isObj(o.metadata);
  const meta = isObj(o.metadata) ? o.metadata : {};
  const ourRefundId = str(meta.mt_refund_id);
  const keyHash = str(meta.mt_refund_key);
  const metaRef = str(meta.mt_ref);
  return {
    ref: id, status, amount: { amountMinor, currency }, paymentRef: intentId, intentId, metadataPresent,
    ...(ourRefundId && UUID.test(ourRefundId) ? { ourRefundId } : {}),
    ...(keyHash && /^[0-9a-f]{64}$/.test(keyHash) ? { keyHash } : {}),
    ...(metaRef && AIRWALLEX_REF.test(metaRef) ? { metaRef } : {}),
    ...(status === 'failed' ? { failureCode: 'provider_failed' } : {}),
  };
}

/** The refund as the core sees it: our ref as its payment when the intent's own order id agrees, else the intent id. */
export function refundOut(r: RefundView, intentRef: string | null): ProviderRefund {
  const paymentRef = r.metaRef && intentRef === r.metaRef ? r.metaRef : r.intentId;
  return { ref: r.ref, status: r.status, amount: r.amount, paymentRef, ...(r.ourRefundId ? { ourRefundId: r.ourRefundId } : {}), ...(r.failureCode ? { failureCode: r.failureCode } : {}) };
}

// ---- Events (plan 7, 19.1, 19.4 and 20.7) ----

/** A verified body as our event; null for a body that cannot be read at all (malformed). */
export function parseAirwallexEvent(rawBody: Buffer): NormalisedEvent | null {
  let e: unknown;
  try {
    e = parseExact(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isObj(e)) return null;
  const id = str(e.id);
  const name = str(e.name);
  const created = str(e.created_at);
  const occurredAt = created ? new Date(created) : new Date(NaN);
  if (!id || !EVENT_ID.test(id) || !name || name.length > 128 || Number.isNaN(occurredAt.getTime())) return null;
  const object = isObj(e.data) ? e.data.object : undefined;
  const head = { providerEventId: id, type: name, occurredAt };
  const unsupported = (review?: 'reversal' | 'dispute'): NormalisedEvent => ({ ...head, kind: 'unsupported', ...(review ? { review } : {}) });

  if (name.startsWith('payment_intent.')) {
    // A cancelled intent's meaning depends on its session (plan 20.1): read by the pulls, never from the event alone.
    if (name === 'payment_intent.cancelled') return unsupported();
    const intent = intentView(object);
    if (!intent) {
      // Another order id is not ours (ignored); anything else unreadable is malformed. Pulls read every payment of ours.
      const moid = isObj(object) ? str(object.merchant_order_id) : undefined;
      return moid !== undefined && !AIRWALLEX_REF.test(moid) ? unsupported() : null;
    }
    const payment = paymentOf(null, intent);
    return payment ? { ...head, kind: 'payment', payment } : unsupported();
  }
  if (name === 'checkout_session.created' || name === 'checkout_session.cancelled') {
    const s = sessionView(object);
    if (!s) return null;
    // A session says nothing about money: only its unpaid states are payment events (plan 19.1); no redirect in an event.
    const payment = s.status === 'COMPLETED' ? null : paymentOf(s, null);
    if (!payment) return unsupported();
    const { nextAction: _url, ...withoutUrl } = payment;
    return { ...head, kind: 'payment', payment: withoutUrl };
  }
  if (name.startsWith('refund.')) {
    const r = refundView(object);
    // A refund we cannot read may still be money gone: a review task, never dropped (plan 20.7).
    if (!r) return unsupported('reversal');
    // The payment is named by the refund's own intent, never by our metadata (code review 9.2, point 4): the core
    // resolves it with retrievePayment, which reads the intent's own merchant_order_id. A refund event without a
    // metadata object claims no id of ours; the core then asks retrieveRefund, which says "unknown" (retried).
    return { ...head, kind: 'refund', refund: refundOut(r, null) };
  }
  const lower = name.toLowerCase();
  if (lower.includes('dispute') || lower.includes('chargeback')) return unsupported('dispute');
  if (lower.includes('reversal')) return unsupported('reversal');
  return unsupported();
}

/** Airwallex's error code from an error body (A14), if any. */
export function errorCode(body: unknown): string | undefined {
  return isObj(body) && typeof body.code === 'string' ? body.code : undefined;
}

export { parseExact };
export type { WebhookVerification };
