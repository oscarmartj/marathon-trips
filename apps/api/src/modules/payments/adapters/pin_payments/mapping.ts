// Reading Pin Payments' answers (plan docs/plans/4.4-au-card-gateway.md, sections 2, 6 to 8): closed lists and strict
// shapes only. Pin's words (error_description, messages, status text) never leave this folder.
import type { CardDeclineCode, GatewayCharge, GatewayRefund, NormalisedEvent, ProviderPaymentStatus, ProviderRefundStatus } from '../../core/provider';
import { CARD_SESSION_REF } from '../../core/provider';

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const CHARGE_TOKEN = /^ch_[A-Za-z0-9_-]{10,40}$/;
export const REFUND_TOKEN = /^rf_[A-Za-z0-9_-]{10,40}$/;
export const EVENT_TOKEN = /^evt_[A-Za-z0-9_-]{10,40}$/;
export const SESSION_TOKEN = /^se_[A-Za-z0-9_-]{10,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Strict ISO 8601 with a zone, as Pin's examples (`2012-06-20T03:10:49Z`). */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Metadata keys we write on a charge (plan 4.4, section 6.3 step 3). */
export const META_SESSION = 'mt_session';
export const META_PAYMENT = 'mt_payment';

/** Pin's decline codes we map; anything else that is a 400 on a charge is a generic decline. */
const DECLINE_CODES: Readonly<Record<string, CardDeclineCode>> = {
  card_declined: 'card_declined',
  insufficient_funds: 'insufficient_funds',
  expired_card: 'expired_card',
  lost_card: 'card_declined',
  stolen_card: 'card_declined',
  processing_error: 'processing_error',
  suspected_fraud: 'suspected_fraud',
  three_d_secure_unavailable: 'card_not_authenticated',
};
export const declineCodeOf = (error: string | undefined): CardDeclineCode | undefined => (error ? DECLINE_CODES[error] : undefined);

/** Integer minor units from a JSON number: only safe integers (plan 4.4, section 6.1). */
export function minorOf(v: unknown): bigint | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
}

/** The JSON number Pin takes for an amount; the bigint was bounds-checked by the caller (≤ 999 999 999). */
export function amountForPin(amountMinor: bigint): number {
  if (amountMinor < 1n || amountMinor > 999_999_999n) throw new RangeError('amount out of range');
  return Number(amountMinor);
}

export const dateOf = (v: unknown): Date | undefined => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);

/** Pin's error code from an error body (`{ error, error_description }` or an array of those), or undefined. */
export function pinError(body: unknown): { error?: string; chargeToken?: string } {
  const b = Array.isArray(body) ? body[0] : body;
  if (!isObj(b)) return {};
  const error = typeof b.error === 'string' && /^[a-z_]{1,64}$/.test(b.error) ? b.error : undefined;
  const chargeToken = typeof b.charge_token === 'string' && CHARGE_TOKEN.test(b.charge_token) ? b.charge_token : undefined;
  return { error, chargeToken };
}

/** The object of a success answer: Pin wraps it in `response`. */
export const responseOf = (body: unknown): unknown => (isObj(body) ? body.response : undefined);

/**
 * A charge, or undefined if it does not have the documented shape. Its state is read defensively (review M1): failed
 * only on an explicit failure, pending while 3-D Secure is open or the charge is successful but not yet captured, and
 * `unknown` for anything else (the caller treats that as "cannot read it", never as a decline).
 */
export function chargeOf(v: unknown): (GatewayCharge & { unknown: boolean }) | undefined {
  if (!isObj(v)) return undefined;
  const { token, currency } = v;
  const amount = minorOf(v.amount);
  if (typeof token !== 'string' || !CHARGE_TOKEN.test(token) || typeof currency !== 'string' || !CURRENCY.test(currency) || amount === undefined) return undefined;
  const success = v.success === true;
  const captured = v.captured === true;
  const pending = (success && !captured) || (v.success !== true && v.status_message === 'Pending');
  const failed = v.success === false && !pending && (v.status_message === 'Failed' || (typeof v.error_message === 'string' && v.error_message.length > 0));
  const meta = isObj(v.metadata) ? v.metadata : {};
  const sessionRef = typeof meta[META_SESSION] === 'string' && CARD_SESSION_REF.test(meta[META_SESSION]) ? meta[META_SESSION] : undefined;
  const ourPaymentId = typeof meta[META_PAYMENT] === 'string' && UUID.test(meta[META_PAYMENT]) ? meta[META_PAYMENT] : undefined;
  const charge: GatewayCharge & { unknown: boolean } = { token, success, captured, pending, failed, amount: { amountMinor: amount, currency }, unknown: !(success && captured) && !pending && !failed };
  if (sessionRef) charge.sessionRef = sessionRef;
  if (ourPaymentId) charge.ourPaymentId = ourPaymentId;
  if (failed) charge.failureCode = 'card_declined';
  return charge;
}

/** The charge's status as ours: collected, still in progress, or ended without money (only an explicit failure). */
export const chargeStatus = (c: GatewayCharge): ProviderPaymentStatus => (c.success && c.captured ? 'succeeded' : c.failed ? 'failed' : 'pending');

/** A refund's status from `status_message` (plan 4.4, section 7); undefined if we cannot read it. */
export function refundStatusOf(v: Obj): ProviderRefundStatus | undefined {
  if (v.status_message === 'Pending') return 'pending';
  if (v.status_message === 'Success') return 'succeeded';
  if (v.status_message === 'Failed' || (v.success === false && typeof v.error_message === 'string' && v.error_message.length > 0)) return 'failed';
  return undefined;
}

export function refundOf(v: unknown): GatewayRefund | undefined {
  if (!isObj(v)) return undefined;
  const { token, currency, charge } = v;
  const amount = minorOf(v.amount);
  const createdAt = dateOf(v.created_at);
  const chargeToken = typeof charge === 'string' ? charge : isObj(charge) ? charge.token : undefined;
  const status = refundStatusOf(v);
  if (typeof token !== 'string' || !REFUND_TOKEN.test(token) || typeof currency !== 'string' || !CURRENCY.test(currency) || amount === undefined) return undefined;
  if (typeof chargeToken !== 'string' || !CHARGE_TOKEN.test(chargeToken) || !createdAt || !status) return undefined;
  const r: GatewayRefund = { token, status, amount: { amountMinor: amount, currency }, chargeToken, createdAt };
  if (status === 'failed') r.failureCode = 'refund_failed';
  return r;
}

const PAYMENT_EVENTS = new Set(['charge.captured', 'charge.authorised', 'charge.failed', 'charge.voided']);
const REFUND_EVENTS = new Set(['refund.created', 'refund.succeeded', 'refund.failed']);

/**
 * An event body that already passed verification (plan 4.4, section 8.2). Statuses come from `data`, never from the
 * event's name, so a late event states its own, older state. Null if the body is not a Pin event.
 */
export function parsePinEvent(v: unknown): NormalisedEvent | null {
  if (!isObj(v) || !isObj(v.data)) return null;
  const { token, type } = v;
  const occurredAt = dateOf(v.created_at);
  if (typeof token !== 'string' || !EVENT_TOKEN.test(token) || typeof type !== 'string' || type.length === 0 || type.length > 64 || !occurredAt) return null;
  const base = { providerEventId: token, type, occurredAt };
  if (PAYMENT_EVENTS.has(type)) {
    const c = chargeOf(v.data);
    if (!c) return null;
    // A state we cannot read is not processed: the next read of the gateway decides (review M1).
    if (c.unknown) return { ...base, kind: 'unsupported' };
    const status: ProviderPaymentStatus = chargeStatus(c);
    const payment = { ref: c.sessionRef ?? c.token, status, amount: c.amount, ...(c.ourPaymentId ? { ourPaymentId: c.ourPaymentId } : {}), ...(status === 'failed' ? { failureCode: c.failureCode ?? 'card_declined' } : {}) };
    return { ...base, kind: 'payment', payment };
  }
  if (REFUND_EVENTS.has(type)) {
    const r = refundOf(v.data);
    if (!r) return null;
    return { ...base, kind: 'refund', refund: { ref: r.token, status: r.status, amount: r.amount, paymentRef: r.chargeToken, ...(r.failureCode ? { failureCode: r.failureCode } : {}) } };
  }
  if (type.startsWith('dispute.')) return { ...base, kind: 'unsupported', review: 'dispute' };
  return { ...base, kind: 'unsupported' };
}
