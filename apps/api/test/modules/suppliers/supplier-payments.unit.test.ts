// Task 6.2, pure parts (plan docs/plans/6.2-supplier-payments.md, sections 3.5, 5 and 6): the report rule with supplier
// payments, the ledger lines of a supplier payment, the posting fingerprint and the Brisbane buckets. Table-driven.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tripMoney } from '../../../src/modules/payments/core/client-money.service';
import type { BookingMoney } from '../../../src/modules/payments/core/client-money.service';
import { assertBalanced, contentSha256, supplierPaymentLines } from '../../../src/modules/payments/core/ledger';
import { addDays, dueBucket, endOfBrisbaneDay, todayInBrisbane } from '../../../src/modules/suppliers/dates';

const b = (over: Partial<BookingMoney> = {}): BookingMoney => ({ fundsMinor: 0n, overpaymentsMinor: 0n, receivableMinor: 0n, feesMinor: 0n, returnDate: '2027-06-21', ...over });

describe('report_subtracts_supplier_payments_from_money_to_keep (section 6, decision D7)', () => {
  // applied A, overpayments O, cost K, paid P → owed, margin (not earned), keep, paid beyond customer money.
  const rows: Array<{ name: string; bookings: BookingMoney[]; cost: bigint | null; paid: bigint; today: string; expect: Record<string, bigint | null> }> = [
    { name: 'P = 0 gives task 4.6 exactly', bookings: [b({ fundsMinor: 100_000n })], cost: 30_000n, paid: 0n, today: '2027-01-01',
      expect: { owedToSuppliersMinor: 30_000n, marginNotEarnedMinor: 70_000n, keepSeparateMinor: 100_000n, paidBeyondCustomerMoneyMinor: 0n } },
    { name: 'P < A: what was paid leaves the money to keep', bookings: [b({ fundsMinor: 100_000n })], cost: 30_000n, paid: 20_000n, today: '2027-01-01',
      expect: { owedToSuppliersMinor: 10_000n, marginNotEarnedMinor: 70_000n, keepSeparateMinor: 80_000n, paidBeyondCustomerMoneyMinor: 0n } },
    { name: 'P = K: nothing owed, margin kept until travel', bookings: [b({ fundsMinor: 100_000n })], cost: 30_000n, paid: 30_000n, today: '2027-01-01',
      expect: { owedToSuppliersMinor: 0n, marginNotEarnedMinor: 70_000n, keepSeparateMinor: 70_000n, paidBeyondCustomerMoneyMinor: 0n } },
    { name: 'P = A', bookings: [b({ fundsMinor: 30_000n })], cost: 50_000n, paid: 30_000n, today: '2027-01-01',
      expect: { owedToSuppliersMinor: 0n, marginNotEarnedMinor: 0n, keepSeparateMinor: 0n, paidBeyondCustomerMoneyMinor: 0n } },
    { name: 'P > A: the rest was the business\'s own money', bookings: [b({ fundsMinor: 10_000n })], cost: 50_000n, paid: 30_000n, today: '2027-01-01',
      expect: { owedToSuppliersMinor: 0n, marginNotEarnedMinor: 0n, keepSeparateMinor: 0n, paidBeyondCustomerMoneyMinor: 20_000n } },
    { name: 'a prepayment with no booking yet', bookings: [], cost: 50_000n, paid: 25_000n, today: '2027-01-01',
      expect: { heldMinor: 0n, owedToSuppliersMinor: 0n, keepSeparateMinor: 0n, paidBeyondCustomerMoneyMinor: 25_000n } },
    { name: 'travelled: the margin is earned and leaves the money to keep', bookings: [b({ fundsMinor: 100_000n })], cost: 30_000n, paid: 30_000n, today: '2027-07-01',
      expect: { owedToSuppliersMinor: 0n, marginEarnedMinor: 70_000n, marginNotEarnedMinor: 0n, keepSeparateMinor: 0n } },
    { name: 'overpayments stay kept even when suppliers took all applied money', bookings: [b({ fundsMinor: 10_000n, overpaymentsMinor: 5_000n })], cost: 50_000n, paid: 40_000n, today: '2027-01-01',
      expect: { overpaymentsMinor: 5_000n, keepSeparateMinor: 5_000n, paidBeyondCustomerMoneyMinor: 30_000n } },
    { name: 'a customer debt never offsets another customer\'s money', bookings: [b({ fundsMinor: 50_000n }), b({ fundsMinor: -20_000n, receivableMinor: 20_000n })], cost: 30_000n, paid: 10_000n, today: '2027-01-01',
      expect: { customerDebtMinor: 20_000n, heldMinor: 50_000n, owedToSuppliersMinor: 20_000n, keepSeparateMinor: 40_000n } },
    { name: 'refunds after paying lower A: more is the business\'s own', bookings: [b({ fundsMinor: 5_000n })], cost: 30_000n, paid: 20_000n, today: '2027-01-01',
      expect: { keepSeparateMinor: 0n, paidBeyondCustomerMoneyMinor: 15_000n } },
    { name: 'costs not comparable (K null): no margin, paid in the trip currency still leaves', bookings: [b({ fundsMinor: 100_000n })], cost: null, paid: 20_000n, today: '2027-01-01',
      expect: { owedToSuppliersMinor: null, marginNotEarnedMinor: null, keepSeparateMinor: 80_000n, paidBeyondCustomerMoneyMinor: 0n } },
  ];
  for (const r of rows) {
    it(r.name, () => {
      const m = tripMoney({ bookings: r.bookings, supplierCostMinor: r.cost, paidToSuppliersMinor: r.paid, today: r.today });
      expect(m).toMatchObject({ ...r.expect, paidToSuppliersMinor: r.paid });
      // Invariants: nothing negative; keep = owed + margin not earned + overpayments when the cost is known.
      for (const v of Object.values(m)) if (typeof v === 'bigint') expect(v >= 0n).toBe(true);
      if (r.cost !== null) expect(m.keepSeparateMinor).toBe(m.owedToSuppliersMinor! + m.marginNotEarnedMinor! + m.overpaymentsMinor);
    });
  }
});

describe('supplier_ledger_posting_balances_per_currency (section 5)', () => {
  const rows = [
    { name: 'in the supplier currency', p: { amountMinor: 760_400n, currency: 'DKK', baseAmountMinor: null, baseCurrency: null },
      lines: [['supplier_payable', 'DKK', 760_400n], ['bank', 'DKK', -760_400n]] },
    { name: 'EUR paid from AUD', p: { amountMinor: 120_000n, currency: 'EUR', baseAmountMinor: 201_234n, baseCurrency: 'AUD' },
      lines: [['supplier_payable', 'EUR', 120_000n], ['fx_conversion', 'EUR', -120_000n], ['fx_conversion', 'AUD', 201_234n], ['bank', 'AUD', -201_234n]] },
    { name: 'JPY (exponent 0) paid from AUD: no rate, amounts as typed', p: { amountMinor: 150_000n, currency: 'JPY', baseAmountMinor: 140_055n, baseCurrency: 'AUD' },
      lines: [['supplier_payable', 'JPY', 150_000n], ['fx_conversion', 'JPY', -150_000n], ['fx_conversion', 'AUD', 140_055n], ['bank', 'AUD', -140_055n]] },
  ] as const;
  for (const r of rows) {
    it(r.name, () => {
      const lines = supplierPaymentLines(r.p);
      expect(lines.map((l) => [l.accountCode, l.currency, l.amountMinor])).toEqual(r.lines);
      expect(() => assertBalanced(lines)).not.toThrow();
    });
  }
  it('refuses 0, a bank amount in the same currency, and an unbalanced mix of currencies', () => {
    expect(() => supplierPaymentLines({ amountMinor: 0n, currency: 'DKK', baseAmountMinor: null, baseCurrency: null })).toThrow();
    expect(() => supplierPaymentLines({ amountMinor: 10n, currency: 'DKK', baseAmountMinor: 10n, baseCurrency: 'DKK' })).toThrow();
    expect(() => assertBalanced([{ accountCode: 'a', currency: 'EUR', amountMinor: 5n }, { accountCode: 'b', currency: 'AUD', amountMinor: -5n }])).toThrow();
  });
});

describe('existing_posting_hashes_unchanged (section 5)', () => {
  it('a booking posting hashes exactly as before task 6.2; a supplier posting includes its payment and line currencies', () => {
    const c = { kind: 'payment', mode: 'test', currency: 'AUD', bookingId: 'b1', paymentId: 'p1', refundId: null, reversesTransactionId: null, description: 'payment_succeeded', lines: [{ accountCode: 'customer_funds', amountMinor: -500n }, { accountCode: 'provider_clearing:x', amountMinor: 500n }] };
    // The 4.6 formula, written out.
    const before = createHash('sha256').update(JSON.stringify([c.kind, c.mode, c.currency, c.bookingId, c.paymentId, c.refundId, c.reversesTransactionId, c.description, [['customer_funds', '-500'], ['provider_clearing:x', '500']]])).digest('hex');
    expect(contentSha256(c)).toBe(before);
    expect(contentSha256({ ...c, supplierPaymentId: null })).toBe(before);
    const sp = { ...c, bookingId: null, paymentId: null, supplierPaymentId: 's1', lines: [{ accountCode: 'fx_conversion', currency: 'AUD', amountMinor: 5n }, { accountCode: 'fx_conversion', currency: 'EUR', amountMinor: -5n }] };
    const swapped = { ...sp, lines: [{ accountCode: 'fx_conversion', currency: 'EUR', amountMinor: 5n }, { accountCode: 'fx_conversion', currency: 'AUD', amountMinor: -5n }] };
    expect(contentSha256(sp)).not.toBe(contentSha256(swapped));
    expect(contentSha256(sp)).not.toBe(contentSha256({ ...sp, supplierPaymentId: 's2' }));
  });
});

describe('supplier_schedule_buckets_brisbane_boundaries (section 3.5)', () => {
  const D = '2031-03-10';
  const rows: Array<[string, string, string | null, string]> = [
    // [now (UTC), today in Brisbane, due date, bucket]
    ['2031-03-01T13:59:59.999Z', '2031-03-01', D, 'later'],
    ['2031-03-02T14:00:00.000Z', '2031-03-03', D, 'upcoming'], // D − 7
    ['2031-03-09T00:00:00.000Z', '2031-03-09', D, 'upcoming'], // D − 1
    ['2031-03-10T13:59:59.999Z', '2031-03-10', D, 'due_today'], // 23:59:59.999 in Brisbane on D
    ['2031-03-10T14:00:00.000Z', '2031-03-11', D, 'overdue'], // 00:00 in Brisbane on D + 1
    ['2031-03-10T14:00:00.000Z', '2031-03-11', null, 'undated'],
  ];
  for (const [now, today, due, bucket] of rows) {
    it(`${now} with due ${due}: ${bucket}`, () => {
      expect(todayInBrisbane(new Date(now))).toBe(today);
      expect(dueBucket(due, todayInBrisbane(new Date(now)))).toBe(bucket);
    });
  }
  it('the end of a Brisbane day is 14:00Z minus 1 ms; days add across months', () => {
    expect(endOfBrisbaneDay(D).toISOString()).toBe('2031-03-10T13:59:59.999Z');
    expect(addDays('2031-02-27', 2)).toBe('2031-03-01');
    expect(addDays('2031-03-01', -1)).toBe('2031-02-28');
  });
});
