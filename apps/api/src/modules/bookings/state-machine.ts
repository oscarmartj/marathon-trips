import { Inject, Injectable } from '@nestjs/common';
import type { BookingStatus } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { SettingsService } from '../../platform/flags/flags.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { InventoryService } from '../catalogue';
import { PromoRedemptionService } from '../pricing';
import { BookingTransitionHooks } from './hooks';
import { BOOKING_EVENTS } from './manifest';
import { BOOKING_SETTINGS } from './settings';
import { Tx, dbNow } from './support';

/**
 * Every pair of states plan 0.1, 6.2 allows, money transitions included. The same list is the trigger in migration
 * 0014; a test compares them.
 */
export const BOOKING_STATUS_PAIRS: ReadonlyArray<readonly [BookingStatus, BookingStatus]> = [
  ['requested', 'approved'], ['requested', 'declined'], ['requested', 'cancelled'], ['requested', 'expired'],
  ['approved', 'deposit_paid'], ['approved', 'cancelled'], ['approved', 'expired'],
  ['deposit_paid', 'confirmed'], ['deposit_paid', 'cancelled'], ['deposit_paid', 'completed'],
  ['confirmed', 'balance_paid'], ['confirmed', 'cancelled'], ['confirmed', 'completed'],
  ['balance_paid', 'confirmed'], ['balance_paid', 'completed'], ['balance_paid', 'cancelled'],
  ['cancelled', 'refunded'], ['refunded', 'cancelled'],
];

/** The events task 2.4 implements: the cells of plan 0.1, 6.2 that move no money (plan 2.4, section 5). */
export type BookingEvent = 'approve' | 'decline' | 'cancel' | 'expire_request';

/** Where each event takes each state; a missing state is a 409 (or "no change" for the expiry task). */
export const BOOKING_EVENT_TABLE: Readonly<Record<BookingEvent, Partial<Record<BookingStatus, BookingStatus>>>> = {
  approve: { requested: 'approved' },
  decline: { requested: 'declined' },
  cancel: { requested: 'cancelled', approved: 'cancelled' },
  expire_request: { requested: 'expired' },
};

/** Cells that move money: a 409 until payments exist (tasks 3.2 and 6.4), never a silent cancellation. */
export const MONEY_CELLS: Readonly<Partial<Record<BookingEvent, readonly BookingStatus[]>>> = {
  cancel: ['deposit_paid', 'confirmed', 'balance_paid'],
};

const RELEASING: ReadonlySet<BookingStatus> = new Set(['declined', 'cancelled', 'expired']);
const TIME_COLUMN: Partial<Record<BookingStatus, string>> = { approved: 'approvedAt', declined: 'declinedAt', cancelled: 'cancelledAt', expired: 'expiredAt' };

interface LockedBooking {
  id: string;
  status: BookingStatus;
  version: number;
  customerId: string;
  packageId: string;
  editionId: string;
  currency: string;
  requestExpiresAt: Date;
}

export interface TransitionInput {
  actor: AuditActor;
  /** The version the panel read; absent for the expiry task. */
  version?: number;
  reason?: string;
}

export type TransitionResult = { changed: true; from: BookingStatus; to: BookingStatus; at: Date } | { changed: false; status: BookingStatus };

/**
 * The only code that changes `bookings.status` (plan 2.4, section 5; checked by a test). One transition, in the
 * caller's transaction: lock the booking, check the table and the version, compare-and-set the status, run the hooks,
 * give back the code and the stock (Booking → PromoCode → pools by id, plan 0.1, 6.3), audit and publish. All or nothing.
 */
@Injectable()
export class BookingStateMachine {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(PromoRedemptionService) private readonly redemptions: PromoRedemptionService,
    @Inject(BookingTransitionHooks) private readonly hooks: BookingTransitionHooks,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async transition(tx: Tx, bookingId: string, event: BookingEvent, input: TransitionInput): Promise<TransitionResult> {
    const approvalHours = event === 'approve' ? await this.settings.get(BOOKING_SETTINGS.approvalExpiryHours.key, BOOKING_SETTINGS.approvalExpiryHours.fallback) : 0;
    const rows = await tx.$queryRaw<LockedBooking[]>`
      SELECT id, status::text AS status, version, "customerId", "packageId", "editionId", currency, "requestExpiresAt"
      FROM bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
    const b = rows[0];
    if (!b) throw notFound('booking_not_found', 'Booking not found');
    const at = await dbNow(tx);
    const to = BOOKING_EVENT_TABLE[event][b.status];

    if (event === 'expire_request') {
      // The task: anything else, or a request whose time has not come, is no change.
      if (!to || b.requestExpiresAt.getTime() > at.getTime()) return { changed: false, status: b.status };
    } else {
      if (!to) {
        if (MONEY_CELLS[event]?.includes(b.status)) throw conflict('cancellation_needs_payments', 'This booking has payments to settle first. Cancelling it is not available yet.');
        throw conflict('transition_not_allowed', 'This booking cannot change that way in its current state');
      }
      if (input.version !== undefined && input.version !== b.version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      if (event === 'approve' && b.requestExpiresAt.getTime() <= at.getTime()) throw conflict('request_expired', 'This request has expired');
    }

    const approvalExpiresAt = to === 'approved' ? new Date(at.getTime() + approvalHours * 3_600_000) : null;
    const hooked = { id: b.id, customerId: b.customerId, packageId: b.packageId, currency: b.currency, from: b.status };
    if (event === 'approve' || event === 'cancel') await this.hooks.run(event, tx, hooked, { actor: input.actor, at, approvalExpiresAt });

    const column = TIME_COLUMN[to];
    const reason = input.reason ?? null;
    // Compare-and-set: the row is locked, so 0 rows here means a bug, never a race; still a 409, never a silent write.
    const updated = await tx.$executeRawUnsafe(
      `UPDATE bookings SET status = $2::"BookingStatus", version = version + 1, "updatedAt" = $3,
         "${column}" = $3, "approvalExpiresAt" = COALESCE($4, "approvalExpiresAt"), "statusReason" = COALESCE($5, "statusReason")
       WHERE id = $1::uuid AND status = $6::"BookingStatus" AND version = $7`,
      b.id, to, at, approvalExpiresAt, RELEASING.has(to) ? reason : null, b.status, b.version,
    );
    if (updated !== 1) throw conflict('booking_state_changed', 'This booking changed. Reload and try again.');

    let released = { places: 0, promo: false };
    if (RELEASING.has(to)) released = await this.release(tx, b.id, input.actor, at);

    await this.audit.record(tx, {
      actor: input.actor, action: 'bookings.booking.status_changed', entityType: 'Booking', entityId: b.id, model: 'Booking',
      before: { status: b.status, customerId: b.customerId }, after: { status: to, customerId: b.customerId },
      reason, context: { event, from: b.status, to, releasedPlaces: released.places, promoReleased: released.promo },
    });
    const type = { approved: BOOKING_EVENTS.approved, declined: BOOKING_EVENTS.declined, cancelled: BOOKING_EVENTS.cancelled, expired: BOOKING_EVENTS.expired }[to as 'approved' | 'declined' | 'cancelled' | 'expired'];
    await this.outbox.publish(tx, {
      type, aggregateType: 'Booking', aggregateId: b.id, aggregateVersion: b.version + 1,
      payload: { bookingId: b.id, packageId: b.packageId, editionId: b.editionId, from: b.status, to }, actorType: input.actor.type, actorId: input.actor.id ?? undefined,
    });
    return { changed: true, from: b.status, to, at };
  }

  /**
   * Gives back the code and the stock, once even if two transitions race: the redemption and each claim are released
   * by a compare-and-set, and only what that statement released is returned to the pool.
   */
  private async release(tx: Tx, bookingId: string, actor: AuditActor, at: Date): Promise<{ places: number; promo: boolean }> {
    let promo = false;
    const redemption = await tx.promoRedemption.findFirst({ where: { bookingId, releasedAt: null }, select: { promoCodeId: true } });
    if (redemption) promo = await this.redemptions.releaseIn(tx, { promoCodeId: redemption.promoCodeId, bookingId, now: at });
    const claims = await tx.$queryRaw<Array<{ poolId: string; quantity: number }>>`
      UPDATE inventory_claims SET status = 'released', "releasedAt" = ${at}
      WHERE "bookingId" = ${bookingId}::uuid AND status = 'held'
      RETURNING "poolId"::text AS "poolId", quantity`;
    claims.sort((a, c) => (a.poolId < c.poolId ? -1 : a.poolId > c.poolId ? 1 : 0));
    for (const c of claims) await this.inventory.release(tx, c.poolId, c.quantity, { actor, bookingId });
    return { places: claims.reduce((n, c) => n + c.quantity, 0), promo };
  }
}
