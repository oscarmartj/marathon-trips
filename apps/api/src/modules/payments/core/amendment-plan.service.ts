import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { AppError } from '../../../platform/errors/safe-error';
import { OutboxService } from '../../../platform/events/outbox.service';
import { conflict } from '../../../platform/http/api-error';
import { BookingAmendmentHooks } from '../../bookings';
import type { AmendmentMoneyAfter, AmendmentMoneyFacts, AmendmentMoneyPort, AmendmentPlanContext, LockedBooking } from '../../bookings';
import { PAYMENT_EVENTS } from './attempt-state';
import { PaymentCoverageService } from './coverage.service';
import { ProviderGateway } from './gateway';
import { payable, succeededPaymentsSource } from './payable';
import { amendedPlanItems, dateIn } from './schedule';

type Tx = Prisma.TransactionClient;

/** The one credit task of a booking (plan section 6, review M6): opened while a change leaves money to give back. */
export const creditTaskRef = (bookingId: string) => `payments:overpaid:amendment:${bookingId}`;
/** An unpaid adjustment past its due date (plan section 6, review M2): one task per booking and due date. */
export const overdueTaskRef = (bookingId: string, dueDate: string) => `payments:adjustment_overdue:${bookingId}:${dueDate}`;

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Payments' side of a change of a booking (task 6.3; plan docs/plans/6.3-booking-amendments.md, section 6), registered
 * with bookings at start-up. Runs inside the change's transaction with the booking locked; never locks a payment.
 * Money is parked: a lower total that leaves money paid beyond it becomes a credit pending with a task, never a refund.
 */
@Injectable()
export class PaymentAmendmentService implements AmendmentMoneyPort {
  constructor(
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentCoverageService) private readonly coverage: PaymentCoverageService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  register(hooks: BookingAmendmentHooks): void {
    hooks.registerMoney(this);
  }

  async facts(tx: Tx, bookingId: string): Promise<AmendmentMoneyFacts> {
    const collectedMinor = await succeededPaymentsSource.collected(tx, bookingId, this.gateway.mode);
    const live = await tx.payment.findUnique({ where: { liveBookingId: bookingId }, select: { id: true } });
    return { collectedMinor, liveAttempt: live !== null };
  }

  async restate(tx: Tx, booking: LockedBooking, ctx: AmendmentPlanContext): Promise<AmendmentMoneyAfter> {
    const schedule = await tx.paymentSchedule.findUnique({ where: { bookingId: booking.id }, select: { id: true, version: true, currency: true } });
    if (!schedule) throw new AppError('plan_missing', 'A booking after its deposit has no payment plan');
    const active = await tx.paymentScheduleItem.findMany({ where: { bookingId: booking.id, state: 'active' }, select: { kind: true, sequence: true, amountMinor: true, dueDate: true } });
    const items = amendedPlanItems(active.map((i) => ({ kind: i.kind, sequence: i.sequence, amountMinor: i.amountMinor, dueDate: ymd(i.dueDate) })), ctx.newTotalMinor, ctx.adjustmentDue);
    if (items) {
      const version = schedule.version + 1;
      const bumped = await tx.paymentSchedule.updateMany({ where: { id: schedule.id, version: schedule.version }, data: { version } });
      if (bumped.count !== 1) throw conflict('payment_plan_changed', 'The payment plan changed. Try again.');
      const superseded = await tx.paymentScheduleItem.updateMany({ where: { scheduleId: schedule.id, state: 'active' }, data: { state: 'superseded', supersededInVersion: version } });
      for (const i of items) {
        await tx.paymentScheduleItem.create({
          data: { scheduleId: schedule.id, bookingId: booking.id, currency: schedule.currency, kind: i.kind, sequence: i.sequence, planVersion: version, amountMinor: i.amountMinor, dueDate: new Date(`${i.dueDate}T00:00:00.000Z`) },
        });
      }
      await this.audit.record(tx, {
        actor: ctx.actor, action: 'payments.schedule.amended', entityType: 'PaymentSchedule', entityId: schedule.id,
        before: { version: schedule.version }, after: { version, items: items.map((i) => ({ kind: i.kind, sequence: i.sequence, amountMinor: i.amountMinor.toString(), dueDate: i.dueDate })) },
        fieldClasses: { items: 'nopii' }, context: { bookingId: booking.id, supersededItems: superseded.count, cause: 'amendment', toSnapshotVersion: ctx.toVersion },
      });
      await this.outbox.publish(tx, { type: PAYMENT_EVENTS.scheduleSuperseded, aggregateType: 'PaymentSchedule', aggregateId: schedule.id, aggregateVersion: version, payload: { scheduleId: schedule.id, bookingId: booking.id }, actorType: ctx.actor.type, actorId: ctx.actor.id ?? undefined });
      // A link pays one item of the old plan: it is revoked (it would stop working anyway; 5.1). No Payment is locked.
      const revoked = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE payment_links SET status = 'revoked', "revokedAt" = clock_timestamp() WHERE "bookingId" = ${booking.id}::uuid AND status = 'active' RETURNING id::text AS id`;
      for (const r of revoked) await this.audit.record(tx, { actor: ctx.actor, action: 'payments.paymentLink.revoked', entityType: 'PaymentLink', entityId: r.id, before: { status: 'active' }, after: { status: 'revoked' }, context: { bookingId: booking.id, reason: 'plan_changed' } });
    }

    // Coverage C with the booking locked by the change (Booking → Payment is never reversed: nothing here locks a payment).
    await this.coverage.apply(tx, booking, ctx.actor);
    const money = await this.coverage.money(tx, booking.id);
    const owed = await tx.paymentScheduleItem.findMany({ where: { bookingId: booking.id, state: 'active' }, select: { sequence: true, amountMinor: true } });
    const outstandingMinor = payable(owed, money.collectedMinor).outstandingMinor;
    const creditPendingMinor = money.allocation.overpaidMinor;

    // The credit task follows the current credit, never a stale amount (review M6).
    const ref = creditTaskRef(booking.id);
    if (creditPendingMinor > 0n) {
      const open = await tx.task.findFirst({ where: { sourceRef: ref, source: 'system', status: 'open', deletedAt: null }, select: { id: true } });
      if (!open) {
        await this.tasks.createSystemIn(tx, {
          title: `Credit pending after a change on booking ${ctx.reference}`,
          description: 'A change lowered the price below what the customer has paid. Refunds are not available yet: arrange it by hand. The booking shows the current credit.',
          entityType: 'Booking', entityId: booking.id, sourceRef: ref,
        });
        const paid = await tx.payment.findMany({ where: { bookingId: booking.id, mode: this.gateway.mode, status: 'succeeded' }, select: { id: true, version: true }, orderBy: [{ succeededAt: 'asc' }, { id: 'asc' }] });
        for (const p of paid) await this.outbox.publish(tx, { type: PAYMENT_EVENTS.overpaid, aggregateType: 'Payment', aggregateId: p.id, aggregateVersion: p.version, payload: { paymentId: p.id, bookingId: booking.id }, actorType: ctx.actor.type, actorId: ctx.actor.id ?? undefined });
      }
    } else {
      await this.tasks.closeSystemIn(tx, ref);
    }
    return { collectedMinor: money.collectedMinor, outstandingMinor, creditPendingMinor };
  }

  /**
   * Adjustments past their due date that the money collected does not cover (plan section 6, review M2): one task per
   * booking and due date, for Oscar to chase or undo the change. Nothing is cancelled automatically. Run by the sweep.
   */
  async flagOverdueAdjustments(db: Tx, now: Date): Promise<string[]> {
    const today = dateIn(now);
    const rows = await db.$queryRaw<Array<{ bookingId: string; reference: string; dueDate: Date }>>`
      SELECT DISTINCT i."bookingId"::text AS "bookingId", b.reference, i."dueDate"
        FROM payment_schedule_items i JOIN bookings b ON b.id = i."bookingId"
       WHERE i.kind = 'adjustment' AND i.state = 'active' AND i."dueDate" < ${today}::date
         AND b.status IN ('deposit_paid', 'confirmed', 'balance_paid')
         -- Once per booking and due date, whatever became of the task (code review, point 3): closing it without the money
         -- does not make it come back every ten minutes, and items already flagged never crowd out new ones.
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t."sourceRef" = 'payments:adjustment_overdue:' || i."bookingId"::text || ':' || to_char(i."dueDate", 'YYYY-MM-DD') AND t."deletedAt" IS NULL)
       ORDER BY i."dueDate", 1 LIMIT 200`;
    const flagged: string[] = [];
    for (const r of rows) {
      const money = await this.coverage.money(db, r.bookingId);
      const items = await db.paymentScheduleItem.findMany({ where: { bookingId: r.bookingId, state: 'active' }, select: { sequence: true, kind: true, dueDate: true } });
      const late = items.filter((i) => i.kind === 'adjustment' && ymd(i.dueDate) === ymd(r.dueDate)).map((i) => i.sequence);
      const unpaid = money.allocation.items.some((a) => late.includes(a.sequence) && a.paidMinor < a.amountMinor);
      if (!unpaid) continue;
      await this.tasks.createSystemIn(db, {
        title: `A change on booking ${r.reference} is unpaid since ${ymd(r.dueDate)}`,
        description: 'What a change of this booking added was not paid by its due date. Chase the customer, or change the booking back.',
        entityType: 'Booking', entityId: r.bookingId, sourceRef: overdueTaskRef(r.bookingId, ymd(r.dueDate)),
      });
      flagged.push(r.bookingId);
    }
    return flagged;
  }
}
