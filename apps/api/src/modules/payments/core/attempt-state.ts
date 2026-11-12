import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PaymentStatus } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { OutboxService } from '../../../platform/events/outbox.service';
import { bossDb } from '../../../platform/database/boss-db';
import { isRetryableTransactionError } from '../../../platform/database/transaction';
import { AppError, safeError } from '../../../platform/errors/safe-error';
import { conflict } from '../../../platform/http/api-error';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { approvalExpiryJob } from '../../bookings';
import type { LockedBooking } from '../../bookings';
import { CoverageFailedError, PaymentCoverageService } from './coverage.service';
import type { ProviderPaymentStatus } from './provider';
import { succeededPaymentsSource } from './payable';

type Tx = Prisma.TransactionClient;

/** Every pair the attempt state machine and the trigger of migration 0017 allow (plan 3.1, sections 5.2 and 14.8). */
export const PAYMENT_STATUS_PAIRS: ReadonlyArray<readonly [PaymentStatus, PaymentStatus]> = [
  ['created', 'requires_action'], ['created', 'pending'], ['created', 'succeeded'], ['created', 'failed'], ['created', 'cancelled'], ['created', 'expired'],
  ['requires_action', 'pending'], ['requires_action', 'succeeded'], ['requires_action', 'failed'], ['requires_action', 'cancelled'], ['requires_action', 'expired'],
  ['pending', 'succeeded'], ['pending', 'failed'],
  ['failed', 'succeeded'], ['cancelled', 'succeeded'], ['expired', 'succeeded'],
];

/** The task opened when the coverage rule keeps failing for a payment; the sweep leaves such attempts alone. */
export const coverageTaskRef = (paymentId: string) => `payments:coverage_failed:${paymentId}`;

export const LIVE_STATUSES: readonly PaymentStatus[] = ['created', 'requires_action', 'pending'];

/** What happened, as the state machine sees it: a gateway status, or an expiry the gateway confirmed by cancelling. */
export type AttemptEvent = ProviderPaymentStatus | 'expire_confirmed';

/**
 * The table of plan 3.1, section 5.2: where each event takes each state; null is "no change" (a duplicate, an event
 * out of order, or one that only moves forward). Money wins: a collected payment is recorded whatever came before.
 */
export function nextStatus(from: PaymentStatus, event: AttemptEvent): PaymentStatus | null {
  switch (event) {
    case 'requires_action':
      return from === 'created' ? 'requires_action' : null;
    case 'pending':
      return from === 'created' || from === 'requires_action' ? 'pending' : null;
    case 'succeeded':
      return ['created', 'requires_action', 'pending', 'failed', 'cancelled', 'expired'].includes(from) ? 'succeeded' : null;
    case 'failed':
      return from === 'created' || from === 'requires_action' || from === 'pending' ? 'failed' : null;
    case 'cancelled':
      return from === 'created' || from === 'requires_action' ? 'cancelled' : null;
    case 'expire_confirmed':
      return from === 'created' || from === 'requires_action' ? 'expired' : null;
  }
}

export const PAYMENT_EVENTS = {
  created: 'payments.payment.created',
  succeeded: 'payments.payment.succeeded',
  failed: 'payments.payment.failed',
  overpaid: 'payments.booking.overpaid',
  lateSucceeded: 'payments.payment.late_succeeded',
  scheduleCreated: 'payments.schedule.created',
  scheduleSuperseded: 'payments.schedule.superseded',
} as const;

export interface LockedPayment {
  id: string;
  bookingId: string;
  status: PaymentStatus;
  version: number;
  mode: 'test' | 'live';
  amountMinor: bigint;
  currency: string;
  providerPaymentRef: string | null;
  providerAccountId: string;
  attemptNumber: number;
}

/**
 * Locks one payment of a booking the caller has already locked (plan 0.1, 6.3: Booking → Payment). The LockedBooking
 * argument makes the order a compile-time rule (plan 3.2, section 11, point 11); a payment of another booking is refused.
 */
export async function lockPayment(tx: Tx, booking: LockedBooking, paymentId: string): Promise<LockedPayment | null> {
  const rows = await tx.$queryRaw<LockedPayment[]>`
    SELECT id::text AS id, "bookingId"::text AS "bookingId", status::text AS status, version, mode::text AS mode, "amountMinor", currency,
           "providerPaymentRef", "providerAccountId"::text AS "providerAccountId", "attemptNumber"
    FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
  const p = rows[0] ?? null;
  if (p && p.bookingId !== booking.id) throw new AppError('payment_lock_order', 'A payment can only be locked after its own booking');
  return p;
}

/** Ends without money: the attempt no longer holds back the approval expiry (plan 0.1, 6.2). */
const ENDED_WITHOUT_MONEY: readonly PaymentStatus[] = ['failed', 'cancelled', 'expired'];

/**
 * The only code that writes payments.status (checked by a test). One change, in the caller's transaction, with the
 * booking and the payment locked: compare-and-set, audit, events, and the overpayment check when money comes in.
 */
@Injectable()
export class PaymentStateMachine {
  private readonly logger = new Logger('Payments');

  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(PaymentCoverageService) private readonly coverage: PaymentCoverageService,
    @Inject(JobsService) private readonly jobs: JobsService,
  ) {}

  /** Fills in the gateway reference once (the webhook can arrive before the gateway's answer). */
  async setReference(tx: Tx, p: LockedPayment, ref: string): Promise<void> {
    if (p.providerPaymentRef === ref) return;
    if (p.providerPaymentRef !== null) throw conflict('payment_reference_mismatch', 'The gateway reference does not match this payment');
    await tx.$executeRaw`UPDATE payments SET "providerPaymentRef" = ${ref}, "updatedAt" = clock_timestamp() WHERE id = ${p.id}::uuid AND "providerPaymentRef" IS NULL`;
    p.providerPaymentRef = ref;
  }

  async apply(tx: Tx, booking: LockedBooking, p: LockedPayment, event: AttemptEvent, ctx: { source: 'api' | 'webhook' | 'sweep'; failureCode?: string }): Promise<PaymentStatus | null> {
    if (p.bookingId !== booking.id) throw new AppError('payment_lock_order', 'A payment can only change with its own booking locked');
    const bookingReference = booking.reference;
    const to = nextStatus(p.status, event);
    if (!to) return null;
    const live = LIVE_STATUSES.includes(to);
    const failureCode = to === 'failed' ? (ctx.failureCode ?? 'failed').slice(0, 64) : null;
    const n = await tx.$executeRaw`
      UPDATE payments SET status = ${to}::"PaymentStatus", version = version + 1, "updatedAt" = clock_timestamp(),
        "liveBookingId" = ${live ? p.bookingId : null}::uuid,
        "succeededAt" = CASE WHEN ${to}::text = 'succeeded' THEN clock_timestamp() ELSE "succeededAt" END,
        "failureCode" = COALESCE(${failureCode}::text, "failureCode")
      WHERE id = ${p.id}::uuid AND status = ${p.status}::"PaymentStatus"`;
    if (n !== 1) throw conflict('payment_state_changed', 'This payment changed. Try again.');
    const from = p.status;
    p.status = to;
    p.version += 1;
    await this.audit.record(tx, {
      actor: SYSTEM_ACTOR, action: 'payments.payment.status_changed', entityType: 'Payment', entityId: p.id,
      before: { status: from }, after: { status: to }, context: { from, to, source: ctx.source, bookingId: p.bookingId },
    });
    if (to === 'succeeded' || to === 'failed') {
      await this.outbox.publish(tx, {
        type: to === 'succeeded' ? PAYMENT_EVENTS.succeeded : PAYMENT_EVENTS.failed, aggregateType: 'Payment', aggregateId: p.id, aggregateVersion: p.version,
        payload: { paymentId: p.id, bookingId: p.bookingId }, actorType: 'system',
      });
    }
    // An attempt that leaves the live states closes its "unresolved" task, whoever ended it (review round 3, point 1).
    if (LIVE_STATUSES.includes(from) && !live) await this.tasks.closeSystemIn(tx, `payments:unresolved:${p.id}`);
    if (to === 'succeeded' && (from === 'failed' || from === 'cancelled' || from === 'expired')) await this.lateSuccess(tx, p, from, bookingReference);
    if (to === 'succeeded') {
      await this.checkOverpayment(tx, p, bookingReference);
      await this.applyCoverage(tx, booking, p);
    }
    if (LIVE_STATUSES.includes(from) && ENDED_WITHOUT_MONEY.includes(to)) await this.requeueApprovalExpiry(tx, booking);
    return to;
  }

  /**
   * The coverage rule in the same transaction as the money (plan 0.1, 6.2; plan 3.2, section 1.4). If it fails, the
   * whole change is undone: a database retry stays a retry, anything else becomes CoverageFailedError, which the callers
   * turn into a task for Oscar (plan 3.2, section 11, point 8). Once recorded, an earlier such task is closed.
   */
  private async applyCoverage(tx: Tx, booking: LockedBooking, p: LockedPayment): Promise<void> {
    try {
      await this.coverage.apply(tx, booking, SYSTEM_ACTOR);
    } catch (err) {
      if (isRetryableTransactionError(err)) throw err;
      throw new CoverageFailedError(p.id, err);
    }
    await this.tasks.closeSystemIn(tx, coverageTaskRef(p.id));
  }

  /**
   * An attempt that ends without money on an approval past its time: the expiry is evaluated again by a job for that
   * booking, after this commits (plan 0.1, 6.2 and 6.3: this transaction holds a payment and never locks stock after it).
   */
  private async requeueApprovalExpiry(tx: Tx, booking: LockedBooking): Promise<void> {
    if (booking.status !== 'approved') return;
    const [{ due }] = await tx.$queryRaw<Array<{ due: boolean }>>`SELECT "approvalExpiresAt" <= clock_timestamp() AS due FROM bookings WHERE id = ${booking.id}::uuid` as [{ due: boolean }];
    if (!due) return;
    const job = approvalExpiryJob(booking.id);
    await this.jobs.send(QUEUES.bookingsMaintenance, job.data, { db: bossDb(tx), singletonKey: job.singletonKey });
  }

  /** Opens, in its own transaction, the task for a payment whose coverage could not be applied (plan 3.2, 11.8). */
  async coverageFailed(db: { $transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> }, err: CoverageFailedError, reference: string): Promise<void> {
    // The cause as a code only (safeError keeps no values, so no personal data or secrets): in the log and the task.
    const cause = safeError(err.original).code;
    this.logger.error(`coverage failed for payment ${err.paymentId}: ${cause}`);
    await db.$transaction(async (tx) => {
      await this.tasks.createSystemIn(tx, {
        title: `Payment could not be applied to booking ${reference}`,
        description: `A payment the gateway reports as collected could not move the booking along its payment states (${cause}), so it is not recorded yet. Check the booking; the payment is retried once it is fixed.`,
        entityType: 'Payment', entityId: err.paymentId, sourceRef: coverageTaskRef(err.paymentId),
      });
    });
  }

  /**
   * Money for an attempt that had already ended (failed, cancelled or expired): the customer may have paid the same
   * item twice, whatever the totals say. Always a task for Oscar and an event (review M1).
   */
  private async lateSuccess(tx: Tx, p: LockedPayment, from: PaymentStatus, reference: string): Promise<void> {
    await this.tasks.createSystemIn(tx, {
      title: `Late payment success on booking ${reference}`,
      description: `A payment attempt that had ${from === 'failed' ? 'failed' : from === 'cancelled' ? 'been cancelled' : 'expired'} was collected after all. Check whether the customer paid twice and arrange a refund if needed.`,
      entityType: 'Payment', entityId: p.id, sourceRef: `payments:late_success:${p.id}`,
    });
    await this.outbox.publish(tx, { type: PAYMENT_EVENTS.lateSucceeded, aggregateType: 'Payment', aggregateId: p.id, aggregateVersion: p.version, payload: { paymentId: p.id, bookingId: p.bookingId }, actorType: 'system' });
  }

  /**
   * Money collected beyond what the plan's active items ask for (a late success after a new attempt, or money for a
   * cancelled booking): a task for Oscar and an event, once per payment (plan 3.1, section 14, point 3). Task 3.2
   * turns it into an overpayment liability.
   */
  private async checkOverpayment(tx: Tx, p: LockedPayment, reference: string): Promise<void> {
    const owed = await tx.paymentScheduleItem.aggregate({ where: { bookingId: p.bookingId, state: 'active' }, _sum: { amountMinor: true } });
    const collected = await succeededPaymentsSource.collected(tx, p.bookingId, p.mode);
    if (collected <= (owed._sum.amountMinor ?? 0n)) return;
    await this.tasks.createSystemIn(tx, {
      title: `Overpayment on booking ${reference}`,
      description: 'A payment came in beyond what the payment plan asks for. Check the booking and arrange a refund if needed.',
      entityType: 'Booking', entityId: p.bookingId, sourceRef: `payments:overpaid:${p.id}`,
    });
    await this.outbox.publish(tx, { type: PAYMENT_EVENTS.overpaid, aggregateType: 'Payment', aggregateId: p.id, aggregateVersion: p.version, payload: { paymentId: p.id, bookingId: p.bookingId }, actorType: 'system' });
  }
}
