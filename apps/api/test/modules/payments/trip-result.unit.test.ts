// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md): the pure parts, table-driven: currency decimal places and the
// implied rate (finding 3), the result of a trip, the checks against the ledger, the forecast buckets and the CSV cells.
import { describe, expect, it } from 'vitest';
import { cell, parseCsv } from '../../../src/platform/common/csv';
import { renderExport, rateE9Text, textCell, tripResultRows, TRIP_RESULT_HEADER, exportFilename } from '../../../src/modules/payments/core/accountant-export';
import { buildForecast, forecastBucket } from '../../../src/modules/payments/core/cash-forecast';
import { currencyExponent, impliedRateE9, minorToDecimal } from '../../../src/modules/payments/core/fx';
import { reconcile, tripResult, type ResultBooking, type TripResultInput } from '../../../src/modules/payments/core/trip-result';

describe('currency exponents and the implied rate (finding 3)', () => {
  it.each([['AUD', 2], ['JPY', 0], ['KWD', 3], ['EUR', 2], ['KRW', 0]])('currencyExponent %s is %i', (c, e) => expect(currencyExponent(c)).toBe(e));

  it.each([
    [123450n, 'AUD', '1234.50'], [1234n, 'JPY', '1234'], [5n, 'AUD', '0.05'], [-5n, 'AUD', '-0.05'], [0n, 'AUD', '0.00'], [1500n, 'KWD', '1.500'], [-1234n, 'JPY', '-1234'],
  ])('minorToDecimal(%s %s) is %s', (m, c, text) => expect(minorToDecimal(m, c)).toBe(text));

  it('fx_conversion_respects_currency_exponents: 10 000 JPY for 100.00 AUD is 0.01 AUD per JPY, and the other way 100 JPY per AUD', () => {
    expect(impliedRateE9(10_000n, 'JPY', 10_000n, 'AUD')).toBe(10_000_000n);
    expect(impliedRateE9(10_000n, 'AUD', 10_000n, 'JPY')).toBe(100_000_000_000n);
    // The same amounts between two currencies with two places each are a rate of 1.
    expect(impliedRateE9(10_000n, 'EUR', 10_000n, 'AUD')).toBe(1_000_000_000n);
    // Three decimal places on one side: 1.000 KWD for 5.00 AUD is 5 AUD per KWD.
    expect(impliedRateE9(1_000n, 'KWD', 500n, 'AUD')).toBe(5_000_000_000n);
  });

  it('rounds half up, once', () => {
    // 3 JPY for 1.00 AUD: 0.3333... AUD per JPY would be 33.3 AUD per JPY, so check a clean half: 2 JPY for 0.01 AUD is 0.005 AUD/JPY.
    expect(impliedRateE9(2n, 'JPY', 1n, 'AUD')).toBe(5_000_000n);
    // 3 EUR cents for 1 AUD cent is 0.3333... : rounds down.
    expect(impliedRateE9(3n, 'EUR', 1n, 'AUD')).toBe(333_333_333n);
    // 3 for 2 is 0.6666...: rounds up.
    expect(impliedRateE9(3n, 'EUR', 2n, 'AUD')).toBe(666_666_667n);
  });

  it.each([[0n, 10n, 'JPY', 'AUD'], [10n, 0n, 'JPY', 'AUD'], [-1n, 10n, 'JPY', 'AUD'], [10n, 10n, 'AUD', 'AUD']])('refuses %s %s %s %s', (a, b, ca, cb) => {
    expect(() => impliedRateE9(a, ca, b, cb)).toThrow(RangeError);
  });

  it('rateE9Text has nine places', () => {
    expect([rateE9Text(10_000_000n), rateE9Text(1_000_000_000n), rateE9Text(5n)]).toEqual(['0.010000000', '1.000000000', '0.000000005']);
  });
});

const booking = (o: Partial<ResultBooking> = {}): ResultBooking => ({ status: 'deposit_paid', returnDate: '2027-06-21', totalMinor: 100_000n, fundsMinor: 50_000n, overpaymentsMinor: 0n, receivableMinor: 0n, feesMinor: 0n, penaltyMinor: null, ...o });
const base = (o: Partial<TripResultInput> = {}): TripResultInput => ({
  bookings: [booking()], refunds: { cancellationMinor: 0n, priceReductionMinor: 0n, overpaymentReturnMinor: 0n, externalMinor: 0n }, costCommittedMinor: 30_000n, costPaidMinor: 10_000n,
  otherCurrencies: [], feesImported: true, today: '2026-11-20', ...o,
});

describe('tripResult', () => {
  it('a booked trip not yet travelled: cash, expected and no final result', () => {
    const r = tripResult(base());
    expect(r).toMatchObject({ keptMinor: 50_000n, earnedRevenueMinor: 0n, notYetEarnedMinor: 50_000n, expectedRevenueMinor: 100_000n, costUnpaidMinor: 20_000n, resultCashMinor: 40_000n, resultExpectedMinor: 70_000n, resultEarnedMinor: null, settled: false });
  });

  it.each([
    ['returned before today', { returnDate: '2026-11-19' }, true],
    ['returns today', { returnDate: '2026-11-20' }, false],
    ['completed status', { status: 'completed', returnDate: '2027-01-01' }, true],
    ['cancelled', { status: 'cancelled', penaltyMinor: 20_000n, fundsMinor: 20_000n }, true],
    ['no return date', { returnDate: null }, false],
  ] as Array<[string, Partial<ResultBooking>, boolean]>)('earned and settled: %s', (_n, o, earned) => {
    const r = tripResult(base({ bookings: [booking(o)] }));
    expect(r.settled).toBe(earned);
    expect(r.earnedRevenueMinor).toBe(earned ? booking(o).fundsMinor : 0n);
    expect(r.resultEarnedMinor).toBe(earned ? booking(o).fundsMinor - 30_000n : null);
  });

  it('a cancelled booking counts at its penalty, and what it keeps is the penalties kept', () => {
    const r = tripResult(base({ bookings: [booking({ status: 'cancelled', totalMinor: 100_000n, fundsMinor: 15_000n, penaltyMinor: 25_000n })] }));
    expect(r).toMatchObject({ cancelledBookings: 1, penaltiesKeptMinor: 15_000n, expectedRevenueMinor: 25_000n, earnedRevenueMinor: 15_000n });
  });

  it('approved is not expected revenue; overpayments are not revenue; a debt never offsets another booking', () => {
    const r = tripResult(base({ bookings: [booking({ status: 'approved', fundsMinor: 0n }), booking({ fundsMinor: 40_000n, overpaymentsMinor: 5_000n }), booking({ fundsMinor: -9_000n, receivableMinor: 9_000n })] }));
    expect(r).toMatchObject({ expectedRevenueMinor: 200_000n, keptMinor: 40_000n, overpaymentsMinor: 5_000n, customerDebtMinor: 9_000n });
  });

  it('refunds are information: they are not taken off a second time', () => {
    const r = tripResult(base({ refunds: { cancellationMinor: 1_000n, priceReductionMinor: 2_000n, overpaymentReturnMinor: 3_000n, externalMinor: 4_000n } }));
    expect(r.refundedMinor).toBe(10_000n);
    expect(r.keptMinor).toBe(50_000n);
    expect(r.resultCashMinor).toBe(40_000n);
  });

  it('fees come off every result and "fees not imported" is a warning', () => {
    const r = tripResult(base({ bookings: [booking({ feesMinor: 1_500n })], feesImported: false }));
    expect(r).toMatchObject({ feesMinor: 1_500n, resultCashMinor: 38_500n, resultExpectedMinor: 68_500n });
    expect(r.warnings.feesNotImported).toBe(true);
  });

  it('costs in another currency are left out unless staff typed both amounts of a payment for this trip', () => {
    const left = tripResult(base({ otherCurrencies: [{ currency: 'EUR', committedMinor: 12_000n, paidMinor: 5_000n, unpaidMinor: 7_000n, explicitPaidMinor: 0n, explicitDebitedMinor: 0n }] }));
    expect(left).toMatchObject({ costInResultMinor: 30_000n, resultExpectedMinor: 70_000n });
    expect(left.warnings.otherCurrencyLeftOut).toBe(true);
    expect(left.otherCurrencies[0]!.leftOutMinor).toBe(12_000n);
    const typed = tripResult(base({ otherCurrencies: [{ currency: 'EUR', committedMinor: 12_000n, paidMinor: 12_000n, unpaidMinor: 0n, explicitPaidMinor: 12_000n, explicitDebitedMinor: 20_000n }] }));
    expect(typed).toMatchObject({ costInResultMinor: 50_000n, costPaidInResultMinor: 30_000n, resultExpectedMinor: 50_000n, resultCashMinor: 20_000n });
    expect(typed.warnings.otherCurrencyLeftOut).toBe(false);
    // Part typed, part not: only the part left out is a warning.
    const part = tripResult(base({ otherCurrencies: [{ currency: 'EUR', committedMinor: 20_000n, paidMinor: 12_000n, unpaidMinor: 8_000n, explicitPaidMinor: 12_000n, explicitDebitedMinor: 20_000n }] }));
    expect(part.otherCurrencies[0]!.leftOutMinor).toBe(8_000n);
    expect(part.warnings.otherCurrencyLeftOut).toBe(true);
  });

  it('a prepayment only (no bookings) is a loss so far, and not settled', () => {
    const r = tripResult(base({ bookings: [], costCommittedMinor: 5_000n, costPaidMinor: 5_000n }));
    expect(r).toMatchObject({ resultCashMinor: -5_000n, settled: false, resultEarnedMinor: null, bookings: 0 });
  });

  it('no supplier costs at all is a warning', () => {
    expect(tripResult(base({ costCommittedMinor: 0n, costPaidMinor: 0n })).warnings.noSupplierCosts).toBe(true);
  });
});

describe('reconcile', () => {
  it('matches, and flags a wrong figure and a currency only one side has', () => {
    const r = reconcile('supplier_paid', new Map([['AUD', 100n], ['EUR', 5n]]), new Map([['AUD', 100n], ['EUR', 6n], ['JPY', 1n]]));
    expect(r.map((x) => [x.currency, x.matches])).toEqual([['AUD', true], ['EUR', false], ['JPY', false]]);
  });
});

describe('forecast', () => {
  it.each([
    ['2026-11-19', 'overdue'], ['2026-11-20', 'window'], ['2026-12-01', 'window'], ['2027-02-18', 'window'], ['2027-02-19', 'later'], [null, 'undated'],
  ])('forecastBucket %s is %s (today 2026-11-20, window to 2027-02-18)', (d, b) => expect(forecastBucket(d, '2026-11-20', '2026-11-20', '2027-02-18')).toBe(b));

  it('dated between today and a later window start is "earlier"', () => {
    expect(forecastBucket('2026-11-25', '2026-11-20', '2026-12-01', '2027-02-01')).toBe('earlier');
  });

  it('per currency, never mixed; net is instalments less suppliers; tentative and penalties are beside it; running starts at 0', () => {
    const f = buildForecast({
      today: '2026-11-20', from: '2026-11-20', to: '2027-02-18',
      ins: [
        { packageId: 'a', currency: 'AUD', date: '2026-11-25', kind: 'instalments', amountMinor: 1_000n },
        { packageId: 'a', currency: 'AUD', date: '2026-11-25', kind: 'tentative', amountMinor: 700n },
        { packageId: 'b', currency: 'AUD', date: '2026-12-02', kind: 'penalties', amountMinor: 300n },
        { packageId: 'a', currency: 'AUD', date: '2026-11-10', kind: 'instalments', amountMinor: 50n },
        { packageId: 'c', currency: 'EUR', date: '2026-11-25', kind: 'instalments', amountMinor: 9n },
      ],
      outs: [
        { packageId: 'a', currency: 'AUD', date: '2026-11-25', amountMinor: 400n },
        { packageId: 'a', currency: 'AUD', date: '2026-12-02', amountMinor: 100n },
        { packageId: null, currency: 'AUD', date: null, amountMinor: 80n },
        { packageId: 'a', currency: 'AUD', date: '2026-11-01', amountMinor: 20n },
        { packageId: 'a', currency: 'AUD', date: '2027-06-01', amountMinor: 7n },
      ],
    });
    const aud = f.currencies.find((c) => c.currency === 'AUD')!;
    expect(f.currencies.map((c) => c.currency)).toEqual(['AUD', 'EUR']);
    expect(aud.days.map((d) => [d.date, d.instalmentsInMinor, d.tentativeInMinor, d.penaltiesInMinor, d.supplierOutMinor, d.firmNetMinor, d.runningNetMinor])).toEqual([
      ['2026-11-25', 1_000n, 700n, 0n, 400n, 600n, 600n],
      ['2026-12-02', 0n, 0n, 300n, 100n, -100n, 500n],
    ]);
    expect(aud.overdue).toMatchObject({ instalmentsInMinor: 50n, supplierOutMinor: 20n, firmNetMinor: 30n });
    expect(aud.undated).toMatchObject({ supplierOutMinor: 80n });
    expect(aud.later).toMatchObject({ supplierOutMinor: 7n });
    expect(aud.all).toMatchObject({ instalmentsInMinor: 1_050n, tentativeInMinor: 700n, penaltiesInMinor: 300n, supplierOutMinor: 607n });
    expect(f.currencies.find((c) => c.currency === 'EUR')!.all).toMatchObject({ instalmentsInMinor: 9n, supplierOutMinor: 0n });
    // Per trip: the same figures, each trip on its own; costs with no trip are their own row.
    expect(f.trips.find((t) => t.packageId === 'a' && t.currency === 'AUD')).toMatchObject({ instalmentsInMinor: 1_050n, supplierOutMinor: 527n });
    expect(f.trips.find((t) => t.packageId === null)).toMatchObject({ supplierOutMinor: 80n });
  });

  it('ignores zero and negative amounts', () => {
    const f = buildForecast({ today: '2026-11-20', from: '2026-11-20', to: '2026-12-20', ins: [{ packageId: 'a', currency: 'AUD', date: '2026-11-25', kind: 'instalments', amountMinor: 0n }], outs: [{ packageId: 'a', currency: 'AUD', date: '2026-11-25', amountMinor: -1n }] });
    expect(f.currencies).toEqual([]);
  });
});

describe('accountant CSV', () => {
  const hostile = ['=HYPERLINK("http://x","y")', '+1', '-2', '@SUM(A1)', '\t=1', '\r=1', 'a;=1', 'a,@x', '"=1', 'ok, fine'];

  it.each(hostile)('text cell %j is guarded and quoted, and reads back through both separators', (text) => {
    const csv = renderExport(['A', 'B'], [[text, 'x']]);
    const rows = parseCsv(csv);
    // Whatever the reader splits on, no field of the row starts with a formula character.
    for (const field of rows[1]!) expect(field).not.toMatch(/^\s*[=+\-@\t\r]/);
    // Read with either separator, and with the quotes dropped: a fragment may begin with the guard quote, never with a formula.
    for (const frag of csv.slice(1).split(/[,;\r\n]/)) expect(frag.replace(/^["\s]*/, '')).not.toMatch(/^[=+\-@\t]/);
    expect(textCell(text)).toBe(cell(text));
  });

  it('money is an exact decimal, negative is a number, JPY has no decimals, nothing is guarded', () => {
    const csv = renderExport(['Amount', 'Yen'], [[{ money: -1250n, currency: 'AUD' }, { money: 1234n, currency: 'JPY' }], [{ money: 5n, currency: 'AUD' }, null]]);
    expect(csv).toBe('﻿Amount,Yen\r\n-12.50,1234\r\n0.05,\r\n');
  });

  it('refuses a row with the wrong number of columns', () => {
    expect(() => renderExport(['A', 'B'], [['x']])).toThrow(RangeError);
  });

  it('a hostile trip name in the trip result file is guarded', () => {
    const r = tripResult(base());
    const rows = tripResultRows('test', [{ packageId: 'p', currency: 'AUD', trip: '=HYPERLINK("x")', result: r }]);
    const csv = renderExport(TRIP_RESULT_HEADER, rows);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(parseCsv(csv)[1]).toHaveLength(TRIP_RESULT_HEADER.length);
  });

  it('the file name has only safe characters', () => {
    expect(exportFilename('trip_result', '2026-07-01', '2027-06-30')).toBe('marathon-trips-trip-result-20260701-20270630.csv');
  });
});
