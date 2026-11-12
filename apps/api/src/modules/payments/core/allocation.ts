// How the money collected for a booking covers its plan (plan 3.2, section 2; plan 0.1, P7 and P8). Pure and the only
// place this is computed. With refunds, chargebacks, voids and plan changes parked, the only movement is money coming
// in from succeeded payments, so allocation by sequence is an exact function of what was collected: no table yet.
// Task 4.5 creates the append-only PaymentAllocation table from this split (payments in the order of allocateByPayment).
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
}

const bySequence = <T extends { sequence: number }>(items: readonly T[]): T[] => [...items].sort((a, b) => a.sequence - b.sequence);

/** Fills the active items in order of sequence with what was collected; the rest is overpayment. */
export function allocate(items: readonly ActiveItem[], collectedMinor: bigint): Allocation {
  if (collectedMinor < 0n) throw new RangeError('collected cannot be negative');
  let left = collectedMinor;
  const out = bySequence(items).map((i) => {
    const paid = left >= i.amountMinor ? i.amountMinor : left;
    left -= paid;
    return { sequence: i.sequence, amountMinor: i.amountMinor, paidMinor: paid };
  });
  return { items: out, overpaidMinor: left };
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
    let left = p.amountMinor;
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
