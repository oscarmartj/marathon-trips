import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { ApiError, conflict } from '../../platform/http/api-error';
import { isUniqueViolation, promoUsableAt } from './adjustments';

type Tx = Prisma.TransactionClient;

/**
 * How the transaction that redeems a code runs (plan 2.2, section 15, point 3): READ COMMITTED inside runTransaction.
 * Every redemption of one code waits for the code's row (FOR UPDATE) and then reads what is committed, so the limits
 * hold without retries. REPEATABLE READ is also correct (the loser gets 40001 and runTransaction runs it again).
 */
export const REDEEM_TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;

/** Codes a redemption can fail with; the panel sees them, the public sees one answer (publicRedemptionError). */
export const REDEMPTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  'promo_code_unavailable', 'promo_code_customer_limit', 'promo_code_changed', 'booking_has_promo_code', 'busy_try_again',
]);

/**
 * The single public answer for any failed redemption (plan 2.2, section 15, point 2), like publicPromoStatus for
 * quotes: an anonymous caller cannot tell an exhausted code from a per-customer limit or a changed code. Anything else
 * is returned as it is.
 */
export function publicRedemptionError(err: unknown): unknown {
  if (err instanceof ApiError && REDEMPTION_FAILURE_CODES.has(err.code)) {
    return conflict('promo_code_unavailable', 'That code can no longer be used. Remove it to continue.');
  }
  return err;
}

export interface RedeemInput {
  promoCodeId: string;
  /** The code's version the quote saw (QuoteService.priceWithPromoRef): a change since then is a 409. */
  promoCodeVersion: number;
  bookingId: string;
  customerId: string;
  now: Date;
}

interface LockedCode {
  id: string;
  version: number;
  enabled: boolean;
  archivedAt: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  maxRedemptions: number | null;
  maxPerCustomer: number | null;
  redeemedCount: number;
}

const unavailable = () => conflict('promo_code_unavailable', 'This code can no longer be used');

/**
 * Redeeming and releasing promo codes (plan 2.2, section 8). Task 2.4 calls these inside its own transaction, after
 * pricing and only when the code was applied, in the lock order of plan 0.1, 6.3 (Customer → Quote → Booking →
 * PromoCode → pools). Any failure is thrown, so the whole request aborts: never a snapshot with a discount and no
 * redemption.
 */
@Injectable()
export class PromoRedemptionService {
  private async lockCode(tx: Tx, id: string): Promise<LockedCode | null> {
    const rows = await tx.$queryRaw<LockedCode[]>`
      SELECT id, version, enabled, "archivedAt", "validFrom", "validTo", "maxRedemptions", "maxPerCustomer", "redeemedCount"
      FROM promo_codes WHERE id = ${id}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  async redeemIn(tx: Tx, input: RedeemInput): Promise<{ redemptionId: string; created: boolean }> {
    const code = await this.lockCode(tx, input.promoCodeId);
    if (!code) throw unavailable();
    const existing = await tx.promoRedemption.findUnique({ where: { promoCodeId_bookingId: { promoCodeId: input.promoCodeId, bookingId: input.bookingId } } });
    if (existing) {
      // A retry of the same request: already counted, nothing more to do.
      if (existing.releasedAt === null) return { redemptionId: existing.id, created: false };
      throw unavailable();
    }
    if (code.version !== input.promoCodeVersion) throw conflict('promo_code_changed', 'This code changed since the price was shown');
    if (!promoUsableAt(code, input.now)) throw unavailable();
    if (code.maxPerCustomer !== null) {
      const active = await tx.promoRedemption.count({ where: { promoCodeId: input.promoCodeId, customerId: input.customerId, releasedAt: null } });
      if (active >= code.maxPerCustomer) throw conflict('promo_code_customer_limit', 'This code has been used as many times as allowed');
    }
    let redemptionId: string;
    try {
      redemptionId = (await tx.promoRedemption.create({
        data: { promoCodeId: input.promoCodeId, bookingId: input.bookingId, customerId: input.customerId, activeBookingId: input.bookingId, redeemedAt: input.now },
        select: { id: true },
      })).id;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('booking_has_promo_code', 'This booking already uses a promo code');
      throw err;
    }
    const counted = await tx.$executeRaw`
      UPDATE promo_codes SET "redeemedCount" = "redeemedCount" + 1
      WHERE id = ${input.promoCodeId}::uuid AND ("maxRedemptions" IS NULL OR "redeemedCount" < "maxRedemptions")`;
    if (counted !== 1) throw unavailable();
    return { redemptionId, created: true };
  }

  /**
   * Gives a redemption back when a request is declined, expires or is cancelled before travel. The code's row is locked
   * first (plan 0.1, 6.3); the count goes down only if this call released the redemption, so two releases count once.
   */
  async releaseIn(tx: Tx, input: { promoCodeId: string; bookingId: string; now: Date }): Promise<boolean> {
    await this.lockCode(tx, input.promoCodeId);
    const released = await tx.$executeRaw`
      UPDATE promo_redemptions SET "releasedAt" = ${input.now}, "activeBookingId" = NULL
      WHERE "promoCodeId" = ${input.promoCodeId}::uuid AND "bookingId" = ${input.bookingId}::uuid AND "releasedAt" IS NULL`;
    if (released !== 1) return false;
    await tx.$executeRaw`UPDATE promo_codes SET "redeemedCount" = "redeemedCount" - 1 WHERE id = ${input.promoCodeId}::uuid`;
    return true;
  }
}
