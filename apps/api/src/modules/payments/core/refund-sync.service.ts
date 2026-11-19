import { Inject, Injectable } from '@nestjs/common';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { readBookingForPayments } from '../../bookings';
import { lockPayment } from './attempt-state';
import { ProviderGateway } from './gateway';
import { PAYMENT_TX_OPTIONS } from './payable-states';
import { LATE_PENDING_CODE, PaymentRefundStateMachine, lockRefund, refundEventOf } from './refunds.service';
import { MANUAL_KEY } from '../adapters/manual/manual';

/** Refunds left `requested` or `pending` this long are read again from the gateway (plan 0.1, 6.2; plan 3.3, 12.6). */
export const REFUND_REQUERY_AFTER_MS = 24 * 3_600_000;

export type RefundRequery = 'applied' | 'still_pending' | 'unknown_at_gateway';

/** Reads a refund's real state from the gateway and applies it (sweep of plan 3.3, 12.6). */
@Injectable()
export class PaymentRefundSyncService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentRefundStateMachine) private readonly machine: PaymentRefundStateMachine,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  /** Refunds still open after 24 hours, oldest first. */
  async due(now: Date, limit = 50): Promise<string[]> {
    const rows = await this.prisma.refund.findMany({
      // Task 4.5 (plan review, 4): a manual refund has no gateway to ask; it waits for Oscar's transfer (its own task).
      // Re-review, M2: a refund we failed that the gateway was still processing is asked about too, so a lost webhook
      // never blocks the booking for good.
      where: {
        OR: [{ status: { in: ['requested', 'pending'] } }, { status: 'failed', origin: 'app', failureCode: LATE_PENDING_CODE, providerRefundRef: { not: null } }],
        manualRefund: false, payment: { adapterKey: { not: MANUAL_KEY } }, updatedAt: { lte: new Date(now.getTime() - REFUND_REQUERY_AFTER_MS) },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async requery(refundId: string): Promise<RefundRequery> {
    const row = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, select: { id: true, paymentId: true, bookingId: true, providerAccountId: true, providerRefundRef: true, idempotencyKey: true, createdAt: true, payment: { select: { providerPaymentRef: true } } } });
    const remote = row.providerRefundRef
      ? await this.gateway.call(row.providerAccountId, 'retrieve', (provider, ctx) => provider.retrieveRefund(ctx, { ref: row.providerRefundRef! }))
      : row.payment.providerPaymentRef
        ? await this.gateway.call(row.providerAccountId, 'retrieve', (provider, ctx) => provider.retrieveRefund(ctx, { idempotencyKey: row.idempotencyKey, paymentRef: row.payment.providerPaymentRef!, createdAt: row.createdAt }))
        : null;
    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: row.bookingId }, true);
      const p = b ? await lockPayment(tx, b, row.paymentId) : null;
      const r = p ? await lockRefund(tx, p, row.id) : null;
      if (!b || !p || !r) return 'unknown_at_gateway' as const;
      if (r.status === 'failed' && remote && remote.amount.amountMinor === r.amountMinor) {
        // A late pending one: the gateway's word settles it (made, still in progress, or failed: the block is lifted).
        // Unknown at the gateway, it stays blocked with a task below: staff resolve it.
        const handled = await this.machine.gatewayMovedFailedRefund(tx, b, p, r, remote, 'sweep');
        if (!handled) await this.machine.clearLatePending(tx, b, r);
        return handled && remote.status === 'pending' ? ('still_pending' as const) : ('applied' as const);
      }
      if (remote && remote.amount.amountMinor === r.amountMinor) {
        const to = await this.machine.apply(tx, b, p, r, refundEventOf(remote.status), { source: 'sweep', failureCode: remote.failureCode });
        if (to) return 'applied' as const;
      }
      await this.tasks.createSystemIn(tx, {
        title: `Refund on booking ${b.reference} is still not settled`,
        description: remote ? 'A refund has been in progress at the payment gateway for more than a day. Check it with the gateway.' : 'A refund we recorded cannot be found at the payment gateway. Check it with the gateway.',
        entityType: 'Refund', entityId: r.id, sourceRef: `payments:refund_pending:${r.id}`,
      });
      return remote ? ('still_pending' as const) : ('unknown_at_gateway' as const);
    }, PAYMENT_TX_OPTIONS);
  }
}
