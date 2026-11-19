import { Inject, Injectable } from '@nestjs/common';
import type { BookingStatus } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { AppError } from '../../../platform/errors/safe-error';
import { conflict, notFound } from '../../../platform/http/api-error';
import { BookingCoverage, BookingTransitionHooks, readBookingForPayments } from '../../bookings';
import type { LockedBooking } from '../../bookings';
import { allocate, coverageFacts } from './allocation';
import type { Allocation, CoverageFacts } from './allocation';
import { ProviderGateway } from './gateway';
import { netCollectedSource } from './payable';

type Tx = Prisma.TransactionClient;

export const COVERAGE_HOOK = 'payments.coverage';

/**
 * The coverage rule could not be applied where money came in (plan 3.2, section 11, point 8). The transaction is undone
 * (a payment is never recorded without its coverage) and a task for Oscar is opened in another one.
 */
export class CoverageFailedError extends AppError {
  constructor(readonly paymentId: string, readonly original: unknown) {
    super('coverage_failed', 'The payment could not be applied to its booking');
  }
}

export interface BookingMoney extends CoverageFacts {
  collectedMinor: bigint;
  allocation: Allocation;
}

/**
 * What the money collected means for a booking (plan 3.2, sections 1 and 2), and the hooks that apply it: the deposit
 * check before Oscar confirms, and the coverage rule after approval (a total of 0 is covered at once) and after
 * confirmation (a booking paid in full moves on to balance paid).
 */
@Injectable()
export class PaymentCoverageService {
  constructor(
    @Inject(BookingCoverage) private readonly coverage: BookingCoverage,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
  ) {}

  register(hooks: BookingTransitionHooks): void {
    hooks.register('confirm', COVERAGE_HOOK, async (tx, b) => {
      if (!(await this.money(tx, b.id)).depositCovered) throw conflict('deposit_not_covered', 'The deposit for this booking has not been paid');
    });
    hooks.register('approve', COVERAGE_HOOK, (tx, b, ctx) => this.applyById(tx, b.id, ctx.actor), 'after');
    hooks.register('confirm', COVERAGE_HOOK, (tx, b, ctx) => this.applyById(tx, b.id, ctx.actor), 'after');
  }

  /** Active items, what was collected in this environment's mode, its split and the coverage facts. */
  async money(db: Tx, bookingId: string): Promise<BookingMoney> {
    const items = await db.paymentScheduleItem.findMany({ where: { bookingId, state: 'active' }, select: { kind: true, sequence: true, amountMinor: true } });
    const collected = await netCollectedSource.collected(db, bookingId, this.gateway.mode);
    return { ...coverageFacts(items, collected), collectedMinor: collected, allocation: allocate(items, collected) };
  }

  /** The coverage rule, with the booking locked by the caller (the lock order Booking → Payment is the caller's). */
  async apply(tx: Tx, booking: LockedBooking, actor: AuditActor): Promise<BookingStatus> {
    const m = await this.money(tx, booking.id);
    return this.coverage.apply(tx, booking, { depositCovered: m.depositCovered, totalCovered: m.totalCovered }, actor);
  }

  private async applyById(tx: Tx, bookingId: string, actor: AuditActor): Promise<void> {
    // The booking transition holds the lock already; taking it again in the same transaction does not wait.
    const b = await readBookingForPayments(tx, { id: bookingId }, true);
    if (!b) throw notFound('booking_not_found', 'Booking not found');
    await this.apply(tx, b, actor);
  }
}
