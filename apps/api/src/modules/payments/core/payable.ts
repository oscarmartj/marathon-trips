// What the customer can pay now (plan 3.1, section 4.3): the only place this is computed. "Collected" is net (task 3.3):
// succeeded payments less succeeded refunds, in this environment's mode; a reversed refund no longer counts. Payable
// amounts, coverage and the ledger all read this one number. The method is not an input: no surcharge can depend on it.

export interface ActiveItem {
  sequence: number;
  amountMinor: bigint;
}

export interface Payable {
  /** Sum of active items. */
  owedMinor: bigint;
  collectedMinor: bigint;
  outstandingMinor: bigint;
  /** The item a payment would cover up to, and its amount; null when nothing is due or the sequence is unknown. */
  next: { sequence: number; amountMinor: bigint } | null;
}

const max0 = (x: bigint) => (x > 0n ? x : 0n);

export function payable(items: readonly ActiveItem[], allocatableMinor: bigint, upToSequence?: number): Payable {
  // A receivable (money out beyond money in, task 4.5) is never asked for here: the customer owes the items, and what
  // is owed beyond them is a task for Oscar (plan 4.5, 14.5).
  const collectedMinor = max0(allocatableMinor);
  const sorted = [...items].sort((a, b) => a.sequence - b.sequence);
  const owed = sorted.reduce((s, i) => s + i.amountMinor, 0n);
  const outstanding = max0(owed - collectedMinor);
  let target: number | undefined = upToSequence;
  if (target === undefined) {
    // The first item not yet covered.
    let cumulative = 0n;
    for (const i of sorted) {
      cumulative += i.amountMinor;
      if (cumulative > collectedMinor) {
        target = i.sequence;
        break;
      }
    }
  }
  const upTo = target === undefined ? undefined : sorted.filter((i) => i.sequence <= target!);
  if (target === undefined || !sorted.some((i) => i.sequence === target) || !upTo) return { owedMinor: owed, collectedMinor, outstandingMinor: outstanding, next: null };
  const cumulative = upTo.reduce((s, i) => s + i.amountMinor, 0n);
  const amount = max0(cumulative - collectedMinor) < outstanding ? max0(cumulative - collectedMinor) : outstanding;
  return { owedMinor: owed, collectedMinor, outstandingMinor: outstanding, next: amount > 0n ? { sequence: target, amountMinor: amount } : null };
}

/** Where 3.2 plugs in the allocation table without touching routes or tests. */
export interface CollectedAmountSource {
  collected(db: import('../../../generated/prisma/client').Prisma.TransactionClient, bookingId: string, mode: 'test' | 'live'): Promise<bigint>;
}

/** The money of one booking in one mode (task 4.5, plan section 2). */
export interface BookingCash {
  /** Succeeded payments less succeeded refunds less chargebacks withdrawn and not reinstated: the cash we hold. */
  collectedMinor: bigint;
  /** App refunds requested or pending: already promised back, so no plan item may use them. */
  reservedMinor: bigint;
  /** collected − reserved: what the allocation fills the plan with (negative is a receivable). */
  allocatableMinor: bigint;
  /** A succeeded payment exists (a voided transfer does not count). */
  everCollected: boolean;
}

export async function bookingCash(db: import('../../../generated/prisma/client').Prisma.TransactionClient, bookingId: string, mode: 'test' | 'live'): Promise<BookingCash> {
  const [r] = await db.$queryRaw<Array<{ paid: bigint; payments: bigint; refunded: bigint; reserved: bigint; withdrawn: bigint }>>`
    SELECT
      (SELECT COALESCE(sum("amountMinor"), 0) FROM payments WHERE "bookingId" = ${bookingId}::uuid AND mode = ${mode}::"PaymentMode" AND status = 'succeeded')::bigint AS paid,
      (SELECT count(*) FROM payments WHERE "bookingId" = ${bookingId}::uuid AND mode = ${mode}::"PaymentMode" AND status = 'succeeded')::bigint AS payments,
      (SELECT COALESCE(sum("amountMinor"), 0) FROM refunds WHERE "bookingId" = ${bookingId}::uuid AND mode = ${mode}::"PaymentMode" AND status = 'succeeded')::bigint AS refunded,
      (SELECT COALESCE(sum("amountMinor"), 0) FROM refunds WHERE "bookingId" = ${bookingId}::uuid AND mode = ${mode}::"PaymentMode" AND ((origin = 'app' AND status IN ('requested', 'pending')) OR (origin = 'app' AND status = 'failed' AND "failureCode" = 'late_pending_at_gateway')))::bigint AS reserved,
      (SELECT COALESCE(sum("amountMinor"), 0) FROM disputes WHERE "bookingId" = ${bookingId}::uuid AND mode = ${mode}::"PaymentMode" AND "fundsWithdrawnAt" IS NOT NULL AND "fundsReinstatedAt" IS NULL)::bigint AS withdrawn`;
  const collected = r!.paid - r!.refunded - r!.withdrawn;
  return { collectedMinor: collected, reservedMinor: r!.reserved, allocatableMinor: collected - r!.reserved, everCollected: r!.payments > 0n };
}

/**
 * What the plan is filled with (task 4.5): `allocatable` of bookingCash. Negative when money out exceeded money in
 * (a receivable); payable() never asks for that part.
 */
export const netCollectedSource: CollectedAmountSource = {
  async collected(db, bookingId, mode) {
    return (await bookingCash(db, bookingId, mode)).allocatableMinor;
  },
};
