// Booking request limits per customer and per IP (plan docs/plans/2.4-booking-requests.md, section 4). The other test
// files raise both limits; this one runs an app with low ones.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STATE_HEADERS, TestApp, makeApp, signInCustomer } from '../../support/auth';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
beforeAll(async () => {
  t = await makeApp({ BOOKING_REQUESTS_PER_HOUR_PER_USER: '2', BOOKING_REQUESTS_PER_HOUR_PER_IP: '3' });
});
afterAll(async () => {
  await t.close();
});

const send = (cookie: string) => t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', cookie).set('Idempotency-Key', randomUUID()).send({});

describe('request_rate_limited_per_user_and_ip', () => {
  it('two per customer, three per address, before the body is even read', async () => {
    const a = await signInCustomer(t);
    const b = await signInCustomer(t);
    // the guard runs before validation, so empty bodies count (422 means "let through")
    expect((await send(a.cookie)).status).toBe(422);
    expect((await send(a.cookie)).status).toBe(422);
    const third = await send(a.cookie);
    expect([third.status, third.body.code, Number(third.headers['retry-after']) > 0]).toEqual([429, 'rate_limited', true]);
    // a second customer from the same address: the address had 3 tries counted (the refused one included)
    const other = await send(b.cookie);
    expect([other.status, other.body.code]).toEqual([429, 'rate_limited']);
  });
});
