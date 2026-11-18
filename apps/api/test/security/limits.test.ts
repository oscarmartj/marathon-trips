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

  it('a full table refuses every address without a place for as long as it stays full, and never wipes a guessed one', () => {
    const d = new UnknownAccountDelay(2);
    d.reserve('target', 'c1', 0);
    for (let i = 0; i < 3; i++) {
      try {
        d.claim('target', 0);
      } catch {
        // the third failure sets a delay
      }
    }
    d.reserve('other', 'c2', 0);
    expect(() => d.reserve('flood-1', 'c3', 0)).toThrow();
    // Review round 2: not only for a minute: an hour later minus a second the table is still full, and still refuses.
    expect(() => d.reserve('flood-2', 'c3', 3_599_000)).toThrow();
    // The guessed address keeps its delay: a flood cannot evict it.
    expect(() => d.claim('target', 500)).toThrow();
    // Once its entries expire, there is room again.
    expect(() => d.reserve('later', 'c4', 3_600_001)).not.toThrow();
    // Without a place and without room, a failure is refused, never stored over someone else's count.
    const one = new UnknownAccountDelay(1);
    one.reserve('held', 'c', 0);
    expect(() => one.claim('never-reserved', 0)).toThrow();
    expect(() => one.claim('held', 0)).not.toThrow();
  });

  it('one client can bring only so many new addresses an hour, which keeps one client from filling the table', () => {
    const d = new UnknownAccountDelay(1000, 3);
    for (let i = 0; i < 3; i++) d.reserve(`a${i}`, 'client', 0);
    expect(() => d.reserve('a3', 'client', 0)).toThrow();
    expect(() => d.reserve('a0', 'client', 0)).not.toThrow(); // an address it already tried keeps its place
    expect(() => d.reserve('b0', 'other-client', 0)).not.toThrow();
  });

  const attempt = (email: string) => t.http().post('/auth/staff/sign-in').set(STATE_HEADERS).send({ email, password: 'definitely-wrong-password' });

  it('with the table full, long after it filled, a known and an unknown address answer the same (review round 2)', async () => {
    const svc = t.app.get(StaffAuthService);
    const staffTried = await createStaff(t);
    const staffNew = await createStaff(t);
    const unknownTried = uniqueEmail('tried');
    Reflect.set(svc, 'unknown', new UnknownAccountDelay(2, 100_000));
    // Before the flood the attacker tries one staff address and one address with no account.
    expect((await attempt(staffTried.email)).status).toBe(401);
    expect((await attempt(unknownTried)).status).toBe(401);
    // The table is now full. Addresses tried before keep answering as before, the same for both kinds.
    const [a, b] = [await attempt(staffTried.email), await attempt(unknownTried)];
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body).toEqual(b.body);
    // New addresses are refused the same, staff or not, and the minute passing changes nothing (the table is still full).
    const later = Date.now() + 2 * 60_000;
    const realNow = Date.now;
    Date.now = () => later;
    try {
      const [k, u] = [await attempt(staffNew.email), await attempt(uniqueEmail('new'))];
      expect([k.status, u.status]).toEqual([429, 429]);
      expect(k.body).toEqual(u.body);
      expect(k.headers['retry-after']).toBe(u.headers['retry-after']);
    } finally {
      Date.now = realNow;
      Reflect.set(svc, 'unknown', new UnknownAccountDelay(100_000, 100_000));
    }
  });

  it('a parallel burst on a nearly full table is decided before any lookup: known and unknown get the same answers', async () => {
    const svc = t.app.get(StaffAuthService);
    const staff = await Promise.all([createStaff(t), createStaff(t), createStaff(t)]);
    for (let round = 0; round < 3; round++) {
      Reflect.set(svc, 'unknown', new UnknownAccountDelay(3, 100_000));
      // Known and unknown interleaved; only the first three to arrive get a place, whichever they are.
      const emails = round % 2 ? [uniqueEmail('u'), staff[0]!.email, uniqueEmail('u'), staff[1]!.email, uniqueEmail('u'), staff[2]!.email] : [staff[0]!.email, uniqueEmail('u'), staff[1]!.email, uniqueEmail('u'), staff[2]!.email, uniqueEmail('u')];
      const results = await Promise.all(emails.map((e) => attempt(e)));
      // Supertest opens the connections in order; in memory the places go to the first three requests that reach the
      // service. Whatever the order, exactly three get the normal answer and three the 429, and every answer of one
      // kind is identical for staff and non-staff addresses.
      expect(results.filter((r) => r.status === 401)).toHaveLength(3);
      expect(results.filter((r) => r.status === 429)).toHaveLength(3);
      const bodies = (status: number) => new Set(results.filter((r) => r.status === status).map((r) => JSON.stringify(r.body)));
      expect(bodies(401).size).toBe(1);
      expect(bodies(429).size).toBe(1);
    }
    Reflect.set(svc, 'unknown', new UnknownAccountDelay(100_000, 100_000));
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
