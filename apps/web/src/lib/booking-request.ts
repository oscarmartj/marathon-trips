import { ISO_COUNTRY_CODES, type BookingContact, type QuoteRequest } from '@mt/shared';

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

/** Common wrong codes and the ISO code people mean by them. */
const COUNTRY_SUGGESTIONS: Record<string, string> = { UK: 'GB', EN: 'GB', USA: 'US', UAE: 'AE' };

/**
 * The message key and parameters for a country code the API would refuse (it takes assigned ISO 3166-1 alpha-2 codes
 * only), or null when it is fine. Uses the same set as the API, so the form and the API agree.
 */
export function countryProblem(value: string): { key: string; params: Record<string, string> } | null {
  const code = value.trim().toUpperCase();
  if (ISO_COUNTRY_CODES.has(code)) return null;
  const suggestion = COUNTRY_SUGGESTIONS[code];
  if (suggestion) return { key: 'bookingRequest.errors.countrySuggest', params: { code, suggestion } };
  return { key: 'bookingRequest.errors.countryInvalid', params: { code: code || '' } };
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

/** What the API answers when the contact lives outside the countries we sell to: a waiting list entry, not a request (task 2.6). */
export interface WaitlistJoined {
  outcome: 'waitlisted';
  status: string;
  travellers: number;
  package: { name: Record<string, string> };
}

/** The waiting list answer, or null for anything else (a booking request answer has a reference and no outcome). */
export function parseWaitlistJoined(body: unknown): WaitlistJoined | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const pkg = b.package as { name?: unknown } | undefined;
  if (b.outcome !== 'waitlisted' || typeof b.status !== 'string' || typeof b.travellers !== 'number' || !pkg || typeof pkg.name !== 'object' || pkg.name === null) return null;
  return b as unknown as WaitlistJoined;
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
