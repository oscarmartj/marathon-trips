// The coverage rule, the derived split and the lock order, without a database (plan docs/plans/3.2-payment-plan-coverage.md,
// sections 1, 2 and 11).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BookingStatus } from '@mt/shared';
import { BOOKING_EVENT_TABLE, BOOKING_STATUS_PAIRS, coverageEvents } from '../../../src/modules/bookings';
import { allocate, allocateByPayment, coverageFacts } from '../../../src/modules/payments/core/allocation';
import { payable } from '../../../src/modules/payments/core/payable';
import { readSources } from '../../conventions/module-boundaries';

const STATES: BookingStatus[] = ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed', 'declined', 'expired', 'cancelled', 'refunded'];
const D = (amountMinor: bigint, sequence = 1) => ({ kind: 'deposit', sequence, amountMinor });
const B = (amountMinor: bigint, sequence = 2) => ({ kind: 'balance', sequence, amountMinor });

describe('coverage_facts_table (section 1.1)', () => {
  const cases: Array<[string, Array<{ kind: string; sequence: number; amountMinor: bigint }>, bigint, boolean, boolean, bigint]> = [
    ['deposit and balance, nothing paid', [D(500n), B(1500n)], 0n, false, false, 500n],
    ['deposit and balance, deposit short by 1', [D(500n), B(1500n)], 499n, false, false, 500n],
    ['deposit and balance, deposit exact', [D(500n), B(1500n)], 500n, true, false, 500n],
    ['deposit and balance, part of the balance', [D(500n), B(1500n)], 1999n, true, false, 500n],
    ['deposit and balance, all of it', [D(500n), B(1500n)], 2000n, true, true, 500n],
    ['deposit and balance, more than all', [D(500n), B(1500n)], 2500n, true, true, 500n],
    ['deposit equals total', [D(2000n)], 2000n, true, true, 2000n],
    ['no deposit item: the first item is the deposit', [B(1500n, 1)], 0n, false, false, 1500n],
    ['no deposit item, first item paid', [B(1500n, 1)], 1500n, true, true, 1500n],
    ['total 0: nothing owed, covered', [], 0n, true, true, 0n],
    ['items out of order', [B(1500n), D(500n)], 500n, true, false, 500n],
  ];
  it.each(cases)('%s', (_name, items, collected, deposit, total, threshold) => {
    expect(coverageFacts(items, collected)).toEqual({ depositCovered: deposit, totalCovered: total, depositThresholdMinor: threshold });
  });
});

describe('coverage_events_table (section 1.2): ten states × facts × auto-confirmation', () => {
  const facts = [
    { depositCovered: false, totalCovered: false },
    { depositCovered: true, totalCovered: false },
    { depositCovered: true, totalCovered: true },
  ];
  const expected = (s: BookingStatus, f: (typeof facts)[number], auto: boolean): string[] => {
    if (s === 'approved' && f.depositCovered) return auto ? (f.totalCovered ? ['deposit_covered', 'auto_confirm', 'total_covered'] : ['deposit_covered', 'auto_confirm']) : ['deposit_covered'];
    if (s === 'confirmed' && f.totalCovered) return ['total_covered'];
    // Task 6.3: a change raised the total of a booking paid in full (plan 0.1, 6.2).
    if (s === 'balance_paid' && !f.totalCovered) return ['total_uncovered'];
    return [];
  };
  const cells = STATES.flatMap((s) => facts.flatMap((f) => [true, false].map((auto) => [s, f, auto] as const)));
  it.each(cells)('%s %o auto=%s', (s, f, auto) => {
    expect(coverageEvents(s, f, auto)).toEqual(expected(s, f, auto));
  });

  it('deposit_uncovered_only_when_asked: a voided transfer reopens the approval, a change to the deposit never does', () => {
    const f = { depositCovered: false, totalCovered: false };
    expect(coverageEvents('deposit_paid', f, true)).toEqual([]);
    expect(coverageEvents('deposit_paid', { ...f, reopenDeposit: true }, true)).toEqual(['deposit_uncovered']);
    expect(coverageEvents('deposit_paid', { depositCovered: true, totalCovered: true, reopenDeposit: true }, true)).toEqual([]);
    expect(coverageEvents('confirmed', { ...f, reopenDeposit: true }, true)).toEqual([]);
  });

  it('full_payment_before_confirmation_waits_for_oscar: deposit_paid never jumps to balance_paid', () => {
    expect(coverageEvents('approved', { depositCovered: true, totalCovered: true }, false)).toEqual(['deposit_covered']);
    expect(coverageEvents('deposit_paid', { depositCovered: true, totalCovered: true }, true)).toEqual([]);
  });
});

describe('booking_event_table_within_status_pairs (section 1.3)', () => {
  it('every cell of every event is a pair the trigger allows', () => {
    const pairs = new Set(BOOKING_STATUS_PAIRS.map((p) => p.join('>')));
    const cells = Object.values(BOOKING_EVENT_TABLE).flatMap((t) => Object.entries(t).map(([from, to]) => `${from}>${to}`));
    expect(cells.filter((c) => !pairs.has(c))).toEqual([]);
  });

  it('the coverage events and the approval expiry are the cells of plan 0.1, 6.2', () => {
    expect(BOOKING_EVENT_TABLE.deposit_covered).toEqual({ approved: 'deposit_paid' });
    expect(BOOKING_EVENT_TABLE.auto_confirm).toEqual({ deposit_paid: 'confirmed' });
    expect(BOOKING_EVENT_TABLE.confirm).toEqual({ deposit_paid: 'confirmed' });
    expect(BOOKING_EVENT_TABLE.total_covered).toEqual({ confirmed: 'balance_paid' });
    expect(BOOKING_EVENT_TABLE.total_uncovered).toEqual({ balance_paid: 'confirmed' });
    expect(BOOKING_EVENT_TABLE.deposit_uncovered).toEqual({ deposit_paid: 'approved' });
    expect(BOOKING_EVENT_TABLE.expire_approval).toEqual({ approved: 'expired' });
    // Cancelling a paid booking stays a 409 until refunds exist.
    expect(BOOKING_EVENT_TABLE.cancel).toEqual({ requested: 'cancelled', approved: 'cancelled' });
  });
});

/** A small seeded generator (no new dependency): the same cases on every run. */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

describe('allocation_and_schedule_invariants_hold (section 2, plan 0.1 P8): 2,000 seeded cases', () => {
  it('per item between 0 and its amount, filled in order, nothing lost, overpayment only when all is paid', () => {
    const r = rng(20261113);
    const int = (n: number) => BigInt(Math.floor(r() * n));
    for (let k = 0; k < 2000; k++) {
      const n = Math.floor(r() * 4);
      const items = Array.from({ length: n }, (_, i) => ({ kind: i === 0 && r() < 0.8 ? 'deposit' : 'balance', sequence: i + 1, amountMinor: 1n + int(500_000) }));
      const owed = items.reduce((s, i) => s + i.amountMinor, 0n);
      const payments = Array.from({ length: Math.floor(r() * 4) }, (_, i) => ({ id: `p${i}`, amountMinor: 1n + int(Number(owed) + 1000), succeededAt: new Date(1_700_000_000_000 + Math.floor(r() * 1e6)) }));
      const collected = payments.reduce((s, p) => s + p.amountMinor, 0n);
      const a = allocate(items, collected);
      const paid = a.items.reduce((s, i) => s + i.paidMinor, 0n);
      expect(paid + a.overpaidMinor).toBe(collected);
      expect(a.overpaidMinor >= 0n).toBe(true);
      for (const i of a.items) expect(i.paidMinor >= 0n && i.paidMinor <= i.amountMinor).toBe(true);
      // In order: an item is only touched once every earlier one is full.
      for (let j = 1; j < a.items.length; j++) if (a.items[j]!.paidMinor > 0n) expect(a.items[j - 1]!.paidMinor).toBe(a.items[j - 1]!.amountMinor);
      if (a.overpaidMinor > 0n) expect(a.items.every((i) => i.paidMinor === i.amountMinor)).toBe(true);
      // The per-payment split adds up to the same per item and the same overpayment.
      const shares = allocateByPayment(items, payments);
      for (const i of a.items) expect(shares.filter((s) => s.sequence === i.sequence).reduce((s, x) => s + x.amountMinor, 0n)).toBe(i.paidMinor);
      expect(shares.filter((s) => s.sequence === null).reduce((s, x) => s + x.amountMinor, 0n)).toBe(a.overpaidMinor);
      for (const p of payments) expect(shares.filter((s) => s.paymentId === p.id).reduce((s, x) => s + x.amountMinor, 0n)).toBe(p.amountMinor);
      // The facts agree with the split and with what payable() asks for next.
      const f = coverageFacts(items, collected);
      expect(f.totalCovered).toBe(a.items.every((i) => i.paidMinor === i.amountMinor));
      const next = payable(items, collected).next;
      expect(next === null).toBe(f.totalCovered);
      if (items.length > 0 && items[0]!.kind === 'deposit') expect(f.depositCovered).toBe(a.items[0]!.paidMinor === a.items[0]!.amountMinor);
    }
  });

  // Task 4.5 changes what 3.2 fixed here (plan 4.5, 14.5): money out beyond money in (a chargeback after a full refund)
  // is a receivable, no longer an impossible input. Nothing is paid and nothing is overpaid.
  it('a negative amount collected is a receivable: no item paid, no overpayment', () => {
    const a = allocate([{ sequence: 1, amountMinor: 500n }], -1n);
    expect(a).toEqual({ items: [{ sequence: 1, amountMinor: 500n, paidMinor: 0n }], overpaidMinor: 0n, receivableMinor: -1n });
    expect(payable([{ sequence: 1, amountMinor: 500n }], -1n).outstandingMinor).toBe(500n);
  });
});

describe('allocation_order_by_succeeded_at_then_id (section 11, point 10)', () => {
  it('earlier payments fill earlier items; a tie on time goes by id; what is left of a payment is its overpayment', () => {
    const at = new Date('2026-11-13T00:00:00Z');
    const later = new Date('2026-11-13T00:00:01Z');
    const shares = allocateByPayment([D(500n), B(1500n)], [
      { id: 'c', amountMinor: 1000n, succeededAt: later },
      { id: 'b', amountMinor: 300n, succeededAt: at },
      { id: 'a', amountMinor: 400n, succeededAt: at },
    ]);
    expect(shares).toEqual([
      { paymentId: 'a', sequence: 1, amountMinor: 400n },
      { paymentId: 'b', sequence: 1, amountMinor: 100n },
      { paymentId: 'b', sequence: 2, amountMinor: 200n },
      { paymentId: 'c', sequence: 2, amountMinor: 1000n },
    ]);
    expect(allocateByPayment([D(500n)], [{ id: 'x', amountMinor: 700n, succeededAt: at }])).toEqual([
      { paymentId: 'x', sequence: 1, amountMinor: 500n },
      { paymentId: 'x', sequence: null, amountMinor: 200n },
    ]);
  });
});

describe('static checks (sections 1.3 and 11.11)', () => {
  const src = resolve(__dirname, '../../../src');
  const files = readSources(src);

  it('only_coverage_applies_money_events: the coverage events appear in the state machine table and applyCoverage only', () => {
    const using = files.filter((f) => /'(deposit_covered|auto_confirm|total_covered|total_uncovered|deposit_uncovered)'/.test(f.text)).map((f) => f.name).sort();
    expect(using).toEqual(['modules/bookings/coverage.ts', 'modules/bookings/state-machine.ts']);
    // The panel's route type takes no coverage event.
    expect(readFileSync(join(src, 'modules/bookings/state-machine.ts'), 'utf8')).toMatch(/export type StaffBookingEvent = 'approve' \| 'decline' \| 'cancel' \| 'confirm';/);
  });

  it('lock_payment_requires_locked_booking: every call passes a booking locked in the same transaction', () => {
    const calls = files.flatMap((f) => [...f.text.matchAll(/lockPayment\(([^)]*)\)/g)].map((m) => `${f.name}: ${m[1]}`));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls.filter((x) => !x.includes('attempt-state.ts'))) expect(c).toMatch(/: tx, b, /);
    expect(readFileSync(join(src, 'modules/payments/core/attempt-state.ts'), 'utf8')).toMatch(/export async function lockPayment\(tx: Tx, booking: LockedBooking, paymentId: string\)/);
  });
});
