// What each payment of a booking can give back now (plan docs/plans/4.5-refunds-disputes.md, section 2). The only place
// a refund amount is computed: from the plan, the payments, the refunds and the disputes, never from a request.
import type { Prisma } from '../../../generated/prisma/client';
import { allocate, overpaymentByPayment } from './allocation';
import type { ActiveItem } from './payable';

type Tx = Prisma.TransactionClient;

export interface PaymentMoney {
  id: string;
  amountMinor: bigint;
  succeededAt: Date;
  /** Succeeded refunds of this payment. */
  refundedMinor: bigint;
  /** App refunds of this payment still requested or pending. */
  reservedMinor: bigint;
  /** Chargebacks withdrawn and not reinstated. */
  withdrawnMinor: bigint;
  /** A dispute open, with evidence submitted, or lost. */
  disputed: boolean;
  /**
   * Review of the code, H2: a refund made on the gateway's dashboard is still in progress somewhere on the booking.
   * Until it settles nobody knows what it takes, so nothing is refunded from the app (P10, in-flight + new).
   */
  externalPending?: boolean;
  /** Re-review, M1: a dispute still open on any payment of the booking (the same rule as secondPayoutRisk). */
  bookingDisputeOpen?: boolean;
}

export interface Refundable {
  paymentId: string;
  /** amount − refunded − withdrawn: what is left of the payment at the gateway, reservations included. */
  netMinor: bigint;
  /** The overpayment this payment owns, its in-flight refunds already taken off. */
  overpaymentMinor: bigint;
  /** What one refund from the app may take now: 0 when disputed. */
  refundableMinor: bigint;
  blocked: 'disputed' | 'booking_disputed' | 'external_refund_in_progress' | null;
}

/**
 * Pure (plan 4.5, section 2): `refundable(p) = min(overpayment share of p, booking overpayment)`, 0 when the payment is
 * disputed. Overpayment shares come from allocateByPayment over each payment's net less its reservations, in order of
 * (succeededAt, id); the booking's overpayment from the allocation of what is allocatable.
 */
export function refundableByPayment(items: readonly ActiveItem[], payments: readonly PaymentMoney[]): Refundable[] {
  const avail = payments.map((p) => ({ id: p.id, amountMinor: p.amountMinor - p.refundedMinor - p.withdrawnMinor - p.reservedMinor, succeededAt: p.succeededAt }));
  const allocatable = avail.reduce((s, p) => s + p.amountMinor, 0n);
  const bookingOver = allocate(items, allocatable).overpaidMinor;
  const shares = overpaymentByPayment(items, avail);
  return payments.map((p) => {
    const share = shares.get(p.id) ?? 0n;
    const capped = share < bookingOver ? share : bookingOver;
    const blocked = p.disputed ? 'disputed' as const : p.bookingDisputeOpen ? 'booking_disputed' as const : p.externalPending ? 'external_refund_in_progress' as const : null;
    return {
      paymentId: p.id, netMinor: p.amountMinor - p.refundedMinor - p.withdrawnMinor, overpaymentMinor: share,
      refundableMinor: blocked ? 0n : capped, blocked,
    };
  });
}

/** Reads what refundableByPayment needs for one booking in one mode. The caller holds the booking's lock. */
export async function loadRefundable(tx: Pick<Tx, '$queryRaw' | 'paymentScheduleItem'>, bookingId: string, mode: 'test' | 'live'): Promise<Refundable[]> {
  const items = await tx.paymentScheduleItem.findMany({ where: { bookingId, state: 'active' }, select: { sequence: true, amountMinor: true } });
  const rows = await tx.$queryRaw<Array<{ id: string; amountMinor: bigint; succeededAt: Date; refunded: bigint; reserved: bigint; withdrawn: bigint; disputed: boolean; externalPending: boolean; bookingDisputeOpen: boolean }>>`
    SELECT p.id::text AS id, p."amountMinor", p."succeededAt",
      COALESCE((SELECT sum(r."amountMinor") FROM refunds r WHERE r."paymentId" = p.id AND r.status = 'succeeded'), 0)::bigint AS refunded,
      COALESCE((SELECT sum(r."amountMinor") FROM refunds r WHERE r."paymentId" = p.id AND r.origin = 'app' AND r.status IN ('requested', 'pending')), 0)::bigint AS reserved,
      COALESCE((SELECT sum(d."amountMinor") FROM disputes d WHERE d."paymentId" = p.id AND d."fundsWithdrawnAt" IS NOT NULL AND d."fundsReinstatedAt" IS NULL), 0)::bigint AS withdrawn,
      EXISTS (SELECT 1 FROM disputes d WHERE d."paymentId" = p.id AND d.status IN ('open', 'evidence_submitted', 'lost')) AS disputed,
      EXISTS (SELECT 1 FROM disputes d WHERE d."bookingId" = p."bookingId" AND d.mode = ${mode}::"PaymentMode" AND d.status IN ('open', 'evidence_submitted')) AS "bookingDisputeOpen",
      EXISTS (SELECT 1 FROM refunds r WHERE r."bookingId" = p."bookingId" AND r.mode = ${mode}::"PaymentMode" AND ((r.origin = 'external' AND r.status = 'pending')
        OR (r.origin = 'app' AND r.status = 'failed' AND r."failureCode" = 'late_pending_at_gateway'))) AS "externalPending"
    FROM payments p WHERE p."bookingId" = ${bookingId}::uuid AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded'
    ORDER BY p."succeededAt", p.id`;
  return refundableByPayment(items, rows.map((r) => ({ id: r.id, amountMinor: r.amountMinor, succeededAt: r.succeededAt, refundedMinor: r.refunded, reservedMinor: r.reserved, withdrawnMinor: r.withdrawn, disputed: r.disputed, externalPending: r.externalPending, bookingDisputeOpen: r.bookingDisputeOpen })));
}
