import { Lru } from '../../platform/auth/attempt-limiter';
import type { PrismaService } from '../../platform/database/prisma.service';

let prisma: PrismaService | null = null;

/** Set once by WaitlistModule; the @OwnedBy check runs outside Nest's injection. */
export function setWaitlistOwnershipDb(db: PrismaService): void {
  prisma = db;
}

export const WAITLIST_OWNERSHIP_MISSES_PER_HOUR = 30;
const HOUR = 3_600_000;
const misses = new Lru<number[]>(10_000, HOUR);
const missesOf = (userId: string, now: number): number[] => (misses.get(userId, now) ?? []).filter((t) => t > now - HOUR);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only when the waiting list entry belongs to the customer of this user. Any other case, an unknown id included,
 * is the same false (404). Guessing is capped like booking references.
 */
export async function ownsWaitlistEntry(ctx: { userId: string; params: Record<string, string> }, now = Date.now()): Promise<boolean> {
  const recent = missesOf(ctx.userId, now);
  if (recent.length >= WAITLIST_OWNERSHIP_MISSES_PER_HOUR) return false;
  const id = ctx.params.id ?? '';
  const rows = prisma && UUID.test(id)
    ? await prisma.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM waitlist_entries w JOIN customers c ON c.id = w."customerId" WHERE w.id = ${id}::uuid AND c."userId" = ${ctx.userId}::uuid`
    : [];
  if (rows.length === 1) return true;
  misses.set(ctx.userId, [...recent, now], now);
  return false;
}
