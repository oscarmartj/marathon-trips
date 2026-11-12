import { acceptTermsSchema, startPaymentSchema } from '@mt/shared';
import type { CheckoutTermsView, PaymentMethod, PaymentRefreshView } from '@mt/shared';

// Checkout helpers (task 3.5). Pure functions, so the rules the page depends on are tested without a browser. The page
// never works out an amount: it shows what the API sends, and what it sends back is a method, a version and a digest.

export const BOOKING_REFERENCE = /^MT-[0-9A-HJKMNP-TV-Z]{6}$/;
export const isBookingReference = (v: unknown): v is string => typeof v === 'string' && BOOKING_REFERENCE.test(v);

/** The body that starts a payment: a method and nothing else (the strict schema of the API refuses any other key). */
export function startPaymentBody(method: PaymentMethod): { method: PaymentMethod } {
  return startPaymentSchema.parse({ method });
}

/** The body that accepts the terms the person was shown: the version and digest the server gave. */
export function acceptTermsBody(terms: Pick<CheckoutTermsView, 'digest'> & { version: number }): { version: number; digest: string } {
  return acceptTermsSchema.parse({ version: terms.version, digest: terms.digest });
}

/**
 * Where to send the browser for the provider's page: only an absolute https address, or http on this machine, and only while this page is itself served from this machine (the
 * simulator in development and in the end-to-end run; a deployed site never sends a browser to http). Anything else, such as a relative path, javascript: or data:, is refused.
 */
export function safeRedirect(url: unknown, here: string | undefined = typeof window === 'undefined' ? undefined : window.location.hostname): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === 'https:') return parsed.toString();
  const local = (h: string | undefined) => h === 'localhost' || h === '127.0.0.1';
  if (parsed.protocol === 'http:' && local(parsed.hostname) && local(here)) return parsed.toString();
  return null;
}

/** Message key (under checkout.errors) for an answer of the start-payment or accept-terms routes. */
export function checkoutErrorKey(status: number, code: string | undefined): string {
  if (status === 401) return 'signedOut';
  if (status === 429) return 'tooMany';
  if (code === 'terms_changed') return 'termsChanged';
  if (code === 'terms_unavailable') return 'termsUnavailable';
  const known = ['terms_not_accepted', 'no_payment_method_available', 'approval_expired', 'booking_not_payable', 'nothing_to_pay', 'payment_attempt_in_progress', 'payment_already_recorded', 'provider_unavailable'];
  if (code && known.includes(code)) return code;
  if (code === 'busy_try_again') return 'busy';
  if (status === 503) return 'provider_unavailable';
  return 'generic';
}

/** Message key (under checkout.notPayable) for the reason the API gives when the plan cannot be paid. */
export function notPayableKey(reason: string | undefined): string {
  return reason && ['booking_not_payable', 'approval_expired', 'nothing_to_pay', 'no_payment_method_available'].includes(reason) ? reason : 'generic';
}

export const SETTLING = ['created', 'pending', 'requires_action'] as const;

export type PaymentOutcome = 'paid' | 'processing' | 'failed' | 'none';

/** What the return page says, from the API's latest attempt only (never from the address). */
export function outcomeOf(view: PaymentRefreshView): PaymentOutcome {
  const a = view.attempt;
  if (!a) return 'none';
  if (a.status === 'succeeded') return 'paid';
  if ((SETTLING as readonly string[]).includes(a.status)) return 'processing';
  return 'failed';
}

/** How long the return page keeps asking while a payment settles: six more times, two seconds apart. */
export const REFRESH_EVERY_MS = 2_000;
export const REFRESH_MAX_TRIES = 6;

/** An instant as the customer reads it, in Brisbane time (the business time zone). */
export const formatInstant = (iso: string): string =>
  new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Australia/Brisbane' }).format(new Date(iso));

/** A fresh idempotency key: 36 characters of hex and hyphens, inside the API's 16 to 64 rule. */
export const newIdempotencyKey = (): string => globalThis.crypto.randomUUID();
