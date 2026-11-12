import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { canonicalJson, sha256Hex } from '../../platform/crypto/hmac';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict } from '../../platform/http/api-error';
import { InventoryService } from '../catalogue';
import { BOOKING_EVENTS } from './manifest';
import { BookingRequestService, startOfDayInBrisbane } from './request.service';
import type { BookingLimits } from './settings';
import { BookingStateMachine } from './state-machine';
import { snapshotBreakdownSchema, snapshotConfigurationSchema } from './snapshot-schema';
import { Tx, dbNow, toDate } from './support';

/** What a quote hands over when its customer accepts it (task 2.5; the quote module owns the quote, this module the booking). */
export interface AcceptedQuote {
  quoteId: string;
  customerId: string;
  packageId: string;
  editionId: string;
  currency: string;
  totalMinor: bigint;
  depositMinor: bigint;
  priceVersionId: string;
  engineVersion: string;
  departureDate: string;
  returnDate: string;
  balanceDueDate: string;
  configuration: Prisma.JsonValue;
  priceBreakdown: Prisma.JsonValue;
}

export interface LockedQuoteCustomer {
  id: string;
  email: string;
  userId: string | null;
  residenceCountry: string;
}

/**
 * The booking side of accepting a quote (plan 2.5, section 5): the customer lock, and one transaction step that writes
 * the booking from the quote's stored price (not priced again: a quote holds its price until it expires), holds the
 * stock and approves it through the state machine. The caller has already locked the customer and the quote, in that order.
 */
@Injectable()
export class QuotedBookingService {
  constructor(
    @Inject(BookingRequestService) private readonly requests: BookingRequestService,
    @Inject(BookingStateMachine) private readonly machine: BookingStateMachine,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /** The first lock of a quote acceptance: the customer, FOR UPDATE; null when it is closed or does not exist. */
  async lockCustomer(tx: Tx, customerId: string): Promise<LockedQuoteCustomer | null> {
    const rows = await tx.$queryRaw<LockedQuoteCustomer[]>`
      SELECT id, email::text AS email, "userId", "countryOfResidence" AS "residenceCountry"
      FROM customers WHERE id = ${customerId}::uuid AND "deletedAt" IS NULL AND "anonymisedAt" IS NULL FOR UPDATE`;
    return rows[0] ?? null;
  }

  async createApprovedFromQuote(tx: Tx, q: AcceptedQuote, customer: LockedQuoteCustomer, actor: AuditActor, limits: BookingLimits): Promise<{ bookingId: string; reference: string }> {
    const at = await dbNow(tx);
    const configuration = snapshotConfigurationSchema.parse(q.configuration);
    const priceBreakdown = snapshotBreakdownSchema.parse(q.priceBreakdown);
    const requestExpiresAt = new Date(Math.min(at.getTime() + limits.requestExpiryHours * 3_600_000, startOfDayInBrisbane(q.departureDate).getTime()));
    const bookingId = await this.requests.insertBooking(tx, {
      customerId: q.customerId, kind: 'catalogue', packageId: q.packageId, editionId: q.editionId, status: 'requested', currentSnapshotVersion: 1,
      departureDate: toDate(q.departureDate), returnDate: toDate(q.returnDate), currency: q.currency,
      totalMinor: q.totalMinor, depositMinor: q.depositMinor, balanceDueDate: toDate(q.balanceDueDate),
      residenceCountry: customer.residenceCountry, requestedAt: at, requestExpiresAt, sourceChannel: 'web',
      requestKeyHash: sha256Hex(`quote-acceptance:${q.quoteId}`), requestConfigHash: sha256Hex(canonicalJson(configuration)), requestContactHmac: null,
    });
    await tx.bookingSnapshot.create({
      data: {
        bookingId, version: 1, kind: 'original', configuration, priceBreakdown: priceBreakdown as unknown as Prisma.InputJsonObject,
        totalMinor: q.totalMinor, depositMinor: q.depositMinor, currency: q.currency, priceVersionId: q.priceVersionId, engineVersion: q.engineVersion,
      },
    });
    await this.requests.insertParts(tx, bookingId, q.customerId, { configuration });

    // The stock, pool by pool in id order; no place left is a 409 and nothing stays written.
    const demand = await this.inventory.demandFor(tx, configuration);
    for (const d of demand) {
      await tx.inventoryClaim.create({ data: { bookingId, poolId: d.poolId, quantity: d.quantity } });
      await this.inventory.hold(tx, d.poolId, d.quantity, { actor, bookingId });
    }
    const reference = (await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { reference: true } })).reference;
    await this.audit.record(tx, {
      actor, action: 'bookings.booking.requested', entityType: 'Booking', entityId: bookingId, model: 'Booking',
      after: { status: 'requested', customerId: q.customerId, packageId: q.packageId, totalMinor: q.totalMinor.toString(), depositMinor: q.depositMinor.toString(), currency: q.currency, residenceCountry: customer.residenceCountry, requestExpiresAt: requestExpiresAt.toISOString() },
      context: { quoteId: q.quoteId, places: demand.reduce((n, d) => n + d.quantity, 0) },
    });
    await this.outbox.publish(tx, {
      type: BOOKING_EVENTS.requested, aggregateType: 'Booking', aggregateId: bookingId, aggregateVersion: 0,
      payload: { bookingId, packageId: q.packageId, editionId: q.editionId, customerId: q.customerId }, actorType: actor.type, actorId: actor.id ?? undefined,
    });
    // Staff sent the quote, so accepting it is the approval: the state machine does it, like any other approval.
    const r = await this.machine.transition(tx, bookingId, 'approve', { actor, reason: 'Quote accepted', approvalHours: limits.approvalExpiryHours });
    if (!r.changed) throw conflict('booking_state_changed', 'This booking changed. Reload and try again.');
    return { bookingId, reference };
  }
}
