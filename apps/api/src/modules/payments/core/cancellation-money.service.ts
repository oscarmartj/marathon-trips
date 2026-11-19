// Payments' side of a cancellation (task 6.4, plan docs/plans/6.4-cancellation-policies.md, sections 2.8, 6 and 13).
// The plan itself follows in the schedule's `cancel` hook; here: what the booking holds and what blocks it, and the
// after phase (Booking → pools → Payment): the open transfer request is cancelled and coverage C applied.
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { BookingCancellationHooks, BookingTransitionHooks } from '../../bookings';
import type { BookingHookContext, CancellationMoneyFacts, CancellationMoneyPort, HookedBooking } from '../../bookings';
import { readBookingForPayments } from '../../bookings';
import { PaymentStateMachine, lockPayment } from './attempt-state';
import { PaymentCoverageService } from './coverage.service';
import { ProviderGateway } from './gateway';
import { bookingCash } from './payable';
import { LATE_PENDING_CODE } from './refunds.service';

type Tx = Prisma.TransactionClient;

export const CANCELLATION_HOOK = 'payments.cancellation';

@Injectable()
export class PaymentCancellationService implements CancellationMoneyPort {
  constructor(
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentStateMachine) private readonly attempts: PaymentStateMachine,
    @Inject(PaymentCoverageService) private readonly coverage: PaymentCoverageService,
  ) {}

  register(hooks: BookingTransitionHooks, cancellations: BookingCancellationHooks): void {
    cancellations.registerMoney(this);
    hooks.register('cancel', CANCELLATION_HOOK, (tx, b, ctx) => this.afterCancel(tx, b, ctx), 'after');
  }

  /** Read with the booking locked by the caller, without Payment locks (every change of a payment locks the booking first). */
  async facts(tx: Tx, bookingId: string): Promise<CancellationMoneyFacts> {
    const mode = this.gateway.mode;
    const cash = await bookingCash(tx, bookingId, mode);
    const [r] = await tx.$queryRaw<Array<{ disputed: bigint; pendingDebit: boolean; refundInFlight: boolean; disputeOpen: boolean }>>`
      SELECT
        COALESCE((SELECT sum(d."amountMinor") FROM disputes d WHERE d."bookingId" = ${bookingId}::uuid AND d.mode = ${mode}::"PaymentMode"
                   AND d.status IN ('open', 'evidence_submitted') AND (d."fundsWithdrawnAt" IS NULL OR d."fundsReinstatedAt" IS NOT NULL)), 0)::bigint AS disputed,
        EXISTS (SELECT 1 FROM payments p WHERE p."liveBookingId" = ${bookingId}::uuid AND p.status = 'pending') AS "pendingDebit",
        EXISTS (SELECT 1 FROM refunds r WHERE r."bookingId" = ${bookingId}::uuid AND r.mode = ${mode}::"PaymentMode"
                 AND ((r.origin = 'app' AND r.status IN ('requested', 'pending')) OR (r.origin = 'external' AND r.status = 'pending')
                      OR (r.origin = 'app' AND r.status = 'failed' AND r."failureCode" = ${LATE_PENDING_CODE}))) AS "refundInFlight",
        EXISTS (SELECT 1 FROM disputes d WHERE d."bookingId" = ${bookingId}::uuid AND d.mode = ${mode}::"PaymentMode" AND d.status IN ('open', 'evidence_submitted')) AS "disputeOpen"`;
    return { collectedMinor: cash.collectedMinor, disputedMinor: r!.disputed, pendingDebit: r!.pendingDebit, refundInFlight: r!.refundInFlight, disputeOpen: r!.disputeOpen };
  }

  /**
   * After the status is written (review m7): an open request to pay by transfer (`manual_intent` in `created`) ends as
   * cancelled without calling anyone (P2), then coverage C (a cancelled booking that holds nothing of what it was paid
   * is refunded at once).
   */
  private async afterCancel(tx: Tx, hooked: HookedBooking, ctx: BookingHookContext): Promise<void> {
    const b = await readBookingForPayments(tx, { id: hooked.id }, true);
    if (!b) return;
    const open = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM payments WHERE "bookingId" = ${b.id}::uuid AND origin = 'manual_intent' AND status = 'created' ORDER BY id`;
    for (const o of open) {
      const intent = await lockPayment(tx, b, o.id);
      if (intent && intent.status === 'created') await this.attempts.apply(tx, b, intent, 'cancelled', { source: 'api' });
    }
    await this.coverage.applyById(tx, b.id, ctx.actor);
  }
}
