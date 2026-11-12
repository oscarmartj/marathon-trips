import { Inject, Injectable, Logger } from '@nestjs/common';
import type { QuoteRequest } from '@mt/shared';
import { AuditService, SYSTEM_ACTOR } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { canonicalJson, sha256Hex } from '../../platform/crypto/hmac';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { safeError } from '../../platform/errors/safe-error';
import { OutboxService } from '../../platform/events/outbox.service';
import { SettingsService } from '../../platform/flags/flags.service';
import { ApiError, conflict, notFound } from '../../platform/http/api-error';
import { InventoryService, PackagePricingReader, lockPackage } from '../catalogue';
import { QuoteService, publicPromoStatus } from '../pricing';
import { WaitlistService } from '../waitlist';
import { BOOKING_EVENTS } from './manifest';
import { BookingRequestService, REQUEST_TX_OPTIONS, mapLoadError, startOfDayInBrisbane, todayInBrisbane } from './request.service';
import { readBookingLimits } from './settings';
import { snapshotConfigurationSchema } from './snapshot-schema';
import { Tx, dbNow, jsonOf, toDate } from './support';
import { Prisma } from '../../generated/prisma/client';

/** Most offers one release can make, and most entries it looks at. */
const MAX_OFFERS_PER_RELEASE = 20;
const MAX_ENTRIES_LOOKED_AT = 50;
/** Errors that mean the entry's request can no longer be priced at all (an option was removed), not that the package is between prices. */
const UNRESOLVABLE = new Set(['catalogue_changed', 'package_not_found']);
const unresolvable = (err: unknown): boolean => err instanceof ApiError && (UNRESOLVABLE.has(err.code) || err.status === 422);

/** The first lock of a customer-side action: the customer, FOR UPDATE; null when it is closed or does not exist. */
async function lockCustomer(tx: Tx, customerId: string): Promise<{ id: string; residenceCountry: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; residenceCountry: string }>>`
    SELECT id, "countryOfResidence" AS "residenceCountry" FROM customers WHERE id = ${customerId}::uuid AND "deletedAt" IS NULL AND "anonymisedAt" IS NULL FOR UPDATE`;
  return rows[0] ?? null;
}

/** Sale statuses a place can be offered or taken in. */
const OFFERABLE: ReadonlySet<string> = new Set(['open', 'waitlist', 'sold_out']);

const offerClosed = () => conflict('offer_no_longer_open', 'This offer is no longer open');

/**
 * Offers and promotion for the waiting list (task 6.5; plan docs/plans/6.5-waitlist-promotion.md). It lives in bookings
 * because it owns the claims on the stock; the entries themselves are written through the waitlist module's service.
 * Lock order: Customer → Entry → Booking → Pools by id; a promotion runs with the booking and pools of the release
 * already locked and takes entries SKIP LOCKED, so it never waits for one.
 */
@Injectable()
export class WaitlistOffersService {
  private readonly logger = new Logger('Waitlist');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WaitlistService) private readonly waitlist: WaitlistService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(PackagePricingReader) private readonly catalogue: PackagePricingReader,
    @Inject(BookingRequestService) private readonly requests: BookingRequestService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {
    this.waitlist.registerOfferCloser((tx, entryId, to, actor) => this.closeOffer(tx, entryId, to, actor));
  }

  // ---- Promotion ----

  /**
   * Places came back to the stock of this package: offer them to the first entries they fit, in queue order. An entry
   * that does not fit keeps its place and is passed over. Runs inside the releasing transaction, so nobody can take the
   * places between the release and the offer. Returns how many offers were made.
   */
  async promoteIn(tx: Tx, packageId: string, actor: AuditActor, at: Date): Promise<number> {
    const view = await this.catalogue.load(tx, packageId);
    if (!view || !view.publiclyVisible || !OFFERABLE.has(view.saleStatus) || view.checkInDate <= todayInBrisbane(at)) return 0;
    const countries = await this.waitlist.salesCountries(tx);
    const entries = await this.waitlist.lockWaiting(tx, packageId, MAX_ENTRIES_LOOKED_AT);
    let offers = 0;
    for (const e of entries) {
      if (offers >= MAX_OFFERS_PER_RELEASE) break;
      // Someone who no longer lives in a country we sell to keeps their place but is not offered one (task 2.6).
      if (!countries.includes(e.residence)) continue;
      let demand: Array<{ poolId: string; quantity: number }>;
      try {
        const { configuration } = await this.quotes.priceIn(tx, e.configuration as unknown as QuoteRequest, { audience: 'staff', now: at });
        demand = await this.inventory.demandFor(tx, configuration);
      } catch (err) {
        if (!unresolvable(err)) {
          this.logger.warn(`offer skipped for an entry: ${safeError(err).code}`);
          continue;
        }
        // Its options are gone: it can never be offered, so it leaves the queue instead of blocking it.
        await this.waitlist.closeIn(tx, { id: e.id, packageId, customerId: e.customerId }, 'waiting', 'expired', at, actor, { reason: 'The trip changed and the choice can no longer be offered' });
        continue;
      }
      if (demand.length === 0 || !(await this.fits(tx, demand))) continue;
      for (const d of demand) {
        await tx.inventoryClaim.create({ data: { waitlistEntryId: e.id, poolId: d.poolId, quantity: d.quantity } });
        await this.inventory.hold(tx, d.poolId, d.quantity, { actor });
      }
      await this.waitlist.offerIn(tx, e, packageId, at, actor);
      offers++;
    }
    return offers;
  }

  /** Every pool has what the demand needs. Pools are locked in id order (plan 0.1, 6.3). */
  private async fits(tx: Tx, demand: Array<{ poolId: string; quantity: number }>): Promise<boolean> {
    const ids = demand.map((d) => d.poolId);
    const rows = await tx.$queryRaw<Array<{ id: string; remaining: number }>>`
      SELECT id::text AS id, (capacity - consumed)::int AS remaining FROM inventory_pools WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const remaining = new Map(rows.map((r) => [r.id, r.remaining]));
    return demand.every((d) => (remaining.get(d.poolId) ?? 0) >= d.quantity);
  }

  /** Gives an entry's held places back to the stock, once (compare-and-set), pools in id order. */
  private async releaseClaims(tx: Tx, entryId: string, actor: AuditActor, at: Date): Promise<number> {
    const claims = await tx.$queryRaw<Array<{ poolId: string; quantity: number }>>`
      UPDATE inventory_claims SET status = 'released', "releasedAt" = ${at}
      WHERE "waitlistEntryId" = ${entryId}::uuid AND status = 'held' RETURNING "poolId"::text AS "poolId", quantity`;
    claims.sort((a, c) => (a.poolId < c.poolId ? -1 : a.poolId > c.poolId ? 1 : 0));
    for (const c of claims) await this.inventory.release(tx, c.poolId, c.quantity, { actor });
    return claims.reduce((n, c) => n + c.quantity, 0);
  }

  /** An offer ends without a booking: the places go back and are offered to the next person. The entry is locked by the caller or here. */
  async closeOffer(tx: Tx, entryId: string, to: 'withdrawn' | 'expired', actor: AuditActor): Promise<boolean> {
    const entry = await this.waitlist.lockEntry(tx, entryId);
    if (!entry || entry.status !== 'offered') return false;
    const at = await dbNow(tx);
    await this.releaseClaims(tx, entry.id, actor, at);
    await this.waitlist.closeIn(tx, entry, 'offered', to, at, actor);
    await this.promoteIn(tx, entry.packageId, actor, at);
    return true;
  }

  /** The periodic task: offers past their time end and their places move on. One failure does not stop the rest. */
  async expireOffers(limit = 50): Promise<{ expired: number; failed: number }> {
    let expired = 0;
    let failed = 0;
    for (const id of await this.waitlist.dueOffers(limit)) {
      try {
        const done = await runTransaction(this.prisma, async (tx) => {
          const entry = await this.waitlist.lockEntry(tx, id, { skipLocked: true });
          if (!entry || entry.status !== 'offered' || !entry.offerExpiresAt || entry.offerExpiresAt.getTime() > (await dbNow(tx)).getTime()) return false;
          return this.closeOffer(tx, id, 'expired', SYSTEM_ACTOR);
        }, REQUEST_TX_OPTIONS);
        if (done) expired++;
      } catch (err) {
        failed++;
        this.logger.error(`offer expiry failed: ${safeError(err).code}`);
      }
    }
    return { expired, failed };
  }

  // ---- The customer's side ----

  /** The entry as its customer sees it; an offered one comes with the engine's current price. */
  async view(entryId: string) {
    const v = await this.waitlist.entryView(entryId);
    if (!v) throw notFound('not_found', 'Not found');
    const { configuration, ...rest } = v;
    if (v.status !== 'offered') return { ...rest, price: null };
    try {
      const breakdown = await this.prisma.$transaction(
        async (tx) => (await this.quotes.priceIn(tx, configuration as unknown as QuoteRequest, { audience: 'staff', now: new Date() })),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      const { trace: _trace, ...b } = breakdown;
      return { ...rest, price: jsonOf({ ...b, promo: { status: publicPromoStatus(b.promo.status) } }) };
    } catch (err) {
      if (err instanceof ApiError) return { ...rest, price: null };
      throw err;
    }
  }

  /** The customer takes the offer: it becomes a booking request, priced again by the engine, holding the same places. */
  async accept(userId: string, entryId: string, actor: AuditActor): Promise<{ bookingReference: string; created: boolean }> {
    const limits = await readBookingLimits(this.settings);
    try {
      return await runTransaction(this.prisma, (tx) => this.acceptIn(tx, userId, entryId, actor, limits.requestExpiryHours), REQUEST_TX_OPTIONS);
    } catch (err) {
      throw mapLoadError(err);
    }
  }

  private async acceptIn(tx: Tx, userId: string, entryId: string, actor: AuditActor, requestExpiryHours: number) {
    const owner = await tx.$queryRaw<Array<{ customerId: string }>>`
      SELECT w."customerId" FROM waitlist_entries w JOIN customers c ON c.id = w."customerId" WHERE w.id = ${entryId}::uuid AND c."userId" = ${userId}::uuid`;
    if (owner.length === 0) throw notFound('not_found', 'Not found');
    const customer = await lockCustomer(tx, owner[0]!.customerId);
    if (!customer) throw conflict('customer_closed', 'This account is closed');
    const entry = await this.waitlist.lockEntry(tx, entryId, { customerId: customer.id });
    if (!entry) throw notFound('not_found', 'Not found');
    if (entry.status === 'converted' && entry.bookingId) {
      const b = await tx.booking.findUniqueOrThrow({ where: { id: entry.bookingId }, select: { reference: true } });
      return { bookingReference: b.reference, created: false };
    }
    const at = await dbNow(tx);
    if (entry.status !== 'offered' || !entry.offerExpiresAt || entry.offerExpiresAt.getTime() <= at.getTime()) throw offerClosed();

    if (!(await this.waitlist.salesCountries(tx)).includes(customer.residenceCountry)) throw conflict('country_not_served', 'We cannot take booking requests from where you live yet.');
    await lockPackage(tx, entry.packageId, 'share');
    const view = await this.catalogue.load(tx, entry.packageId);
    if (!view || !view.publiclyVisible || !OFFERABLE.has(view.saleStatus)) throw conflict('package_not_open', 'This trip is no longer open for booking');
    let priced;
    try {
      priced = await this.quotes.priceIn(tx, entry.configuration as unknown as QuoteRequest, { audience: 'staff', now: at });
    } catch (err) {
      if (unresolvable(err)) throw conflict('catalogue_changed', 'This trip changed since the offer. Leave the list and join again.');
      throw err;
    }
    if (priced.depositMinor === null || priced.balanceMinor === null) throw conflict('deposit_not_configured', 'This package is not ready for sale');
    if (priced.departureDate <= todayInBrisbane(at)) throw conflict('package_departed', 'This trip has already started');

    // The places go from the entry to the booking in this transaction: released, then held again, so nobody gets in between.
    await this.releaseClaims(tx, entry.id, actor, at);
    const configuration = snapshotConfigurationSchema.parse(jsonOf(priced.configuration));
    const requestExpiresAt = new Date(Math.min(at.getTime() + requestExpiryHours * 3_600_000, startOfDayInBrisbane(priced.departureDate).getTime()));
    const bookingId = await this.requests.insertBooking(tx, {
      customerId: customer.id, kind: 'catalogue', packageId: entry.packageId, editionId: view.editionId, status: 'requested', currentSnapshotVersion: 1,
      departureDate: toDate(priced.departureDate), returnDate: toDate(priced.returnDate), currency: priced.currency,
      totalMinor: priced.totalMinor, depositMinor: priced.depositMinor, balanceDueDate: toDate(priced.balanceDueDate),
      residenceCountry: customer.residenceCountry, requestedAt: at, requestExpiresAt, sourceChannel: 'web',
      requestKeyHash: sha256Hex(`waitlist-acceptance:${entry.id}`), requestConfigHash: sha256Hex(canonicalJson(entry.configuration)), requestContactHmac: null,
    });
    await this.requests.insertSnapshot(tx, bookingId, priced);
    await this.requests.insertParts(tx, bookingId, customer.id, { configuration });
    const demand = await this.inventory.demandFor(tx, configuration);
    for (const d of demand) {
      await tx.inventoryClaim.create({ data: { bookingId, poolId: d.poolId, quantity: d.quantity } });
      await this.inventory.hold(tx, d.poolId, d.quantity, { actor, bookingId });
    }
    await this.waitlist.closeIn(tx, entry, 'offered', 'converted', at, actor, { bookingId });
    await this.audit.record(tx, {
      actor, action: 'bookings.booking.requested', entityType: 'Booking', entityId: bookingId, model: 'Booking',
      after: { status: 'requested', customerId: customer.id, packageId: entry.packageId, totalMinor: priced.totalMinor.toString(), depositMinor: priced.depositMinor.toString(), currency: priced.currency, residenceCountry: customer.residenceCountry, requestExpiresAt: requestExpiresAt.toISOString() },
      context: { waitlistEntryId: entry.id, places: demand.reduce((n, d) => n + d.quantity, 0) },
    });
    await this.outbox.publish(tx, {
      type: BOOKING_EVENTS.requested, aggregateType: 'Booking', aggregateId: bookingId, aggregateVersion: 0,
      payload: { bookingId, packageId: entry.packageId, editionId: view.editionId, customerId: customer.id }, actorType: actor.type, actorId: actor.id ?? undefined,
    });
    const reference = (await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { reference: true } })).reference;
    return { bookingReference: reference, created: true };
  }

  /** The customer leaves the list, or declines the offer: the places, if any, go to the next person. */
  async withdraw(userId: string, entryId: string, actor: AuditActor): Promise<{ status: string }> {
    try {
      return await runTransaction(this.prisma, async (tx) => {
        const owner = await tx.$queryRaw<Array<{ customerId: string }>>`
          SELECT w."customerId" FROM waitlist_entries w JOIN customers c ON c.id = w."customerId" WHERE w.id = ${entryId}::uuid AND c."userId" = ${userId}::uuid`;
        if (owner.length === 0) throw notFound('not_found', 'Not found');
        const customer = await lockCustomer(tx, owner[0]!.customerId);
        if (!customer) throw conflict('customer_closed', 'This account is closed');
        const entry = await this.waitlist.lockEntry(tx, entryId, { customerId: customer.id });
        if (!entry) throw notFound('not_found', 'Not found');
        if (entry.status === 'withdrawn') return { status: 'withdrawn' };
        if (entry.status === 'waiting') {
          await this.waitlist.closeIn(tx, entry, 'waiting', 'withdrawn', await dbNow(tx), actor);
        } else if (entry.status === 'offered') {
          await this.closeOffer(tx, entry.id, 'withdrawn', actor);
        } else {
          throw conflict('entry_not_open', 'This entry has already ended');
        }
        return { status: 'withdrawn' };
      }, REQUEST_TX_OPTIONS);
    } catch (err) {
      throw mapLoadError(err);
    }
  }
}
