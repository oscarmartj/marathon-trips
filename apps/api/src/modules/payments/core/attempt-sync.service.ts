import { Inject, Injectable } from '@nestjs/common';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import type { PaymentMethod, PaymentRefreshView } from '@mt/shared';
import { ApiError, notFound } from '../../../platform/http/api-error';
import { readBookingForPayments } from '../../bookings';
import { LIVE_STATUSES, PaymentStateMachine, lockPayment } from './attempt-state';
import type { AttemptEvent } from './attempt-state';
import { PAYMENT_TX_OPTIONS, PaymentAttemptsService } from './attempts.service';
import type { ReplaceOutcome } from './attempts.service';
import { ProviderGateway } from './gateway';
import { ProviderError } from './provider';
import type { ProviderPayment } from './provider';

/** A failure of a call to the gateway (whatever it threw), carried up to run() with the original error. */
class GatewayCallFailure extends Error {
  constructor(readonly original: unknown) {
    super('gateway call failed');
  }
}

export type SyncAction = 'sync' | 'cancel' | 'expire' | 'cancel_orphan' | 'replace';
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
  ) {
    attempts.useReplacer((id) => this.replace(id));
  }

  /**
   * Replacing a live attempt the customer no longer wants (plan 3.2, section 4): exactly the cancellation path, so it
   * ends only when the gateway confirms the cancellation; then says what happened to it.
   */
  async replace(paymentId: string): Promise<ReplaceOutcome> {
    const outcome = await this.run(paymentId, 'replace');
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } });
    if (p.status === 'succeeded') return 'recorded';
    return outcome === 'applied' && !LIVE_STATUSES.includes(p.status) ? 'replaced' : 'unresolved';
  }

  /**
   * The customer's "where does my payment stand" (task 3.5, plan section 3): a live attempt is read from the gateway and
   * recorded exactly as the sweep does; then the latest attempt and the booking status are returned. It never creates
   * an attempt. A gateway that cannot be reached leaves things as they are: the page keeps asking. A coverage failure
   * still reaches the customer as the 503 "being processed".
   */
  async refresh(reference: string): Promise<PaymentRefreshView> {
    const b = await readBookingForPayments(this.prisma, { reference });
    if (!b) throw notFound();
    const live = await this.prisma.payment.findUnique({ where: { liveBookingId: b.id }, select: { id: true } });
    if (live) {
      try {
        await this.run(live.id, 'sync');
      } catch (err) {
        const gatewayTrouble = err instanceof ProviderError || (err instanceof ApiError && err.status === 409);
        if (!gatewayTrouble) throw err;
      }
    }
    const latest = await this.prisma.payment.findFirst({ where: { bookingId: b.id }, orderBy: { attemptNumber: 'desc' }, select: { status: true, method: true, amountMinor: true, currency: true } });
    const after = await readBookingForPayments(this.prisma, { id: b.id });
    return {
      bookingStatus: (after ?? b).status,
      attempt: latest ? { status: latest.status, method: latest.method as PaymentMethod, amountMinor: latest.amountMinor.toString(), currency: latest.currency } : null,
    };
  }

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
      return await this.settle(p, action === 'replace' ? 'cancel' : action, now);
    } catch (err) {
      // A gateway that keeps failing (rotated credentials, a retired key version, a refused call…) must not hide a
      // blocked booking: past 24 hours the task is opened anyway, then the error goes back to the job and the sweep
      // tries again (review rounds 2 and 3). Only failures of the gateway call count, never our own conflicts.
      if (err instanceof GatewayCallFailure) {
        if (now.getTime() - p.pendingExpiresAt.getTime() >= UNRESOLVED_AFTER_MS) await this.unresolved(p.id, p.pendingExpiresAt, now);
        throw err.original;
      }
      throw err;
    }
  }

  /** Every gateway call of the expiry and cancellation paths, marked so the caller can tell its failures apart. */
  private async gw<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new GatewayCallFailure(err);
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
    if (after.status === 'cancelled' || after.status === 'failed') {
      // The gateway confirmed nothing can be paid any more: the orphan task is done (review round 3, point 2).
      await this.prisma.$transaction((tx) => this.tasks.closeSystemIn(tx, `payments:orphan:${paymentId}`));
    }
    return after.status === 'cancelled' || after.status === 'failed' || after.status === 'succeeded' ? 'applied' : 'still_pending';
  }

  private async settle(p: { id: string; providerAccountId: string; providerPaymentRef: string | null; idempotencyKey: string; pendingExpiresAt: Date }, action: 'cancel' | 'expire', now: Date): Promise<SyncOutcome> {
    const remote = await this.gw(() => this.retrieve(p));
    if (!remote) return this.unresolved(p.id, p.pendingExpiresAt, now);
    if (remote.status === 'requires_action') {
      const after = await this.gw(() => this.gateway.call(p.providerAccountId, 'cancel', (provider, ctx) => provider.cancelPayment(ctx, remote.ref, `${p.idempotencyKey}:cancel`)));
      return this.finish(p.id, after, action, p.pendingExpiresAt, now);
    }
    return this.finish(p.id, remote, action, p.pendingExpiresAt, now);
  }

  private async finish(paymentId: string, remote: ProviderPayment, action: 'cancel' | 'expire', expiresAt: Date, now: Date): Promise<SyncOutcome> {
    if (remote.status === 'cancelled') {
      const event: AttemptEvent = action === 'cancel' ? 'cancelled' : 'expire_confirmed';
      await runTransaction(this.prisma, async (tx) => {
        const b = await this.attempts.lockBookingOf(tx, paymentId);
        if (!b) throw notFound();
        const p = await lockPayment(tx, b, paymentId);
        if (!p) throw notFound();
        await this.machine.setReference(tx, p, remote.ref);
        if (remote.amount.amountMinor !== p.amountMinor || remote.amount.currency !== p.currency) return this.attempts.mismatchTask(tx, p, b.reference);
        await this.machine.apply(tx, b, p, event, { source: 'sweep' });
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
        // Only while it is still live: one that ended meanwhile needs no task (its end closes any).
        const p = b ? await lockPayment(tx, b, paymentId) : null;
        if (!p || !LIVE_STATUSES.includes(p.status)) return;
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
