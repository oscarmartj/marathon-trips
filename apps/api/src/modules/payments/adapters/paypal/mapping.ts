// Pure parts of the PayPal adapter (plan docs/plans/4.3-paypal-adapter.md, sections 5.6, 6, 7.1 and 8): orders,
// captures and refunds as our types, the event parser and the error table. No network, no clock, never PayPal's words.
import { createHash } from 'node:crypto';
import type { NormalisedEvent, ProviderErrorCode, ProviderPayment, ProviderRefund, ProviderRefundStatus } from '../../core/provider';
import { fromPayPalValue } from './money';

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** PayPal IDs: 1 to 20 uppercase letters and digits (developer.paypal.com/sdk/payment/v2/definitions/supplementary_data). */
export const PAYPAL_ID = /^[A-Z0-9]{1,20}$/;
/** A refund names its payment by the capture: `capture:<id>` (plan 6). */
export const CAPTURE_REF = /^capture:([A-Z0-9]{1,20})$/;
const EVENT_ID = /^WH-[A-Za-z0-9-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** First 20 hex characters of the key's digest: ties an order or refund to our idempotency key without quoting it. */
export const keyDigest = (idempotencyKey: string): string => createHash('sha256').update(`paypal:key:${idempotencyKey}`).digest('hex').slice(0, 20);

/** Our marker in `custom_id`: `o` open order, `c` cancelled order, `r` refund (plan 5.2 and 5.4). */
export type MarkerKind = 'o' | 'c' | 'r';
export const customId = (kind: MarkerKind, ourId: string, idempotencyKey: string): string => `mt1:${kind}:${ourId}:${keyDigest(idempotencyKey)}`;
const MARKER = /^mt1:([ocr]):([0-9a-f-]{36}):([0-9a-f]{20})$/;

export function parseMarker(v: unknown): { kind: MarkerKind; ourId: string; digest: string } | null {
  const m = typeof v === 'string' ? MARKER.exec(v) : null;
  if (!m || !UUID.test(m[2]!)) return null;
  return { kind: m[1] as MarkerKind, ourId: m[2]!, digest: m[3]! };
}

function money(o: unknown): { amountMinor: bigint; currency: string } | null {
  if (!isObj(o)) return null;
  const currency = str(o.currency_code);
  const amountMinor = fromPayPalValue(o.value, currency);
  return amountMinor === null || !currency ? null : { amountMinor, currency };
}

const COLLECTED = ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/** The first purchase unit, its captures and refunds, as PayPal lists them in an order. */
export function purchaseUnit(order: unknown): { unit: Obj; captures: Obj[]; refunds: Obj[] } | null {
  if (!isObj(order)) return null;
  const units = arr(order.purchase_units);
  if (units.length !== 1 || !isObj(units[0])) return null;
  const unit = units[0];
  const payments = isObj(unit.payments) ? unit.payments : {};
  return { unit, captures: arr(payments.captures).filter(isObj), refunds: arr(payments.refunds).filter(isObj) };
}

function sum(list: Obj[], currency: string): bigint | null {
  let total = 0n;
  for (const c of list) {
    const m = money(c.amount);
    if (!m || m.currency !== currency) return null;
    total += m.amountMinor;
  }
  return total;
}

/**
 * An order as our ProviderPayment (plan 5.6), or null if it is not one we can read. `origin` is the manifest's checkout
 * origin: an approval link outside it makes the order unreadable; without any link the documented `checkoutnow?token=`
 * URL is used.
 */
export function orderToPayment(o: unknown, origin: string): ProviderPayment | null {
  if (!isObj(o)) return null;
  const id = str(o.id);
  const pu = purchaseUnit(o);
  if (!id || !PAYPAL_ID.test(id) || !pu) return null;
  const base = money(pu.unit.amount);
  if (!base) return null;
  const marker = parseMarker(pu.unit.custom_id);
  const ours = marker && marker.kind !== 'r' ? { ourPaymentId: marker.ourId } : {};
  const status = str(o.status);
  if (status === 'COMPLETED') {
    const collected = pu.captures.filter((c) => COLLECTED.includes(str(c.status) ?? ''));
    const pending = pu.captures.filter((c) => c.status === 'PENDING');
    const ended = pu.captures.filter((c) => c.status === 'DECLINED' || c.status === 'FAILED');
    if (collected.length > 0) {
      const total = sum(collected, base.currency);
      return total === null ? null : { ref: id, status: 'succeeded', amount: { amountMinor: total, currency: base.currency }, ...ours };
    }
    if (pending.length > 0) {
      const total = sum(pending, base.currency);
      return total === null ? null : { ref: id, status: 'pending', amount: { amountMinor: total, currency: base.currency }, ...ours };
    }
    if (ended.length > 0) return { ref: id, status: 'failed', amount: base, ...ours, failureCode: 'capture_declined' };
    return null;
  }
  if (status === 'VOIDED' || marker?.kind === 'c') return { ref: id, status: 'cancelled', amount: base, ...ours };
  if (status === 'CREATED' || status === 'SAVED' || status === 'APPROVED' || status === 'PAYER_ACTION_REQUIRED') {
    const link = arr(o.links).filter(isObj).find((l) => l.rel === 'approve' || l.rel === 'payer-action');
    // An approval link outside the checkout origin is refused (plan 5.2, review L3); an order PayPal lists without one
    // (an approved order's read) gets the documented approval URL of its token.
    if (link && !(typeof link.href === 'string' && link.href.startsWith(`${origin}/`))) return null;
    const url = link ? (link.href as string) : `${origin}/checkoutnow?token=${id}`;
    return { ref: id, status: 'requires_action', amount: base, ...ours, nextAction: { type: 'redirect', url } };
  }
  return null;
}

/** The order a capture belongs to (assumption A2). */
export const captureOrderId = (c: unknown): string | undefined => {
  if (!isObj(c) || !isObj(c.supplementary_data) || !isObj(c.supplementary_data.related_ids)) return undefined;
  const id = str(c.supplementary_data.related_ids.order_id);
  return id && PAYPAL_ID.test(id) ? id : undefined;
};

/**
 * A capture seen in a webhook as our payment (plan 7.1). A declined capture is `requires_action`: after
 * INSTRUMENT_DECLINED the order is still payable, so only a read decides whether it ended (review point 3).
 */
export function captureToPayment(c: unknown): ProviderPayment | null {
  if (!isObj(c)) return null;
  const orderId = captureOrderId(c);
  const m = money(c.amount);
  if (!orderId || !m || !PAYPAL_ID.test(str(c.id) ?? '')) return null;
  const marker = parseMarker(c.custom_id);
  const ours = marker && marker.kind !== 'r' ? { ourPaymentId: marker.ourId } : {};
  const status = str(c.status) ?? '';
  if (COLLECTED.includes(status)) return { ref: orderId, status: 'succeeded', amount: m, ...ours };
  if (status === 'PENDING') return { ref: orderId, status: 'pending', amount: m, ...ours };
  if (status === 'DECLINED' || status === 'FAILED') return { ref: orderId, status: 'requires_action', amount: m, ...ours };
  return null;
}

const REFUND_STATUS: Record<string, ProviderRefundStatus> = { COMPLETED: 'succeeded', PENDING: 'pending', FAILED: 'failed', CANCELLED: 'cancelled' };
const UP_CAPTURE = /\/v2\/payments\/captures\/([A-Z0-9]{1,20})(?:$|[/?#])/;

/** The capture a refund belongs to, from its `up` link (assumption A3). */
export function refundCaptureId(r: Obj): string | undefined {
  const up = arr(r.links).filter(isObj).find((l) => l.rel === 'up' && typeof l.href === 'string');
  const m = up ? UP_CAPTURE.exec(up.href as string) : null;
  return m?.[1];
}

/** A refund as our ProviderRefund, or null. `captureId` is used when the refund has no `up` link. */
export function refundToProvider(r: unknown, captureId?: string): ProviderRefund | null {
  if (!isObj(r)) return null;
  const id = str(r.id);
  const status = REFUND_STATUS[str(r.status) ?? ''];
  const m = money(r.amount);
  const cap = refundCaptureId(r) ?? captureId;
  if (!id || !PAYPAL_ID.test(id) || !status || !m || !cap) return null;
  const marker = parseMarker(r.custom_id);
  return {
    ref: id, status, amount: m, paymentRef: `capture:${cap}`,
    ...(marker?.kind === 'r' ? { ourRefundId: marker.ourId } : {}),
    ...(status === 'failed' ? { failureCode: 'refund_failed' } : {}),
  };
}

const PAYMENT_EVENTS = ['PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DECLINED'];
const REFUND_EVENTS = ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.REFUND.PENDING', 'PAYMENT.REFUND.FAILED'];
/** The events a PayPal webhook must be subscribed to (guide and connection test). */
export const REQUIRED_EVENT_TYPES: readonly string[] = ['CHECKOUT.ORDER.APPROVED', ...PAYMENT_EVENTS, ...REFUND_EVENTS];

/** A PayPal event (plan 7.1), or null if it is not one we can read. Statuses come from the resource, not the name. */
export function parsePayPalEvent(e: unknown, origin: string): NormalisedEvent | null {
  if (!isObj(e)) return null;
  const id = str(e.id);
  const type = str(e.event_type);
  const created = str(e.create_time);
  const occurredAt = created ? new Date(created) : new Date(NaN);
  if (!id || !EVENT_ID.test(id) || !type || type.length > 100 || !/^[A-Z0-9._-]+$/.test(type) || Number.isNaN(occurredAt.getTime())) return null;
  const base = { providerEventId: id, type, occurredAt };
  if (type === 'CHECKOUT.ORDER.APPROVED') {
    const payment = orderToPayment(e.resource, origin);
    return payment ? { ...base, kind: 'payment', payment } : null;
  }
  if (PAYMENT_EVENTS.includes(type)) {
    const payment = captureToPayment(e.resource);
    return payment ? { ...base, kind: 'payment', payment } : null;
  }
  if (REFUND_EVENTS.includes(type)) {
    const refund = refundToProvider(e.resource);
    return refund ? { ...base, kind: 'refund', refund } : null;
  }
  // Money moved without us (review M2): the core opens a task. Other events are only stored.
  if (type === 'PAYMENT.CAPTURE.REVERSED') return { ...base, kind: 'unsupported', review: 'reversal' };
  if (type === 'CUSTOMER.DISPUTE.CREATED') return { ...base, kind: 'unsupported', review: 'dispute' };
  return { ...base, kind: 'unsupported' };
}

// ---- Errors (plan 8) ----

/** PayPal's issue names that we act on; anything else is just its HTTP status. */
const KNOWN_ISSUES = [
  'INSTRUMENT_DECLINED', 'ORDER_NOT_APPROVED', 'TRANSACTION_REFUSED', 'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING', 'ORDER_ALREADY_CAPTURED',
  'PREVIOUS_REQUEST_IN_PROGRESS', 'PAYPAL_REQUEST_ID_PREVIOUSLY_USED', 'INVALID_REQUEST', 'invalid_client',
] as const;
export type PayPalIssue = (typeof KNOWN_ISSUES)[number];

/** The first known issue named in an error body (`name`, `error`, or `details[].issue`). */
export function paypalIssue(body: unknown): PayPalIssue | undefined {
  if (!isObj(body)) return undefined;
  const names = [str(body.name), str(body.error), ...arr(body.details).filter(isObj).map((d) => str(d.issue))];
  return KNOWN_ISSUES.find((k) => names.includes(k));
}

/** The capture outcomes that leave the order payable with another instrument (plan 5.3). */
export const PAYER_RETRY_ISSUES: readonly PayPalIssue[] = ['INSTRUMENT_DECLINED', 'ORDER_NOT_APPROVED', 'TRANSACTION_REFUSED', 'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING'];

/** An HTTP error as our code (plan 8). */
export function paypalError(status: number, issue: PayPalIssue | undefined): { code: ProviderErrorCode; retryable: boolean } {
  if (status === 401) return { code: 'provider_auth_failed', retryable: false };
  if (status === 400 && issue === 'invalid_client') return { code: 'provider_auth_failed', retryable: false };
  if (status === 404) return { code: 'provider_not_found', retryable: false };
  if (status === 409 || status === 429) return { code: 'provider_busy', retryable: true };
  if (status === 422 && (issue === 'PREVIOUS_REQUEST_IN_PROGRESS' || issue === 'PAYPAL_REQUEST_ID_PREVIOUSLY_USED')) return { code: 'provider_busy', retryable: true };
  if (status === 400 || status === 403 || status === 422) return { code: 'provider_rejected', retryable: false };
  return { code: 'provider_unavailable', retryable: true };
}
