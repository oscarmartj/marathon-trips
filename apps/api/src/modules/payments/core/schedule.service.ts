import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import { bossDb } from '../../../platform/database/boss-db';
import { AppError } from '../../../platform/errors/safe-error';
import { OutboxService } from '../../../platform/events/outbox.service';
import { conflict } from '../../../platform/http/api-error';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { BookingTransitionHooks, readBookingForPayments } from '../../bookings';
import type { BookingHookContext, HookedBooking } from '../../bookings';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { PAYMENT_EVENTS } from './attempt-state';
import { PaymentCoverageService } from './coverage.service';
import { ProviderGateway } from './gateway';
import { netCollectedSource } from './payable';
import { LedgerService } from './ledger.service';
import { scheduleReallocationKey } from './ledger';
import { planItems } from './schedule';

type Tx = Prisma.TransactionClient;

export const SCHEDULE_HOOK = 'payments.schedule';

/**
 * The payment plan follows the booking in the booking's own transaction (plan 3.1, section 4.2): created on approval,
 * superseded on cancellation. Neither hook locks a payment: they run before the code and the stock are released, and
 * the global order puts Payment after them (plan 0.1, 6.3). A live attempt is cancelled by a job after the commit.
 */
@Injectable()
export class PaymentScheduleService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentCoverageService) private readonly coverage: PaymentCoverageService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  register(hooks: BookingTransitionHooks): void {
    hooks.register('approve', SCHEDULE_HOOK, (tx, b, ctx) => this.onApprove(tx, b, ctx));
    hooks.register('cancel', SCHEDULE_HOOK, (tx, b, ctx) => this.onCancel(tx, b, ctx));
    hooks.register('expire_approval', SCHEDULE_HOOK, (tx, b, ctx) => this.onExpireApproval(tx, b, ctx));
  }

  async onApprove(tx: Tx, hooked: HookedBooking, ctx: BookingHookContext): Promise<void> {
    if (!ctx.approvalExpiresAt) throw new AppError('plan_needs_approval_expiry', 'An approval without an expiry cannot date its deposit');
    const b = await readBookingForPayments(tx, { id: hooked.id });
    if (!b || b.currency !== hooked.currency) throw new AppError('plan_booking_mismatch', 'The booking and its snapshot do not agree');
    if (await tx.paymentSchedule.findUnique({ where: { bookingId: b.id }, select: { id: true } })) throw new AppError('plan_already_exists', 'This booking already has a payment plan');
    const items = planItems({ totalMinor: b.totalMinor, depositMinor: b.depositMinor, balanceDueDate: b.balanceDueDate, approvalExpiresAt: ctx.approvalExpiresAt });
    const schedule = await tx.paymentSchedule.create({ data: { bookingId: b.id, currency: b.currency, version: 1 }, select: { id: true } });
    for (const i of items) {
      await tx.paymentScheduleItem.create({
        data: { scheduleId: schedule.id, bookingId: b.id, currency: b.currency, kind: i.kind, sequence: i.sequence, planVersion: 1, amountMinor: i.amountMinor, dueDate: new Date(`${i.dueDate}T00:00:00.000Z`) },
      });
    }
    await this.audit.record(tx, {
      actor: ctx.actor, action: 'payments.schedule.created', entityType: 'PaymentSchedule', entityId: schedule.id,
      after: { version: 1, items: items.map((i) => ({ kind: i.kind, sequence: i.sequence, amountMinor: i.amountMinor.toString(), dueDate: i.dueDate })) },
      fieldClasses: { items: 'nopii' }, context: { bookingId: b.id, items: items.length },
    });
    await this.outbox.publish(tx, { type: PAYMENT_EVENTS.scheduleCreated, aggregateType: 'PaymentSchedule', aggregateId: schedule.id, aggregateVersion: 1, payload: { scheduleId: schedule.id, bookingId: b.id }, actorType: ctx.actor.type, actorId: ctx.actor.id ?? undefined });
    // Money that arrived before the plan follows it (plan 3.3, 12.7); nothing is posted when nothing was collected.
    await this.ledger.reallocate(tx, { id: b.id, currency: b.currency }, this.gateway.mode, `approval:${b.id}:plan`);
  }

  /**
   * Before task 6.4 there are no penalties, so a cancelled booking owes nothing: every active item is superseded. A
   * booking with money collected cannot be cancelled yet (409, as for the paid states): refunds are parked.
   */
  async onCancel(tx: Tx, hooked: HookedBooking, ctx: BookingHookContext): Promise<void> {
    const schedule = await tx.paymentSchedule.findUnique({ where: { bookingId: hooked.id }, select: { id: true, version: true, currency: true } });
    const collected = await netCollectedSource.collected(tx, hooked.id, this.gateway.mode);
    if (collected > 0n) throw conflict('cancellation_needs_payments', 'This booking has payments to settle first. Cancelling it is not available yet.');
    if (!schedule) return;
    await this.supersede(tx, hooked.id, schedule, 'booking_cancelled', ctx);
    // A live attempt is cancelled at the gateway after this commits (no Payment lock here).
    const live = await tx.payment.findUnique({ where: { liveBookingId: hooked.id }, select: { id: true } });
    if (live) await this.jobs.send(QUEUES.paymentsAttempts, { paymentId: live.id, action: 'cancel' }, { db: bossDb(tx), singletonKey: `cancel:${live.id}` });
  }

  /**
   * The deposit time of an approval ran out (plan 0.1, 6.2; plan 3.2, section 3). Refused (409, the sweep counts it as
   * blocked) while an attempt is live, since money may be on its way, or when the deposit is covered. Otherwise the plan
   * owes 0: every active item is superseded, and money already in becomes an overpayment with a task for Oscar. Reads
   * payments without locking them: every change of an attempt locks this booking first, and it is locked here.
   */
  async onExpireApproval(tx: Tx, hooked: HookedBooking, ctx: BookingHookContext): Promise<void> {
    const live = await tx.payment.findUnique({ where: { liveBookingId: hooked.id }, select: { id: true } });
    if (live) throw conflict('approval_expiry_blocked_by_payment', 'A payment for this booking is still in progress');
    const money = await this.coverage.money(tx, hooked.id);
    if (money.depositCovered) throw conflict('approval_expiry_blocked_by_payment', 'The deposit for this booking is paid');
    const schedule = await tx.paymentSchedule.findUnique({ where: { bookingId: hooked.id }, select: { id: true, version: true, currency: true } });
    if (!schedule) throw new AppError('plan_missing', 'An approved booking has no payment plan');
    await this.supersede(tx, hooked.id, schedule, 'approval_expired', ctx);
    if (money.collectedMinor > 0n) {
      const b = await readBookingForPayments(tx, { id: hooked.id });
      await this.tasks.createSystemIn(tx, {
        title: `Overpayment on booking ${b?.reference ?? 'unknown'}`,
        description: 'The time to pay the deposit ran out with money already paid. Arrange a refund.',
        entityType: 'Booking', entityId: hooked.id, sourceRef: `payments:overpaid:approval_expired:${hooked.id}`,
      });
      // Same shape as the overpayment of task 3.1 (attempt-state.ts): one event per payment, with its id and version.
      const paid = await tx.payment.findMany({ where: { bookingId: hooked.id, mode: this.gateway.mode, status: 'succeeded' }, select: { id: true, version: true }, orderBy: [{ succeededAt: 'asc' }, { id: 'asc' }] });
      for (const p of paid) await this.outbox.publish(tx, { type: PAYMENT_EVENTS.overpaid, aggregateType: 'Payment', aggregateId: p.id, aggregateVersion: p.version, payload: { paymentId: p.id, bookingId: hooked.id }, actorType: ctx.actor.type, actorId: ctx.actor.id ?? undefined });
    }
  }

  /** Supersedes every active item in a new plan version (the plan then owes 0), with its audit entry and event. */
  private async supersede(tx: Tx, bookingId: string, schedule: { id: string; version: number; currency: string }, cause: 'booking_cancelled' | 'approval_expired', ctx: BookingHookContext): Promise<void> {
    const version = schedule.version + 1;
    const bumped = await tx.paymentSchedule.updateMany({ where: { id: schedule.id, version: schedule.version }, data: { version } });
    if (bumped.count !== 1) throw conflict('payment_plan_changed', 'The payment plan changed. Try again.');
    const superseded = await tx.paymentScheduleItem.updateMany({ where: { scheduleId: schedule.id, state: 'active' }, data: { state: 'superseded', supersededInVersion: version } });
    await this.audit.record(tx, {
      actor: ctx.actor, action: 'payments.schedule.superseded', entityType: 'PaymentSchedule', entityId: schedule.id,
      before: { version: schedule.version }, after: { version }, context: { bookingId, supersededItems: superseded.count, cause },
    });
    await this.outbox.publish(tx, { type: PAYMENT_EVENTS.scheduleSuperseded, aggregateType: 'PaymentSchedule', aggregateId: schedule.id, aggregateVersion: version, payload: { scheduleId: schedule.id, bookingId }, actorType: ctx.actor.type, actorId: ctx.actor.id ?? undefined });
    // The plan owes 0: money already in moves to overpayments (plan 3.3, 1.5), one key per plan version.
    await this.ledger.reallocate(tx, { id: bookingId, currency: schedule.currency }, this.gateway.mode, scheduleReallocationKey(bookingId, version));
  }
}
