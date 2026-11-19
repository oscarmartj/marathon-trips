import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService, SYSTEM_ACTOR } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { OutboxService } from '../../../platform/events/outbox.service';
import { AppError } from '../../../platform/errors/safe-error';
import { conflict, notFound } from '../../../platform/http/api-error';
import { readBookingForPayments } from '../../bookings';
import type { LockedBooking } from '../../bookings';
import { PAYMENT_EVENTS } from './attempt-state';
import type { LockedPayment } from './attempt-state';
import { PaymentCoverageService } from './coverage.service';
import { LedgerService } from './ledger.service';
import type { ProviderRefund, ProviderRefundStatus } from './provider';

type Tx = Prisma.TransactionClient;
export type RefundStatusName = 'requested' | 'pending' | 'succeeded' | 'failed' | 'reversed';

/** Every pair the refund state machine and the trigger of migration 0033 allow (plan 0.1, 6.2; plan 3.3, 3.1). */
export const REFUND_STATUS_PAIRS: ReadonlyArray<readonly [RefundStatusName, RefundStatusName]> = [
  ['requested', 'pending'], ['requested', 'succeeded'], ['requested', 'failed'],
  ['pending', 'succeeded'], ['pending', 'failed'],
  ['succeeded', 'reversed'],
];

/** What happened to a refund, as the state machine sees it. `reversal_confirmed`: failed after success, confirmed by the gateway. */
export type RefundEvent = 'pending' | 'succeeded' | 'failed' | 'reversal_confirmed';

/** A gateway status as an event; a cancelled refund moved no money, so it is a failure (plan 3.3, 12.9). */
export const refundEventOf = (s: ProviderRefundStatus): 'pending' | 'succeeded' | 'failed' => (s === 'cancelled' ? 'failed' : s);

/** The refund table of plan 0.1, 6.2 (rows without app requests): null is "no change". Forward only. */
export function nextRefundStatus(from: RefundStatusName, event: RefundEvent): RefundStatusName | null {
  switch (event) {
    case 'pending':
      return from === 'requested' ? 'pending' : null;
    case 'succeeded':
      return from === 'requested' || from === 'pending' ? 'succeeded' : null;
    case 'failed':
      return from === 'requested' || from === 'pending' ? 'failed' : null;
    case 'reversal_confirmed':
      return from === 'succeeded' ? 'reversed' : null;
  }
}

export interface LockedRefund {
  id: string;
  paymentId: string;
  bookingId: string;
  providerAccountId: string;
  status: RefundStatusName;
  version: number;
  mode: 'test' | 'live';
  amountMinor: bigint;
  currency: string;
  providerRefundRef: string | null;
  origin: 'app' | 'external';
  manualRefund: boolean;
}

/** Locks a refund of a payment the caller has locked (lock order Booking → Payment → Refund, plan 0.1, 6.3). */
export async function lockRefund(tx: Tx, payment: LockedPayment, refundId: string): Promise<LockedRefund | null> {
  const rows = await tx.$queryRaw<LockedRefund[]>`
    SELECT id::text AS id, "paymentId"::text AS "paymentId", "bookingId"::text AS "bookingId", "providerAccountId"::text AS "providerAccountId",
           status::text AS status, version, mode::text AS mode, "amountMinor", currency, "providerRefundRef", origin::text AS origin, "manualRefund"
    FROM refunds WHERE id = ${refundId}::uuid FOR UPDATE`;
  const r = rows[0] ?? null;
  if (r && r.paymentId !== payment.id) throw new AppError('refund_lock_order', 'A refund can only be locked after its own payment');
  return r;
}

/** The task that puts a booking under review after money went out (plan 3.3, 12.3). */
export const coverageLostTaskRef = (bookingId: string) => `payments:coverage_lost:${bookingId}`;

/**
 * Whether a booking is under payment review: its coverage-lost task is open. While it is, no reminder is sent and no
 * new charge attempt starts (plan 3.3, 12.3). Oscar closes the task once he has cancelled or adjusted the booking.
 */
export async function bookingUnderPaymentReview(db: Pick<Tx, '$queryRaw'>, bookingId: string): Promise<boolean> {
  // Task 4.5 (plan review, 6): a dispute still open on one of its payments puts it under review too, so no reminder,
  // payment link or new charge reaches a customer who is disputing a payment.
  const rows = await db.$queryRaw<Array<{ open: boolean }>>`
    SELECT (EXISTS (SELECT 1 FROM tasks WHERE "sourceRef" = ${coverageLostTaskRef(bookingId)} AND status = 'open' AND "deletedAt" IS NULL)
         OR EXISTS (SELECT 1 FROM disputes WHERE "bookingId" = ${bookingId}::uuid AND status IN ('open', 'evidence_submitted'))) AS open`;
  return rows[0]?.open === true;
}

export const underReview = () => conflict('booking_payment_under_review', 'This booking is being reviewed after a refund. Contact us before paying.');

/**
 * The only code that writes refunds.status (checked by a test). One change, in the caller's transaction, with booking,
 * payment and refund locked: compare-and-set, audit, events, the ledger posting, and what money out or back means.
 */
@Injectable()
export class PaymentRefundStateMachine {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(PaymentCoverageService) private readonly coverage: PaymentCoverageService,
  ) {}

  /**
   * Records a refund made on the gateway's dashboard (plan 0.1, P5): created `pending`, then moved to what the gateway
   * says, so an already succeeded one is posted at once. One task for Oscar per refund.
   */
  async createExternal(tx: Tx, booking: LockedBooking, p: LockedPayment, remote: ProviderRefund): Promise<LockedRefund> {
    const key = `refund:external:${p.providerAccountId}:${remote.ref}`;
    const [row] = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO refunds (id, "paymentId", "bookingId", "providerAccountId", mode, currency, "amountMinor", origin, status, "idempotencyKey", "providerRefundRef", "updatedAt")
      VALUES (gen_random_uuid(), ${p.id}::uuid, ${p.bookingId}::uuid, ${p.providerAccountId}::uuid, ${p.mode}::"PaymentMode", ${p.currency}, ${remote.amount.amountMinor},
              'external', 'pending', ${key}, ${remote.ref}, clock_timestamp())
      RETURNING id::text AS id`;
    const r = (await lockRefund(tx, p, row!.id))!;
    await this.audit.record(tx, {
      actor: SYSTEM_ACTOR, action: 'payments.refund.recorded_external', entityType: 'Refund', entityId: r.id,
      after: { status: 'pending', amountMinor: r.amountMinor.toString(), currency: r.currency }, context: { bookingId: booking.id, paymentId: p.id },
    });
    await this.tasks.createSystemIn(tx, {
      title: `Refund made at the payment gateway on booking ${booking.reference}`,
      description: 'A refund was made on the payment gateway\'s own dashboard, not in this app. It is recorded and in the ledger. Check the booking: cancel or change it if needed.',
      entityType: 'Refund', entityId: r.id, sourceRef: `payments:external_refund:${r.id}`,
    });
    await this.apply(tx, booking, p, r, refundEventOf(remote.status), { source: 'webhook', failureCode: remote.failureCode });
    return r;
  }

  async apply(tx: Tx, booking: LockedBooking, p: LockedPayment, r: LockedRefund, event: RefundEvent, ctx: RefundApplyContext): Promise<RefundStatusName | null> {
    if (r.bookingId !== booking.id || r.paymentId !== p.id) throw new AppError('refund_lock_order', 'A refund can only change with its booking and payment locked');
    const to = nextRefundStatus(r.status, event);
    if (!to) return null;
    const failureCode = to === 'failed' ? (ctx.failureCode ?? 'refund_failed').slice(0, 64) : null;
    const ref = ctx.providerRefundRef ?? null;
    const confirmedBy = ctx.confirmedById ?? null;
    // Leaving `requested` drops a manual refund's destination in the same statement (the CHECK is not deferred) and ends
    // any retry of the gateway request (task 4.5).
    const n = await tx.$executeRaw`
      UPDATE refunds SET status = ${to}::"RefundStatus", version = version + 1, "updatedAt" = clock_timestamp(),
        "succeededAt" = CASE WHEN ${to}::text = 'succeeded' THEN clock_timestamp() ELSE "succeededAt" END,
        "failureCode" = COALESCE(${failureCode}::text, "failureCode"),
        "providerRefundRef" = COALESCE("providerRefundRef", ${ref}::text),
        "confirmedById" = COALESCE("confirmedById", ${confirmedBy}::uuid),
        "destinationCiphertext" = NULL, "destinationKeyVersion" = NULL, "nextAttemptAt" = NULL
      WHERE id = ${r.id}::uuid AND status = ${r.status}::"RefundStatus"`;
    if (n !== 1) throw conflict('refund_state_changed', 'This refund changed. Try again.');
    const from = r.status;
    r.status = to;
    r.version += 1;
    if (ref && !r.providerRefundRef) r.providerRefundRef = ref;
    const actor = ctx.actor ?? SYSTEM_ACTOR;
    await this.audit.record(tx, {
      actor, action: 'payments.refund.status_changed', entityType: 'Refund', entityId: r.id,
      before: { status: from }, after: { status: to }, context: { from, to, source: ctx.source, bookingId: r.bookingId, paymentId: r.paymentId },
    });
    const type = to === 'succeeded' ? PAYMENT_EVENTS.refundSucceeded : to === 'failed' ? PAYMENT_EVENTS.refundFailed : to === 'reversed' ? PAYMENT_EVENTS.refundReversed : null;
    if (type) await this.outbox.publish(tx, { type, aggregateType: 'Refund', aggregateId: r.id, aggregateVersion: r.version, payload: { refundId: r.id, paymentId: r.paymentId, bookingId: r.bookingId }, actorType: 'system' });
    if (to === 'succeeded') {
      await this.ledger.postRefundSucceeded(tx, booking, r);
      await this.afterMoneyOut(tx, booking, { refundId: r.id }, actor);
    }
    if (to === 'failed' && r.origin === 'app') {
      // The money it held back is free again (plan 0.1, P10): the plan may now be filled with it.
      await this.ledger.reallocate(tx, booking, r.mode, `refund:${r.id}:released`);
      await this.coverage.apply(tx, booking, actor);
    }
    if (to === 'reversed') {
      await this.ledger.postRefundReversed(tx, booking, r);
      // Money back in: the coverage rule may move the booking forward again (it never moves it back).
      await this.coverage.apply(tx, booking, actor);
    }
    return to;
  }

  /** Fills in the gateway's reference of an app refund matched by our id before the gateway answered (task 4.5). */
  async setReference(tx: Tx, r: LockedRefund, ref: string): Promise<void> {
    if (r.providerRefundRef !== null) return;
    await tx.$executeRaw`UPDATE refunds SET "providerRefundRef" = ${ref}, "updatedAt" = clock_timestamp() WHERE id = ${r.id}::uuid AND "providerRefundRef" IS NULL`;
    r.providerRefundRef = ref;
  }

  /**
   * After money out (a refund or a chargeback), with the booking locked (plan 0.1, 6.2, money-out cells; task 4.5): a
   * booking whose status claims coverage it no longer has is put under review (a task that stops reminders, links and
   * new charges); a completed trip gets a task; then the coverage rule runs (`balance_paid → confirmed`,
   * `cancelled → refunded`). A deposit no longer covered never moves a booking back.
   */
  async afterMoneyOut(tx: Tx, booking: LockedBooking, cause: { refundId?: string; disputeId?: string }, actor: AuditActor = SYSTEM_ACTOR, opts: { forceReview?: boolean } = {}): Promise<void> {
    const b = await readBookingForPayments(tx, { id: booking.id }, true);
    if (!b) throw notFound('booking_not_found', 'Booking not found');
    const m = await this.coverage.money(tx, booking.id);
    const lost = ((b.status === 'deposit_paid' || b.status === 'confirmed') && !m.depositCovered) || (b.status === 'balance_paid' && !m.totalCovered)
      || (b.status === 'completed' && !m.totalCovered) || m.allocation.receivableMinor < 0n;
    if ((lost || opts.forceReview) && !(await this.reviewTaskOpen(tx, booking.id))) {
      await this.tasks.createSystemIn(tx, {
        title: `Booking ${b.reference} is no longer paid as its status says`,
        description: 'Money went out of this booking (a refund or a chargeback). Reminders, payment links and new payments are stopped until this task is closed: check the booking and the payment gateway first.',
        entityType: 'Booking', entityId: booking.id, sourceRef: coverageLostTaskRef(booking.id),
      });
      await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'payments.booking.under_review', entityType: 'Booking', entityId: booking.id, context: { ...cause, status: b.status } });
    }
    await this.coverage.apply(tx, booking, actor);
  }

  private async reviewTaskOpen(tx: Tx, bookingId: string): Promise<boolean> {
    return (await tx.task.count({ where: { sourceRef: coverageLostTaskRef(bookingId), source: 'system', status: 'open', deletedAt: null } })) > 0;
  }
}

export interface RefundApplyContext {
  source: 'webhook' | 'sweep' | 'api' | 'staff';
  failureCode?: string;
  actor?: AuditActor;
  /** The gateway's reference (or a manual refund's bank reference), set if the row has none. */
  providerRefundRef?: string;
  /** Staff who confirmed a manual refund. */
  confirmedById?: string;
}
