import { Inject, Injectable } from '@nestjs/common';
import type { AccountPaymentRecord, PaymentAttemptView, PaymentMethod, PaymentPlanView, StartPayment } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import type { AppConfig } from '../../../platform/config/config';
import { bossDb } from '../../../platform/database/boss-db';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { OutboxService } from '../../../platform/events/outbox.service';
import { ApiError, conflict, notFound, unprocessable } from '../../../platform/http/api-error';
import { IdempotencyInProgressError, IdempotencyKeyReuseError, IdempotencyService } from '../../../platform/idempotency/idempotency.service';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { SettingsService } from '../../../platform/flags/flags.service';
import { readBookingForPayments } from '../../bookings';
import type { BookingForPayments, LockedBooking } from '../../bookings';
import { LIVE_STATUSES, LockedPayment, PAYMENT_EVENTS, PaymentStateMachine, lockPayment } from './attempt-state';
import { ProviderGateway } from './gateway';
import { allocate } from './allocation';
import { payable, succeededPaymentsSource } from './payable';
import type { ProviderPayment } from './provider';
import { ProviderError } from './provider';
import { CoverageFailedError } from './coverage.service';
import { PaymentRouting } from './routing';
import { TermsService } from './terms.service';
import { PAYABLE_STATES, PAYMENT_TX_OPTIONS } from './payable-states';
import { PAYMENT_SETTINGS } from './settings';

type Tx = Prisma.TransactionClient;

export { PAYABLE_STATES, PAYMENT_TX_OPTIONS };

const ENDED_WITHOUT_MONEY: readonly string[] = ['failed', 'cancelled', 'expired'];

/** The outcome of replacing a live attempt (plan 3.2, section 4). */
export type ReplaceOutcome = 'replaced' | 'recorded' | 'unresolved';

/** Transaction A found a live attempt the customer asked to replace; nothing was written. */
class ReplacementNeeded extends Error {
  constructor(readonly paymentId: string, readonly collectedMinor: bigint) {
    super('replacement needed');
  }
}

/** The idempotency record's answer when a replacement revealed money already in. */
const ALREADY_RECORDED = 'PaymentAlreadyRecorded';

const alreadyRecorded = () => conflict('payment_already_recorded', 'A payment for this booking has just been recorded. Check the booking before paying again.');

const busy = () => conflict('busy_try_again', 'Many people are doing this at once. Try again.');

function mapLoadError(err: unknown): unknown {
  if (err instanceof Error && !(err instanceof ApiError) && /P2024|P2028|Transaction already closed|Unable to start a transaction in the given time/.test(err.message)) return busy();
  return err;
}

const providerUnavailable = () => new ApiError(503, 'provider_unavailable', 'The payment service is not answering. Try again in a moment.', { 'Retry-After': '30' });

/**
 * Payment attempts (plan 3.1, section 5): created or resumed in transaction A with the booking locked, then the
 * gateway is called outside any transaction with our idempotency key, then transaction B records what it said, with
 * the booking and the payment locked in that order.
 */
@Injectable()
export class PaymentAttemptsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentRouting) private readonly routing: PaymentRouting,
    @Inject(PaymentStateMachine) private readonly machine: PaymentStateMachine,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(TermsService) private readonly terms: TermsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---- Customer: the plan ----

  async planView(reference: string): Promise<PaymentPlanView> {
    const b = await readBookingForPayments(this.prisma, { reference });
    if (!b) throw notFound();
    const items = await this.prisma.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, orderBy: { sequence: 'asc' }, select: { kind: true, sequence: true, amountMinor: true, dueDate: true } });
    const collected = await succeededPaymentsSource.collected(this.prisma, b.id, this.gateway.mode);
    const p = payable(items, collected);
    const split = allocate(items, collected);
    const paid = new Map(split.items.map((i) => [i.sequence, i.paidMinor]));
    const methods = await this.routing.methods(this.prisma, { currency: b.currency, country: b.residenceCountry });
    const live = await this.prisma.payment.findUnique({ where: { liveBookingId: b.id }, select: { status: true, method: true, amountMinor: true, currency: true } });
    const reason = b.status === 'balance_paid' ? 'nothing_to_pay' : !PAYABLE_STATES.includes(b.status) ? 'booking_not_payable'
      : b.status === 'approved' && b.approvalExpiresAt && b.approvalExpiresAt.getTime() <= Date.now() ? 'approval_expired'
        : !p.next ? 'nothing_to_pay'
          : methods.length === 0 ? 'no_payment_method_available' : undefined;
    return {
      reference: b.reference, currency: b.currency, payable: reason === undefined, ...(reason ? { notPayableReason: reason } : {}),
      items: items.map((i) => ({ kind: i.kind, sequence: i.sequence, amountMinor: i.amountMinor.toString(), dueDate: i.dueDate.toISOString().slice(0, 10), paidMinor: (paid.get(i.sequence) ?? 0n).toString() })),
      collectedMinor: p.collectedMinor.toString(), outstandingMinor: p.outstandingMinor.toString(), overpaidMinor: split.overpaidMinor.toString(),
      // The deposit date is a Brisbane day, but the approval ends at this instant (plan 3.2, section 11, point 2).
      depositDueBy: b.status === 'approved' && b.approvalExpiresAt ? b.approvalExpiresAt.toISOString() : null,
      nextPayable: p.next ? { sequence: p.next.sequence, amountMinor: p.next.amountMinor.toString() } : null,
      methods,
      liveAttempt: live ? { status: live.status, method: live.method, amountMinor: live.amountMinor.toString(), currency: live.currency } : null,
    };
  }

  /**
   * The payments a customer sees in their account (task 5.1): the attempts of the booking that succeeded in this
   * environment's mode, oldest first. A record of money received, not a receipt: no ids, references or failure codes.
   */
  async paymentRecords(reference: string): Promise<AccountPaymentRecord[]> {
    const rows = await this.prisma.payment.findMany({
      where: { booking: { reference }, mode: this.gateway.mode, status: 'succeeded' }, orderBy: [{ succeededAt: 'asc' }, { attemptNumber: 'asc' }],
      select: { succeededAt: true, amountMinor: true, currency: true, method: true },
    });
    return rows.map((r) => ({ succeededAt: r.succeededAt!.toISOString(), amountMinor: r.amountMinor.toString(), currency: r.currency, method: r.method as PaymentMethod }));
  }

  // ---- Customer: start (or resume) a payment ----

  async start(user: { id: string }, reference: string, body: StartPayment, key: string, actor: AuditActor): Promise<PaymentAttemptView> {
    const booking = await readBookingForPayments(this.prisma, { reference });
    if (!booking) throw notFound();
    // The route of the record carries the booking id, so one key on two bookings is two records (plan 3.1, 14.4).
    return this.startWith(booking, { actorType: 'customer', actorId: user.id, route: `POST /booking-requests/${booking.id}/payments` }, body, body, key, actor, null);
  }

  /**
   * A payment through a payment link (task 5.1, plan section 5). The link's holder has no session: the idempotency
   * record belongs to the token (its hash) and the link, the amount is the plan's up to the link's target item, and the
   * terms must already have been accepted by the signed-in customer. Nothing here accepts terms or replaces an attempt.
   */
  async startViaLink(link: { id: string; bookingId: string; tokenHash: string; targetSequence: number }, method: StartPayment['method'], key: string): Promise<PaymentAttemptView> {
    const booking = await readBookingForPayments(this.prisma, { id: link.bookingId });
    if (!booking) throw notFound();
    const actor: AuditActor = { type: 'payment_link', id: link.id };
    return this.startWith(booking, { actorType: 'token', actorId: link.tokenHash, route: `POST /payment-links/${link.id}/payments` }, { method }, { method, upToSequence: link.targetSequence }, key, actor, link.id);
  }

  private async startWith(
    booking: BookingForPayments, record: { actorType: 'customer' | 'token'; actorId: string; route: string }, recordBody: object, body: StartPayment,
    key: string, actor: AuditActor, viaLink: string | null,
  ): Promise<PaymentAttemptView> {
    const outcome = await this.idempotency.run({ ...record, key, body: recordBody }, async () => {
      try {
        // The current booking terms must have been accepted (task 3.5). Inside the record, so a retry of a payment that
        // was already created replays it even if the terms changed since; a refusal deletes the record: nothing stored.
        // A booking that cannot take a payment at all keeps its own error (booking_not_payable and the like).
        if (PAYABLE_STATES.includes(booking.status)) await this.terms.assertAccepted(booking.id);
        const paymentId = await this.createOrReplace(booking.id, body, actor, viaLink);
        return { status: 201, resourceType: 'Payment', resourceId: paymentId };
      } catch (err) {
        // Stored as this key's answer, so a retry with the same key and body never pays the next item (review, point 4).
        if (err instanceof ApiError && err.code === 'payment_already_recorded') return { status: 409, resourceType: ALREADY_RECORDED };
        throw err;
      }
    }).catch((err: unknown) => {
      if (err instanceof IdempotencyKeyReuseError) throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');
      if (err instanceof IdempotencyInProgressError) throw conflict('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed');
      throw err;
    });
    if (outcome.result.resourceType === ALREADY_RECORDED) throw alreadyRecorded();
    const payment = await this.prisma.payment.findUnique({ where: { id: outcome.result.resourceId! }, select: { id: true, bookingId: true } });
    if (!payment || payment.bookingId !== booking.id) throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request');
    const nextAction = await this.drive(payment.id);
    return this.attemptView(payment.id, nextAction);
  }

  /** The sync service's replacement of a live attempt (registered by it: the two services need each other). */
  private replacer?: (paymentId: string) => Promise<ReplaceOutcome>;

  useReplacer(fn: (paymentId: string) => Promise<ReplaceOutcome>): void {
    this.replacer = fn;
  }

  /**
   * Transaction A, and with `replaceLiveAttempt` the replacement of P2 (plan 3.2, sections 4 and 11.1): the live attempt
   * is ended only once the gateway confirms its cancellation, and transaction A runs once more. If that showed money
   * came in, or anything was collected between the two, nothing new is created: the customer did not ask for that item.
   */
  async createOrReplace(bookingId: string, body: StartPayment, actor: AuditActor, viaLink: string | null = null): Promise<string> {
    try {
      return await this.createOrResume(bookingId, body, actor, undefined, viaLink);
    } catch (err) {
      if (!(err instanceof ReplacementNeeded)) throw err;
      if (!this.replacer) throw conflict('payment_attempt_in_progress', 'A payment for this booking is already in progress');
      let outcome: ReplaceOutcome;
      try {
        outcome = await this.replacer(err.paymentId);
      } catch (e) {
        throw this.forCustomer(e);
      }
      if (outcome === 'recorded') throw alreadyRecorded();
      if (outcome !== 'replaced') throw conflict('payment_attempt_in_progress', 'A payment for this booking is still being processed. Try again shortly.');
      return this.createOrResume(bookingId, body, actor, { expectCollected: err.collectedMinor }, viaLink);
    }
  }

  /** Transaction A (plan 3.1, section 5.1). Returns the id of a new or resumed live attempt. */
  async createOrResume(bookingId: string, body: StartPayment, actor: AuditActor, again?: { expectCollected: bigint }, viaLink: string | null = null): Promise<string> {
    const expiryMinutes = await this.settings.get(PAYMENT_SETTINGS.attemptExpiryMinutes.key, PAYMENT_SETTINGS.attemptExpiryMinutes.fallback);
    let result: string | { expiredLive: string };
    try {
      result = await runTransaction(this.prisma, async (tx): Promise<string | { expiredLive: string }> => {
        const b = await readBookingForPayments(tx, { id: bookingId }, true);
        if (!b) throw notFound();
        const [{ at }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at` as [{ at: Date }];
        this.assertPayable(b, at);
        // Through a link: the link must still be active and in date, checked with the booking locked (Booking → PaymentLink).
        // Its target must still be an active item of the plan, at the sequence the caller pays up to: a regenerated plan
        // (superseded items) makes the link not found (review round 1, point 2).
        if (viaLink) {
          const link = await tx.$queryRaw<Array<{ ok: boolean }>>`
            SELECT (l.status = 'active' AND l."expiresAt" > ${at} AND i.state = 'active' AND i.sequence = ${body.upToSequence ?? -1}) AS ok
            FROM payment_links l JOIN payment_schedule_items i ON i.id = l."targetScheduleItemId" AND i."bookingId" = l."bookingId"
            WHERE l.id = ${viaLink}::uuid AND l."bookingId" = ${b.id}::uuid FOR UPDATE OF l`;
          if (!link[0]?.ok) throw notFound('payment_link_not_found', 'This payment link is not valid');
        }
        const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { id: true, sequence: true, amountMinor: true } });
        if (body.upToSequence !== undefined && !items.some((i) => i.sequence === body.upToSequence)) throw unprocessable('unknown_plan_item', 'There is no such item in the payment plan');
        const collected = await succeededPaymentsSource.collected(tx, b.id, this.gateway.mode);
        if (again && collected !== again.expectCollected) throw alreadyRecorded();
        const due = payable(items, collected, body.upToSequence).next;
        if (!due) throw conflict('nothing_to_pay', 'There is nothing to pay on this booking right now');

        const accounts = await this.routing.candidates(tx, { method: body.method, currency: b.currency, country: b.residenceCountry });
        const live = await tx.$queryRaw<Array<{ id: string; status: string; method: string; amountMinor: bigint; pendingExpiresAt: Date; providerAccountId: string; paymentLinkId: string | null }>>`
          SELECT id::text AS id, status::text AS status, method::text AS method, "amountMinor", "pendingExpiresAt", "providerAccountId"::text AS "providerAccountId",
                 "paymentLinkId"::text AS "paymentLinkId"
          FROM payments WHERE "liveBookingId" = ${b.id}::uuid FOR UPDATE`;
        const current = live[0];
        if (current) {
          // Past its expiry but not swept yet: not resumable; its sweep is queued after this transaction (plan 3.1, 14.9).
          if (current.pendingExpiresAt.getTime() <= at.getTime()) return { expiredLive: current.id };
          // Resumed only with the same account (still able to take charges), method and amount (plan 3.1, 5.1).
          const sameAccount = accounts.some((a) => a.id === current.providerAccountId);
          // Never across paths (task 5.1, review G2): checkout resumes only its own attempts and a link only the attempts it
          // started, so the return address and the holder always match the attempt.
          const samePath = (current.paymentLinkId ?? null) === viaLink;
          if (samePath && current.status !== 'pending' && sameAccount && current.method === body.method && current.amountMinor === due.amountMinor) return current.id;
          // P2: replaced only on request, never a pending debit, and once only (plan 3.2, section 4).
          if (body.replaceLiveAttempt && !again && current.status !== 'pending') throw new ReplacementNeeded(current.id, collected);
          throw conflict('payment_attempt_in_progress', 'A payment for this booking is already in progress');
        }

        const account = accounts[0];
        if (!account) throw conflict('no_payment_method_available', 'This payment method is not available for this booking right now');
        const last = await tx.payment.aggregate({ where: { bookingId: b.id }, _max: { attemptNumber: true } });
        const n = (last._max.attemptNumber ?? 0) + 1;
        const target = items.find((i) => i.sequence === due.sequence)!;
        const created = await tx.payment.create({
          data: {
            bookingId: b.id, currency: b.currency, origin: 'collection', attemptNumber: n, targetScheduleItemId: target.id, payerCustomerId: b.customerId,
            providerAccountId: account.id, mode: account.mode, adapterKey: account.adapterKey, method: body.method, amountMinor: due.amountMinor,
            status: 'created', liveBookingId: b.id, idempotencyKey: `booking:${b.id}:attempt:${n}`, paymentLinkId: viaLink,
            pendingExpiresAt: new Date(at.getTime() + expiryMinutes * 60_000),
          },
          select: { id: true },
        });
        await this.audit.record(tx, {
          actor, action: 'payments.payment.created', entityType: 'Payment', entityId: created.id, model: 'Payment',
          after: { status: 'created', method: body.method, amountMinor: due.amountMinor.toString(), currency: b.currency, attemptNumber: n },
          context: { bookingId: b.id, upToSequence: due.sequence },
        });
        await this.outbox.publish(tx, { type: PAYMENT_EVENTS.created, aggregateType: 'Payment', aggregateId: created.id, aggregateVersion: 0, payload: { paymentId: created.id, bookingId: b.id }, actorType: actor.type, actorId: actor.id ?? undefined });
        return created.id;
      }, PAYMENT_TX_OPTIONS);
    } catch (err) {
      throw mapLoadError(err);
    }
    if (typeof result === 'string') return result;
    await this.jobs.send(QUEUES.paymentsAttempts, { paymentId: result.expiredLive, action: 'expire' }, { singletonKey: `expire:${result.expiredLive}` });
    throw conflict('payment_attempt_in_progress', 'A payment for this booking is still being processed. Try again shortly.');
  }

  /** Back to the page of the path the attempt was started on: a link's holder may have no session (review G2). */
  returnUrlOf(p: { paymentLinkId: string | null; booking: { reference: string } }): string {
    return p.paymentLinkId ? `${this.config.WEB_ORIGIN}/pay/return` : `${this.config.WEB_ORIGIN}/payments/return?ref=${p.booking.reference}`;
  }

  private assertPayable(b: BookingForPayments, at: Date): void {
    // Paid in full (plan 0.1, 6.2: "409, nothing outstanding"): say so rather than "not payable".
    if (b.status === 'balance_paid') throw conflict('nothing_to_pay', 'There is nothing to pay on this booking right now');
    if (!PAYABLE_STATES.includes(b.status)) throw conflict('booking_not_payable', 'This booking cannot take a payment in its current state');
    if (b.status === 'approved' && (!b.approvalExpiresAt || b.approvalExpiresAt.getTime() <= at.getTime())) throw conflict('approval_expired', 'The time to pay the deposit for this booking has run out');
  }

  /**
   * Calls the gateway for a live attempt (create with our key if it has no reference yet, otherwise retrieve) and
   * records the answer in transaction B. Returns the redirect only if the booking can still pay and the attempt is
   * still waiting for the customer (plan 3.1, 14.10).
   */
  async drive(paymentId: string): Promise<{ type: 'redirect'; url: string } | undefined> {
    const p = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { id: true, bookingId: true, paymentLinkId: true, booking: { select: { reference: true } }, status: true, adapterKey: true, providerAccountId: true, providerPaymentRef: true, idempotencyKey: true, amountMinor: true, currency: true, method: true, createdAt: true, payerCustomer: { select: { countryOfResidence: true } } },
    });
    if (!LIVE_STATUSES.includes(p.status)) return undefined;
    let remote: ProviderPayment | null;
    if (p.providerPaymentRef) {
      // The object exists at the gateway: an error reading it never ends the attempt (plan 3.1, 14.3; review G1).
      try {
        remote = await this.gateway.call(p.providerAccountId, 'retrieve', (provider, ctx) => provider.retrievePayment(ctx, { ref: p.providerPaymentRef! }));
      } catch (err) {
        throw this.forCustomer(err);
      }
    } else {
      try {
        remote = await this.gateway.call(p.providerAccountId, 'create', (provider, ctx) => provider.createPayment(ctx, {
          amount: { amountMinor: p.amountMinor, currency: p.currency }, method: p.method, idempotencyKey: p.idempotencyKey,
          metadata: { paymentId: p.id, bookingId: p.bookingId }, returnUrl: this.returnUrlOf(p), customerCountry: p.payerCustomer.countryOfResidence,
          // Always the row's (plan 3.3, 12.5): every retry under this key sends the same parameters.
          createdAt: p.createdAt,
        }));
      } catch (err) {
        if (!(err instanceof ProviderError)) throw this.forCustomer(err);
        if (err.retryable) throw providerUnavailable();
        remote = await this.lookupAfterRefusal(p.providerAccountId, p.idempotencyKey, p.createdAt);
        if (remote === null) {
          // The gateway refused and holds no object under our key: nothing can be charged; a new attempt may start.
          await this.record(p.id, null, 'api', err.code);
          return undefined;
        }
      }
    }
    if (!remote) return undefined;
    const ok = await this.record(p.id, remote, 'api');
    const url = remote.nextAction?.url;
    const origin = this.gateway.registry.get(p.adapterKey)?.manifest.checkoutOrigin;
    if (!ok || !url || !origin || !url.startsWith(`${origin}/`)) return undefined;
    return { type: 'redirect', url };
  }

  /**
   * After a definitive refusal of createPayment (credentials, a concurrent request with the same key…), asks the
   * gateway whether an object exists under our key. Only a clear "none" lets the attempt fail; any doubt is a 503 and
   * the attempt stays live (plan 3.1, 14.3; review G1).
   */
  private async lookupAfterRefusal(accountId: string, idempotencyKey: string, createdAt: Date): Promise<ProviderPayment | null> {
    try {
      return await this.gateway.call(accountId, 'retrieve', (provider, ctx) => provider.retrievePayment(ctx, { idempotencyKey, createdAt }));
    } catch (err) {
      throw this.forCustomer(err);
    }
  }

  /**
   * What a customer sees of a gateway problem: a 503 for the gateway, and for the gateway wrapper's own refusals
   * (account paused, adapter blocked…) the neutral "payment in progress", never the internal code (review round 2, 4).
   */
  forCustomer(err: unknown): unknown {
    if (err instanceof ProviderError) return providerUnavailable();
    if (err instanceof ApiError && err.status === 409) return conflict('payment_attempt_in_progress', 'This payment cannot continue right now. Try again later.');
    return err;
  }

  /**
   * Transaction B: booking, then payment, locked; the reference filled in once; the gateway's status applied by the
   * state machine (forward only). A gateway amount or currency that is not ours is not recorded. Returns whether the
   * booking is still payable and the attempt still waits for the customer.
   */
  async record(paymentId: string, remote: ProviderPayment | null, source: 'api' | 'sweep', failureCode?: string): Promise<boolean> {
    try {
      return await this.recordOnce(paymentId, remote, source, failureCode);
    } catch (err) {
      throw await this.afterCoverageFailure(err);
    }
  }

  /**
   * A payment whose coverage could not be applied is not recorded (its transaction was undone): Oscar gets a task, the
   * customer a 503 that says it is being processed, and the sweep leaves the attempt alone (plan 3.2, section 11.8).
   */
  async afterCoverageFailure(err: unknown): Promise<unknown> {
    if (!(err instanceof CoverageFailedError)) return err;
    const p = await this.prisma.payment.findUnique({ where: { id: err.paymentId }, select: { booking: { select: { reference: true } } } });
    await this.machine.coverageFailed(this.prisma, err, p?.booking.reference ?? 'unknown');
    return new ApiError(503, 'payment_processing_delayed', 'Your payment is being processed. Check this booking again shortly.', { 'Retry-After': '60' });
  }

  private async recordOnce(paymentId: string, remote: ProviderPayment | null, source: 'api' | 'sweep', failureCode?: string): Promise<boolean> {
    return runTransaction(this.prisma, async (tx) => {
      const b = await this.lockBookingOf(tx, paymentId);
      if (!b) throw notFound();
      const p = await lockPayment(tx, b, paymentId);
      if (!p) throw notFound();
      if (!remote) {
        // Only an attempt the gateway never took (created, no reference) fails without the gateway saying so.
        if (p.status === 'created' && p.providerPaymentRef === null) await this.machine.apply(tx, b, p, 'failed', { source, failureCode });
        return false;
      }
      await this.machine.setReference(tx, p, remote.ref);
      if (remote.amount.amountMinor !== p.amountMinor || remote.amount.currency !== p.currency) {
        await this.mismatchTask(tx, p, b.reference);
        return false;
      }
      // Only an attempt that ended without money (never a collected one) can leave an orphan (review round 3, point 2).
      if (ENDED_WITHOUT_MONEY.includes(p.status) && (remote.status === 'requires_action' || remote.status === 'pending')) {
        // Our attempt already ended but the gateway holds an object that could still be paid: cancel it after this
        // commits and tell Oscar (review round 2, point 2). A late success is still recorded by the state machine.
        await this.jobs.send(QUEUES.paymentsAttempts, { paymentId: p.id, action: 'cancel_orphan' }, { db: bossDb(tx), singletonKey: `orphan:${p.id}` });
        await this.tasks.createSystemIn(tx, {
          title: `Open gateway payment for an ended attempt on booking ${b.reference}`,
          description: 'The payment gateway still has a payable object for a payment attempt that had ended. It is being cancelled; check it was.',
          entityType: 'Payment', entityId: p.id, sourceRef: `payments:orphan:${p.id}`,
        });
        return false;
      }
      await this.machine.apply(tx, b, p, remote.status, { source, failureCode: remote.failureCode });
      const [{ at }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at` as [{ at: Date }];
      const stillPayable = PAYABLE_STATES.includes(b.status) && !(b.status === 'approved' && (!b.approvalExpiresAt || b.approvalExpiresAt <= at));
      // No redirect to the hosted page of an account that no longer takes charges (review M3).
      const account = await tx.providerAccount.findUnique({ where: { id: p.providerAccountId }, select: { status: true } });
      return stillPayable && p.status === 'requires_action' && account?.status === 'active';
    }, PAYMENT_TX_OPTIONS);
  }

  async lockBookingOf(tx: Tx, paymentId: string): Promise<LockedBooking | null> {
    const row = await tx.payment.findUnique({ where: { id: paymentId }, select: { bookingId: true } });
    return row ? readBookingForPayments(tx, { id: row.bookingId }, true) : null;
  }

  async mismatchTask(tx: Tx, p: LockedPayment, reference: string): Promise<void> {
    await this.tasks.createSystemIn(tx, {
      title: `Payment amount mismatch on booking ${reference}`,
      description: 'The payment gateway reported an amount or currency that is not the one we asked for. Nothing was recorded; check the gateway.',
      entityType: 'Payment', entityId: p.id, sourceRef: `payments:mismatch:${p.id}`,
    });
  }

  async attemptView(paymentId: string, nextAction?: { type: 'redirect'; url: string }): Promise<PaymentAttemptView> {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, method: true, amountMinor: true, currency: true } });
    return { status: p.status, method: p.method as PaymentMethod, amountMinor: p.amountMinor.toString(), currency: p.currency, ...(nextAction && p.status === 'requires_action' ? { nextAction } : {}) };
  }
}
