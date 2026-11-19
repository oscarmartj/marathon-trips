// Cancellations (task 6.4, plan docs/plans/6.4-cancellation-policies.md, sections 2, 4, 6 and 13). The penalty and the
// refund come from the pricing engine's pure calculation on the booking's frozen policy, its current snapshot and what
// payments says it holds; the booking is locked first (plan 0.1, 6.3: Booking → PromoCode → pools → Payment).
import { Inject, Injectable } from '@nestjs/common';
import type { CancellationQuoteView, CancellationView } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { canonicalJson, sha256Hex } from '../../platform/crypto/hmac';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { OutboxService } from '../../platform/events/outbox.service';
import { SettingsService } from '../../platform/flags/flags.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { IdempotencyService } from '../../platform/idempotency/idempotency.service';
import { CONTRACTED_STATES, CancellationPolicyService, PricingError, daysBetween, publicPolicyView, quoteCancellation, tierView } from '../pricing';
import type { CancellationQuote, FrozenCancellationPolicy } from '../pricing';
import { BookingCancellationHooks } from './cancellation-hooks';
import type { CancellationMoneyFacts } from './cancellation-hooks';
import { BOOKING_EVENTS } from './manifest';
import { CANCELLATION_SETTINGS } from './settings';
import { BookingStateMachine } from './state-machine';
import { todayInBrisbane } from './request.service';
import { Tx, dbNow } from './support';

/** A blocked request keeps its date this many days (plan section 13, M4). */
export const CANCELLATION_REQUEST_HOLD_DAYS = 14;
/** Transaction options: READ COMMITTED with short limits, like payments. */
const TX = { isolationLevel: 'ReadCommitted' as const, timeout: 15_000, maxWait: 5_000 };

/** Blocks that are money moving (decision 8): the first attempt is recorded and keeps its date. */
const MONEY_BLOCKS: ReadonlySet<string> = new Set(['cancellation_blocked_by_pending_payment', 'cancellation_blocked_by_refund_in_progress', 'cancellation_blocked_by_dispute']);

const MESSAGES: Record<string, string> = {
  transition_not_allowed: 'This booking cannot be cancelled in its current state',
  customer_cancellation_disabled: 'Cancelling online is not available. Contact us and we will help.',
  customer_cancellation_needs_staff: 'This booking is not confirmed yet. Contact us to cancel it.',
  customer_cancellation_rejected_until_policies_exist: 'This booking has no cancellation policy to apply online. Contact us to cancel it.',
  customer_cannot_cancel_after_departure: 'This trip has already started. Contact us.',
  cancellation_blocked_by_pending_payment: 'A payment for this booking is still being processed. We have noted your request and its date.',
  cancellation_blocked_by_refund_in_progress: 'A refund for this booking is still being processed. We have noted the request and its date.',
  cancellation_blocked_by_dispute: 'A payment of this booking is disputed. We have noted your request and its date; we will be in touch.',
};

export type CancelledBy = 'customer' | 'staff';

interface Loaded {
  id: string;
  reference: string;
  customerId: string;
  status: string;
  version: number;
  currency: string;
  currentSnapshotVersion: number;
  departureDate: string;
  totalMinor: bigint;
  configuration: { rooms?: Array<{ travellers?: unknown[] }> };
  cancellationPolicyId: string | null;
}

interface Computed {
  booking: Loaded;
  policy: FrozenCancellationPolicy | null;
  facts: CancellationMoneyFacts;
  today: string;
  effectiveDate: string;
  requestId: string | null;
  heldMinor: bigint;
  places: number;
  quote: CancellationQuote | null;
  blockedReason: string | null;
  digest: string;
}

class MoneyBlocked extends Error {
  constructor(readonly code: string, readonly digest: string, readonly businessDate: string) {
    super(code);
  }
}

@Injectable()
export class BookingCancellationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BookingStateMachine) private readonly machine: BookingStateMachine,
    @Inject(CancellationPolicyService) private readonly policies: CancellationPolicyService,
    @Inject(BookingCancellationHooks) private readonly hooks: BookingCancellationHooks,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  /** What cancelling now would do (read-only; the panel and the customer page show it as the API returns it). */
  async quote(where: { id: string } | { reference: string }, by: CancelledBy, opts: { operatorCancelled?: boolean } = {}): Promise<CancellationQuoteView> {
    const customerEnabled = by === 'customer' ? await this.customerEnabled() : true;
    return this.prisma.$transaction(async (tx) => {
      const b = await this.load(tx, where, false);
      if (!b) throw notFound('booking_not_found', 'Booking not found');
      return this.view(await this.compute(tx, b, by, !!opts.operatorCancelled, customerEnabled));
    }, TX);
  }

  /** The cancellation itself (section 6). Staff: step-up by the route's permission; the digest of the quote shown is required. */
  async cancelByStaff(id: string, input: { version: number; reason: string; quoteDigest: string; operatorCancelled: boolean }, actor: AuditActor): Promise<CancellationView> {
    return this.cancel({ id }, 'staff', { ...input }, actor);
  }

  /** The customer's own cancellation, once per Idempotency-Key; a replay answers the cancellation as it stands. */
  async cancelByCustomer(reference: string, input: { quoteDigest: string }, key: string, actor: AuditActor): Promise<{ created: boolean; cancellation: CancellationView }> {
    const outcome = await this.idempotency.run({
      actorType: 'customer', actorId: actor.id!, route: 'POST /account/bookings/:reference/cancel', key, body: { reference, quoteDigest: input.quoteDigest },
    }, async () => {
      const c = await this.cancel({ reference }, 'customer', { quoteDigest: input.quoteDigest, operatorCancelled: false, reason: 'Cancelled by the customer online' }, actor);
      return { status: 201, resourceType: 'Cancellation', resourceId: c.id };
    });
    return { created: !outcome.replayed, cancellation: await this.get(outcome.result.resourceId!) };
  }

  async get(id: string): Promise<CancellationView> {
    const c = await this.prisma.cancellation.findUnique({ where: { id } });
    if (!c) throw notFound('cancellation_not_found', 'Cancellation not found');
    return cancellationView(c);
  }

  async forBooking(bookingId: string): Promise<CancellationView | null> {
    const c = await this.prisma.cancellation.findUnique({ where: { bookingId } });
    return c ? cancellationView(c) : null;
  }

  private async cancel(where: { id: string } | { reference: string }, by: CancelledBy, input: { version?: number; reason: string; quoteDigest: string; operatorCancelled: boolean }, actor: AuditActor): Promise<CancellationView> {
    const customerEnabled = by === 'customer' ? await this.customerEnabled() : true;
    try {
      const id = await runTransaction(this.prisma, (tx) => this.cancelIn(tx, where, by, input, actor, customerEnabled), TX);
      return this.get(id);
    } catch (err) {
      if (!(err instanceof MoneyBlocked)) throw err;
      // Section 13, M4: the first refused attempt is recorded in its own transaction, then the 409 stands.
      await runTransaction(this.prisma, (tx) => this.recordRequest(tx, where, by, err, actor), TX);
      throw conflict(err.code, MESSAGES[err.code] ?? 'This booking cannot be cancelled right now');
    }
  }

  private async cancelIn(tx: Tx, where: { id: string } | { reference: string }, by: CancelledBy, input: { version?: number; reason: string; quoteDigest: string; operatorCancelled: boolean }, actor: AuditActor, customerEnabled: boolean): Promise<string> {
    const b = await this.load(tx, where, true);
    if (!b) throw notFound('booking_not_found', 'Booking not found');
    // The state first (as the state machine answers it), then the version the panel read.
    if (!['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid'].includes(b.status)) throw conflict('transition_not_allowed', MESSAGES.transition_not_allowed!);
    if (input.version !== undefined && input.version !== b.version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
    if (input.operatorCancelled && by !== 'staff') throw conflict('transition_not_allowed', MESSAGES.transition_not_allowed!);
    const c = await this.compute(tx, b, by, input.operatorCancelled, customerEnabled);
    if (c.blockedReason) {
      if (MONEY_BLOCKS.has(c.blockedReason)) throw new MoneyBlocked(c.blockedReason, c.digest, c.today);
      throw conflict(c.blockedReason, MESSAGES[c.blockedReason] ?? 'This booking cannot be cancelled');
    }
    if (c.digest !== input.quoteDigest) throw conflict('cancellation_quote_changed', 'What cancelling this booking means has changed since it was shown. Look at it again.');
    const q = c.quote!;
    const [row] = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO cancellations (id, "bookingId", currency, "requestedBy", "requestedById", "bookingStatus", "snapshotVersion", basis, "cancellationPolicyId", "cancellationRequestId",
        "businessDate", "processedDate", "daysBeforeDeparture", "tierMinDays", "policySnapshot", "baseTotalMinor", places, "collectedMinor", "policyPenaltyMinor", "penaltyMinor", "waivedMinor", "refundableMinor")
      VALUES (gen_random_uuid(), ${b.id}::uuid, ${b.currency}, ${by}::"CancellationRequestedBy", ${actor.id}::uuid, ${b.status}::"BookingStatus", ${b.currentSnapshotVersion}, ${q.basis}::"CancellationBasis",
        ${q.basis === 'policy' ? c.policy!.id : null}::uuid, ${c.requestId}::uuid, ${c.effectiveDate}::date, ${c.today}::date, ${q.daysBeforeDeparture}, ${q.tier?.minDaysBeforeDeparture ?? null}::int,
        ${JSON.stringify(policySnapshot(c))}::jsonb, ${b.totalMinor}, ${c.places}, ${c.heldMinor}, ${q.policyPenaltyMinor}, ${q.penaltyMinor}, ${q.waivedMinor}, ${q.refundableMinor})
      ON CONFLICT ("bookingId") DO NOTHING RETURNING id::text AS id`;
    if (!row) throw conflict('already_cancelled', 'This booking is already cancelled');
    await this.machine.transition(tx, b.id, 'cancel', { actor, reason: input.reason, cancellation: { id: row.id, penaltyMinor: q.penaltyMinor, dueDate: c.today } });
    await this.audit.record(tx, {
      actor, action: 'bookings.cancellation.recorded', entityType: 'Booking', entityId: b.id, model: 'Booking', reason: input.reason,
      after: { cancellationId: row.id, basis: q.basis, requestedBy: by, businessDate: c.effectiveDate, daysBeforeDeparture: q.daysBeforeDeparture, tierMinDays: q.tier?.minDaysBeforeDeparture ?? null,
        policyPenaltyMinor: q.policyPenaltyMinor.toString(), penaltyMinor: q.penaltyMinor.toString(), waivedMinor: q.waivedMinor.toString(), refundableMinor: q.refundableMinor.toString(), currency: b.currency },
      fieldClasses: { cancellationId: 'nopii', basis: 'nopii', requestedBy: 'nopii', businessDate: 'nopii', daysBeforeDeparture: 'nopii', tierMinDays: 'nopii', policyPenaltyMinor: 'nopii', penaltyMinor: 'nopii', waivedMinor: 'nopii', refundableMinor: 'nopii', currency: 'nopii' },
    });
    await this.outbox.publish(tx, {
      type: BOOKING_EVENTS.cancellationRecorded, aggregateType: 'Booking', aggregateId: b.id, aggregateVersion: b.version + 1,
      payload: { bookingId: b.id, cancellationId: row.id, basis: q.basis }, actorType: actor.type, actorId: actor.id ?? undefined,
    });
    if (q.refundableMinor > 0n) {
      await this.tasks.createSystemIn(tx, {
        title: `Refund due on booking ${b.reference} (cancellation)`,
        description: `The booking was cancelled (${q.basis}). Refund ${formatMinor(q.refundableMinor, b.currency)} from the booking page, as a cancellation refund.`,
        entityType: 'Booking', entityId: b.id, sourceRef: `bookings:cancellation_refund_due:${b.id}`,
      });
    }
    return row.id;
  }

  /**
   * An attempt refused while money was moving (M4; review of the code, 2). Inside the window of the latest request it
   * changes nothing but the task, which is opened again if someone closed it; past that window it starts a new request,
   * with today's date. Every refused attempt has an open task for Oscar.
   */
  private async recordRequest(tx: Tx, where: { id: string } | { reference: string }, by: CancelledBy, blocked: MoneyBlocked, actor: AuditActor): Promise<void> {
    const b = await this.load(tx, where, true);
    if (!b || !['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid'].includes(b.status)) return;
    const active = await this.activeRequest(tx, b.id, blocked.businessDate);
    let date = active?.date ?? blocked.businessDate;
    if (!active) {
      const [row] = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO cancellation_requests (id, "bookingId", "requestedBy", "requestedById", "businessDate", "blockedReason", "quoteDigest")
        VALUES (gen_random_uuid(), ${b.id}::uuid, ${by}::"CancellationRequestedBy", ${actor.id}::uuid, ${blocked.businessDate}::date, ${blocked.code}, ${blocked.digest})
        ON CONFLICT ("bookingId", "businessDate") DO NOTHING RETURNING id::text AS id`;
      date = blocked.businessDate;
      if (row) {
        await this.audit.record(tx, {
          actor, action: 'bookings.cancellation.requested', entityType: 'Booking', entityId: b.id, model: 'Booking',
          after: { cancellationRequestId: row.id, requestedBy: by, businessDate: blocked.businessDate, blockedReason: blocked.code },
          fieldClasses: { cancellationRequestId: 'nopii', requestedBy: 'nopii', businessDate: 'nopii', blockedReason: 'nopii' },
        });
      }
    }
    await this.tasks.createSystemIn(tx, {
      title: `Cancellation requested on booking ${b.reference}`,
      description: `A cancellation was asked for on ${date} but could not go ahead (${blocked.code}). Its tier holds until ${CANCELLATION_REQUEST_HOLD_DAYS} days after that date: settle what is in progress and cancel it.`,
      entityType: 'Booking', entityId: b.id, sourceRef: `bookings:cancellation_requested:${b.id}:${date}`,
    });
  }

  /** The latest blocked request of a booking whose date still holds on `today` (within the window), or none. */
  private async activeRequest(tx: Tx, bookingId: string, today: string): Promise<{ id: string; date: string } | null> {
    const req = await tx.cancellationRequest.findFirst({ where: { bookingId }, orderBy: { businessDate: 'desc' }, select: { id: true, businessDate: true } });
    if (!req) return null;
    const date = req.businessDate.toISOString().slice(0, 10);
    return daysBetween(date, today) <= CANCELLATION_REQUEST_HOLD_DAYS ? { id: req.id, date } : null;
  }

  private async compute(tx: Tx, b: Loaded, by: CancelledBy, operatorCancelled: boolean, customerEnabled: boolean): Promise<Computed> {
    const policy = await this.policies.frozen(tx, b.cancellationPolicyId);
    const facts = await this.hooks.money.facts(tx, b.id);
    const today = todayInBrisbane(await dbNow(tx));
    const req = await this.activeRequest(tx, b.id, today);
    const effectiveDate = req ? req.date : today;
    const heldMinor = facts.collectedMinor - facts.disputedMinor;
    // Places of the current snapshot: its configuration's travellers (runners and supporters alike, decision 12).
    const places = (b.configuration.rooms ?? []).reduce((n, r) => n + (r.travellers?.length ?? 0), 0);
    const cancellable = ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid'].includes(b.status);
    let quote: CancellationQuote | null = null;
    try {
      quote = cancellable ? quoteCancellation({
        policy, status: b.status, operatorCancelled, departureDate: b.departureDate, effectiveDate, baseTotalMinor: b.totalMinor, places, currency: b.currency, heldMinor,
      }) : null;
    } catch (err) {
      // Fails closed (plan section 9): a policy that cannot be applied to this booking is a 409, never a guess.
      if (err instanceof PricingError) throw conflict(err.code, 'The cancellation policy of this booking cannot be applied. Contact us.');
      throw err;
    }

    let blockedReason: string | null = null;
    if (!cancellable) blockedReason = 'transition_not_allowed';
    else if (by === 'customer') {
      if (!customerEnabled) blockedReason = 'customer_cancellation_disabled';
      else if (!CONTRACTED_STATES.includes(b.status)) blockedReason = 'customer_cancellation_needs_staff';
      else if (!policy) blockedReason = 'customer_cancellation_rejected_until_policies_exist';
      else if (b.departureDate < today) blockedReason = 'customer_cannot_cancel_after_departure';
    }
    if (!blockedReason) {
      if (facts.pendingDebit) blockedReason = 'cancellation_blocked_by_pending_payment';
      else if (facts.refundInFlight) blockedReason = 'cancellation_blocked_by_refund_in_progress';
      else if (facts.disputeOpen && by === 'customer') blockedReason = 'cancellation_blocked_by_dispute';
    }
    const digest = sha256Hex(canonicalJson({
      bookingId: b.id, version: b.version, snapshotVersion: b.currentSnapshotVersion, effectiveDate, operatorCancelled,
      basis: quote?.basis ?? null, tier: quote?.tier?.minDaysBeforeDeparture ?? null, policy: policy?.digest ?? null, held: heldMinor.toString(),
      policyPenalty: quote?.policyPenaltyMinor.toString() ?? null, penalty: quote?.penaltyMinor.toString() ?? null, refundable: quote?.refundableMinor.toString() ?? null,
    }));
    return { booking: b, policy, facts, today, effectiveDate, requestId: req ? req.id : null, heldMinor, places, quote, blockedReason, digest };
  }

  private view(c: Computed): CancellationQuoteView {
    const q = c.quote;
    return {
      bookingId: c.booking.id, currency: c.booking.currency, basis: q?.basis ?? 'not_contracted', effectiveDate: c.effectiveDate,
      daysBeforeDeparture: q?.daysBeforeDeparture ?? daysBetween(c.effectiveDate, c.booking.departureDate),
      tier: q?.tier ? tierView(q.tier) : null, policy: c.policy ? publicPolicyView(c.policy) : null,
      heldMinor: c.heldMinor.toString(), policyPenaltyMinor: (q?.policyPenaltyMinor ?? 0n).toString(), penaltyMinor: (q?.penaltyMinor ?? 0n).toString(),
      waivedMinor: (q?.waivedMinor ?? 0n).toString(), refundableMinor: (q?.refundableMinor ?? 0n).toString(),
      blockedReason: c.blockedReason, quoteDigest: c.digest,
    };
  }

  private async load(tx: Tx, where: { id: string } | { reference: string }, lock: boolean): Promise<Loaded | null> {
    // The booking row is locked on its own first (as read.ts does): a join locked with it would re-check an old snapshot.
    const id = 'id' in where
      ? where.id
      : (await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM bookings WHERE reference = ${where.reference}`)[0]?.id;
    if (!id) return null;
    if (lock) await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${id}::uuid FOR UPDATE`;
    const rows = await tx.$queryRaw<Array<Omit<Loaded, 'departureDate'> & { departureDate: Date }>>`
      SELECT b.id::text AS id, b.reference, b."customerId"::text AS "customerId", b.status::text AS status, b.version, b.currency, b."currentSnapshotVersion",
             b."departureDate", s."totalMinor", s.configuration, s."cancellationPolicyId"::text AS "cancellationPolicyId"
        FROM bookings b JOIN booking_snapshots s ON s."bookingId" = b.id AND s.version = b."currentSnapshotVersion"
       WHERE b.id = ${id}::uuid`;
    const r = rows[0];
    return r ? { ...r, departureDate: r.departureDate.toISOString().slice(0, 10) } : null;
  }

  private customerEnabled(): Promise<boolean> {
    return this.settings.get(CANCELLATION_SETTINGS.customerEnabled.key, CANCELLATION_SETTINGS.customerEnabled.fallback);
  }
}

/** The policy as applied: ids, thresholds, modes and amounts only (no free text reaches the immutable row). */
function policySnapshot(c: Computed): Record<string, unknown> {
  const q = c.quote!;
  return {
    policyId: c.policy?.id ?? null, digest: c.policy?.digest ?? null, currency: c.policy?.currency ?? null,
    tiers: (c.policy?.tiers ?? []).map((t) => ({ id: t.id, ...tierView(t) })),
    tierId: q.tier?.id ?? null, effectiveDate: c.effectiveDate, processedDate: c.today, heldMinor: c.heldMinor.toString(),
    disputedMinor: c.facts.disputedMinor.toString(), departureDate: c.booking.departureDate,
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function cancellationView(c: Prisma.CancellationGetPayload<object>): CancellationView {
  return {
    id: c.id, requestedBy: c.requestedBy, basis: c.basis, businessDate: ymd(c.businessDate), processedDate: ymd(c.processedDate),
    daysBeforeDeparture: c.daysBeforeDeparture, tierMinDays: c.tierMinDays, currency: c.currency, baseTotalMinor: c.baseTotalMinor.toString(),
    collectedMinor: c.collectedMinor.toString(), policyPenaltyMinor: c.policyPenaltyMinor.toString(), penaltyMinor: c.penaltyMinor.toString(),
    waivedMinor: c.waivedMinor.toString(), refundableMinor: c.refundableMinor.toString(), createdAt: c.createdAt.toISOString(),
  };
}

/** For a task's text only (staff read it); screens format amounts themselves from the API's strings. */
function formatMinor(minor: bigint, currency: string): string {
  const s = minor.toString().padStart(3, '0');
  return `${currency} ${s.slice(0, -2)}.${s.slice(-2)}`;
}

