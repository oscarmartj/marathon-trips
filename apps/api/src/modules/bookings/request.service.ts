import { Inject, Injectable } from '@nestjs/common';
import type { BookingRequest } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import type { AppConfig } from '../../platform/config/config';
import { canonicalJson, hmacHex, sha256Hex } from '../../platform/crypto/hmac';
import { APP_CONFIG, PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { OutboxService } from '../../platform/events/outbox.service';
import { SettingsService } from '../../platform/flags/flags.service';
import { ApiError, conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { InventoryService } from '../catalogue';
import { PromoRedemptionService, QuoteService, REDEEM_TX_OPTIONS, publicRedemptionError } from '../pricing';
import { WaitlistService } from '../waitlist';
import type { PriceBreakdown } from '../pricing';
import { CustomerService } from './customer.service';
import { BOOKING_EVENTS } from './manifest';
import { BookingLimits, readBookingLimits } from './settings';
import { snapshotBreakdownSchema, snapshotConfigurationSchema } from './snapshot-schema';
import type { SnapshotConfiguration } from './snapshot-schema';
import { ReferenceGenerator, Tx, dbNow, jsonOf, toDate } from './support';

/** How long the request transaction may wait for a connection and run (plan 2.4, section 16, point 7). */
export const REQUEST_TX_OPTIONS = { ...REDEEM_TX_OPTIONS, timeout: 15_000, maxWait: 5_000 } as const;

const busy = () => conflict('busy_try_again', 'Many people are doing this at once. Try again.');

/**
 * Prisma's "no connection in time" (P2024) and "transaction closed or timed out" (P2028) are load, not a fault of the
 * request: 409 busy_try_again, never a 500 (plan 2.4, section 16, point 7).
 */
export function mapLoadError(err: unknown): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2024' || err.code === 'P2028')) return busy();
  if (err instanceof Error && !(err instanceof ApiError) && /P2024|P2028|Transaction already closed|Unable to start a transaction in the given time/.test(err.message)) return busy();
  return err;
}

/** The business time zone has no daylight saving (plan 0.1, assumption 1): the start of a day there is UTC+10. */
const BRISBANE_OFFSET = '+10:00';
export const todayInBrisbane = (at: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
export const startOfDayInBrisbane = (date: string): Date => new Date(`${date}T00:00:00.000${BRISBANE_OFFSET}`);

/**
 * What a request became (task 2.6): a booking request, or, for someone who does not live in a country we sell to, a
 * waiting list entry (no price kept, no stock held).
 */
export type CreatedRequest = { kind: 'booking'; bookingId: string; created: boolean } | { kind: 'waitlist'; entryId: string; created: boolean };

/**
 * Creates a booking request (plan 2.4, section 4): prices the configuration with the engine, stores the immutable
 * snapshot, redeems the code and holds the stock, all in ONE transaction in READ COMMITTED, locking in the order
 * Customer → Package (shared) → PromoCode → pools by id. The amount always comes from the engine, never from the request.
 */
@Injectable()
export class BookingRequestService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(PromoRedemptionService) private readonly redemptions: PromoRedemptionService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(CustomerService) private readonly customers: CustomerService,
    @Inject(WaitlistService) private readonly waitlist: WaitlistService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ReferenceGenerator) private readonly references: ReferenceGenerator,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(user: { id: string; email: string }, body: BookingRequest, idempotencyKey: string, actor: AuditActor): Promise<CreatedRequest> {
    const limits = await readBookingLimits(this.settings);
    const { contact, ...configuration } = body;
    const hashes = {
      key: sha256Hex(`booking-request:${user.id}:${idempotencyKey}`),
      config: sha256Hex(canonicalJson(configuration)),
      contact: hmacHex(this.config.AUTH_HMAC_KEY, `booking-request-contact:${canonicalJson(contact)}`),
    };
    try {
      return await runTransaction(this.prisma, (tx) => this.createIn(tx, user, body, hashes, limits, actor), REQUEST_TX_OPTIONS);
    } catch (err) {
      throw mapLoadError(err);
    }
  }

  private async createIn(tx: Tx, user: { id: string; email: string }, body: BookingRequest, hashes: { key: string; config: string; contact: string }, limits: BookingLimits, actor: AuditActor): Promise<CreatedRequest> {
    const { contact, ...configuration } = body;
    // 1. The customer, locked: everything this customer does from here on runs one request at a time.
    const { customer, created } = await this.customers.lockOrCreate(tx, user, contact, actor);

    // 2. The same Idempotency-Key again (a retry after the commit, or after the idempotency record's lock ran out).
    const existing = await tx.booking.findUnique({ where: { customerId_requestKeyHash: { customerId: customer.id, requestKeyHash: hashes.key } }, select: { id: true, requestConfigHash: true, requestContactHmac: true } });
    if (existing) {
      if (existing.requestConfigHash === hashes.config && existing.requestContactHmac === hashes.contact) return { kind: 'booking', bookingId: existing.id, created: false };
      throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');
    }
    // The same key may have made a waiting list entry (the platform's record of it lasts 24 hours): same answer, or 422.
    const wl = await this.waitlist.findByKey(tx, customer.id, hashes.key);
    if (wl) {
      if (wl.requestConfigHash === hashes.config && wl.requestContactHmac === hashes.contact) return { kind: 'waitlist', entryId: wl.id, created: false };
      throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');
    }
    if (!created) await this.customers.applyContact(tx, customer, contact, actor);

    // 3. Who may ask: a resident of a country we sell to sends a request; anyone else joins the waiting list (task 2.6).
    if (!limits.salesCountries.includes(contact.countryOfResidence)) return this.joinWaitlistIn(tx, user, customer.id, body, hashes, actor);

    // 3b. A package whose sale is `waitlist` or `sold_out` takes no request: the resident joins its waiting list (task 6.5).
    const sale = await tx.$queryRaw<Array<{ saleStatus: string }>>`SELECT "saleStatus"::text AS "saleStatus" FROM packages WHERE id = ${configuration.packageId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
    if (sale[0] && (sale[0].saleStatus === 'waitlist' || sale[0].saleStatus === 'sold_out')) return this.joinWaitlistIn(tx, user, customer.id, body, hashes, actor, 'sold_out');

    // 4. How much one customer may hold.
    const open = await tx.booking.count({ where: { customerId: customer.id, status: 'requested' } });
    if (open >= limits.maxOpenRequests) throw conflict('too_many_open_requests', 'You already have as many open requests as we can take. We will be in touch about them first.');

    // 5. The package, shared: its sale status and price versions cannot change until this commits.
    const pkg = await tx.$queryRaw<Array<{ editionId: string }>>`SELECT "editionId" FROM packages WHERE id = ${configuration.packageId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
    if (pkg.length === 0) throw notFound('package_not_found', 'Package not found');

    // 6. The database clock, after the locks: the engine's `now`, the code's, and the request's time.
    const at = await dbNow(tx);

    // 7. The price, from the engine only.
    const { breakdown, promoRef } = await this.quotes.priceWithPromoRef(tx, configuration, { audience: 'public', now: at });
    if (configuration.promoCode !== undefined && breakdown.promo.status !== 'applied') {
      throw conflict('promo_code_unavailable', 'That code can no longer be used. Remove it to continue.');
    }
    if (breakdown.depositMinor === null || breakdown.balanceMinor === null) throw conflict('deposit_not_configured', 'This package is not ready for sale');
    if (breakdown.departureDate <= todayInBrisbane(at)) throw conflict('package_departed', 'This trip has already started');

    // 10a. The stock it needs, from one consistent read of the package's options.
    const demand = await this.inventory.demandFor(tx, breakdown.configuration);
    const places = demand.reduce((n, d) => n + d.quantity, 0);
    const [held] = await tx.$queryRaw<Array<{ n: number }>>`
      SELECT COALESCE(SUM(c.quantity), 0)::int AS n FROM inventory_claims c JOIN bookings b ON b.id = c."bookingId"
      WHERE b."customerId" = ${customer.id}::uuid AND b.status = 'requested' AND c.status = 'held'`;
    if ((held?.n ?? 0) + places > limits.maxHeldPlaces) throw conflict('too_many_places_held', 'This request would hold more places than we can keep for one customer. Contact us for a group booking.');

    // 8. The booking and its snapshot.
    const requestExpiresAt = new Date(Math.min(at.getTime() + limits.requestExpiryHours * 3_600_000, startOfDayInBrisbane(breakdown.departureDate).getTime()));
    const bookingId = await this.insertBooking(tx, {
      customerId: customer.id, kind: 'catalogue', packageId: configuration.packageId, editionId: pkg[0]!.editionId, status: 'requested', currentSnapshotVersion: 1,
      departureDate: toDate(breakdown.departureDate), returnDate: toDate(breakdown.returnDate), currency: breakdown.currency,
      totalMinor: breakdown.totalMinor, depositMinor: breakdown.depositMinor, balanceDueDate: toDate(breakdown.balanceDueDate),
      residenceCountry: contact.countryOfResidence, requestedAt: at, requestExpiresAt, sourceChannel: 'web',
      requestKeyHash: hashes.key, requestConfigHash: hashes.config, requestContactHmac: hashes.contact,
    });
    await this.insertSnapshot(tx, bookingId, breakdown);
    await this.insertParts(tx, bookingId, customer.id, breakdown);

    // 9. The code, counted in the same transaction: a failure aborts everything, and reads the same to the public.
    if (promoRef) {
      try {
        await this.redemptions.redeemIn(tx, { promoCodeId: promoRef.id, promoCodeVersion: promoRef.version, bookingId, customerId: customer.id, now: at });
      } catch (err) {
        throw publicRedemptionError(err);
      }
    }

    // 10b. The stock, pool by pool in id order; no place left is a 409 and nothing stays written.
    for (const d of demand) {
      await tx.inventoryClaim.create({ data: { bookingId, poolId: d.poolId, quantity: d.quantity } });
      await this.inventory.hold(tx, d.poolId, d.quantity, { actor, bookingId });
    }

    // 11. Audit and event, in the same transaction.
    await this.audit.record(tx, {
      actor, action: 'bookings.booking.requested', entityType: 'Booking', entityId: bookingId, model: 'Booking',
      after: { status: 'requested', customerId: customer.id, packageId: configuration.packageId, totalMinor: breakdown.totalMinor.toString(), depositMinor: breakdown.depositMinor.toString(), currency: breakdown.currency, residenceCountry: contact.countryOfResidence, requestExpiresAt: requestExpiresAt.toISOString() },
      context: { promoApplied: promoRef !== null, places },
    });
    await this.outbox.publish(tx, {
      type: BOOKING_EVENTS.requested, aggregateType: 'Booking', aggregateId: bookingId, aggregateVersion: 0,
      payload: { bookingId, packageId: configuration.packageId, editionId: pkg[0]!.editionId, customerId: customer.id }, actorType: actor.type, actorId: actor.id ?? undefined,
    });
    return { kind: 'booking', bookingId, created: true };
  }

  /**
   * The waiting list instead of a request (task 2.6), in the same transaction and under the same customer lock. The
   * configuration is still checked by the engine, so a package that is not open for sale, a departed one or a nonsense
   * configuration is refused the same way, but nothing it returns is kept except the head count: no price, no snapshot,
   * no code redeemed (a code, if sent, is ignored) and no stock held.
   */
  private async joinWaitlistIn(tx: Tx, user: { id: string; email: string }, customerId: string, body: BookingRequest, hashes: { key: string; config: string; contact: string }, actor: AuditActor, reason: 'non_resident' | 'sold_out' = 'non_resident'): Promise<CreatedRequest> {
    const { contact, promoCode: _ignored, ...configuration } = body;
    const pkg = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM packages WHERE id = ${configuration.packageId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
    if (pkg.length === 0) throw notFound('package_not_found', 'Package not found');
    const at = await dbNow(tx);
    const { breakdown } = await this.quotes.priceWithPromoRef(tx, configuration, { audience: 'public', now: at, includeWaitlist: reason === 'sold_out' });
    if (breakdown.departureDate <= todayInBrisbane(at)) throw conflict('package_departed', 'This trip has already started');
    const travellers = breakdown.configuration.rooms.reduce((n, r) => n + r.travellers.length, 0);
    const joined = await this.waitlist.joinIn(tx, {
      customerId, email: user.email, countryOfResidence: contact.countryOfResidence, packageId: configuration.packageId, travellers,
      requestKeyHash: hashes.key, requestConfigHash: hashes.config, requestContactHmac: hashes.contact, actor,
      ...(reason === 'sold_out' ? { reason, configuration: configuration as unknown as Prisma.InputJsonObject } : {}),
    });
    return { kind: 'waitlist', ...joined };
  }

  /** A fresh random reference; a collision is skipped with ON CONFLICT DO NOTHING (a 23505 would abort the transaction). */
  async insertBooking(tx: Tx, data: Omit<Prisma.BookingCreateManyInput, 'reference'>): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await tx.booking.createManyAndReturn({ data: [{ ...data, reference: this.references.next() }], skipDuplicates: true, select: { id: true } });
      if (rows.length === 1) return rows[0]!.id;
    }
    throw busy();
  }

  async insertSnapshot(tx: Tx, bookingId: string, b: PriceBreakdown): Promise<void> {
    // Ids, slots, codes, dates and amounts only: checked before it reaches an immutable row.
    const configuration = snapshotConfigurationSchema.parse(jsonOf(b.configuration));
    const priceBreakdown = snapshotBreakdownSchema.parse(jsonOf(b));
    await tx.bookingSnapshot.create({
      data: {
        bookingId, version: 1, kind: 'original', configuration, priceBreakdown: priceBreakdown as unknown as Prisma.InputJsonObject,
        totalMinor: b.totalMinor, depositMinor: b.depositMinor!, currency: b.currency, priceVersionId: b.priceVersionId, engineVersion: b.engineVersion,
      },
    });
  }

  /** Places, rooms and extras as they stand, from the engine's configuration (the lead is place 1). */
  async insertParts(tx: Tx, bookingId: string, customerId: string, b: { configuration: SnapshotConfiguration }): Promise<void> {
    const c = b.configuration;
    const travellers = c.rooms.flatMap((r) => r.travellers);
    await tx.bookingTraveller.createMany({
      data: travellers.map((t) => ({ bookingId, customerId, slot: t.slot, participationType: t.participationType, raceDistanceId: t.raceDistanceId, isLead: t.slot === 1 })),
    });
    await tx.bookingRoom.createMany({ data: c.rooms.map((r) => ({ bookingId, roomOptionId: r.roomOptionId, occupancy: r.occupancy, travellerSlots: r.travellers.map((t) => t.slot) })) });
    const extras = c.extras.flatMap((e): Prisma.BookingExtraCreateManyInput[] =>
      e.travellerSlots.length > 0 ? e.travellerSlots.map((s) => ({ bookingId, extraId: e.extraId, quantity: 1, travellerSlot: s })) : [{ bookingId, extraId: e.extraId, quantity: e.quantity, travellerSlot: null }],
    );
    if (extras.length > 0) await tx.bookingExtra.createMany({ data: extras });
  }
}
