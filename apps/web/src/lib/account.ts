import type { CustomerDocumentKind, PaymentLinkRefreshView, PaymentMethod } from '@mt/shared';

// Task 8.3: these two lists mirror @mt/shared (CUSTOMER_DOCUMENT_KINDS, PAYMENT_METHODS) and the shape of a payment link token.
// Importing the values would put the validation library into the browser bundle of every page that pays by link (about 114 kB
// compressed). account.test.ts checks that they still match the shared package, so they cannot drift.
export const CUSTOMER_DOCUMENT_KINDS = ['confirmation', 'itinerary', 'voucher'] as const;
export const PAYMENT_METHODS_LIST = ['card', 'apple_pay', 'google_pay', 'payto', 'becs', 'payid_transfer', 'bpay', 'bnpl', 'manual_other'] as const;
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// The customer area and payment links (task 5.1). Pure helpers, tested without a browser. The pages show what the API
// sends; nothing here adds up an amount.

export const BOOKING_STATUS_KEYS = ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed', 'declined', 'expired', 'cancelled', 'refunded'] as const;

/** Message key (under account.status) for a booking status; an unknown one reads as "being reviewed", never as confirmed. */
export const statusKey = (status: string): string => ((BOOKING_STATUS_KEYS as readonly string[]).includes(status) ? status : 'unknown');

/** Where a document is downloaded: the API through the same-origin proxy, under the booking's reference. */
export function documentHref(reference: string, kind: string): string | null {
  if (!/^MT-[0-9A-HJKMNP-TV-Z]{6}$/.test(reference) || !(CUSTOMER_DOCUMENT_KINDS as readonly string[]).includes(kind)) return null;
  return `/api/account/bookings/${reference}/documents/${kind}`;
}

export const documentKinds = (kinds: readonly string[]): CustomerDocumentKind[] => kinds.filter((k): k is CustomerDocumentKind => (CUSTOMER_DOCUMENT_KINDS as readonly string[]).includes(k));

/** The body that pays through a link: the token and a method, nothing else (the API's strict schema refuses any other key). */
export function payByLinkBody(token: string, method: PaymentMethod): { token: string; method: PaymentMethod } {
  if (!LINK_TOKEN_PATTERN.test(token) || !(PAYMENT_METHODS_LIST as readonly string[]).includes(method)) throw new Error('Not a payment link token or payment method');
  return { token, method };
}

/** Message key (under payLink.errors) for an answer of the payment link routes. */
export function payLinkErrorKey(status: number, code: string | undefined): string {
  if (status === 404) return 'notFound';
  if (status === 429) return 'tooMany';
  const known = ['terms_not_accepted', 'terms_unavailable', 'payment_attempt_in_progress', 'payment_already_recorded', 'no_payment_method_available', 'provider_unavailable', 'nothing_to_pay', 'approval_expired', 'booking_not_payable'];
  if (code && known.includes(code)) return code;
  if (status === 503) return 'provider_unavailable';
  return 'generic';
}

/** What the link's return page says, from the API's answer only. */
export function linkOutcome(view: PaymentLinkRefreshView): 'paid' | 'processing' | 'failed' | 'none' {
  if (view.used || view.attempt?.status === 'succeeded') return 'paid';
  const a = view.attempt;
  if (!a) return 'none';
  return ['created', 'pending', 'requires_action'].includes(a.status) ? 'processing' : 'failed';
}

/** The link's token is kept only for the trip to the provider and back, in this tab, then deleted. */
export const PAY_LINK_STORAGE_KEY = 'mt.payLinkToken';

/** Task 4.6: a receipt or note of the customer's booking, as the API lists it. */
export interface AccountReceipt {
  number: string;
  kind: 'receipt' | 'refund' | 'refund_reversal' | 'chargeback' | 'chargeback_reinstatement' | 'void';
  issuedAt: string;
  amountMinor: string;
  currency: string;
  receiptNumber: string | null;
}

export const RECEIPT_KINDS: readonly AccountReceipt['kind'][] = ['receipt', 'refund', 'refund_reversal', 'chargeback', 'chargeback_reinstatement', 'void'];

/** The download link of one receipt or note, through the API proxy; null for anything that is not one. */
export function receiptHref(reference: string, number: string): string | null {
  if (!/^MT-[0-9A-HJKMNP-TV-Z]{6}$/.test(reference) || !/^MT-[TR]-[1-9][0-9]{0,17}$/.test(number)) return null;
  return `/api/account/bookings/${reference}/receipts/${number}`;
}

/** The documents of a kind the page knows how to name. */
export const knownReceipts = (list: readonly AccountReceipt[]): AccountReceipt[] => list.filter((r) => RECEIPT_KINDS.includes(r.kind));
