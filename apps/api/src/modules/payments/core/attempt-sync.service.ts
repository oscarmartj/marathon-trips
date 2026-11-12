import { Inject, Injectable } from '@nestjs/common';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { notFound } from '../../../platform/http/api-error';
import { LIVE_STATUSES, PaymentStateMachine, lockPayment } from './attempt-state';
import type { AttemptEvent } from './attempt-state';
import { PAYMENT_TX_OPTIONS, PaymentAttemptsService } from './attempts.service';
import { ProviderGateway } from './gateway';
import type { ProviderPayment } from './provider';

export type SyncAction = 'sync' | 'cancel' | 'expire';
export type SyncOutcome = 'not_live' | 'not_due' | 'applied' | 'unresolved' | 'still_pending';

/** An attempt still unresolved this long after its expiry gets a task for Oscar (plan 3.1, section 14, point 3). */
export const UNRESOLVED_AFTER_MS = 24 * 3_600_000;

/**
 * Brings one live attempt in line with the gateway (plan 3.1, sections 5.2, 5.3 and 14.3): `sync` applies what the
 * gateway says; `cancel` (booking cancelled) and `expire` (pendingExpiresAt passed) ask the gateway first and only end
 * the attempt when the gateway confirms it can no longer be charged. No answer, or no object found, keeps it live.
 */
@Injectable()
export class PaymentAttemptSyncService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentAttemptsService) private readonly attempts: PaymentAttemptsService,
    @Inject(PaymentStateMachine) private readonly machine: PaymentStateMachine,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  async run(paymentId: string, action: SyncAction, now: Date = new Date()): Promise<SyncOutcome> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId }, select: { id: true, status: true, providerAccountId: true, providerPaymentRef: true, idempotencyKey: true, pendingExpiresAt: true } });
    if (!p) throw notFound();
    if (!LIVE_STATUSES.includes(p.status)) return 'not_live';
    if (action === 'expire' && p.pendingExpiresAt.getTime() > now.getTime()) return 'not_due';

    // ProviderError (retryable or not) propagates: the job retries, and the sweep picks the attempt up again.
    const remote = await this.gateway.call(p.providerAccountId, 'retrieve', (provider, ctx) =>
      provider.retrievePayment(ctx, p.providerPaymentRef ? { ref: p.providerPaymentRef } : { idempotencyKey: p.idempotencyKey }));

    if (action === 'sync') {
      if (remote) await this.attempts.record(p.id, remote, 'sweep');
      return remote ? 'applied' : 'unresolved';
    }
    if (!remote) return this.unresolved(p.id, p.pendingExpiresAt, now);
    if (remote.status === 'requires_action') {
      const after = await this.gateway.call(p.providerAccountId, 'cancel', (provider, ctx) => provider.cancelPayment(ctx, remote.ref, `${p.idempotencyKey}:cancel`));
      return this.finish(p.id, after, action, p.pendingExpiresAt, now);
    }
    return this.finish(p.id, remote, action, p.pendingExpiresAt, now);
  }

  private async finish(paymentId: string, remote: ProviderPayment, action: 'cancel' | 'expire', expiresAt: Date, now: Date): Promise<SyncOutcome> {
    if (remote.status === 'cancelled') {
      const event: AttemptEvent = action === 'cancel' ? 'cancelled' : 'expire_confirmed';
      await runTransaction(this.prisma, async (tx) => {
        const b = await this.attempts.lockBookingOf(tx, paymentId);
        const p = await lockPayment(tx, paymentId);
        if (!b || !p) throw notFound();
        await this.machine.setReference(tx, p, remote.ref);
        if (remote.amount.amountMinor !== p.amountMinor || remote.amount.currency !== p.currency) return this.attempts.mismatchTask(tx, p, b.reference);
        await this.machine.apply(tx, p, event, { source: 'sweep', bookingReference: b.reference });
      }, PAYMENT_TX_OPTIONS);
      return 'applied';
    }
    await this.attempts.record(paymentId, remote, 'sweep');
    if (remote.status === 'pending' || remote.status === 'requires_action') return this.unresolved(paymentId, expiresAt, now, remote.status === 'pending' ? 'still_pending' : 'unresolved');
    return 'applied';
  }

  private async unresolved(paymentId: string, expiresAt: Date, now: Date, outcome: SyncOutcome = 'unresolved'): Promise<SyncOutcome> {
    if (now.getTime() - expiresAt.getTime() >= UNRESOLVED_AFTER_MS) {
      await this.prisma.$transaction(async (tx) => {
        const b = await this.attempts.lockBookingOf(tx, paymentId);
        await this.tasks.createSystemIn(tx, {
          title: `Payment attempt unresolved on booking ${b?.reference ?? 'unknown'}`,
          description: 'The payment gateway has not confirmed how this payment attempt ended. It still blocks new payments for the booking. Check the gateway.',
          entityType: 'Payment', entityId: paymentId, sourceRef: `payments:unresolved:${paymentId}`,
        });
      });
    }
    return outcome;
  }
}
