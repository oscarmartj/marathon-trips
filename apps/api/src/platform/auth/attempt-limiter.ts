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

/** The same schedule for addresses with no account, kept in memory so the two cases look alike (T2). */
export class UnknownAccountDelay {
  private readonly entries = new Lru<{ failures: number; nextAllowedAt: number }>(100_000, COUNT_WINDOW_SECONDS * 1000);

  claim(key: string, now: number = Date.now()): void {
    const e = this.entries.get(key, now) ?? { failures: 0, nextAllowedAt: 0 };
    if (e.nextAllowedAt > now) throw tooManyRequests((e.nextAllowedAt - now) / 1000);
    const failures = e.failures + 1;
    this.entries.set(key, { failures, nextAllowedAt: now + delaySeconds(failures) * 1000 }, now);
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
