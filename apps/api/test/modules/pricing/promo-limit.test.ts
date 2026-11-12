// public_promo_attempts_limited_per_ip and promo_attempt_limit_ipv6_prefix (plan docs/plans/2.2-pricing-rules-promo-codes.md,
// sections 9 and 15, point 7): its own app, so the limiter starts empty, trusting X-Forwarded-For from loopback.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DistinctLimiter, PROMO_CODES_PER_WINDOW, attemptKeyOf } from '../../../src/modules/pricing/promo-attempt.guard';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { createCode, freshCode } from '../../support/adjustments';
import { pricedWorld, quoteBody } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
let w: PricedWorld;
beforeAll(async () => {
  t = await makeApp({ TRUST_PROXY: 'loopback' });
  admin = await staffClient(t);
  w = await pricedWorld(admin);
});
afterAll(async () => {
  await closeCatalogue(t);
});

const from = (ip: string, body: object) => t.http().post('/pricing/quotes').set(STATE_HEADERS).set('X-Forwarded-For', ip).send(body);

describe('attemptKeyOf', () => {
  it.each<[string, string]>([
    ['203.0.113.7', 'v4:203.0.113.7'],
    ['::ffff:203.0.113.7', 'v4:203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', 'v6:2001:0db8:0001:0002::/64'],
    ['2001:db8:1:2::9', 'v6:2001:0db8:0001:0002::/64'],
    ['2001:DB8:1:2:ffff::1', 'v6:2001:0db8:0001:0002::/64'],
    ['2001:db8::1', 'v6:2001:0db8:0000:0000::/64'],
    ['fe80::1%eth0', 'v6:fe80:0000:0000:0000::/64'],
    ['::1', 'v6:0000:0000:0000:0000::/64'],
  ])('%s → %s', (ip, key) => expect(attemptKeyOf(ip)).toBe(key));

  it('DistinctLimiter: the same value again does not count; the window slides', () => {
    const l = new DistinctLimiter(2, 1000);
    expect([l.allow('k', 'A', 0), l.allow('k', 'A', 10), l.allow('k', 'B', 20), l.allow('k', 'C', 30), l.allow('k', 'A', 40)]).toEqual([true, true, true, false, true]);
    expect(l.allow('k', 'C', 1001)).toBe(true);
    expect(l.allow('other', 'Z', 40)).toBe(true);
  });

  it('the code a customer keeps using always fits again once its first try leaves the window (code review M2)', () => {
    const l = new DistinctLimiter(2, 1000);
    expect([l.allow('k', 'MINE', 0), l.allow('k', 'OTHER', 500), l.allow('k', 'THIRD', 600)]).toEqual([true, true, false]);
    expect([l.allow('k', 'MINE', 999), l.allow('k', 'MINE', 1001), l.allow('k', 'MINE', 1499)]).toEqual([true, true, true]);
  });
});

describe('public_promo_attempts_limited_per_ip', () => {
  it(`${PROMO_CODES_PER_WINDOW} different codes pass, the next is a 429 whether it exists or not; the same code again and quotes without a code still pass`, async () => {
    const ip = '198.51.100.20';
    const real = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id });
    const tried: string[] = [];
    for (let i = 0; i < PROMO_CODES_PER_WINDOW - 1; i++) tried.push(freshCode('GUESS'));
    tried.push('bad format!');
    for (const code of tried) expect((await from(ip, quoteBody(w, { promoCode: code }))).status, code).toBe(200);
    for (const code of [freshCode('GUESS'), real.code]) {
      const over = await from(ip, quoteBody(w, { promoCode: code }));
      expect([over.status, over.body.code, over.headers['retry-after']], code).toEqual([429, 'promo_attempts_exceeded', '900']);
    }
    // a code already tried, typed differently, is the same code: still allowed
    expect((await from(ip, quoteBody(w, { promoCode: ` ${tried[0]!.toLowerCase()} ` }))).status).toBe(200);
    expect((await from(ip, quoteBody(w))).status).toBe(200);
    // another address is not affected
    expect((await from('198.51.100.21', quoteBody(w, { promoCode: real.code }))).body.promo.status).toBe('applied');
  });

  it('promo_attempt_limit_ipv6_prefix: addresses in one /64 share the limit, another /64 does not', async () => {
    const inPrefix = (i: number) => `2001:db8:aa:bb::${(i + 1).toString(16)}`;
    for (let i = 0; i < PROMO_CODES_PER_WINDOW; i++) expect((await from(inPrefix(i), quoteBody(w, { promoCode: freshCode('V6') }))).status).toBe(200);
    expect((await from('2001:db8:aa:bb:ffff:ffff:ffff:fffe', quoteBody(w, { promoCode: freshCode('V6') }))).status).toBe(429);
    expect((await from('2001:db8:aa:bc::1', quoteBody(w, { promoCode: freshCode('V6') }))).status).toBe(200);
  });
});
