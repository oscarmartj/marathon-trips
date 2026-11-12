import { Inject, Injectable } from '@nestjs/common';
import type { PaymentStatus } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { OutboxService } from '../../../platform/events/outbox.service';
import { conflict } from '../../../platform/http/api-error';
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

/** Locks one payment (after its booking, plan 0.1, 6.3). */
export async function lockPayment(tx: Tx, paymentId: string): Promise<LockedPayment | null> {
  const rows = await tx.$queryRaw<LockedPayment[]>`
    SELECT id::text AS id, "bookingId"::text AS "bookingId", status::text AS status, version, mode::text AS mode, "amountMinor", currency,
           "providerPaymentRef", "providerAccountId"::text AS "providerAccountId", "attemptNumber"
    FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * The only code that writes payments.status (checked by a test). One change, in the caller's transaction, with the
 * booking and the payment locked: compare-and-set, audit, events, and the overpayment check when money comes in.
 */
@Injectable()
export class PaymentStateMachine {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  /** Fills in the gateway reference once (the webhook can arrive before the gateway's answer). */
  async setReference(tx: Tx, p: LockedPayment, ref: string): Promise<void> {
    if (p.providerPaymentRef === ref) return;
    if (p.providerPaymentRef !== null) throw conflict('payment_reference_mismatch', 'The gateway reference does not match this payment');
    await tx.$executeRaw`UPDATE payments SET "providerPaymentRef" = ${ref}, "updatedAt" = clock_timestamp() WHERE id = ${p.id}::uuid AND "providerPaymentRef" IS NULL`;
    p.providerPaymentRef = ref;
  }

  async apply(tx: Tx, p: LockedPayment, event: AttemptEvent, ctx: { source: 'api' | 'webhook' | 'sweep'; failureCode?: string; bookingReference: string }): Promise<PaymentStatus | null> {
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
    if (to === 'succeeded' && (from === 'failed' || from === 'cancelled' || from === 'expired')) await this.lateSuccess(tx, p, from, ctx.bookingReference);
    if (to === 'succeeded') await this.checkOverpayment(tx, p, ctx.bookingReference);
    return to;
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
