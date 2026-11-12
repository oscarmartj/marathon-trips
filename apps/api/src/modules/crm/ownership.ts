import { QUOTE_REFERENCE_PATTERN } from '@mt/shared';
import { Lru } from '../../platform/auth/attempt-limiter';
import type { PrismaService } from '../../platform/database/prisma.service';

let prisma: PrismaService | null = null;

/** Set once by CrmModule; the @OwnedBy check runs outside Nest's injection. */
export function setQuoteOwnershipDb(db: PrismaService): void {
  prisma = db;
}

export const QUOTE_OWNERSHIP_MISSES_PER_HOUR = 30;
const HOUR = 3_600_000;
const misses = new Lru<number[]>(10_000, HOUR);

const missesOf = (userId: string, now: number): number[] => (misses.get(userId, now) ?? []).filter((t) => t > now - HOUR);

/**
 * True only when the quote with this reference has been sent to the customer of this user (a draft is not theirs yet).
 * Any other case, an unknown reference included, is the same false (404). Guessing is capped like booking references.
 */
export async function ownsQuoteReference(ctx: { userId: string; params: Record<string, string> }, now = Date.now()): Promise<boolean> {
  const recent = missesOf(ctx.userId, now);
  if (recent.length >= QUOTE_OWNERSHIP_MISSES_PER_HOUR) return false;
  const reference = ctx.params.reference ?? '';
  const rows = prisma && QUOTE_REFERENCE_PATTERN.test(reference)
    ? await prisma.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM quotes q JOIN customers c ON c.id = q."customerId"
        WHERE q.reference = ${reference} AND q.status <> 'draft' AND c."userId" = ${ctx.userId}::uuid`
    : [];
  if (rows.length === 1) return true;
  misses.set(userId(ctx), [...recent, now], now);
  return false;
}
const userId = (ctx: { userId: string }) => ctx.userId;
