import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lru, UnknownAccountDelay } from '../../src/platform/auth/attempt-limiter';
import { rateLimitKey } from '../../src/platform/http/client-ip-watch';
import { CustomerAuthService, MAGIC_LINKS_PER_ADDRESS } from '../../src/platform/auth/customer-auth.service';
import { StaffAuthService } from '../../src/platform/auth/staff-auth.service';
import { STATE_HEADERS, TestApp, createStaff, makeApp, uniqueEmail } from '../support/auth';

// Task 8.5: in-memory counters that guard against account enumeration and mail floods (S-06, S-07).
let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

describe('bounded tables never forget a live count (S-06)', () => {
  it('trySet refuses a new key when the table is full of live entries, keeps existing keys, and makes room once they expire', () => {
    const lru = new Lru<number>(2, 60_000);
    expect(lru.trySet('a', 1, 0)).toBe(true);
    expect(lru.trySet('b', 1, 0)).toBe(true);
    expect(lru.trySet('c', 1, 10)).toBe(false);
    expect(lru.get('a', 10)).toBe(1);
    expect(lru.trySet('a', 2, 10)).toBe(true);
    expect(lru.trySet('c', 1, 60_001)).toBe(true);
  });

  it('a full unknown-address table refuses new addresses for a minute instead of wiping the guessed ones', () => {
    const d = new UnknownAccountDelay(2);
    for (let i = 0; i < 3; i++) {
      try {
        d.claim('target', 0);
      } catch {
        // the third failure sets a delay
      }
    }
    d.claim('other', 0);
    expect(() => d.claim('flood-1', 0)).toThrow();
    // Saturated for every address, those with an entry too (review round 1): no answer depends on having one.
    expect(d.saturated(1000)).toBe(true);
    // The guessed address keeps its delay: a flood cannot evict it.
    expect(() => d.claim('target', 500)).toThrow();
    expect(d.saturated(61_000)).toBe(false);
  });

  it('while saturated, a known staff address and an unknown one get the same 429 (no enumeration, T2)', async () => {
    const staff = await createStaff(t);
    const svc = t.app.get(StaffAuthService);
    const full = new UnknownAccountDelay(1);
    Reflect.set(svc, 'unknown', full);
    const attempt = (email: string) => t.http().post('/auth/staff/sign-in').set(STATE_HEADERS).send({ email, password: 'definitely-wrong-password' });
    expect((await attempt(uniqueEmail('filler'))).status).toBe(401);
    const unknown = await attempt(uniqueEmail('nobody'));
    const known = await attempt(staff.email);
    expect([unknown.status, known.status]).toEqual([429, 429]);
    expect(unknown.body).toEqual(known.body);
    Reflect.set(svc, 'unknown', new UnknownAccountDelay());
    // Once the table has room again, the known account is checked as before.
    expect((await attempt(staff.email)).status).toBe(401);
  });

  it('an unknown address tried before the flood and a staff account answer alike while saturated (review round 1)', async () => {
    const staff = await createStaff(t);
    const svc = t.app.get(StaffAuthService);
    Reflect.set(svc, 'unknown', new UnknownAccountDelay(2));
    const attempt = (email: string) => t.http().post('/auth/staff/sign-in').set(STATE_HEADERS).send({ email, password: 'definitely-wrong-password' });
    const probe = uniqueEmail('probe');
    // The attacker tries V once (no account: V gets an entry), fills the table, then tries V and a staff address again.
    expect((await attempt(probe)).status).toBe(401);
    expect((await attempt(uniqueEmail('filler'))).status).toBe(401);
    expect((await attempt(uniqueEmail('overflow'))).status).toBe(429);
    const unknownWithEntry = await attempt(probe);
    const known = await attempt(staff.email);
    expect([unknownWithEntry.status, known.status]).toEqual([429, 429]);
    expect(unknownWithEntry.body).toEqual(known.body);
    expect(unknownWithEntry.headers['retry-after']).toBe(known.headers['retry-after']);
    Reflect.set(svc, 'unknown', new UnknownAccountDelay());
  });

  it('sign-in rate limits count an IPv6 client per /64, so one client cannot spread its attempts over its own addresses', () => {
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe(rateLimitKey('2001:db8:1:2:ffff:ffff:ffff:fffe'));
    expect(rateLimitKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:0db8:0001:0002:0:0:0:1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('2001:db8:1:3::1')).not.toBe(rateLimitKey('2001:db8:1:2::1'));
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey(undefined)).toBe('unknown');
  });
});

describe('per-address email caps are counted in the database (S-07)', () => {
  it('a restart of the service (a fresh in-memory state) does not reset the magic-link cap', async () => {
    const email = uniqueEmail('flooded');
    const svc = t.app.get(CustomerAuthService);
    for (let i = 0; i < MAGIC_LINKS_PER_ADDRESS + 3; i++) await svc.requestLink(email);
    const count = () => t.prisma.outboundEmail.count({ where: { to: email, templateKey: 'auth.magic_link' } });
    expect(await count()).toBe(MAGIC_LINKS_PER_ADDRESS);
    // A second instance (or the same one after a restart) reads the same count.
    const other = new CustomerAuthService(t.prisma, Reflect.get(svc, 'config'), Reflect.get(svc, 'mail'), Reflect.get(svc, 'templates'), Reflect.get(svc, 'sessions'), Reflect.get(svc, 'audit'), Reflect.get(svc, 'outbox'));
    await other.requestLink(email);
    expect(await count()).toBe(MAGIC_LINKS_PER_ADDRESS);
    // The answer never changes.
    expect((await t.http().post('/auth/customer/magic-link').set(STATE_HEADERS).send({ email })).status).toBe(202);
  });

  it('parallel requests for one address cannot pass the cap together', async () => {
    const email = uniqueEmail('parallel');
    const svc = t.app.get(CustomerAuthService);
    await Promise.all(Array.from({ length: 8 }, () => svc.requestLink(email)));
    expect(await t.prisma.outboundEmail.count({ where: { to: email, templateKey: 'auth.magic_link' } })).toBe(MAGIC_LINKS_PER_ADDRESS);
  });

  it('a flood of other addresses does not reset the cap of one address', async () => {
    const email = uniqueEmail('victim');
    const svc = t.app.get(CustomerAuthService);
    for (let i = 0; i < MAGIC_LINKS_PER_ADDRESS; i++) await svc.requestLink(email);
    for (let i = 0; i < 20; i++) await svc.requestLink(uniqueEmail(`noise${i}`));
    await svc.requestLink(email);
    expect(await t.prisma.outboundEmail.count({ where: { to: email, templateKey: 'auth.magic_link' } })).toBe(MAGIC_LINKS_PER_ADDRESS);
  });
});
