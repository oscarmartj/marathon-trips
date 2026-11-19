// How the money collected for a booking covers its plan (plan 3.2, section 2; plan 0.1, P7 and P8). Pure and the only
// place this is computed. The split stays derived (task 4.5 decided not to create the PaymentAllocation table, plan
// docs/plans/4.5-refunds-disputes.md, 12.1 and 14.6): it is a function of what is allocatable now (collected less
// refunds still in flight, which keeps their overpayment reserved), filled by sequence. Money out (refunds and
// chargebacks) therefore comes off the overpayment first and then the last items, whatever payment it came from; a
// negative allocatable (a chargeback after a full refund) is a receivable, which later money pays first.
import type { ActiveItem } from './payable';

export interface AllocatedItem {
  sequence: number;
  amountMinor: bigint;
  paidMinor: bigint;
}

export interface Allocation {
  items: AllocatedItem[];
  /** Collected beyond every active item: money to give back (a task for Oscar), never negative. */
  overpaidMinor: bigint;
  /** Owed to us beyond every item (money out exceeded money in), never positive (task 4.5). */
  receivableMinor: bigint;
}

const bySequence = <T extends { sequence: number }>(items: readonly T[]): T[] => [...items].sort((a, b) => a.sequence - b.sequence);

/** Fills the active items in order of sequence with what was collected; the rest is overpayment. */
export function allocate(items: readonly ActiveItem[], collectedMinor: bigint): Allocation {
  const receivable = collectedMinor < 0n ? collectedMinor : 0n;
  let left = collectedMinor < 0n ? 0n : collectedMinor;
  const out = bySequence(items).map((i) => {
    const paid = left >= i.amountMinor ? i.amountMinor : left;
    left -= paid;
    return { sequence: i.sequence, amountMinor: i.amountMinor, paidMinor: paid };
  });
  return { items: out, overpaidMinor: left, receivableMinor: receivable };
}

export interface SucceededPayment {
  id: string;
  amountMinor: bigint;
  succeededAt: Date;
}

export interface PaymentShare {
  paymentId: string;
  /** null: overpayment. */
  sequence: number | null;
  amountMinor: bigint;
}

/**
 * The same split, per payment (plan 3.2, section 11, point 10): payments in order of (succeededAt, id), each filling the
 * items left by the ones before; what is left of a payment is its overpayment. The totals per item equal allocate().
 */
export function allocateByPayment(items: readonly ActiveItem[], payments: readonly SucceededPayment[]): PaymentShare[] {
  const remaining = bySequence(items).map((i) => ({ sequence: i.sequence, left: i.amountMinor }));
  const ordered = [...payments].sort((a, b) => a.succeededAt.getTime() - b.succeededAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const shares: PaymentShare[] = [];
  for (const p of ordered) {
    // A payment whose money all went back (or more, with a chargeback) holds nothing: its excess is the booking's receivable.
    let left = p.amountMinor > 0n ? p.amountMinor : 0n;
    for (const r of remaining) {
      if (left === 0n) break;
      if (r.left === 0n) continue;
      const take = left >= r.left ? r.left : left;
      r.left -= take;
      left -= take;
      shares.push({ paymentId: p.id, sequence: r.sequence, amountMinor: take });
    }
    if (left > 0n) shares.push({ paymentId: p.id, sequence: null, amountMinor: left });
  }
  return shares;
}

export interface CoverageFacts {
  depositCovered: boolean;
  totalCovered: boolean;
  /** What "deposit covered" asks for: everything up to the last deposit item, or the first item if there is none. */
  depositThresholdMinor: bigint;
}

/**
 * The facts of the coverage rule (plan 3.2, section 1.1). Without a deposit item, the deposit is the first item: nobody
 * is confirmed without money unless nothing is owed (assumption 1).
 */
export function coverageFacts(items: ReadonlyArray<ActiveItem & { kind: string }>, collectedMinor: bigint): CoverageFacts {
  const sorted = bySequence(items);
  const owed = sorted.reduce((s, i) => s + i.amountMinor, 0n);
  const lastDeposit = sorted.reduce((last, i, idx) => (i.kind === 'deposit' ? idx : last), -1);
  const upTo = lastDeposit >= 0 ? lastDeposit : sorted.length > 0 ? 0 : -1;
  const threshold = sorted.slice(0, upTo + 1).reduce((s, i) => s + i.amountMinor, 0n);
  return { depositCovered: collectedMinor >= threshold, totalCovered: collectedMinor >= owed, depositThresholdMinor: threshold };
}

/** The overpayment each payment owns (task 4.5, plan 2): its share of what allocateByPayment leaves over. */
export function overpaymentByPayment(items: readonly ActiveItem[], payments: readonly SucceededPayment[]): Map<string, bigint> {
  const out = new Map<string, bigint>(payments.map((p) => [p.id, 0n]));
  for (const s of allocateByPayment(items, payments)) if (s.sequence === null) out.set(s.paymentId, (out.get(s.paymentId) ?? 0n) + s.amountMinor);
  return out;
}
