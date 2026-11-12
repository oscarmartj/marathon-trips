import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { PackagePricingReader, lockPackage } from '../catalogue';
import { SettingsService } from '../../platform/flags/flags.service';
import { QuotedBookingService, dbNow, mapLoadError, readBookingLimits, todayInBrisbane } from '../bookings';
import type { BookingLimits } from '../bookings';
import { QUOTE_TX_OPTIONS } from './quote.service';
import { CRM_EVENTS } from './manifest';

interface LockedQuote {
  id: string;
  status: string;
  expiresAt: Date | null;
  customerId: string;
  packageId: string;
  editionId: string;
  currency: string;
  totalMinor: bigint;
  depositMinor: bigint;
  priceVersionId: string;
  engineVersion: string;
  departureDate: Date;
  returnDate: Date;
  balanceDueDate: Date;
  configuration: unknown;
  priceBreakdown: unknown;
  bookingId: string | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A customer accepts the quote they were sent (plan 2.5, section 5). One transaction in the order of plan 0.1, 6.3:
 * customer, quote, then the booking and the stock. The booking gets the price the quote holds, not a new one. Accepting
 * twice, or from two tabs at once, gives the same booking: the second waits on the quote's lock and finds it accepted.
 */
/** A sent quote can be accepted strictly before its expiry instant: at the instant itself, and after it, it cannot. */
export function quoteIsOpenAt(expiresAt: Date | null, at: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() > at.getTime();
}

@Injectable()
export class QuoteAcceptanceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotedBookingService) private readonly bookings: QuotedBookingService,
    @Inject(PackagePricingReader) private readonly catalogue: PackagePricingReader,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async accept(userId: string, reference: string, actor: AuditActor): Promise<{ bookingReference: string; created: boolean }> {
    // Settings are read before the transaction: inside it they would need a second connection while this one is held.
    const limits = await readBookingLimits(this.settings);
    try {
      return await runTransaction(this.prisma, (tx) => this.acceptIn(tx, userId, reference, actor, limits), QUOTE_TX_OPTIONS);
    } catch (err) {
      throw mapLoadError(err);
    }
  }

  private async acceptIn(tx: Parameters<Parameters<typeof runTransaction>[1]>[0], userId: string, reference: string, actor: AuditActor, limits: BookingLimits) {
    // The customer first (their user's quote only), then the quote.
    const owner = await tx.$queryRaw<Array<{ customerId: string }>>`
      SELECT q."customerId" FROM quotes q JOIN customers c ON c.id = q."customerId" WHERE q.reference = ${reference} AND q.status <> 'draft' AND c."userId" = ${userId}::uuid`;
    if (owner.length === 0) throw notFound('not_found', 'Not found');
    const customer = await this.bookings.lockCustomer(tx, owner[0]!.customerId);
    if (!customer) throw conflict('customer_closed', 'This account is closed');
    const rows = await tx.$queryRaw<LockedQuote[]>`
      SELECT id, status::text AS status, "expiresAt", "customerId", "packageId", "editionId", currency, "totalMinor", "depositMinor", "priceVersionId", "engineVersion",
             "departureDate", "returnDate", "balanceDueDate", configuration, "priceBreakdown", "bookingId"
      FROM quotes WHERE reference = ${reference} FOR UPDATE`;
    const q = rows[0];
    if (!q) throw notFound('not_found', 'Not found');
    if (q.status === 'accepted' && q.bookingId) {
      const b = await tx.booking.findUniqueOrThrow({ where: { id: q.bookingId }, select: { reference: true } });
      return { bookingReference: b.reference, created: false };
    }
    if (q.status !== 'sent') throw conflict('quote_not_available', 'This quote can no longer be accepted');
    const at = await dbNow(tx);
    if (!quoteIsOpenAt(q.expiresAt, at)) throw conflict('quote_expired', 'This quote has expired. Ask us for a new one.');

    // The package, shared, and still on sale; the trip still ahead.
    await lockPackage(tx, q.packageId, 'share');
    const view = await this.catalogue.load(tx, q.packageId);
    if (!view || !view.publiclyVisible || view.saleStatus !== 'open') throw conflict('package_not_open', 'This trip is no longer open for booking');
    // The trip's dates are part of what was offered (the deposit and the balance date hang on them): if the package moved since, the offer is void.
    const cfg = q.configuration as { extraNightsBefore: number; extraNightsAfter: number };
    const shift = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
    if (view.balanceDueDate !== day(q.balanceDueDate) || shift(view.checkInDate, -cfg.extraNightsBefore) !== day(q.departureDate) || shift(view.checkOutDate, cfg.extraNightsAfter) !== day(q.returnDate)) {
      throw conflict('quote_not_available', 'This trip has changed since the quote was made. Ask us for a new one.');
    }
    if (day(q.departureDate) <= todayInBrisbane(at)) throw conflict('package_departed', 'This trip has already started');

    const booking = await this.bookings.createApprovedFromQuote(tx, {
      quoteId: q.id, customerId: q.customerId, packageId: q.packageId, editionId: q.editionId, currency: q.currency, totalMinor: q.totalMinor, depositMinor: q.depositMinor,
      priceVersionId: q.priceVersionId, engineVersion: q.engineVersion, departureDate: day(q.departureDate), returnDate: day(q.returnDate), balanceDueDate: day(q.balanceDueDate),
      configuration: q.configuration as never, priceBreakdown: q.priceBreakdown as never,
    }, customer, actor, limits);

    // Compare-and-set on the locked row: the quote is accepted once, with its booking.
    const n = await tx.$executeRaw`
      UPDATE quotes SET status = 'accepted', "acceptedAt" = ${at}, "bookingId" = ${booking.bookingId}::uuid, version = version + 1, "updatedAt" = ${at}
      WHERE id = ${q.id}::uuid AND status = 'sent'`;
    if (n !== 1) throw conflict('quote_not_available', 'This quote can no longer be accepted');
    await this.audit.record(tx, {
      actor, action: 'crm.quote.status_changed', entityType: 'Quote', entityId: q.id, model: 'Quote',
      before: { status: 'sent' }, after: { status: 'accepted' }, context: { event: 'accept', bookingId: booking.bookingId },
    });
    await this.outbox.publish(tx, {
      type: CRM_EVENTS.quoteAccepted, aggregateType: 'Quote', aggregateId: q.id, aggregateVersion: 0,
      payload: { quoteId: q.id, bookingId: booking.bookingId, customerId: q.customerId }, actorType: actor.type, actorId: actor.id ?? undefined,
    });
    return { bookingReference: booking.reference, created: true };
  }
}
