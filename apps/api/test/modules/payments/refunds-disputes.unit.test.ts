// Pure parts of task 4.5 (plan docs/plans/4.5-refunds-disputes.md): the refund and dispute state tables, what a payment
// can give back, the booking cells of money going out and the masked destination of a manual refund.
import { describe, expect, it } from 'vitest';
import { coverageEvents } from '../../../src/modules/bookings/coverage';
import { allocate } from '../../../src/modules/payments/core/allocation';
import { destinationHint } from '../../../src/modules/payments/core/app-refunds.service';
import { nextDisputeStatus } from '../../../src/modules/payments/core/disputes.service';
import type { DisputeStatusName } from '../../../src/modules/payments/core/disputes.service';
import { refundableByPayment } from '../../../src/modules/payments/core/refundable';
import type { PaymentMoney } from '../../../src/modules/payments/core/refundable';
import { nextRefundStatus } from '../../../src/modules/payments/core/refunds.service';
import type { RefundEvent, RefundStatusName } from '../../../src/modules/payments/core/refunds.service';

describe('refund_state_event_matrix (plan 0.1, 6.2; plan 4.5, 3.5)', () => {
  const S: RefundStatusName[] = ['requested', 'pending', 'succeeded', 'failed', 'reversed'];
  // Every cell: event × state → the next state or null (no change). The staff confirmation of a manual refund and the
  // definitive refusal of a request are the `succeeded` and `failed` events from `requested`.
  const table: Record<RefundEvent, Record<RefundStatusName, RefundStatusName | null>> = {
    pending: { requested: 'pending', pending: null, succeeded: null, failed: null, reversed: null },
    succeeded: { requested: 'succeeded', pending: 'succeeded', succeeded: null, failed: null, reversed: null },
    failed: { requested: 'failed', pending: 'failed', succeeded: null, failed: null, reversed: null },
    reversal_confirmed: { requested: null, pending: null, succeeded: 'reversed', failed: null, reversed: null },
    // Only apply() moves a failed gateway app refund to succeeded (review H1); the plain table never does.
    late_succeeded: { requested: null, pending: null, succeeded: null, failed: null, reversed: null },
  };
  for (const [event, row] of Object.entries(table) as Array<[RefundEvent, Record<RefundStatusName, RefundStatusName | null>]>) {
    for (const from of S) it(`${event} on ${from} → ${row[from] ?? 'no change'}`, () => expect(nextRefundStatus(from, event)).toBe(row[from]));
  }
});

describe('dispute_state_event_matrix (plan 4.5, 5.2)', () => {
  const S: DisputeStatusName[] = ['open', 'evidence_submitted', 'won', 'lost', 'closed'];
  const expected = (from: DisputeStatusName, said: DisputeStatusName): string => {
    if (from === said) return 'none';
    if (['won', 'lost', 'closed'].includes(from)) return 'review';
    const rank = { open: 0, evidence_submitted: 1, won: 2, lost: 2, closed: 2 } as const;
    return rank[said] > rank[from] ? `move:${said}` : 'none';
  };
  for (const from of S) {
    for (const said of S) {
      it(`${said} on ${from} → ${expected(from, said)}`, () => {
        const n = nextDisputeStatus(from, said);
        expect(n.action === 'move' ? `move:${n.to}` : n.action).toBe(expected(from, said));
      });
    }
  }
  it('a final status never moves, and nothing moves back', () => {
    expect(nextDisputeStatus('lost', 'won')).toEqual({ action: 'review' });
    expect(nextDisputeStatus('evidence_submitted', 'open')).toEqual({ action: 'none' });
  });
});

describe('refundable_is_min_of_payment_share_and_booking_overpayment (plan 4.5, section 2)', () => {
  const at = (n: number) => new Date(1_700_000_000_000 + n * 1000);
  const pay = (id: string, amount: bigint, n: number, over: Partial<PaymentMoney> = {}): PaymentMoney => ({ id, amountMinor: amount, succeededAt: at(n), refundedMinor: 0n, reservedMinor: 0n, withdrawnMinor: 0n, disputed: false, ...over });
  const items = [{ sequence: 1, amountMinor: 300n }, { sequence: 2, amountMinor: 700n }];

  it('the later payment owns the overpayment; the one that pays the plan can give nothing back', () => {
    const r = refundableByPayment(items, [pay('b', 1000n, 1), pay('a', 400n, 2)]);
    expect(r.map((x) => [x.paymentId, x.refundableMinor])).toEqual([['b', 0n], ['a', 400n]]);
  });

  it('a partial refund: a payment that covers the plan and more gives back only the more', () => {
    const r = refundableByPayment(items, [pay('b', 300n, 1), pay('a', 1000n, 2)]);
    expect(r.find((x) => x.paymentId === 'a')).toMatchObject({ refundableMinor: 300n, netMinor: 1000n });
  });

  it('in-flight refunds are already taken off; a disputed payment gives nothing; a receivable leaves nothing', () => {
    expect(refundableByPayment(items, [pay('b', 1000n, 1), pay('a', 400n, 2, { reservedMinor: 150n })]).find((x) => x.paymentId === 'a')!.refundableMinor).toBe(250n);
    expect(refundableByPayment(items, [pay('b', 1000n, 1), pay('a', 400n, 2, { disputed: true })]).find((x) => x.paymentId === 'a')).toMatchObject({ refundableMinor: 0n, blocked: 'disputed' });
    expect(refundableByPayment([], [pay('a', 400n, 1, { refundedMinor: 400n, withdrawnMinor: 400n }), pay('b', 100n, 2)]).map((x) => x.refundableMinor)).toEqual([0n, 0n]);
  });

  it('property: no refund ever touches the plan, and the shares never exceed the booking overpayment (2,000 seeded cases)', () => {
    let seed = 20261119;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const int = (n: number) => BigInt(Math.floor(r() * n));
    for (let k = 0; k < 2000; k++) {
      const its = Array.from({ length: Math.floor(r() * 3) }, (_, i) => ({ sequence: i + 1, amountMinor: 1n + int(1000) }));
      const ps = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => {
        const amount = 1n + int(1500);
        const refunded = r() < 0.3 ? int(Number(amount)) : 0n;
        const reserved = r() < 0.3 ? int(Number(amount - refunded) + 1) : 0n;
        return pay(`p${i}`, amount, Math.floor(r() * 100), { refundedMinor: refunded, reservedMinor: reserved, disputed: r() < 0.1 });
      });
      const out = refundableByPayment(its, ps);
      const allocatable = ps.reduce((s, p) => s + p.amountMinor - p.refundedMinor - p.reservedMinor, 0n);
      const over = allocate(its, allocatable).overpaidMinor;
      for (const x of out) {
        expect(x.refundableMinor >= 0n && x.refundableMinor <= over).toBe(true);
        const p = ps.find((q) => q.id === x.paymentId)!;
        expect(x.refundableMinor <= p.amountMinor - p.refundedMinor - p.reservedMinor).toBe(true);
        // Refunding it leaves every item as paid as before.
        const after = allocate(its, allocatable - x.refundableMinor);
        expect(after.items.map((i) => i.paidMinor)).toEqual(allocate(its, allocatable).items.map((i) => i.paidMinor));
      }
    }
  });
});

describe('money-out cells of the booking (plan 0.1, 6.2; plan 4.5, section 7 and 14.5)', () => {
  const covered = { depositCovered: true, totalCovered: true };
  const none = { depositCovered: false, totalCovered: false };
  it.each([
    ['cancelled_with_negative_collected_moves_to_refunded', 'cancelled', -200n, true, ['fully_refunded']],
    ['cancelled, everything back', 'cancelled', 0n, true, ['fully_refunded']],
    ['voided_only_payment_keeps_cancelled', 'cancelled', 0n, false, []],
    ['cancelled, money still held', 'cancelled', 1n, true, []],
    ['refunded, money back again', 'refunded', 1n, true, ['money_returned']],
    ['refunded, receivable', 'refunded', -5n, true, []],
  ] as const)('%s', (_name, status, collected, ever, events) => {
    expect(coverageEvents(status, { ...none, cash: { collectedMinor: collected, everCollected: ever } }, false)).toEqual(events);
  });
  it('balance_paid no longer covered goes back to confirmed; a deposit no longer covered moves nothing', () => {
    expect(coverageEvents('balance_paid', { depositCovered: true, totalCovered: false, cash: { collectedMinor: 1n, everCollected: true } }, false)).toEqual(['total_uncovered']);
    expect(coverageEvents('confirmed', { ...none, cash: { collectedMinor: 0n, everCollected: true } }, false)).toEqual([]);
    expect(coverageEvents('deposit_paid', { ...none, cash: { collectedMinor: 0n, everCollected: true } }, false)).toEqual([]);
    expect(coverageEvents('confirmed', { ...covered, cash: { collectedMinor: 5n, everCollected: true } }, false)).toEqual(['total_covered']);
  });
});

describe('manual refund destination hint (P13)', () => {
  it('keeps only the last digits', () => {
    expect(destinationHint({ payId: null, bank: { bsb: '062-000', accountNumber: '12345678' } })).toBe('BSB 062-••• acct •••678');
    expect(destinationHint({ payId: { type: 'email', value: 'ada@example.com' }, bank: null })).toBe('PayID a•••.com');
  });
});

describe('only_state_machines_write_refund_and_dispute_status (plan 4.5)', () => {
  it('only the dispute service writes a dispute status, and no controller writes either', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const SRC = join(__dirname, '../../../src');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f === 'generated' ? [] : walk(join(d, f))) : f.endsWith('.ts') ? [join(d, f)] : []));
    const writers = walk(SRC).filter((f) => /UPDATE disputes SET status|dispute\.(update|updateMany|upsert)\(/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(writers).toEqual(['modules/payments/core/disputes.service.ts']);
    const controllers = walk(SRC).filter((f) => /controller/.test(f)).filter((f) => /UPDATE (refunds|disputes)/.test(readFileSync(f, 'utf8')));
    expect(controllers).toEqual([]);
  });
});

describe('allocation_with_reservations_and_receivable_invariants_hold (P8 with 4.5, 2,000 seeded cases)', () => {
  it('paid + overpaid + receivable = allocatable; receivable only when nothing is paid; reservations never fill an item', () => {
    let seed = 4512;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const int = (n: number) => BigInt(Math.floor(r() * n));
    for (let k = 0; k < 2000; k++) {
      const items = Array.from({ length: Math.floor(r() * 4) }, (_, i) => ({ sequence: i + 1, amountMinor: 1n + int(800) }));
      const collected = int(3000) - 1000n;
      const reserved = collected > 0n ? int(Number(collected) + 1) : 0n;
      const a = allocate(items, collected - reserved);
      const paid = a.items.reduce((s, i) => s + i.paidMinor, 0n);
      expect(paid + a.overpaidMinor + a.receivableMinor).toBe(collected - reserved);
      expect(a.receivableMinor <= 0n && a.overpaidMinor >= 0n).toBe(true);
      if (a.receivableMinor < 0n) expect(paid).toBe(0n);
      for (const i of a.items) expect(i.paidMinor >= 0n && i.paidMinor <= i.amountMinor).toBe(true);
      // The items never hold more than what is left once reservations are taken off.
      expect(paid <= (collected - reserved > 0n ? collected - reserved : 0n)).toBe(true);
    }
  });
});
