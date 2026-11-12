import { describe, expect, it } from 'vitest';
import { bookingRequestSchema } from '@mt/shared';
import { IdempotencyKeys, countryProblem, RETURN_TO_KEY, parseWaitlistJoined, rememberReturnTo, requestErrorKey, safeReturnTo, takeReturnTo, toBookingRequest } from './booking-request';
import { messageCatalogue, t } from './i18n';

const quote = {
  packageId: '01a1cf11-cb7b-761b-83fd-12200ee98fc6',
  rooms: [{ roomOptionId: '01a1cf11-cc3c-715e-9d9a-7a3a6fe798d8', travellers: [{ participationType: 'supporter' as const }] }],
  extraNightsBefore: 0, extraNightsAfter: 1, extras: [],
};
const contact = { givenName: ' Ada ', familyName: 'Runner', phone: '', countryOfResidence: 'au' };

function storage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe('booking request body', () => {
  it('request_body_has_no_money_keys: the configuration and the contact only, accepted by the strict API schema', () => {
    const body = toBookingRequest(quote, contact);
    expect(bookingRequestSchema.safeParse(body).success).toBe(true);
    const keys = JSON.stringify(body).match(/"[A-Za-z]+":/g)!.map((k) => k.slice(1, -2));
    expect(keys.filter((k) => /minor|amount|price|total|currency|deposit|status|date/i.test(k))).toEqual([]);
    expect(body.contact).toEqual({ givenName: 'Ada', familyName: 'Runner', countryOfResidence: 'AU' });
  });
});

describe('IdempotencyKeys', () => {
  it('idempotency_key_reused_on_retry: the same body keeps its key, whatever the key order', () => {
    let n = 0;
    const keys = new IdempotencyKeys(() => `key-${++n}`);
    const body = toBookingRequest(quote, contact);
    expect(keys.keyFor(body)).toBe('key-1');
    const { contact: c, ...rest } = body;
    expect(keys.keyFor({ contact: c, ...rest })).toBe('key-1');
  });

  it('idempotency_key_new_when_body_changes: a corrected form gets a new key, and going back to it another', () => {
    let n = 0;
    const keys = new IdempotencyKeys(() => `key-${++n}`);
    const first = toBookingRequest(quote, contact);
    const fixed = toBookingRequest(quote, { ...contact, countryOfResidence: 'NZ' });
    expect([keys.keyFor(first), keys.keyFor(fixed), keys.keyFor(fixed), keys.keyFor(first)]).toEqual(['key-1', 'key-2', 'key-2', 'key-3']);
  });
});

describe('return_to_only_own_request_paths', () => {
  it.each([
    ['/races/gold-coast/request?edition=2027&package=classic&r=a~supporter', true],
    ['https://evil.example/races/x/request?a=1', false],
    ['//evil.example/races/x/request?a=1', false],
    ['/races/x/build?a=1', false],
    ['/account', false],
    ['/races/x/request?a=<script>', false],
    [42, false],
  ])('%s → %s', (path, ok) => {
    expect(safeReturnTo(path) !== null).toBe(ok);
  });

  it('remembers for an hour, reads once, and ignores anything not a request page', () => {
    const s = storage();
    rememberReturnTo(s, '/races/x/request?edition=2027', 1_000);
    expect(takeReturnTo(s, 2_000)).toBe('/races/x/request?edition=2027');
    expect(takeReturnTo(s, 2_000)).toBeNull();
    rememberReturnTo(s, '/races/x/request?edition=2027', 1_000);
    expect(takeReturnTo(s, 1_000 + 3_600_001)).toBeNull();
    rememberReturnTo(s, 'https://evil.example', 1_000);
    expect(s.m.has(RETURN_TO_KEY)).toBe(false);
    s.setItem(RETURN_TO_KEY, JSON.stringify({ path: '//evil.example', at: 1_000 }));
    expect(takeReturnTo(s, 1_000)).toBeNull();
    s.setItem(RETURN_TO_KEY, 'not json');
    expect(takeReturnTo(s, 1_000)).toBeNull();
  });
});

describe('error messages', () => {
  it('every key the request page can show exists, chosen by status and code only', () => {
    const catalogue = messageCatalogue() as { bookingRequest: { errors: Record<string, string> } };
    const cases: Array<[number, string | undefined]> = [
      [0, undefined], [401, undefined], [404, 'package_not_found'], [422, 'validation_failed'], [429, 'rate_limited'], [500, undefined],
      ...['inventory_unavailable', 'promo_code_unavailable', 'country_not_served', 'too_many_open_requests', 'too_many_places_held', 'package_departed', 'catalogue_changed', 'busy_try_again', 'idempotency_in_progress', 'something_new'].map((c): [number, string] => [409, c]),
    ];
    for (const [status, code] of cases) {
      const key = requestErrorKey(status, code).replace('bookingRequest.errors.', '');
      expect(catalogue.bookingRequest.errors[key], `${status} ${code}`).toBeTruthy();
    }
    expect(requestErrorKey(409, 'inventory_unavailable')).toBe('bookingRequest.errors.soldOut');
  });
});

describe('waiting list answer', () => {
  const joined = { outcome: 'waitlisted', status: 'waiting', joinedAt: '2026-11-13T00:00:00.000Z', travellers: 2, package: { id: 'x', name: { 'en-AU': 'Race weekend' } } };

  it('waitlist_answer_recognised: only an answer marked as waitlisted is the waiting list', () => {
    expect(parseWaitlistJoined(joined)?.package.name).toEqual({ 'en-AU': 'Race weekend' });
    // A booking request answer has a reference and no outcome: it must never be taken for a waiting list entry.
    expect(parseWaitlistJoined({ reference: 'MT-4YRAQQ', status: 'requested', isRequest: true, package: { name: {} } })).toBeNull();
    for (const bad of [null, undefined, 'waitlisted', 3, {}, { ...joined, outcome: 'requested' }, { ...joined, package: undefined }, { ...joined, travellers: '2' }]) expect(parseWaitlistJoined(bad)).toBeNull();
  });

  it('a country the API does not serve is no longer an error the form shows: it answers 201 with the waiting list', () => {
    // The 409 country_not_served code stays mapped (a settings change could bring it back), but the form no longer expects it.
    expect(requestErrorKey(409, 'country_not_served')).toBe('bookingRequest.errors.country');
  });
});

describe('country code on the form', () => {
  it('country_code_checked_like_the_api: assigned ISO codes pass in any case; UK suggests GB; made-up codes are named as invalid', () => {
    for (const ok of ['AU', 'nz', ' gb ', 'ES']) expect(countryProblem(ok), ok).toBeNull();
    expect(countryProblem('UK')).toEqual({ key: 'bookingRequest.errors.countrySuggest', params: { code: 'UK', suggestion: 'GB' } });
    expect(countryProblem('usa')?.params).toEqual({ code: 'USA', suggestion: 'US' });
    for (const bad of ['ZZ', 'XX', 'AUS', '', 'A1']) expect(countryProblem(bad)?.key, bad).toBe('bookingRequest.errors.countryInvalid');
    // Every message it can return exists and fills its parameters.
    for (const c of ['UK', 'ZZ', '']) { const p = countryProblem(c)!; expect(t(p.key, p.params)).toMatch(/country code/); }
  });
});
