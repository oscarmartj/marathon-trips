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

  it('one client can make only so many attempts an hour, renewals included, which keeps one client from filling or keeping the table', () => {
    const d = new UnknownAccountDelay(1000, 3);
    for (let i = 0; i < 3; i++) d.reserve(`a${i}`, 'client', 0);
    expect(() => d.reserve('a3', 'client', 0)).toThrow();
    // Round 4: renewing a place costs quota too, so a table filled once cannot be kept full for free.
    expect(() => d.reserve('a0', 'client', 0)).toThrow();
    expect(() => d.reserve('b0', 'other-client', 0)).not.toThrow();
    // An hour later the client has its quota again and its places renew.
    expect(() => d.reserve('a0', 'client', 3_600_001)).not.toThrow();
  });

  it('keeping a full table costs as much every hour as filling it: one retry per address an hour is not enough (round 4)', () => {
    const d = new UnknownAccountDelay(30, 10);
    // Three clients fill the table with ten addresses each.
    for (let c = 0; c < 3; c++) for (let i = 0; i < 10; i++) d.reserve(`c${c}-${i}`, `client-${c}`, 0);
    expect(() => d.reserve('legit', 'staff-office', 1)).toThrow();
    // Fifty minutes later the same clients try to renew their places: their quota for the hour is already spent, so
    // they cannot, and keeping the table full would take as many fresh clients as filling it did.
    for (let c = 0; c < 3; c++) expect(() => d.reserve(`c${c}-0`, `client-${c}`, 50 * 60_000)).toThrow();
    // Past the hour the attackers' places are gone unless renewed, each renewal charged like a new address.
    expect(() => d.reserve('legit', 'staff-office', 3_600_001)).not.toThrow();
  });

  it('kept full for more than an hour while a known and an unknown address keep being tried: both keep their places alike (round 3)', () => {
    const d = new UnknownAccountDelay(4, 1000, 1000);
    const S = 'known-staff';
    const U = 'unknown';
    const tryKnown = (now: number) => d.reserve(S, 'attacker', now); // the database counts a known account
    const tryUnknown = (now: number) => {
      d.reserve(U, 'attacker', now);
      d.claim(U, now);
    };
    tryKnown(0);
    tryUnknown(0);
    d.reserve('flood-1', 'f1', 0);
    d.reserve('flood-2', 'f2', 0);
    const outcome = (fn: () => void) => {
      try {
        fn();
        return 'ok';
      } catch {
        return '429';
      }
    };
    // Every 50 minutes for five hours the flood refills whatever room appears, and S and U are tried again.
    for (let n = 1; n <= 6; n++) {
      const now = n * 50 * 60_000;
      for (let i = 0; i < 4; i++) outcome(() => d.reserve(`flood-${n}-${i}`, `f${n}${i}`, now));
      expect([outcome(() => tryKnown(now)), outcome(() => tryUnknown(now))], `round ${n}`).toEqual(['ok', 'ok']);
    }
    // Tried at once again, U is delayed by its count (six failures)...
    expect(outcome(() => tryUnknown(6 * 50 * 60_000 + 1))).toBe('429');
    // ...which starts again after an hour without a failure, like the database's: two free tries in a row.
    const later = 6 * 50 * 60_000 + 61 * 60_000;
    expect([outcome(() => tryUnknown(later)), outcome(() => tryUnknown(later + 1))]).toEqual(['ok', 'ok']);
  });

  it('an IPv6 /48 brings only so many new addresses an hour, whatever /64s it uses (round 3)', () => {
    const d = new UnknownAccountDelay(100_000, 30, 5);
    for (let i = 0; i < 5; i++) d.reserve(`a${i}`, `2001:db8:1:${i.toString(16)}::/64`, 0);
    expect(() => d.reserve('a5', '2001:db8:1:ff::/64', 0)).toThrow();
    expect(() => d.reserve('b0', '2001:db8:2:0::/64', 0)).not.toThrow();
    expect(() => d.reserve('c0', '203.0.113.7', 0)).not.toThrow();
  });

  it('a client spends quota only for places it is granted; refused retries while the table is full cost nothing (round 3)', () => {
    const d = new UnknownAccountDelay(2, 3, 1000);
    d.reserve('x1', 'other', 0);
    d.reserve('x2', 'other', 0);
    for (let i = 0; i < 10; i++) expect(() => d.reserve(`office-${i}`, 'office', 1000)).toThrow();
    // Room again an hour later: the office still has its whole quota.
    for (let i = 0; i < 2; i++) expect(() => d.reserve(`office-later-${i}`, 'office', 3_600_001)).not.toThrow();
  });

  it('per-client counters fail closed: 10,000 other clients cannot evict the counter of one that is over its quota (round 4)', () => {
    const d = new UnknownAccountDelay(20_000, 1);
    d.reserve('first', 'busy', 0);
    expect(() => d.reserve('second', 'busy', 0)).toThrow();
    // The old WindowLimiter kept 10,000 keys and evicted the oldest: "busy" would have been forgotten here.
    for (let i = 0; i < 10_000; i++) d.reserve(`addr-${i}`, `client-${i}`, 1);
    expect(() => d.reserve('second', 'busy', 2)).toThrow();
  });

  it('refused attempts leave no counter behind: a full table cannot be used to fill the counters and refuse new clients (round 4)', () => {
    const d = new UnknownAccountDelay(2, 1000, 1000);
    d.reserve('x1', 'a', 0);
    d.reserve('x2', 'b', 0);
    // While the table is full, many different clients are refused...
    for (let i = 0; i < 50; i++) expect(() => d.reserve(`flood-${i}`, `2001:db8:9:${i.toString(16)}::/64`, 10)).toThrow();
    // ...and none of them took a counter, so once places free up a new client is served.
    expect(() => d.reserve('legit', 'office', 3_600_001)).not.toThrow();
    expect(Reflect.get(Reflect.get(d, 'perClient'), 'entries').size).toBeLessThanOrEqual(3);
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

describe('the new-address cap through HTTP: per client address, read from the environment (round 3)', () => {
  let h: TestApp;
  beforeAll(async () => {
    // TRUST_PROXY=loopback: the test connects from loopback, so X-Forwarded-For chooses the client address here.
    h = await makeApp({ AUTH_SIGN_IN_ATTEMPTS_PER_HOUR_PER_CLIENT: '2', TRUST_PROXY: 'loopback' });
  });
  afterAll(async () => h.close());
  const from = (ip: string, email: string) =>
    h.http().post('/auth/staff/sign-in').set(STATE_HEADERS).set('X-Forwarded-For', ip).send({ email, password: 'definitely-wrong-password' });

  it('the third new address from one client is refused, another client is not, and one IPv6 /64 is one client', async () => {
    expect((await from('203.0.113.10', uniqueEmail('a'))).status).toBe(401);
    expect((await from('203.0.113.10', uniqueEmail('b'))).status).toBe(401);
    expect((await from('203.0.113.10', uniqueEmail('c'))).status).toBe(429);
    expect((await from('203.0.113.11', uniqueEmail('d'))).status).toBe(401);
    expect((await from('2001:db8:5:6::1', uniqueEmail('e'))).status).toBe(401);
    expect((await from('2001:db8:5:6::ffff', uniqueEmail('f'))).status).toBe(401);
    expect((await from('2001:db8:5:6:1:2:3:4', uniqueEmail('g'))).status).toBe(429);
    expect((await from('2001:db8:5:7::1', uniqueEmail('h'))).status).toBe(401);
  });
});
