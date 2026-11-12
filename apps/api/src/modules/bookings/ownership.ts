import { BOOKING_REFERENCE_PATTERN } from '@mt/shared';
import { Lru } from '../../platform/auth/attempt-limiter';
import type { PrismaService } from '../../platform/database/prisma.service';

let prisma: PrismaService | null = null;

/** Set once by BookingsModule; the @OwnedBy check runs outside Nest's injection. */
export function setOwnershipDb(db: PrismaService): void {
  prisma = db;
}

/** References that were not the user's (unknown or someone else's) per user and hour; past it, nothing is found. */
export const OWNERSHIP_MISSES_PER_HOUR = 30;
const HOUR = 3_600_000;
const misses = new Lru<number[]>(10_000, HOUR);

function missesOf(userId: string, now: number): number[] {
  return (misses.get(userId, now) ?? []).filter((t) => t > now - HOUR);
}

/**
 * True only when the booking with this reference belongs to the customer of this user (plan 2.4, section 7). Any
 * other case, an unknown reference included, is the same false, so the guard answers the same 404 to both. Guards run
 * after the access check, so guessing is capped here: after too many misses in an hour, every reference reads as not
 * found for that user.
 */
export async function ownsBookingReference(ctx: { userId: string; params: Record<string, string> }, now = Date.now()): Promise<boolean> {
  const recent = missesOf(ctx.userId, now);
  if (recent.length >= OWNERSHIP_MISSES_PER_HOUR) return false;
  const reference = ctx.params.reference ?? '';
  const rows = prisma && BOOKING_REFERENCE_PATTERN.test(reference)
    ? await prisma.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM bookings b JOIN customers c ON c.id = b."customerId"
        WHERE b.reference = ${reference} AND c."userId" = ${ctx.userId}::uuid`
    : [];
  if (rows.length === 1) return true;
  misses.set(ctx.userId, [...recent, now], now);
  return false;
}
