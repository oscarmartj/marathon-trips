import { safeError } from '../../platform/errors/safe-error';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AmendmentReason } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { canonicalJson, sha256Hex } from '../../platform/crypto/hmac';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { OutboxService } from '../../platform/events/outbox.service';
import { SettingsService } from '../../platform/flags/flags.service';
import { ApiError, conflict, notFound, unauthorised, unprocessable } from '../../platform/http/api-error';
import { InventoryService } from '../catalogue';
import { PromoRedemptionService, QuoteService, priceDifference, publicPromoStatus } from '../pricing';
import type { AmendmentBasis, PriceBreakdown } from '../pricing';
import { BookingAmendmentHooks } from './amendment-hooks';
import type { AmendmentMoneyAfter } from './amendment-hooks';
import { changesBetween, keepAllRooms, linesByKey, planPlaces, relabelSlots, requestOf, slotToPosition } from './amendment-slots';
import type { AmendmentChangeKind, PlacePlan, RoomRequest } from './amendment-slots';
import { BOOKING_EVENTS } from './manifest';
import { BookingStateMachine } from './state-machine';
import { readBookingForPayments } from './read';
import type { LockedBooking } from './read';
import { REQUEST_TX_OPTIONS, mapLoadError, todayInBrisbane } from './request.service';
import { readAmendmentSettings } from './settings';
import type { AmendmentSettings } from './settings';
import { snapshotBreakdownSchema, snapshotConfigurationSchema } from './snapshot-schema';
import type { SnapshotBreakdown, SnapshotConfiguration } from './snapshot-schema';
import { WaitlistOffersService } from './waitlist-offers.service';
import { Tx, dbNow, jsonOf, toDate } from './support';

/** The states in which a booking can be changed (plan, decision 2). */
export const AMENDABLE_STATES = ['deposit_paid', 'confirmed', 'balance_paid'] as const;

type Extra = { extraId: string; travellerSlots?: number[]; quantity?: number };

/** A change as the routes give it: staff send rooms and positions; customers send nights and extras with place numbers. */
export type AmendmentRequest =
  | { initiatedBy: 'staff'; expectedSnapshotVersion: number; rooms: RoomRequest[]; extraNightsBefore: number; extraNightsAfter: number; extras: Extra[]; reasonCode: AmendmentReason; previewDigest?: string }
  | { initiatedBy: 'customer'; expectedSnapshotVersion: number; extraNightsBefore: number; extraNightsAfter: number; extras: Extra[]; previewDigest?: string };

export type BookingRef = { id: string } | { reference: string };

/** Everything a preview and an apply share, computed from the booking as it stands (plan section 5, steps 3 and 4). */
interface Evaluation {
  bookingId: string;
  reference: string;
  customerId: string;
  packageId: string;
  currency: string;
  fromVersion: number;
  basis: AmendmentBasis;
  current: SnapshotConfiguration;
  places: PlacePlan;
  breakdown: PriceBreakdown;
  previousTotalMinor: bigint;
  differenceMinor: bigint;
  driftMinor: bigint;
  changes: AmendmentChangeKind[];
  collectedMinor: bigint;
  digest: string;
  today: string;
  redeemedPromoCodeId: string | null;
  reasonCode: AmendmentReason;
}

const max0 = (x: bigint) => (x > 0n ? x : 0n);
const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** Errors after which a task for Oscar is opened (plan, decision 4): the prices behind a sold booking changed. */
const BASIS_ERRORS = new Set(['amendment_price_basis_drifted', 'amendment_price_basis_unavailable']);

/**
 * Changes to a booking after its deposit (task 6.3; plan docs/plans/6.3-booking-amendments.md). The engine prices the new
 * configuration on the booking's price basis; a change writes a new immutable snapshot and its amendment record, moves
 * places, rooms, extras, the promo code and the stock, and lets payments restate the plan and apply coverage C, all in one
 * transaction locked Customer → Booking → Package → PromoCode → pools. The amount owed never comes from the request.
 */
@Injectable()
export class BookingAmendmentService {
  private readonly logger = new Logger('BookingAmendments');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(PromoRedemptionService) private readonly redemptions: PromoRedemptionService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(WaitlistOffersService) private readonly offers: WaitlistOffersService,
    @Inject(BookingAmendmentHooks) private readonly hooks: BookingAmendmentHooks,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(BookingStateMachine) private readonly machine: BookingStateMachine,
  ) {}

  /** What the change would do, without writing anything (plan section 5, "Preview"). */
  async preview(ref: BookingRef, req: AmendmentRequest) {
    const settings = await readAmendmentSettings(this.settings);
    try {
      return await runTransaction(this.prisma, async (tx) => {
        const at = await dbNow(tx);
        const e = await this.evaluate(tx, await this.find(tx, ref), req, settings, at);
        return this.previewView(e, req.initiatedBy);
      }, REQUEST_TX_OPTIONS);
    } catch (err) {
      await this.openBasisTask(err, ref);
      throw mapLoadError(err);
    }
  }

  /** Applies a change once per Idempotency-Key (plan section 5). */
  async apply(ref: BookingRef, req: AmendmentRequest, idempotencyKey: string, actor: AuditActor): Promise<{ created: boolean; amendmentId: string; reference: string }> {
    if (!actor.id) throw unauthorised();
    const settings = await readAmendmentSettings(this.settings);
    const keyHash = sha256Hex(`booking-amendment:${actor.id}:${idempotencyKey}`);
    const bodyHash = sha256Hex(canonicalJson(req));
    try {
      return await runTransaction(this.prisma, (tx) => this.applyIn(tx, ref, req, { keyHash, bodyHash }, settings, actor), REQUEST_TX_OPTIONS);
    } catch (err) {
      await this.openBasisTask(err, ref);
      throw mapLoadError(err);
    }
  }

  /**
   * The answer already given for this Idempotency-Key, before anything else is checked (code review, point 6): a retry
   * after success returns the stored change even if the terms, the clock or the booking moved since. Another body with
   * the same key is a 422. Null when the key is new.
   */
  async replay(ref: BookingRef, req: AmendmentRequest, idempotencyKey: string, actor: AuditActor): Promise<{ created: false; amendmentId: string; reference: string } | null> {
    if (!actor.id) throw unauthorised();
    const b = await this.prisma.booking.findFirst({ where: 'id' in ref ? { id: ref.id } : { reference: ref.reference }, select: { id: true, reference: true } });
    if (!b) return null;
    const row = await this.prisma.bookingAmendment.findUnique({ where: { bookingId_requestKeyHash: { bookingId: b.id, requestKeyHash: sha256Hex(`booking-amendment:${actor.id}:${idempotencyKey}`) } }, select: { id: true, requestBodyHash: true } });
    if (!row) return null;
    if (row.requestBodyHash !== sha256Hex(canonicalJson(req))) throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');
    return { created: false, amendmentId: row.id, reference: b.reference };
  }

  private async find(tx: Tx, ref: BookingRef): Promise<{ id: string }> {
    const row = await tx.booking.findFirst({ where: 'id' in ref ? { id: ref.id } : { reference: ref.reference }, select: { id: true } });
    if (!row) throw notFound('booking_not_found', 'Booking not found');
    return row;
  }

  private async applyIn(tx: Tx, ref: BookingRef, req: AmendmentRequest, hashes: { keyHash: string; bodyHash: string }, settings: AmendmentSettings, actor: AuditActor) {
    // 1. Customer (shared, still open: the erasure of 5.5 locks it for update) → Booking (for update).
    const head = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT b.id::text AS id FROM bookings b JOIN customers c ON c.id = b."customerId"
        WHERE ${'id' in ref ? 'b.id = $1::uuid' : 'b.reference = $1'} AND c."deletedAt" IS NULL AND c."anonymisedAt" IS NULL FOR SHARE OF c`,
      'id' in ref ? ref.id : ref.reference,
    );
    if (!head[0]) throw notFound('booking_not_found', 'Booking not found');
    const locked = await readBookingForPayments(tx, { id: head[0].id }, true);
    if (!locked) throw notFound('booking_not_found', 'Booking not found');

    // 2. The same Idempotency-Key: the same answer, or 422 for another body. Before the version check, so a retry after
    // success is not a 409.
    const existing = await tx.bookingAmendment.findUnique({ where: { bookingId_requestKeyHash: { bookingId: locked.id, requestKeyHash: hashes.keyHash } }, select: { id: true, requestBodyHash: true } });
    if (existing) {
      if (existing.requestBodyHash !== hashes.bodyHash) throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');
      return { created: false, amendmentId: existing.id, reference: locked.reference };
    }

    // 3. The package, shared: its price versions cannot be withdrawn while the change is priced.
    await tx.$queryRaw`SELECT id FROM packages WHERE id = (SELECT "packageId" FROM bookings WHERE id = ${locked.id}::uuid) FOR SHARE`;
    const at = await dbNow(tx);
    const e = await this.evaluate(tx, { id: locked.id }, req, settings, at);
    if (req.previewDigest !== e.digest) throw conflict('amendment_price_changed', 'The price of this change has changed. Preview it again.');
    const to = e.fromVersion + 1;

    // 4. The new snapshot and the booking's move to it (compare-and-set on the version read under the lock).
    const configuration = snapshotConfigurationSchema.parse(jsonOf(e.breakdown.configuration));
    const priceBreakdown = snapshotBreakdownSchema.parse(jsonOf(e.breakdown));
    await tx.bookingSnapshot.create({
      data: {
        bookingId: e.bookingId, version: to, kind: 'amendment', configuration, priceBreakdown: priceBreakdown as unknown as Prisma.InputJsonObject,
        totalMinor: e.breakdown.totalMinor, depositMinor: e.breakdown.depositMinor!, currency: e.currency, priceVersionId: e.breakdown.priceVersionId, engineVersion: e.breakdown.engineVersion,
      },
    });
    const moved = await this.machine.moveToSnapshot(tx, e.bookingId, e.fromVersion, {
      totalMinor: e.breakdown.totalMinor, depositMinor: e.breakdown.depositMinor!, departureDate: toDate(e.breakdown.departureDate), returnDate: toDate(e.breakdown.returnDate),
      balanceDueDate: toDate(e.breakdown.balanceDueDate), at,
    });
    if (moved !== 1) throw conflict('version_conflict', 'Someone else changed this booking. Reload and try again.');

    // 5. Places (retired first, so the immediate one-lead constraint never sees two), rooms and extras.
    await this.writeParts(tx, e, to);

    // 6. The promo code, if the engine no longer applies it (Booking → PromoCode).
    if (e.redeemedPromoCodeId && e.breakdown.promo.status !== 'applied') await this.redemptions.releaseIn(tx, { promoCodeId: e.redeemedPromoCodeId, bookingId: e.bookingId, now: at });

    // 7. Stock, pool by pool in id order, then the waiting list once (plan review M5).
    const released = await this.moveStock(tx, e, to, actor);
    if (released > 0) await this.offers.promoteIn(tx, e.packageId, actor, at);

    // 8. Traveller details of replaced and retired places; then payments: plan, links, coverage C, credit task.
    await this.hooks.runPlaces(tx, {
      actor, bookingId: e.bookingId, customerId: e.customerId, retired: e.places.retired,
      carries: e.places.added.filter((a) => a.replacesSlot !== null).map((a) => ({ from: a.replacesSlot!, to: a.slot, runner: a.participationType !== 'supporter' })),
    });
    const lastDay = addDays(e.breakdown.departureDate, -1);
    const due = addDays(e.today, settings.paymentDays);
    const money: AmendmentMoneyAfter = await this.hooks.money.restate(tx, locked as LockedBooking, {
      actor, reference: e.reference, previousTotalMinor: e.previousTotalMinor, newTotalMinor: e.breakdown.totalMinor, toVersion: to, adjustmentDue: due < lastDay ? due : lastDay,
    });

    // 9. The record of the change.
    const row = await tx.bookingAmendment.create({
      data: {
        bookingId: e.bookingId, currency: e.currency, fromVersion: e.fromVersion, toVersion: to, initiatedBy: req.initiatedBy, actorUserId: actor.id!,
        reasonCode: e.reasonCode, changes: e.changes, previousTotalMinor: e.previousTotalMinor, newTotalMinor: e.breakdown.totalMinor,
        priceDifferenceMinor: e.differenceMinor, collectedMinor: money.collectedMinor, outstandingMinor: money.outstandingMinor, creditPendingMinor: money.creditPendingMinor,
        basisDriftMinor: e.driftMinor, basisPriceVersionId: e.basis.priceVersionId, basisAt: e.basis.at, requestKeyHash: hashes.keyHash, requestBodyHash: hashes.bodyHash,
      },
      select: { id: true },
    });

    // 10. Staff raised the price without the customer asking: someone must tell them (plan review M3).
    if (req.initiatedBy === 'staff' && e.differenceMinor > 0n && e.reasonCode !== 'customer_request') {
      await this.tasks.createSystemIn(tx, {
        title: `Tell the customer about the change to booking ${e.reference} and the new amount due`,
        description: 'Staff changed this booking and the price went up. The customer did not ask for it: contact them before the new amount falls due.',
        entityType: 'Booking', entityId: e.bookingId, sourceRef: `bookings:amendment_inform:${e.bookingId}:v${to}`,
      });
    }

    await this.audit.record(tx, {
      actor, action: BOOKING_EVENTS.amended, entityType: 'Booking', entityId: e.bookingId, model: 'Booking',
      before: { currentSnapshotVersion: e.fromVersion, totalMinor: e.previousTotalMinor.toString(), customerId: e.customerId },
      after: { currentSnapshotVersion: to, totalMinor: e.breakdown.totalMinor.toString(), customerId: e.customerId },
      context: {
        amendmentId: row.id, initiatedBy: req.initiatedBy, reasonCode: e.reasonCode, changes: e.changes.join(':'), priceDifferenceMinor: e.differenceMinor.toString(),
        basisDriftMinor: e.driftMinor.toString(), outstandingMinor: money.outstandingMinor.toString(), creditPendingMinor: money.creditPendingMinor.toString(),
        retiredPlaces: e.places.retired.join(':'), addedPlaces: e.places.added.map((a) => a.slot).join(':'), releasedPlaces: released,
      },
    });
    await this.outbox.publish(tx, {
      type: BOOKING_EVENTS.amended, aggregateType: 'Booking', aggregateId: e.bookingId, aggregateVersion: to,
      payload: { bookingId: e.bookingId, amendmentId: row.id, fromVersion: e.fromVersion, toVersion: to }, actorType: actor.type, actorId: actor.id ?? undefined,
    });
    return { created: true, amendmentId: row.id, reference: e.reference };
  }

  /** Steps 3 and 4 of plan section 5: rules, places, prices, drift, difference and digest. Reads only. */
  private async evaluate(tx: Tx, ref: { id: string }, req: AmendmentRequest, settings: AmendmentSettings, at: Date): Promise<Evaluation> {
    const b = await tx.booking.findUnique({
      where: { id: ref.id },
      select: { id: true, reference: true, customerId: true, packageId: true, currency: true, status: true, currentSnapshotVersion: true, departureDate: true, snapshots: { select: { version: true, configuration: true, priceBreakdown: true, totalMinor: true, priceVersionId: true } } },
    });
    if (!b) throw notFound('booking_not_found', 'Booking not found');
    if (req.initiatedBy === 'customer' && !settings.customerEnabled) throw conflict('amendments_unavailable', 'Changes cannot be made online yet. Contact us to change your booking.');
    if (!(AMENDABLE_STATES as readonly string[]).includes(b.status)) throw conflict('amendment_not_allowed', 'This booking cannot be changed in its current state');
    if (req.expectedSnapshotVersion !== b.currentSnapshotVersion) throw conflict('version_conflict', 'Someone else changed this booking. Reload and try again.');
    const today = todayInBrisbane(at);
    const lastDay = (departure: string) => (req.initiatedBy === 'customer' ? addDays(departure, -settings.customerCutoffDays) : addDays(departure, -1));
    if (today > lastDay(ymd(b.departureDate))) throw conflict('amendment_too_late', req.initiatedBy === 'customer' ? 'It is too late to change this booking online. Contact us.' : 'This trip is about to start: it can no longer be changed');

    const snapshot = b.snapshots.find((s) => s.version === b.currentSnapshotVersion)!;
    const current = snapshotConfigurationSchema.parse(snapshot.configuration);
    const stored = snapshot.priceBreakdown as unknown as SnapshotBreakdown;
    const basis = await this.basisOf(tx, b.id, b.snapshots);

    // Places: staff rearrange; a customer keeps every place where it is.
    const placeRows = await tx.bookingTraveller.findMany({ where: { bookingId: b.id }, select: { slot: true, participationType: true, raceDistanceId: true, isLead: true, removedInVersion: true } });
    const currentPlaces = placeRows.filter((p) => p.removedInVersion === null);
    const highest = placeRows.reduce((m, p) => Math.max(m, p.slot), 0);
    const rooms = req.initiatedBy === 'staff' ? req.rooms : keepAllRooms(current);
    const places = planPlaces(currentPlaces, highest, rooms, req.initiatedBy === 'staff');
    let extras = req.extras;
    if (req.initiatedBy === 'customer') {
      const pos = new Map(places.positionToSlot.map((s, i) => [s, i + 1]));
      extras = req.extras.map((x) => ({
        extraId: x.extraId,
        ...(x.travellerSlots !== undefined ? { travellerSlots: x.travellerSlots.map((s) => pos.get(s) ?? (() => { throw unprocessable('place_unknown', 'That place is not part of this booking'); })()) } : {}),
        ...(x.quantity !== undefined ? { quantity: x.quantity } : {}),
      }));
    }

    // The new configuration and the unchanged one, on the same basis (decisions 3 and 4).
    const priced = await this.quotes.priceAmendmentIn(tx, { packageId: b.packageId, rooms: places.rooms, extraNightsBefore: req.extraNightsBefore, extraNightsAfter: req.extraNightsAfter, extras }, basis);
    const breakdown = relabelSlots(priced, places.positionToSlot);
    let again: PriceBreakdown;
    try {
      const currentPositions = [...slotToPosition(current).entries()].sort((x, y) => x[1] - y[1]).map(([s]) => s);
      again = relabelSlots(await this.quotes.priceAmendmentIn(tx, { packageId: b.packageId, ...requestOf(current) }, basis), currentPositions);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'amendment_price_basis_unavailable') throw err;
      if (err instanceof ApiError) throw conflict('amendment_price_basis_unavailable', 'The prices this booking was sold at no longer price it. We have told the team.');
      throw err;
    }
    const driftMinor = again.totalMinor - snapshot.totalMinor;
    const sameLines = sameMap(linesByKey(again), linesByKey(stored));
    if (!sameLines || driftMinor !== 0n) {
      const allowed = driftMinor < 0n && req.initiatedBy === 'staff' && req.reasonCode === 'correction';
      if (!allowed) throw conflict('amendment_price_basis_drifted', 'The prices behind this booking have changed since it was sold, so this change cannot be priced fairly. We have told the team.');
    }

    if (breakdown.currency !== b.currency) throw conflict('currency_mismatch', 'A change cannot move a booking to another currency');
    if (breakdown.depositMinor === null) throw conflict('deposit_not_configured', 'This package is not ready for changes');
    if (today > lastDay(breakdown.departureDate)) throw conflict('amendment_too_late', 'The new dates start too soon for this change');
    const differenceMinor = priceDifference({ totalMinor: snapshot.totalMinor, currency: b.currency }, breakdown);
    if (req.initiatedBy === 'customer' && differenceMinor < 0n) throw conflict('amendment_needs_staff', 'This change lowers the price. Contact us to make it.');
    const changes = changesBetween(current, snapshotConfigurationSchema.parse(jsonOf(breakdown.configuration)), places);
    if (changes.length === 0) throw unprocessable('amendment_has_no_change', 'Nothing in this booking would change');

    const facts = await this.hooks.money.facts(tx, b.id);
    if (facts.liveAttempt) throw conflict('amendment_blocked_by_payment', 'A payment for this booking is in progress. Try again when it has finished.');
    const redemption = await tx.promoRedemption.findFirst({ where: { bookingId: b.id, releasedAt: null }, select: { promoCodeId: true } });
    const reasonCode: AmendmentReason = req.initiatedBy === 'staff' ? req.reasonCode : 'customer_request';
    const digest = sha256Hex(canonicalJson(jsonOf({
      bookingId: b.id, fromVersion: b.currentSnapshotVersion, configuration: breakdown.configuration, totalMinor: breakdown.totalMinor,
      depositMinor: breakdown.depositMinor, currency: breakdown.currency, promo: breakdown.promo.status, driftMinor, reasonCode,
      // What happens to the places, not only the priced result: a previewed replacement (details copied) can never be
      // applied as a removal and an addition (details deleted) with the same digest (code review, point 7).
      retired: places.retired, added: places.added.map((a) => ({ slot: a.slot, participationType: a.participationType, raceDistanceId: a.raceDistanceId, isLead: a.isLead, replacesSlot: a.replacesSlot })),
    })));
    return {
      bookingId: b.id, reference: b.reference, customerId: b.customerId, packageId: b.packageId, currency: b.currency, fromVersion: b.currentSnapshotVersion,
      basis, current, places, breakdown, previousTotalMinor: snapshot.totalMinor, differenceMinor, driftMinor, changes, collectedMinor: facts.collectedMinor,
      digest, today, redeemedPromoCodeId: redemption?.promoCodeId ?? null, reasonCode,
    };
  }

  /** The price basis (decision 3): the latest change's, else the first snapshot's version and pricing instant. */
  private async basisOf(tx: Tx, bookingId: string, snapshots: Array<{ version: number; priceVersionId: string; priceBreakdown: unknown }>): Promise<AmendmentBasis> {
    const last = await tx.bookingAmendment.findFirst({ where: { bookingId }, orderBy: { toVersion: 'desc' }, select: { basisPriceVersionId: true, basisAt: true } });
    const redemption = await tx.promoRedemption.findFirst({ where: { bookingId, releasedAt: null }, select: { promoCodeId: true } });
    if (last) return { priceVersionId: last.basisPriceVersionId, at: last.basisAt, redeemedPromoCodeId: redemption?.promoCodeId ?? null };
    const first = snapshots.find((s) => s.version === 1)!;
    return { priceVersionId: first.priceVersionId, at: new Date((first.priceBreakdown as SnapshotBreakdown).computedAt), redeemedPromoCodeId: redemption?.promoCodeId ?? null };
  }

  private async writeParts(tx: Tx, e: Evaluation, to: number): Promise<void> {
    if (e.places.retired.length > 0) {
      await tx.bookingTraveller.updateMany({ where: { bookingId: e.bookingId, slot: { in: e.places.retired }, removedInVersion: null }, data: { removedInVersion: to } });
    }
    if (e.places.added.length > 0) {
      await tx.bookingTraveller.createMany({
        data: e.places.added.map((a) => ({ bookingId: e.bookingId, customerId: e.customerId, slot: a.slot, participationType: a.participationType, raceDistanceId: a.raceDistanceId, isLead: a.isLead, addedInVersion: to })),
      });
    }
    await tx.bookingRoom.updateMany({ where: { bookingId: e.bookingId, removedInVersion: null }, data: { removedInVersion: to } });
    await tx.bookingExtra.updateMany({ where: { bookingId: e.bookingId, removedInVersion: null }, data: { removedInVersion: to } });
    const c = e.breakdown.configuration;
    await tx.bookingRoom.createMany({ data: c.rooms.map((r) => ({ bookingId: e.bookingId, roomOptionId: r.roomOptionId, occupancy: r.occupancy, travellerSlots: r.travellers.map((t) => t.slot), addedInVersion: to })) });
    const extras = c.extras.flatMap((x): Prisma.BookingExtraCreateManyInput[] =>
      x.travellerSlots.length > 0 ? x.travellerSlots.map((s) => ({ bookingId: e.bookingId, extraId: x.extraId, quantity: 1, travellerSlot: s, addedInVersion: to })) : [{ bookingId: e.bookingId, extraId: x.extraId, quantity: x.quantity, travellerSlot: null, addedInVersion: to }],
    );
    if (extras.length > 0) await tx.bookingExtra.createMany({ data: extras });
  }

  /**
   * The stock the new configuration needs against what the booking holds, per pool in id order (the global lock order):
   * the net delta of each pool, the old claim released and a new one taken where the quantity changes. A pool without
   * room is a 409 and the transaction rolls back. Returns the places given back (plan review M5).
   */
  private async moveStock(tx: Tx, e: Evaluation, to: number, actor: AuditActor): Promise<number> {
    const demand = await this.inventory.demandFor(tx, { packageId: e.packageId, rooms: e.breakdown.configuration.rooms, extras: e.breakdown.configuration.extras });
    const held = await tx.inventoryClaim.findMany({ where: { bookingId: e.bookingId, status: 'held' }, select: { id: true, poolId: true, quantity: true } });
    const want = new Map(demand.map((d) => [d.poolId, d.quantity]));
    const have = new Map(held.map((h) => [h.poolId, h]));
    const pools = [...new Set([...want.keys(), ...have.keys()])].sort();
    let released = 0;
    for (const poolId of pools) {
      const now = want.get(poolId) ?? 0;
      const old = have.get(poolId);
      const delta = now - (old?.quantity ?? 0);
      if (delta === 0) continue;
      if (old) {
        const n = await tx.$executeRaw`UPDATE inventory_claims SET status = 'released', "releasedAt" = clock_timestamp() WHERE id = ${old.id}::uuid AND status = 'held'`;
        if (n !== 1) throw conflict('booking_state_changed', 'This booking changed. Reload and try again.');
      }
      if (now > 0) await tx.inventoryClaim.create({ data: { bookingId: e.bookingId, poolId, quantity: now, snapshotVersion: to } });
      if (delta > 0) await this.inventory.hold(tx, poolId, delta, { actor, bookingId: e.bookingId });
      else {
        await this.inventory.release(tx, poolId, -delta, { actor, bookingId: e.bookingId });
        released += -delta;
      }
    }
    return released;
  }

  private previewView(e: Evaluation, who: 'customer' | 'staff') {
    const { trace, ...rest } = e.breakdown;
    const price = who === 'staff' ? { ...rest, trace } : { ...rest, promo: { status: publicPromoStatus(rest.promo.status) } };
    return jsonOf({
      fromVersion: e.fromVersion,
      changes: e.changes,
      previousTotalMinor: e.previousTotalMinor,
      newTotalMinor: e.breakdown.totalMinor,
      priceDifferenceMinor: e.differenceMinor,
      collectedMinor: e.collectedMinor,
      outstandingAfterMinor: max0(e.breakdown.totalMinor - e.collectedMinor),
      creditPendingAfterMinor: max0(e.collectedMinor - e.breakdown.totalMinor),
      basisDriftMinor: e.driftMinor,
      currency: e.currency,
      departureDate: e.breakdown.departureDate,
      returnDate: e.breakdown.returnDate,
      retiredPlaces: e.places.retired,
      addedPlaces: e.places.added.map((a) => ({ slot: a.slot, participationType: a.participationType, raceDistanceId: a.raceDistanceId, replacesSlot: a.replacesSlot, isLead: a.isLead })),
      price,
      previewDigest: e.digest,
    });
  }

  /** A task for Oscar when the prices behind a sold booking changed (decision 4), in its own transaction, once per version. */
  private async openBasisTask(err: unknown, ref: BookingRef): Promise<void> {
    if (!(err instanceof ApiError) || !BASIS_ERRORS.has(err.code)) return;
    try {
      const b = await this.prisma.booking.findFirst({ where: 'id' in ref ? { id: ref.id } : { reference: ref.reference }, select: { id: true, reference: true, currentSnapshotVersion: true } });
      if (!b) return;
      await this.prisma.$transaction((tx) => this.tasks.createSystemIn(tx, {
        title: `Prices behind booking ${b.reference} have changed: it cannot be changed fairly`,
        description: 'A rule or a rate this booking was sold with was edited or removed, so re-pricing the booking as sold no longer gives its total. Check the price rules before changing it.',
        entityType: 'Booking', entityId: b.id, sourceRef: `bookings:amendment_basis_drift:${b.id}:v${b.currentSnapshotVersion}`,
      }));
    } catch (taskErr) {
      // Task 8.5 (S-10): a code only; an error message can carry values from the database.
      this.logger.error(`could not open the price basis task: ${safeError(taskErr).code}`);
    }
  }
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
