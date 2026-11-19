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

export function payable(items: readonly ActiveItem[], collectedMinor: bigint, upToSequence?: number): Payable {
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

export const netCollectedSource: CollectedAmountSource = {
  async collected(db, bookingId, mode) {
    const paid = await db.payment.aggregate({ where: { bookingId, mode, status: 'succeeded' }, _sum: { amountMinor: true } });
    const refunded = await db.refund.aggregate({ where: { bookingId, mode, status: 'succeeded' }, _sum: { amountMinor: true } });
    const net = (paid._sum.amountMinor ?? 0n) - (refunded._sum.amountMinor ?? 0n);
    // Refunds never exceed their payments (gateway and our cap): a negative net is a broken invariant, not money.
    if (net < 0n) throw new RangeError('refunds exceed payments for a booking');
    return net;
  },
};
