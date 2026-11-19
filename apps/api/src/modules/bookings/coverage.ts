import { Inject, Injectable } from '@nestjs/common';
import type { BookingStatus } from '@mt/shared';
import type { AuditActor } from '../../platform/audit/audit.service';
import { notFound } from '../../platform/http/api-error';
import { readBookingForPayments } from './read';
import type { LockedBooking } from './read';
import { BookingStateMachine } from './state-machine';
import type { CoverageEvent } from './state-machine';
import type { Tx } from './support';

/** What the payments module knows about a booking's money (plan 3.2, section 1.1), computed with the booking locked. */
export interface CoverageFacts {
  depositCovered: boolean;
  totalCovered: boolean;
  /**
   * Only a voided transfer sets this (task 3.4): a `deposit_paid` booking whose deposit is no longer covered goes back to
   * approved. Other callers (a change that raises the deposit) leave it unset and the booking stays `deposit_paid`.
   */
  reopenDeposit?: boolean;
  /**
   * Task 4.5 (plan 0.1, 6.2, money out): the cash held for the booking (payments less refunds less chargebacks) and
   * whether any payment ever succeeded. A cancelled booking that had money and holds none (or less) is refunded; a
   * refunded one that holds money again is cancelled. Absent: those cells do not apply.
   */
  cash?: { collectedMinor: bigint; everCollected: boolean };
}

/**
 * The coverage rule C for money coming in (plan 0.1, 6.2; plan 3.2, section 1.2). Pure: from a status, the facts and
 * the package's auto-confirmation, the coverage events to apply, in order. `deposit_paid` never jumps to
 * `balance_paid`: without auto-confirmation it waits for Oscar even when the total is paid. `balance_paid` whose total is
 * no longer covered goes back to `confirmed` (task 6.3: a change raised the total; task 4.5: a refund or a chargeback).
 * Task 4.5: cancelled ↔ refunded follow the cash held. A deposit no longer covered moves nothing back (payments puts the
 * booking under review instead).
 */
export function coverageEvents(status: BookingStatus, facts: CoverageFacts, autoConfirm: boolean): CoverageEvent[] {
  const events: CoverageEvent[] = [];
  let s = status;
  if (s === 'deposit_paid' && facts.reopenDeposit && !facts.depositCovered) {
    events.push('deposit_uncovered');
    s = 'approved';
    return events;
  }
  if (s === 'approved' && facts.depositCovered) {
    events.push('deposit_covered');
    s = 'deposit_paid';
    if (autoConfirm) {
      events.push('auto_confirm');
      s = 'confirmed';
    }
  }
  if (s === 'confirmed' && facts.totalCovered) events.push('total_covered');
  // Task 6.3: a change raised the total of a booking paid in full; it owes again (plan 0.1, 6.2).
  if (s === 'balance_paid' && !facts.totalCovered) events.push('total_uncovered');
  if (facts.cash) {
    if (s === 'cancelled' && facts.cash.everCollected && facts.cash.collectedMinor <= 0n) events.push('fully_refunded');
    if (s === 'refunded' && facts.cash.collectedMinor > 0n) events.push('money_returned');
  }
  return events;
}

/**
 * The only code that applies the coverage events (checked by a test): payments calls it, in the transaction where money
 * came in or where the booking was approved or confirmed, with the booking already locked. Applying it twice changes
 * nothing. Coverage events release no stock and no code, so a caller holding a payment lock never locks a pool after it.
 */
@Injectable()
export class BookingCoverage {
  constructor(@Inject(BookingStateMachine) private readonly machine: BookingStateMachine) {}

  async apply(tx: Tx, booking: LockedBooking, facts: CoverageFacts, actor: AuditActor): Promise<BookingStatus> {
    // Read again under the lock this transaction already holds: an earlier step may have moved it.
    const b = await readBookingForPayments(tx, { id: booking.id }, true);
    if (!b) throw notFound('booking_not_found', 'Booking not found');
    let status = b.status;
    for (const event of coverageEvents(b.status, facts, b.autoConfirmOnDeposit)) {
      const r = await this.machine.transition(tx, b.id, event, { actor });
      if (r.changed) status = r.to;
    }
    return status;
  }
}
