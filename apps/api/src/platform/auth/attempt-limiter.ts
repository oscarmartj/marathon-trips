import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { tooManyRequests } from '../http/api-error';

type Db = Prisma.TransactionClient | PrismaService;

/** Progressive delay (M2): after the n-th failure, n >= 3, wait min(2^(n-3), 900) seconds. Never a permanent lock-out. */
/** Counts of failures start again after this long without an attempt, for known and unknown addresses alike. */
export const COUNT_WINDOW_SECONDS = 3600;

export function delaySeconds(failures: number): number {
  return failures >= 3 ? Math.min(2 ** (Math.min(failures, 20) - 3), 900) : 0;
}

/** Small LRU with expiry for in-memory counters (M8): bounded size, so an attacker cannot grow it without limit. */
export class Lru<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string, now = Date.now()): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, now = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  /**
   * Task 8.5 (S-06): stores without evicting a live entry. When the table is full of live entries, expired ones are swept
   * (at most once a second, so a full table costs no more than that) and, if there is still no room, nothing is stored
   * and false is returned, so the caller can refuse instead of forgetting someone's count.
   */
  trySet(key: string, value: V, now = Date.now()): boolean {
    if (this.map.has(key) || this.map.size < this.max) {
      this.set(key, value, now);
      return true;
    }
    if (now - this.lastSweep >= 1000) {
      this.lastSweep = now;
      for (const [k, e] of this.map) if (e.expiresAt <= now) this.map.delete(k);
    }
    if (this.map.size >= this.max) return false;
    this.set(key, value, now);
    return true;
  }

  private lastSweep = 0;

  /** Whether `trySet` of this key would succeed now, without storing anything (round 4: no empty entries left behind). */
  canStore(key: string, now = Date.now()): boolean {
    if (this.get(key, now) !== undefined || this.map.size < this.max) return true;
    if (now - this.lastSweep >= 1000) {
      this.lastSweep = now;
      for (const [k, e] of this.map) if (e.expiresAt <= now) this.map.delete(k);
    }
    return this.map.size < this.max;
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Every password, sign-in code and step-up code is counted as a failure *before* it is checked, atomically, and only
 * when the account's delay has passed (G2, M2). Parallel guesses therefore queue behind the delay instead of all being
 * checked at once. A correct password or step-up code gives its own count back; a new session resets the count to 0.
 */
export async function claimAccountAttempt(db: Db, userId: string, now: Date = new Date()): Promise<void> {
  // An hour without attempts starts the count again, exactly like the in-memory counter for unknown addresses (T2).
  const claimed = await db.$queryRaw<Array<{ id: string }>>`
    WITH c AS (
      SELECT id, CASE WHEN "lastFailedLoginAt" IS NULL OR "lastFailedLoginAt" <= ${now}::timestamptz - ${COUNT_WINDOW_SECONDS} * interval '1 second'
        THEN 1 ELSE "failedLoginCount" + 1 END AS n
      FROM users WHERE id = ${userId}::uuid AND ("nextLoginAllowedAt" IS NULL OR "nextLoginAllowedAt" <= ${now}::timestamptz)
      FOR UPDATE
    )
    UPDATE users u SET "failedLoginCount" = c.n, "lastFailedLoginAt" = ${now}::timestamptz,
      "nextLoginAllowedAt" = CASE WHEN c.n >= 3
        THEN ${now}::timestamptz + make_interval(secs => LEAST(power(2, LEAST(c.n, 20) - 3), 900))
        ELSE NULL END
    FROM c WHERE u.id = c.id
    RETURNING u.id`;
  if (claimed.length > 0) return;
  const row = await db.user.findUnique({ where: { id: userId }, select: { nextLoginAllowedAt: true } });
  throw tooManyRequests(row?.nextLoginAllowedAt ? (row.nextLoginAllowedAt.getTime() - now.getTime()) / 1000 : 1);
}

/**
 * Gives back the count claimed for an attempt that succeeded but does not create a session (password step, step-up),
 * and lifts the delay that claim set: the claim only succeeded because the previous delay had passed. Earlier failures
 * stay counted, so the next wrong code is delayed as before.
 */
export async function refundAccountAttempt(db: Db, userId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE users SET "failedLoginCount" = GREATEST("failedLoginCount" - 1, 0), "nextLoginAllowedAt" = NULL
    WHERE id = ${userId}::uuid`;
}

/** Retry-After for an address refused because the table is full or its client added too many new addresses (S-06). */
export const SATURATION_SECONDS = 60;
/** Sign-in attempts one client (an IPv4 address or an IPv6 /64) may make per hour, new addresses and renewals (S-06). */
export const NEW_ADDRESSES_PER_HOUR_PER_CLIENT = 30;
/** Sign-in attempts one IPv6 /48 (a site's allocation, 65,536 /64s) may make per hour, all its /64s together (round 3). */
export const NEW_ADDRESSES_PER_HOUR_PER_SITE = 300;

/** The /48 an IPv6 client key (`a:b:c:d::/64`, from rateLimitKey) belongs to; null for IPv4. */
export function siteOf(client: string): string | null {
  const m = /^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):[0-9a-f]+::\/64$/.exec(client);
  return m ? `${m[1]}:${m[2]}:${m[3]}::/48` : null;
}

/**
 * Times of recent events per key, in a bounded table that fails closed: when it is full of live counters, a new key
 * cannot be counted and the caller refuses instead (round 3: an evicted counter would stop counting).
 */
class ClosedWindowCounter {
  private readonly entries: Lru<number[]>;

  constructor(
    private readonly windowMs: number,
    max: number,
  ) {
    this.entries = new Lru<number[]>(max, windowMs);
  }

  count(key: string, now: number): number {
    return (this.entries.get(key, now) ?? []).filter((t) => t > now - this.windowMs).length;
  }

  hasRoom(key: string, now: number): boolean {
    return this.entries.canStore(key, now);
  }

  record(key: string, now: number): void {
    const recent = (this.entries.get(key, now) ?? []).filter((t) => t > now - this.windowMs);
    this.entries.set(key, [...recent, now], now);
  }
}

type Slot = { failures: number; nextAllowedAt: number; lastFailedAt: number };

/**
 * The same schedule for addresses with no account, kept in memory so the two cases look alike (T2), in a bounded table
 * that never evicts a live count (task 8.5, S-06).
 *
 * Every address takes a place in the table *before* anything is looked up, known accounts too (their place holds no
 * count: the database counts them), and every attempt renews the place, for both kinds alike (round 3), so a place is
 * kept exactly as long as the address keeps being tried. When the table is full, every address without a place is
 * refused the same way, staff or not, for as long as it stays full; a burst of parallel attempts is decided address by
 * address in memory, before the first await. New addresses are capped per client (IPv4 address or IPv6 /64) and per
 * IPv6 /48, and the quota is spent only when a place is granted; the counters themselves fail closed.
 */
export class UnknownAccountDelay {
  private readonly entries: Lru<Slot>;
  private readonly perClient: ClosedWindowCounter;
  private readonly perSite: ClosedWindowCounter;

  constructor(
    max = 100_000,
    private readonly perClientPerHour = NEW_ADDRESSES_PER_HOUR_PER_CLIENT,
    private readonly perSitePerHour = NEW_ADDRESSES_PER_HOUR_PER_SITE,
  ) {
    this.entries = new Lru(max, COUNT_WINDOW_SECONDS * 1000);
    this.perClient = new ClosedWindowCounter(COUNT_WINDOW_SECONDS * 1000, max);
    this.perSite = new ClosedWindowCounter(COUNT_WINDOW_SECONDS * 1000, max);
  }

  /**
   * Gives this address a place in the table (or renews it), or refuses it (429) when the table is full or its client or
   * site has brought too many new addresses this hour. Synchronous on purpose: called before any database lookup, for
   * every address.
   */
  reserve(key: string, client: string, now: number = Date.now()): void {
    const site = siteOf(client);
    const refuse = (): never => {
      throw tooManyRequests(SATURATION_SECONDS);
    };
    // Every attempt that gets or keeps a place is charged, a renewal as much as a new address, known and unknown alike
    // (round 4): otherwise a table filled once could be kept full with one cheap retry per address and hour.
    if (this.perClient.count(client, now) >= this.perClientPerHour) refuse();
    if (site && this.perSite.count(site, now) >= this.perSitePerHour) refuse();
    if (!this.perClient.hasRoom(client, now) || (site && !this.perSite.hasRoom(site, now))) refuse();
    const held = this.entries.get(key, now);
    if (held !== undefined) this.entries.set(key, held, now); // renewed on every attempt (round 3)
    else if (!this.entries.trySet(key, { failures: 0, nextAllowedAt: 0, lastFailedAt: 0 }, now)) refuse();
    // Charged only now that the place is granted or kept (round 3); the counters are created only here (round 4).
    this.perClient.record(client, now);
    if (site) this.perSite.record(site, now);
  }

  /**
   * Counts a failure for an address with no account (its place is normally reserved just before). Like the database
   * count of known accounts, it starts again after an hour without a failure. If the place has gone and the table has
   * no room, the failure is refused (429), never stored by evicting someone else's count.
   */
  claim(key: string, now: number = Date.now()): void {
    const held = this.entries.get(key, now);
    const e = held && now - held.lastFailedAt < COUNT_WINDOW_SECONDS * 1000 ? held : { failures: 0, nextAllowedAt: 0, lastFailedAt: 0 };
    if (e.nextAllowedAt > now) throw tooManyRequests((e.nextAllowedAt - now) / 1000);
    const failures = e.failures + 1;
    if (!this.entries.trySet(key, { failures, nextAllowedAt: now + delaySeconds(failures) * 1000, lastFailedAt: now }, now)) throw tooManyRequests(SATURATION_SECONDS);
  }
}

/** At most `max` events per key in a sliding window; used to cap magic-link emails per address silently. */
export class WindowLimiter {
  private readonly entries: Lru<number[]>;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    this.entries = new Lru<number[]>(10_000, windowMs);
  }

  /** Whether `allow` would pass now, without counting anything (task 5.5: count only what succeeded). */
  wouldAllow(key: string, now: number = Date.now()): boolean {
    return (this.entries.get(key, now) ?? []).filter((t) => t > now - this.windowMs).length < this.max;
  }

  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.entries.get(key, now) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.entries.set(key, recent, now);
      return false;
    }
    this.entries.set(key, [...recent, now], now);
    return true;
  }
}
