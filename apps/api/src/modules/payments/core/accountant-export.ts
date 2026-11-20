// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md, section 5): the accountant's CSV files, pure. Text goes through the
// platform's `cell` (quoting and the formula guard on every fragment, 7.fix-5). Money is written as an exact decimal text built
// from the bigint and the currency's decimal places, after a strict pattern check: a spreadsheet reads it as a number, and a
// negative amount is not a formula. Nothing here reads a name, an email or a free-text field.
import { guardCell } from '../../../platform/common/csv';
import { minorToDecimal } from './fx';
import type { FxPair, TripResultRow } from './trip-result.service';

export type ExportCell = string | { money: bigint; currency: string } | null;
export const EXPORT_MAX_ROWS = 50_000;

const NUMBER = /^-?\d+(\.\d+)?$/;

/** The platform's rule for a text cell (7.fix-5): the formula guard on every fragment, then quotes when it holds a quote, comma, semicolon, CR or LF. */
export const textCell = (s: string): string => {
  const g = guardCell(s);
  return /[",;\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g;
};

function exportCell(c: ExportCell): string {
  if (c === null) return '';
  if (typeof c === 'string') return textCell(c);
  const text = minorToDecimal(c.money, c.currency);
  if (!NUMBER.test(text)) throw new RangeError('a money cell is a plain decimal');
  return text;
}

/** A header is fixed text of ours; it is still quoted by the same rule as every cell. */
export function renderExport(header: readonly string[], rows: readonly (readonly ExportCell[])[]): string {
  const lines = [header.map((h) => textCell(h)).join(','), ...rows.map((r) => {
    if (r.length !== header.length) throw new RangeError('a row has the columns of the header');
    return r.map(exportCell).join(',');
  })];
  return `﻿${lines.join('\r\n')}\r\n`;
}

const yes = (b: boolean): string => (b ? 'Yes' : 'No');

export const TRIP_RESULT_HEADER = [
  'Environment', 'Trip', 'Currency', 'Bookings', 'Cancelled bookings', 'Customer money kept', 'Revenue earned', 'Revenue not yet earned', 'Penalties kept after cancellations',
  'Refunded to customers', 'Overpayments to give back', 'Customer debt', 'Gateway fees', 'Gateway fees imported', 'Supplier costs recorded', 'Supplier costs paid', 'Supplier costs unpaid',
  'Costs in other currencies (not converted)', 'Costs counted in the result', 'Result so far (cash)', 'Result expected', 'Result earned (final trips only)', 'Result complete',
] as const;

export function tripResultRows(mode: string, rows: readonly TripResultRow[]): ExportCell[][] {
  return rows.map(({ trip, currency, result: r }) => {
    const m = (v: bigint): ExportCell => ({ money: v, currency });
    const others = r.otherCurrencies.map((o) => `${o.currency} ${minorToDecimal(o.committedMinor, o.currency)} recorded, ${minorToDecimal(o.paidMinor, o.currency)} paid`).join('; ');
    return [
      mode, trip, currency, String(r.bookings), String(r.cancelledBookings), m(r.keptMinor), m(r.earnedRevenueMinor), m(r.notYetEarnedMinor), m(r.penaltiesKeptMinor),
      m(r.refundedMinor), m(r.overpaymentsMinor), m(r.customerDebtMinor), m(r.feesMinor), yes(r.feesImported), m(r.costCommittedMinor), m(r.costPaidMinor), m(r.costUnpaidMinor),
      others, m(r.costInResultMinor), m(r.resultCashMinor), m(r.resultExpectedMinor), r.resultEarnedMinor === null ? null : m(r.resultEarnedMinor),
      yes(!r.warnings.otherCurrencyLeftOut && !r.warnings.feesNotImported && !r.warnings.noSupplierCosts),
    ];
  });
}

export const LEDGER_HEADER = ['Environment', 'Date (Brisbane)', 'Transaction', 'Kind', 'Account', 'Currency', 'Debit', 'Credit', 'Booking reference', 'Trip', 'Supplier'] as const;
export interface LedgerExportRow { date: string; key: string; kind: string; account: string; currency: string; amountMinor: bigint; bookingReference: string | null; trip: string | null; supplier: string | null }
export function ledgerRows(mode: string, rows: readonly LedgerExportRow[]): ExportCell[][] {
  return rows.map((r) => [
    mode, r.date, r.key, r.kind, r.account, r.currency,
    r.amountMinor > 0n ? { money: r.amountMinor, currency: r.currency } : null,
    r.amountMinor < 0n ? { money: -r.amountMinor, currency: r.currency } : null,
    r.bookingReference, r.trip, r.supplier,
  ]);
}

export const SUPPLIER_PAYMENTS_HEADER = ['Environment', 'Date paid (Brisbane)', 'Date recorded (Brisbane)', 'Supplier', 'Status', 'Currency', 'Amount', 'Bank currency', 'Bank amount', 'Implied rate (bank currency per supplier currency)', 'Trip', 'Cost items'] as const;
export interface SupplierPaymentExportRow {
  paidOn: string; recordedOn: string; supplier: string; status: string; currency: string; amountMinor: bigint;
  bankCurrency: string | null; bankAmountMinor: bigint | null; rateE9: bigint | null; trip: string | null; items: number;
}
/** 10^9 times a rate, as a decimal text with nine places. */
export function rateE9Text(r: bigint): string {
  const s = r.toString().padStart(10, '0');
  return `${s.slice(0, -9)}.${s.slice(-9)}`;
}
export function supplierPaymentRows(mode: string, rows: readonly SupplierPaymentExportRow[]): ExportCell[][] {
  return rows.map((r) => [
    mode, r.paidOn, r.recordedOn, r.supplier, r.status, r.currency, { money: r.amountMinor, currency: r.currency },
    r.bankCurrency, r.bankAmountMinor !== null && r.bankCurrency ? { money: r.bankAmountMinor, currency: r.bankCurrency } : null,
    r.rateE9 === null ? null : rateE9Text(r.rateE9), r.trip, String(r.items),
  ]);
}

export function exportFilename(dataset: string, from: string, to: string): string {
  return `marathon-trips-${dataset.replace(/_/g, '-')}-${from.replace(/-/g, '')}-${to.replace(/-/g, '')}.csv`;
}
export type { FxPair };
