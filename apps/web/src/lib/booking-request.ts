import type { BookingContact, QuoteRequest } from '@mt/shared';

// Booking requests from the web (task 2.4, plan docs/plans/2.4-booking-requests.md, section 9). The body is the
// configuration and the lead contact: never an amount, a currency, a date or a status. The API prices it.

export type BookingRequestBody = QuoteRequest & { contact: BookingContact };

/** The body the API receives: the quote request the builder made, and the contact. Nothing else. */
export function toBookingRequest(quote: QuoteRequest, contact: { givenName: string; familyName: string; phone?: string; countryOfResidence: string }): BookingRequestBody {
  const phone = contact.phone?.trim();
  return {
    ...quote,
    contact: { givenName: contact.givenName.trim(), familyName: contact.familyName.trim(), ...(phone ? { phone } : {}), countryOfResidence: contact.countryOfResidence.trim().toUpperCase() },
  };
}

/** Sorted-key JSON, so two equal bodies compare equal whatever the key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * One Idempotency-Key per body: a retry of the same body (a double click, a network error) reuses the key, so the API
 * makes one request; a corrected form is a new body and gets a new key (plan 2.4, section 16, point 9).
 */
export class IdempotencyKeys {
  private last: { body: string; key: string } | null = null;

  constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

  keyFor(body: unknown): string {
    const c = canonical(body);
    if (this.last?.body !== c) this.last = { body: c, key: this.newKey() };
    return this.last.key;
  }
}

/** Where to go back after signing in: only a booking request page of this site, never another site or another path. */
export const RETURN_TO_KEY = 'mt.bookingRequestReturnTo';
const RETURN_TO = /^\/races\/[a-z0-9-]{1,100}\/request\?[A-Za-z0-9%=&~:,._-]{0,2000}$/;
const RETURN_TO_TTL_MS = 60 * 60 * 1000;

export const safeReturnTo = (value: unknown): string | null => (typeof value === 'string' && RETURN_TO.test(value) ? value : null);

export function rememberReturnTo(storage: Pick<Storage, 'setItem'>, path: string, now = Date.now()): void {
  if (safeReturnTo(path)) storage.setItem(RETURN_TO_KEY, JSON.stringify({ path, at: now }));
}

/** Reads and forgets the remembered path; null when there is none, it is too old or it is not a request page. */
export function takeReturnTo(storage: Pick<Storage, 'getItem' | 'removeItem'>, now = Date.now()): string | null {
  const raw = storage.getItem(RETURN_TO_KEY);
  storage.removeItem(RETURN_TO_KEY);
  try {
    const v = JSON.parse(raw ?? 'null') as { path?: unknown; at?: unknown } | null;
    if (!v || typeof v.at !== 'number' || now - v.at > RETURN_TO_TTL_MS) return null;
    return safeReturnTo(v.path);
  } catch {
    return null;
  }
}

/** The message key for a failed request, by status and the API's error code (never its message). */
export function requestErrorKey(status: number, code: string | undefined): string {
  if (status === 0) return 'bookingRequest.errors.network';
  if (status === 401) return 'bookingRequest.errors.signIn';
  if (status === 404) return 'bookingRequest.errors.notOpen';
  if (status === 422) return 'bookingRequest.errors.invalid';
  if (status === 429) return 'bookingRequest.errors.tooMany';
  if (status === 409) {
    const known: Record<string, string> = {
      inventory_unavailable: 'bookingRequest.errors.soldOut',
      promo_code_unavailable: 'bookingRequest.errors.promo',
      country_not_served: 'bookingRequest.errors.country',
      too_many_open_requests: 'bookingRequest.errors.tooManyOpen',
      too_many_places_held: 'bookingRequest.errors.tooManyPlaces',
      package_departed: 'bookingRequest.errors.notOpen',
      catalogue_changed: 'bookingRequest.errors.changed',
      busy_try_again: 'bookingRequest.errors.busy',
      idempotency_in_progress: 'bookingRequest.errors.busy',
    };
    return known[code ?? ''] ?? 'bookingRequest.errors.notReady';
  }
  return 'bookingRequest.errors.generic';
}
