import { Inject, Injectable } from '@nestjs/common';
import type { BookingStatus, PaymentAttemptView, PaymentMethod, PaymentPlanView, StartPayment } from '@mt/shared';
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
import type { BookingForPayments } from '../../bookings';
import { LIVE_STATUSES, LockedPayment, PAYMENT_EVENTS, PaymentStateMachine, lockPayment } from './attempt-state';
import { ProviderGateway } from './gateway';
import { payable, succeededPaymentsSource } from './payable';
import type { ProviderPayment } from './provider';
import { ProviderError } from './provider';
import { PaymentRouting } from './routing';
import { PAYMENT_SETTINGS } from './settings';

type Tx = Prisma.TransactionClient;

/** Booking states in which a payment can be started (plan 0.1, 6.2, "create an attempt"). */
export const PAYABLE_STATES: readonly BookingStatus[] = ['approved', 'deposit_paid', 'confirmed'];

/** READ COMMITTED with short limits, like booking requests (plan 2.4, section 4). */
export const PAYMENT_TX_OPTIONS = { isolationLevel: 'ReadCommitted' as const, timeout: 15_000, maxWait: 5_000 };

const ENDED_WITHOUT_MONEY: readonly string[] = ['failed', 'cancelled', 'expired'];

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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---- Customer: the plan ----

  async planView(reference: string): Promise<PaymentPlanView> {
    const b = await readBookingForPayments(this.prisma, { reference });
    if (!b) throw notFound();
    const items = await this.prisma.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, orderBy: { sequence: 'asc' }, select: { kind: true, sequence: true, amountMinor: true, dueDate: true } });
    const collected = await succeededPaymentsSource.collected(this.prisma, b.id, this.gateway.mode);
    const p = payable(items, collected);
    const methods = await this.routing.methods(this.prisma, { currency: b.currency, country: b.residenceCountry });
    const live = await this.prisma.payment.findUnique({ where: { liveBookingId: b.id }, select: { status: true, method: true, amountMinor: true, currency: true } });
    const reason = !PAYABLE_STATES.includes(b.status) ? 'booking_not_payable'
      : b.status === 'approved' && b.approvalExpiresAt && b.approvalExpiresAt.getTime() <= Date.now() ? 'approval_expired'
        : !p.next ? 'nothing_to_pay'
          : methods.length === 0 ? 'no_payment_method_available' : undefined;
    return {
      reference: b.reference, currency: b.currency, payable: reason === undefined, ...(reason ? { notPayableReason: reason } : {}),
      items: items.map((i) => ({ kind: i.kind, sequence: i.sequence, amountMinor: i.amountMinor.toString(), dueDate: i.dueDate.toISOString().slice(0, 10) })),
      collectedMinor: p.collectedMinor.toString(), outstandingMinor: p.outstandingMinor.toString(),
      nextPayable: p.next ? { sequence: p.next.sequence, amountMinor: p.next.amountMinor.toString() } : null,
      methods,
      liveAttempt: live ? { status: live.status, method: live.method, amountMinor: live.amountMinor.toString(), currency: live.currency } : null,
    };
  }

  // ---- Customer: start (or resume) a payment ----

  async start(user: { id: string }, reference: string, body: StartPayment, key: string, actor: AuditActor): Promise<PaymentAttemptView> {
    const booking = await readBookingForPayments(this.prisma, { reference });
    if (!booking) throw notFound();
    // The route of the record carries the booking id, so one key on two bookings is two records (plan 3.1, 14.4).
    const outcome = await this.idempotency.run({ actorType: 'customer', actorId: user.id, route: `POST /booking-requests/${booking.id}/payments`, key, body }, async () => {
      const paymentId = await this.createOrResume(booking.id, body, actor);
      return { status: 201, resourceType: 'Payment', resourceId: paymentId };
    }).catch((err: unknown) => {
      if (err instanceof IdempotencyKeyReuseError) throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');
      if (err instanceof IdempotencyInProgressError) throw conflict('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed');
      throw err;
    });
    const payment = await this.prisma.payment.findUnique({ where: { id: outcome.result.resourceId! }, select: { id: true, bookingId: true } });
    if (!payment || payment.bookingId !== booking.id) throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request');
    const nextAction = await this.drive(payment.id);
    return this.attemptView(payment.id, nextAction);
  }

  /** Transaction A (plan 3.1, section 5.1). Returns the id of a new or resumed live attempt. */
  async createOrResume(bookingId: string, body: StartPayment, actor: AuditActor): Promise<string> {
    const expiryMinutes = await this.settings.get(PAYMENT_SETTINGS.attemptExpiryMinutes.key, PAYMENT_SETTINGS.attemptExpiryMinutes.fallback);
    let result: string | { expiredLive: string };
    try {
      result = await runTransaction(this.prisma, async (tx): Promise<string | { expiredLive: string }> => {
        const b = await readBookingForPayments(tx, { id: bookingId }, true);
        if (!b) throw notFound();
        const [{ at }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at` as [{ at: Date }];
        this.assertPayable(b, at);
        const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { id: true, sequence: true, amountMinor: true } });
        if (body.upToSequence !== undefined && !items.some((i) => i.sequence === body.upToSequence)) throw unprocessable('unknown_plan_item', 'There is no such item in the payment plan');
        const collected = await succeededPaymentsSource.collected(tx, b.id, this.gateway.mode);
        const due = payable(items, collected, body.upToSequence).next;
        if (!due) throw conflict('nothing_to_pay', 'There is nothing to pay on this booking right now');

        const accounts = await this.routing.candidates(tx, { method: body.method, currency: b.currency, country: b.residenceCountry });
        const live = await tx.$queryRaw<Array<{ id: string; status: string; method: string; amountMinor: bigint; pendingExpiresAt: Date; providerAccountId: string }>>`
          SELECT id::text AS id, status::text AS status, method::text AS method, "amountMinor", "pendingExpiresAt", "providerAccountId"::text AS "providerAccountId"
          FROM payments WHERE "liveBookingId" = ${b.id}::uuid FOR UPDATE`;
        const current = live[0];
        if (current) {
          // Past its expiry but not swept yet: not resumable; its sweep is queued after this transaction (plan 3.1, 14.9).
          if (current.pendingExpiresAt.getTime() <= at.getTime()) return { expiredLive: current.id };
          // Resumed only with the same account (still able to take charges), method and amount (plan 3.1, 5.1).
          const sameAccount = accounts.some((a) => a.id === current.providerAccountId);
          if (current.status !== 'pending' && sameAccount && current.method === body.method && current.amountMinor === due.amountMinor) return current.id;
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
            status: 'created', liveBookingId: b.id, idempotencyKey: `booking:${b.id}:attempt:${n}`,
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

  private assertPayable(b: BookingForPayments, at: Date): void {
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
      select: { id: true, bookingId: true, status: true, adapterKey: true, providerAccountId: true, providerPaymentRef: true, idempotencyKey: true, amountMinor: true, currency: true, method: true, payerCustomer: { select: { countryOfResidence: true } } },
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
          metadata: { paymentId: p.id, bookingId: p.bookingId }, returnUrl: `${this.config.WEB_ORIGIN}/payments/return`, customerCountry: p.payerCustomer.countryOfResidence,
        }));
      } catch (err) {
        if (!(err instanceof ProviderError)) throw this.forCustomer(err);
        if (err.retryable) throw providerUnavailable();
        remote = await this.lookupAfterRefusal(p.providerAccountId, p.idempotencyKey);
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
  private async lookupAfterRefusal(accountId: string, idempotencyKey: string): Promise<ProviderPayment | null> {
    try {
      return await this.gateway.call(accountId, 'retrieve', (provider, ctx) => provider.retrievePayment(ctx, { idempotencyKey }));
    } catch (err) {
      throw this.forCustomer(err);
    }
  }

  /**
   * What a customer sees of a gateway problem: a 503 for the gateway, and for the gateway wrapper's own refusals
   * (account paused, adapter blocked…) the neutral "payment in progress", never the internal code (review round 2, 4).
   */
  private forCustomer(err: unknown): unknown {
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
    return runTransaction(this.prisma, async (tx) => {
      const b = await this.lockBookingOf(tx, paymentId);
      const p = await lockPayment(tx, paymentId);
      if (!b || !p) throw notFound();
      if (!remote) {
        // Only an attempt the gateway never took (created, no reference) fails without the gateway saying so.
        if (p.status === 'created' && p.providerPaymentRef === null) await this.machine.apply(tx, p, 'failed', { source, failureCode, bookingReference: b.reference });
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
      await this.machine.apply(tx, p, remote.status, { source, failureCode: remote.failureCode, bookingReference: b.reference });
      const [{ at }] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at` as [{ at: Date }];
      const stillPayable = PAYABLE_STATES.includes(b.status) && !(b.status === 'approved' && (!b.approvalExpiresAt || b.approvalExpiresAt <= at));
      // No redirect to the hosted page of an account that no longer takes charges (review M3).
      const account = await tx.providerAccount.findUnique({ where: { id: p.providerAccountId }, select: { status: true } });
      return stillPayable && p.status === 'requires_action' && account?.status === 'active';
    }, PAYMENT_TX_OPTIONS);
  }

  async lockBookingOf(tx: Tx, paymentId: string): Promise<BookingForPayments | null> {
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
