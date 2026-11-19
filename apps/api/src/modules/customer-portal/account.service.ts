import { Inject, Injectable } from '@nestjs/common';
import type { AccountBookingItem, BookingStatus, CustomerDocumentKind } from '@mt/shared';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { AMENDABLE_STATES, AMENDMENT_SETTINGS, BookingCancellationService, CANCELLATION_SETTINGS, customerView } from '../bookings';
import { SettingsService } from '../../platform/flags/flags.service';
import { PaymentAttemptsService } from '../payments';
import { TemplatesService } from '../templates';
import { documentsFor, formatMinor, longDate } from './documents';

const day = (d: Date) => d.toISOString().slice(0, 10);
const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};
export const ACCOUNT_LIST_LIMIT = 100;

/**
 * The customer area (task 5.1, plan docs/plans/5.1-customer-area.md, sections 3 and 4). It reads through the public
 * services of bookings, payments and templates and writes nothing. Ownership is checked by the routes' guards; amounts
 * are the stored ones (the booking's snapshot and the payment plan), never recomputed here.
 */
@Injectable()
export class CustomerAccountService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentAttemptsService) private readonly payments: PaymentAttemptsService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(BookingCancellationService) private readonly cancellations: BookingCancellationService,
  ) {}

  /** The bookings of the signed-in user's customer, newest request first. A closed account, or none, has nothing. */
  async list(userId: string): Promise<{ items: AccountBookingItem[] }> {
    const customer = await this.prisma.customer.findFirst({ where: { userId, deletedAt: null, anonymisedAt: null }, select: { id: true } });
    if (!customer) return { items: [] };
    const rows = await this.prisma.booking.findMany({
      where: { customerId: customer.id }, orderBy: [{ requestedAt: 'desc' }, { reference: 'asc' }], take: ACCOUNT_LIST_LIMIT,
      select: {
        reference: true, status: true, requestedAt: true, departureDate: true, returnDate: true, currency: true, totalMinor: true,
        package: { select: { name: true, slug: true, edition: { select: { year: true, race: { select: { name: true, slug: true } } } } } },
      },
    });
    return {
      items: rows.map((b) => ({
        reference: b.reference, status: b.status, requestedAt: b.requestedAt.toISOString(), departureDate: day(b.departureDate), returnDate: day(b.returnDate),
        currency: b.currency, totalMinor: b.totalMinor.toString(),
        package: {
          name: b.package.name as Record<string, string>, slug: b.package.slug, editionYear: b.package.edition.year,
          race: { name: b.package.edition.race.name as Record<string, string>, slug: b.package.edition.race.slug },
        },
      })),
    };
  }

  /** One booking: what was booked, the payment plan, the payments received and the documents available now. */
  async detail(reference: string) {
    const booking = await customerView(this.prisma, { reference });
    if (!booking) throw notFound();
    const plan = await this.payments.planView(reference);
    const payments = await this.payments.paymentRecords(reference);
    return { booking, plan, payments, documents: documentsFor((booking as { status: BookingStatus }).status), changes: await this.changes(reference), cancellation: await this.cancellation(reference) };
  }

  /**
   * Task 6.4: the booking's cancellation record (what it kept and what may go back), and whether the customer may cancel
   * it online now (the quote route says what it would cost; the API decides again at the cancellation).
   */
  private async cancellation(reference: string) {
    const b = await this.prisma.booking.findUnique({ where: { reference }, select: { id: true, status: true } });
    if (!b) return { record: null, customerCancellationsEnabled: false };
    const enabled = await this.settings.get(CANCELLATION_SETTINGS.customerEnabled.key, CANCELLATION_SETTINGS.customerEnabled.fallback);
    return { record: await this.cancellations.forBooking(b.id), customerCancellationsEnabled: enabled && ['deposit_paid', 'confirmed', 'balance_paid'].includes(b.status) };
  }

  /**
   * The changes made to a booking (task 6.3), oldest first, as history: what changed, by whom (customer or staff) and the
   * difference in price. What is owed or owed back now is the plan's (`plan.outstandingMinor`, `plan.overpaidMinor`), never
   * these rows (plan review M6). Whether the customer can change it online is said too; the API decides at the change.
   */
  private async changes(reference: string) {
    const b = await this.prisma.booking.findUnique({
      where: { reference },
      select: { status: true, amendments: { orderBy: { toVersion: 'asc' }, select: { toVersion: true, createdAt: true, initiatedBy: true, changes: true, previousTotalMinor: true, newTotalMinor: true, priceDifferenceMinor: true, currency: true } } },
    });
    if (!b) return { items: [], customerChangesEnabled: false };
    const enabled = await this.settings.get(AMENDMENT_SETTINGS.customerEnabled.key, AMENDMENT_SETTINGS.customerEnabled.fallback);
    return {
      items: b.amendments.map((a) => ({
        version: a.toVersion, at: a.createdAt.toISOString(), by: a.initiatedBy, changes: a.changes, currency: a.currency,
        previousTotalMinor: a.previousTotalMinor.toString(), newTotalMinor: a.newTotalMinor.toString(), priceDifferenceMinor: a.priceDifferenceMinor.toString(),
      })),
      customerChangesEnabled: enabled && (AMENDABLE_STATES as readonly string[]).includes(b.status),
    };
  }

  /** A document as a PDF, rebuilt from the booking's current snapshot and the live template; nothing is stored. */
  async document(reference: string, kind: CustomerDocumentKind): Promise<{ pdf: Buffer; filename: string }> {
    const b = await this.prisma.booking.findUnique({
      where: { reference },
      select: {
        reference: true, status: true, departureDate: true, returnDate: true, currency: true, totalMinor: true,
        customer: { select: { givenName: true, familyName: true, preferredLocale: true } },
        package: { select: { name: true, edition: { select: { year: true, startDate: true, race: { select: { name: true } } } } } },
      },
    });
    if (!b) throw notFound();
    if (!documentsFor(b.status as BookingStatus).includes(kind)) throw conflict('document_not_available', 'This document is not available for this booking yet');
    const race = en(b.package.edition.race.name);
    // The race day is the edition's start date as the catalogue holds it now (the snapshot has none), a calendar date.
    const startDate = b.package.edition.startDate;
    const itinerary = [
      `${longDate(b.departureDate)}: arrive and check in`,
      ...(startDate ? [`${longDate(startDate)}: race day, ${race}`] : []),
      `${longDate(b.returnDate)}: check out`,
    ].join('\n');
    const { pdf } = await this.templates.renderDocument(this.prisma, kind, 'en-AU', {
      customerName: `${b.customer.givenName} ${b.customer.familyName}`.trim(),
      reference: b.reference,
      trip: `${race} ${b.package.edition.year}: ${en(b.package.name)}`,
      departureDate: longDate(b.departureDate),
      returnDate: longDate(b.returnDate),
      total: formatMinor(b.totalMinor, b.currency),
      itinerary,
    });
    return { pdf, filename: `${b.reference}-${kind}.pdf` };
  }
}
