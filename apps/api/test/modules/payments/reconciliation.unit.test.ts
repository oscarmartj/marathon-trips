// Pure rules of task 4.6 (plan docs/plans/4.6-reconciliation-receipts.md): GST arithmetic (not wired: registration
// cannot be switched on), the customer money report, document causes and settlement arithmetic.
import { describe, expect, it } from 'vitest';
import { tripMoney } from '../../../src/modules/payments/core/client-money.service';
import type { BookingMoney } from '../../../src/modules/payments/core/client-money.service';
import { bookingGst, cumulativeGst, documentGst, gstTreatment, mulDivHalfUpAny } from '../../../src/modules/payments/core/gst';
import { DOCUMENT_TITLES, causeKeyOfEvent, causeOf, formatAmount, renderDocument } from '../../../src/modules/payments/core/receipts.service';
import type { DocumentContent } from '../../../src/modules/payments/core/receipts.service';
import { dedupe, differencesSchema } from '../../../src/modules/payments/core/reconciliation-types';
import { settlementConsistent, settlementSha256 } from '../../../src/modules/payments/core/settlements.service';
import { PAYMENT_SETTINGS } from '../../../src/modules/payments/core/settings';

const id = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('GST arithmetic (not wired; plan 4.6, 4.2)', () => {
  it('gst_rounding_half_up_table: one rule, half up on the absolute value', () => {
    const table: Array<[bigint, bigint]> = [[0n, 0n], [1n, 0n], [5n, 0n], [6n, 1n], [11n, 1n], [16n, 1n], [17n, 2n], [110n, 10n], [1_099_999n, 100_000n], [-6n, -1n], [-5n, 0n], [-17n, -2n]];
    for (const [total, gst] of table) expect(mulDivHalfUpAny(total, 1n, 11n), `${total}`).toBe(gst);
    expect(mulDivHalfUpAny(10n, 1n, 4n)).toBe(3n); // 2.5 → 3
    expect(mulDivHalfUpAny(-10n, 1n, 4n)).toBe(-3n);
    expect(() => mulDivHalfUpAny(1n, 1n, 0n)).toThrow();
  });

  it('gst_treatment_by_race_country: Australia taxable, elsewhere not, missing unknown', () => {
    expect(gstTreatment('AU')).toBe('taxable');
    expect(gstTreatment('NZ')).toBe('not_taxable');
    expect(gstTreatment(null)).toBe('unknown');
    expect(gstTreatment('zz')).toBe('unknown');
    expect(bookingGst(110_000n, 'not_taxable')).toBe(0n);
    expect(bookingGst(110_000n, 'taxable')).toBe(10_000n);
    expect(() => bookingGst(1n, 'unknown')).toThrow();
  });

  it('receipt_gst_sums_to_booking_gst: documents follow customer_funds, never go below zero, and add up when paid', () => {
    // Property test over random sequences of postings moving customer_funds (payments, refunds, chargebacks, approval and
    // plan reallocations) and total changes; the funds balance after each posting is what a document records (R6).
    let seed = 46;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 2000; run++) {
      let total = BigInt(1000 + rand(500_000));
      let gst = bookingGst(total, 'taxable');
      let funds = 0n;
      let docsGst = 0n;
      const steps = 1 + rand(8);
      for (let s = 0; s < steps; s++) {
        const r = rand(10);
        if (r < 6) funds += BigInt(1 + rand(Number(total)));
        else if (r < 8) funds -= BigInt(rand(Number(funds < 0n ? 1n : funds) + 1));
        else {
          total = BigInt(1000 + rand(500_000));
          gst = bookingGst(total, 'taxable');
        }
        if (funds > total) funds = total; // what is beyond the total is an overpayment, not funds
        if (funds < 0n) funds = 0n;
        const d = documentGst({ bookingGstMinor: gst, totalMinor: total, fundsAfterMinor: funds, earlierDocumentsGstMinor: docsGst });
        docsGst += d;
        expect(docsGst, 'accumulated GST is never negative').toBeGreaterThanOrEqual(0n);
        expect(docsGst).toBe(cumulativeGst(gst, total, funds));
      }
      // Paid in full: the documents carry exactly the booking's GST.
      const last = documentGst({ bookingGstMinor: gst, totalMinor: total, fundsAfterMinor: total, earlierDocumentsGstMinor: docsGst });
      expect(docsGst + last).toBe(gst);
    }
    // A payment never lowers the accumulated GST: its receipt's delta is never negative.
    for (let f = 0n; f <= 1000n; f += 37n) {
      expect(cumulativeGst(91n, 1000n, f + 37n) - cumulativeGst(91n, 1000n, f)).toBeGreaterThanOrEqual(0n);
    }
  });

  it('gst_registration_cannot_be_switched_on: the setting refuses true (review R7)', () => {
    const s = PAYMENT_SETTINGS.taxRegistration.schema;
    expect(s.safeParse({ gstRegistered: false }).success).toBe(true);
    const on = s.safeParse({ gstRegistered: true });
    expect(on.success).toBe(false);
    expect(JSON.stringify(on.error?.issues)).toContain('cannot be switched on');
  });
});

const b = (over: Partial<BookingMoney> = {}): BookingMoney => ({ fundsMinor: 0n, overpaymentsMinor: 0n, receivableMinor: 0n, feesMinor: 0n, returnDate: '2027-06-10', ...over });

describe('customer money report rules (plan 4.6, 5.0 and review R2)', () => {
  it('report_separates_unpaid_supplier_funds_from_margin: owed to suppliers, margin not earned and earned are apart', () => {
    const before = tripMoney({ bookings: [b({ fundsMinor: 100_000n }), b({ fundsMinor: 50_000n, overpaymentsMinor: 2_000n })], supplierCostMinor: 90_000n, paidToSuppliersMinor: 0n, today: '2027-06-01' });
    expect(before).toMatchObject({ heldMinor: 152_000n, overpaymentsMinor: 2_000n, owedToSuppliersMinor: 90_000n, marginNotEarnedMinor: 60_000n, marginEarnedMinor: 0n, keepSeparateMinor: 152_000n, tripTravelled: false });
    const after = tripMoney({ bookings: [b({ fundsMinor: 100_000n }), b({ fundsMinor: 50_000n, overpaymentsMinor: 2_000n })], supplierCostMinor: 90_000n, paidToSuppliersMinor: 0n, today: '2027-06-11' });
    expect(after).toMatchObject({ owedToSuppliersMinor: 90_000n, marginNotEarnedMinor: 0n, marginEarnedMinor: 60_000n, keepSeparateMinor: 92_000n, tripTravelled: true });
  });

  it('customer_debt_never_offsets_other_customers_money', () => {
    const m = tripMoney({ bookings: [b({ fundsMinor: 0n, receivableMinor: 50_000n }), b({ fundsMinor: 100_000n })], supplierCostMinor: null, paidToSuppliersMinor: 0n, today: '2027-01-01' });
    expect(m.heldMinor).toBe(100_000n);
    expect(m.keepSeparateMinor).toBe(100_000n);
    expect(m.customerDebtMinor).toBe(50_000n);
  });

  it('client_money_without_comparable_costs_keeps_everything and no negative margin', () => {
    const none = tripMoney({ bookings: [b({ fundsMinor: 70_000n })], supplierCostMinor: null, paidToSuppliersMinor: 0n, today: '2028-01-01' });
    expect(none).toMatchObject({ owedToSuppliersMinor: null, marginNotEarnedMinor: null, marginEarnedMinor: 0n, keepSeparateMinor: 70_000n });
    const overCost = tripMoney({ bookings: [b({ fundsMinor: 70_000n })], supplierCostMinor: 90_000n, paidToSuppliersMinor: 0n, today: '2028-01-01' });
    expect(overCost).toMatchObject({ owedToSuppliersMinor: 70_000n, marginEarnedMinor: 0n, keepSeparateMinor: 70_000n });
    // When 6.2 records payments larger than the cost, margin stays at 0 and nothing kept is lowered below the money held.
    const overPaid = tripMoney({ bookings: [b({ fundsMinor: 70_000n })], supplierCostMinor: 10_000n, paidToSuppliersMinor: 90_000n, today: '2026-01-01' });
    expect(overPaid.marginNotEarnedMinor).toBe(0n);
    expect(overPaid.keepSeparateMinor).toBe(70_000n);
  });

  it('a missing return date counts as not travelled', () => {
    const m = tripMoney({ bookings: [b({ fundsMinor: 10_000n, returnDate: null })], supplierCostMinor: 1_000n, paidToSuppliersMinor: 0n, today: '2099-01-01' });
    expect(m.tripTravelled).toBe(false);
    expect(m.marginEarnedMinor).toBe(0n);
  });
});

describe('documents and settlements', () => {
  it('document causes: one per money posting, none for others', () => {
    expect(causeOf(`payment:${id}:succeeded`)).toEqual({ doc: 'receipt', paymentId: id });
    expect(causeOf(`refund:${id}:reversed`)).toEqual({ doc: 'note', kind: 'refund_reversal', refundId: id });
    expect(causeOf(`chargeback:${id}:withdrawn`)).toEqual({ doc: 'note', kind: 'chargeback', disputeId: id });
    expect(causeOf(`inbound:${id}:voided`)).toEqual({ doc: 'note', kind: 'void', paymentId: id });
    expect(causeOf(`schedule:${id}:v2:reallocation`)).toBeNull();
    expect(causeOf(`fee:${id}`)).toBeNull();
    expect(causeKeyOfEvent({ type: 'payments.refund.succeeded', aggregateId: id })).toBe(`refund:${id}:succeeded`);
    expect(causeKeyOfEvent({ type: 'payments.payment.failed', aggregateId: id })).toBeNull();
  });

  it('unregistered_receipt_has_no_gst_or_tax_invoice_words: titles, layout and footer', () => {
    const c: DocumentContent = { title: DOCUMENT_TITLES.receipt, number: 'MT-T-1', issuedOn: '2026-11-20', issuer: 'Marathon Trips', bookingReference: 'MT-ABCDEF', trip: 'Race 2027: Package', description: 'Payment received for booking MT-ABCDEF', method: 'card', amount: formatAmount(123456n, 'AUD'), amountMinor: '123456', currency: 'AUD', footer: 'A record of money received or returned for the booking above.' };
    const text = [...Object.values(DOCUMENT_TITLES), ...Object.values(c)].join(' ');
    expect(/gst|tax invoice/i.test(text)).toBe(false);
    expect(c.amount).toBe('A$1,234.56');
    const pdf = renderDocument(c).toString('latin1');
    expect(/gst|tax invoice/i.test(pdf)).toBe(false);
    expect(renderDocument(c).equals(renderDocument({ ...c }))).toBe(true);
  });

  it('settlement arithmetic and fingerprint', () => {
    const s = { ref: 'po_1', payoutDate: '2026-11-20', currency: 'AUD', grossMinor: -500n, feesMinor: 1500n, netMinor: -2000n, lines: [{ ref: 'l1', kind: 'charge' as const, paymentRef: 'p', amountMinor: 1000n, feeMinor: 0n }, { ref: 'l2', kind: 'dispute_withdrawal' as const, paymentRef: 'p', disputeRef: 'd', amountMinor: -1500n, feeMinor: 1500n }] };
    expect(settlementConsistent(s)).toBe(true);
    expect(settlementConsistent({ ...s, netMinor: -1999n })).toBe(false);
    expect(settlementSha256(s)).toBe(settlementSha256({ ...s, lines: [...s.lines].reverse() }));
    expect(settlementSha256(s)).not.toBe(settlementSha256({ ...s, lines: [{ ...s.lines[0]!, feeMinor: 1n }, s.lines[1]!] }));
  });

  it('reconciliation_differences_have_no_pii: the schema takes codes, ids and amounts only', () => {
    expect(differencesSchema.safeParse([{ code: 'payment_amount_differs', entityType: 'Payment', entityId: id, ours: { amountMinor: '100', currency: 'AUD', status: 'succeeded' } }]).success).toBe(true);
    expect(differencesSchema.safeParse([{ code: 'payment_amount_differs', entityType: 'Payment', entityId: id, ours: { name: 'Ada Lovelace' } }]).success).toBe(false);
    expect(differencesSchema.safeParse([{ code: 'payment_amount_differs', entityType: 'Payment', entityId: 'ada@example.com' }]).success).toBe(false);
    expect(differencesSchema.safeParse([{ code: 'made_up', entityType: 'Payment', entityId: id }]).success).toBe(false);
    expect(dedupe([{ code: 'receipt_missing', entityType: 'Payment', entityId: id }, { code: 'receipt_missing', entityType: 'Payment', entityId: id }])).toHaveLength(1);
  });
});
