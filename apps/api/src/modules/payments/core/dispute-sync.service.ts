// The dispute sweep of the daily reconciliation (plan docs/plans/4.6-reconciliation-receipts.md, section 2.2 and review
// R5, R9): a dispute whose last webhook was lost is brought up to date from the gateway, through the same code the
// webhook uses (applyRemote), so a final outcome lifts the booking's dispute hold. A gateway dispute of one of our
// payments that we never heard of is registered the same way.
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { readBookingForPayments } from '../../bookings';
import { lockPayment } from './attempt-state';
import { PaymentDisputesService } from './disputes.service';
import { PAYMENT_TX_OPTIONS } from './payable-states';
import type { ProviderDispute } from './provider';
import { ProviderError } from './provider';
import type { Difference } from './reconciliation-types';
import { moneySide } from './reconciliation-types';
import type { GatewayCaller } from './settlements.service';

type Mode = 'test' | 'live';
const FINAL = new Set(['won', 'lost', 'closed']);

const sameFacts = (d: { status: string; fundsWithdrawnAt: Date | null; fundsReinstatedAt: Date | null }, r: ProviderDispute): boolean =>
  d.status === r.status && (d.fundsWithdrawnAt !== null) === r.fundsWithdrawn && (d.fundsReinstatedAt !== null) === r.fundsReinstated;

@Injectable()
export class DisputeSyncService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentDisputesService) private readonly disputes: PaymentDisputesService,
  ) {}

  /**
   * Every open dispute of the account not changed in the last `settleMs` is read at the gateway; if the gateway says
   * something else, it is applied. Returns the differences that remain (unknown at the gateway, refused facts).
   */
  async sweep(accountId: string, mode: Mode, sweepId: string, call: GatewayCaller, opts: { now: Date; settleMs: number }): Promise<{ differences: Difference[]; checked: number; applied: number; errors: number }> {
    const open = await this.prisma.dispute.findMany({
      where: { providerAccountId: accountId, mode, status: { in: ['open', 'evidence_submitted'] }, updatedAt: { lt: new Date(opts.now.getTime() - opts.settleMs) } },
      select: { id: true, providerDisputeRef: true, status: true, updatedAt: true, version: true, fundsWithdrawnAt: true, fundsReinstatedAt: true, amountMinor: true, currency: true },
      orderBy: { updatedAt: 'asc' }, take: 1000,
    });
    const differences: Difference[] = [];
    let applied = 0;
    let errors = 0;
    for (const d of open) {
      // Code review, minor 5: one dispute the gateway answers badly is skipped; an outage (the caller's cut-off, which is
      // not a ProviderError) or bad credentials still stop the run.
      let remote: ProviderDispute | null;
      try {
        remote = await call(async (p, ctx) => (p.retrieveDispute ? p.retrieveDispute(ctx, d.providerDisputeRef) : null));
      } catch (err) {
        if (err instanceof ProviderError && err.code !== 'provider_auth_failed') {
          errors += 1;
          continue;
        }
        throw err;
      }
      if (!remote) {
        differences.push({ code: 'dispute_unknown_at_gateway', entityType: 'Dispute', entityId: d.id, ours: moneySide(d.amountMinor, d.currency, d.status) });
        continue;
      }
      if (sameFacts(d, remote)) continue;
      const out = await this.apply(accountId, remote, `sweep:${d.id}:${sweepId}`, { id: d.id, version: d.version });
      if (out === 'applied') applied += 1;
      else if (out !== 'skipped') differences.push({ code: 'dispute_status_differs', entityType: 'Dispute', entityId: d.id, ours: moneySide(d.amountMinor, d.currency, d.status), gateway: moneySide(remote.amount.amountMinor, remote.amount.currency, remote.status) });
    }
    return { differences, checked: open.length, applied, errors };
  }

  /**
   * Applies what the gateway says of a dispute under the locks the webhook takes (Booking → its payments → payment →
   * dispute). `seen` is the dispute as read before the gateway was asked (review R5): if it changed meanwhile (a webhook
   * got there first) or is already final, nothing is applied. Without `seen`, a dispute we do not know yet is created.
   */
  async apply(accountId: string, remote: ProviderDispute, eventId: string, seen?: { id: string; version: number }): Promise<'applied' | 'skipped' | 'not_our_payment' | string> {
    const payment = await this.prisma.payment.findFirst({ where: { providerAccountId: accountId, providerPaymentRef: remote.paymentRef, status: 'succeeded' }, select: { id: true, bookingId: true } });
    if (!payment) return 'not_our_payment';
    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: payment.bookingId }, true);
      if (!b) return 'not_our_payment';
      await tx.$queryRaw`SELECT id FROM payments WHERE "bookingId" = ${b.id}::uuid ORDER BY id FOR UPDATE`;
      const p = await lockPayment(tx, b, payment.id);
      if (!p || p.status !== 'succeeded') return 'not_our_payment';
      const [now] = await tx.$queryRaw<Array<{ id: string; version: number; status: string }>>`
        SELECT id::text AS id, version, status::text AS status FROM disputes WHERE "providerAccountId" = ${accountId}::uuid AND "providerDisputeRef" = ${remote.ref}`;
      if (seen ? !now || now.id !== seen.id || now.version !== seen.version || FINAL.has(now.status) : !!now) return 'skipped';
      const out = await this.disputes.applyRemote(tx, b, p, accountId, remote, eventId);
      return out.kind === 'processed' ? 'applied' : out.code;
    }, PAYMENT_TX_OPTIONS);
  }
}
