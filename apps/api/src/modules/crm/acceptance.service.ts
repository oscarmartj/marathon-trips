import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { PackagePricingReader, lockPackage } from '../catalogue';
import { QuotedBookingService, dbNow, todayInBrisbane } from '../bookings';
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
const busy = () => conflict('busy_try_again', 'Many people are doing this at once. Try again.');

/**
 * A customer accepts the quote they were sent (plan 2.5, section 5). One transaction in the order of plan 0.1, 6.3:
 * customer, quote, then the booking and the stock. The booking gets the price the quote holds, not a new one. Accepting
 * twice, or from two tabs at once, gives the same booking: the second waits on the quote's lock and finds it accepted.
 */
@Injectable()
export class QuoteAcceptanceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuotedBookingService) private readonly bookings: QuotedBookingService,
    @Inject(PackagePricingReader) private readonly catalogue: PackagePricingReader,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async accept(userId: string, reference: string, actor: AuditActor): Promise<{ bookingReference: string; created: boolean }> {
    try {
      return await runTransaction(this.prisma, (tx) => this.acceptIn(tx, userId, reference, actor), QUOTE_TX_OPTIONS);
    } catch (err) {
      if (err instanceof Error && /P2024|P2028|Transaction already closed|Unable to start a transaction in the given time/.test(err.message)) throw busy();
      throw err;
    }
  }

  private async acceptIn(tx: Parameters<Parameters<typeof runTransaction>[1]>[0], userId: string, reference: string, actor: AuditActor) {
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
    if (!q.expiresAt || q.expiresAt.getTime() <= at.getTime()) throw conflict('quote_expired', 'This quote has expired. Ask us for a new one.');

    // The package, shared, and still on sale; the trip still ahead.
    await lockPackage(tx, q.packageId, 'share');
    const view = await this.catalogue.load(tx, q.packageId);
    if (!view || !view.publiclyVisible || view.saleStatus !== 'open') throw conflict('package_not_open', 'This trip is no longer open for booking');
    if (day(q.departureDate) <= todayInBrisbane(at)) throw conflict('package_departed', 'This trip has already started');

    const booking = await this.bookings.createApprovedFromQuote(tx, {
      quoteId: q.id, customerId: q.customerId, packageId: q.packageId, editionId: q.editionId, currency: q.currency, totalMinor: q.totalMinor, depositMinor: q.depositMinor,
      priceVersionId: q.priceVersionId, engineVersion: q.engineVersion, departureDate: day(q.departureDate), returnDate: day(q.returnDate), balanceDueDate: day(q.balanceDueDate),
      configuration: q.configuration as never, priceBreakdown: q.priceBreakdown as never,
    }, customer, actor);

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
