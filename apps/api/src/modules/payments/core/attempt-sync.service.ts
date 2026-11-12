import { Inject, Injectable } from '@nestjs/common';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { ApiError, notFound } from '../../../platform/http/api-error';
import { LIVE_STATUSES, PaymentStateMachine, lockPayment } from './attempt-state';
import type { AttemptEvent } from './attempt-state';
import { PAYMENT_TX_OPTIONS, PaymentAttemptsService } from './attempts.service';
import { ProviderGateway } from './gateway';
import type { ProviderPayment } from './provider';
import { ProviderError } from './provider';

export type SyncAction = 'sync' | 'cancel' | 'expire' | 'cancel_orphan';
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
    if (action === 'cancel_orphan') return this.cancelOrphan(p.id, p.providerAccountId, p.providerPaymentRef);
    if (!LIVE_STATUSES.includes(p.status)) return 'not_live';
    if (action === 'expire' && p.pendingExpiresAt.getTime() > now.getTime()) return 'not_due';

    if (action === 'sync') {
      const remote = await this.retrieve(p);
      if (remote) await this.attempts.record(p.id, remote, 'sweep');
      return remote ? 'applied' : 'unresolved';
    }
    try {
      return await this.settle(p, action, now);
    } catch (err) {
      // A gateway that keeps failing (rotated credentials…) must not hide a blocked booking: past 24 hours the task is
      // opened anyway, then the error goes back to the job and the sweep tries again (review round 2, point 1).
      if ((err instanceof ProviderError || err instanceof ApiError) && now.getTime() - p.pendingExpiresAt.getTime() >= UNRESOLVED_AFTER_MS) {
        await this.unresolved(p.id, p.pendingExpiresAt, now);
      }
      throw err;
    }
  }

  private retrieve(p: { providerAccountId: string; providerPaymentRef: string | null; idempotencyKey: string }): Promise<ProviderPayment | null> {
    return this.gateway.call(p.providerAccountId, 'retrieve', (provider, ctx) =>
      provider.retrievePayment(ctx, p.providerPaymentRef ? { ref: p.providerPaymentRef } : { idempotencyKey: p.idempotencyKey }));
  }

  /** Cancels at the gateway an object left payable by an attempt that already ended; a late success is recorded. */
  private async cancelOrphan(paymentId: string, accountId: string, ref: string | null): Promise<SyncOutcome> {
    if (!ref) return 'unresolved';
    const remote = await this.gateway.call(accountId, 'retrieve', (provider, ctx) => provider.retrievePayment(ctx, { ref }));
    if (!remote) return 'unresolved';
    const after = remote.status === 'requires_action'
      ? await this.gateway.call(accountId, 'cancel', (provider, ctx) => provider.cancelPayment(ctx, ref, `orphan:${paymentId}:cancel`))
      : remote;
    if (after.status === 'succeeded') await this.attempts.record(paymentId, after, 'sweep');
    return after.status === 'cancelled' || after.status === 'failed' || after.status === 'succeeded' ? 'applied' : 'still_pending';
  }

  private async settle(p: { id: string; providerAccountId: string; providerPaymentRef: string | null; idempotencyKey: string; pendingExpiresAt: Date }, action: 'cancel' | 'expire', now: Date): Promise<SyncOutcome> {
    const remote = await this.retrieve(p);
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
