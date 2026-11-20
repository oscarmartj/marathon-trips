'use client';

import { formatMoney } from '@/lib/builder';
import { checkName, rateText } from '@/lib/finance-panel';
import { t } from '@/lib/i18n-admin';
import { moneyOrDash } from '@/lib/reconciliation-panel';
import { Status } from '../../auth/field';
import { Section, useLoad } from '../catalogue/kit';

interface Other { currency: string; committedMinor: string; paidMinor: string; unpaidMinor: string; explicitPaidMinor: string; explicitDebitedMinor: string; leftOutMinor: string }
interface Result {
  bookings: number; cancelledBookings: number; keptMinor: string; earnedRevenueMinor: string; notYetEarnedMinor: string; penaltiesKeptMinor: string; refundedMinor: string; feesMinor: string;
  costCommittedMinor: string; costPaidMinor: string; resultCashMinor: string; resultExpectedMinor: string; resultEarnedMinor: string | null; otherCurrencies: Other[];
  warnings: { otherCurrencyLeftOut: boolean; feesNotImported: boolean; noSupplierCosts: boolean };
}
interface Row { packageId: string; trip: string; currency: string; result: Result }
interface Total { currency: string; trips: number; settledTrips: number; keptMinor: string; earnedRevenueMinor: string; resultCashMinor: string; resultExpectedMinor: string; resultEarnedMinor: string }
interface Check { name: string; currency: string; reportedMinor: string; ledgerMinor: string; matches: boolean }
interface Pair { supplierCurrency: string; bankCurrency: string; payments: number; supplierAmountMinor: string; bankAmountMinor: string; averageRateE9: string }
interface FxCheck { currency: string; fxFromPaymentsMinor: string; fxInLedgerMinor: string; matches: boolean }
interface Report {
  asOf: string; today: string; rows: Row[]; totals: Total[]; unlinked: Array<{ currency: string; costMinor: string; paidMinor: string; unpaidMinor: string }>;
  reconciliation: Check[]; fx: { pairs: Pair[]; ledger: FxCheck[] };
}

const COLUMNS = ['trip', 'kept', 'earned', 'notEarned', 'penalties', 'refunded', 'fees', 'costRecorded', 'costPaid', 'resultCash', 'resultExpected', 'resultEarned'] as const;
const outcome = (ok: boolean): string => (ok ? t('admin.tripResults.results.checkMatches') : t('admin.tripResults.results.checkDiffers'));

/** The result of each trip (task 6.6). Every figure is the API's; the page only formats them. */
export function TripResultPanel() {
  const { data, error } = useLoad<Report>('/admin/payments/reports/trip-result');
  if (error) return <Status message={error} />;
  if (!data) return null;
  return (
    <Section id="trip-results" title={t('admin.tripResults.results.title')}>
      <p>{t('admin.tripResults.asOf', { when: new Date(data.asOf).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }), today: data.today })}</p>
      {data.rows.length === 0 ? <p>{t('admin.tripResults.results.none')}</p> : (
        <div className="table-wrap">
          <table>
            <caption>{t('admin.tripResults.results.caption')}</caption>
            <thead><tr>{COLUMNS.map((k) => <th key={k} scope="col">{t(`admin.tripResults.results.${k}`)}</th>)}</tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.packageId}-${r.currency}`}>
                  <th scope="row">
                    {r.trip} ({r.currency})
                    <br /><small>{t('admin.tripResults.results.bookings', { count: r.result.bookings, called: r.result.cancelledBookings })}</small>
                    {(Object.keys(r.result.warnings) as Array<keyof Result['warnings']>).filter((w) => r.result.warnings[w]).map((w) => <span key={w}><br /><small>{t(`admin.tripResults.results.warnings.${w}`)}</small></span>)}
                    {r.result.otherCurrencies.map((o) => (
                      <span key={o.currency}>
                        <br /><small>{t('admin.tripResults.results.otherCurrency', { currency: o.currency, recorded: formatMoney(o.committedMinor, o.currency), paid: formatMoney(o.paidMinor, o.currency), left: formatMoney(o.leftOutMinor, o.currency) })}</small>
                        {o.explicitDebitedMinor !== '0' ? <><br /><small>{t('admin.tripResults.results.counted', { debited: formatMoney(o.explicitDebitedMinor, r.currency), paid: formatMoney(o.explicitPaidMinor, o.currency), currency: o.currency })}</small></> : null}
                      </span>
                    ))}
                  </th>
                  <td>{formatMoney(r.result.keptMinor, r.currency)}</td>
                  <td>{formatMoney(r.result.earnedRevenueMinor, r.currency)}</td>
                  <td>{formatMoney(r.result.notYetEarnedMinor, r.currency)}</td>
                  <td>{formatMoney(r.result.penaltiesKeptMinor, r.currency)}</td>
                  <td>{formatMoney(r.result.refundedMinor, r.currency)}</td>
                  <td>{formatMoney(r.result.feesMinor, r.currency)}</td>
                  <td>{formatMoney(r.result.costCommittedMinor, r.currency)}</td>
                  <td>{formatMoney(r.result.costPaidMinor, r.currency)}</td>
                  <td><strong>{formatMoney(r.result.resultCashMinor, r.currency)}</strong></td>
                  <td><strong>{formatMoney(r.result.resultExpectedMinor, r.currency)}</strong></td>
                  <td>{r.result.resultEarnedMinor === null ? t('admin.tripResults.results.notFinal') : <strong>{moneyOrDash(r.result.resultEarnedMinor, r.currency)}</strong>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.totals.length > 0 ? (
        <>
          <h3>{t('admin.tripResults.results.totalsHeading')}</h3>
          <ul>
            {data.totals.map((x) => (
              <li key={x.currency}>{t('admin.tripResults.results.totalRow', { currency: x.currency, trips: x.trips, kept: formatMoney(x.keptMinor, x.currency), earned: formatMoney(x.earnedRevenueMinor, x.currency), cash: formatMoney(x.resultCashMinor, x.currency), expected: formatMoney(x.resultExpectedMinor, x.currency), final: formatMoney(x.resultEarnedMinor, x.currency), settled: x.settledTrips })}</li>
            ))}
          </ul>
        </>
      ) : null}
      {data.unlinked.length > 0 ? (
        <>
          <h3>{t('admin.tripResults.results.unlinkedHeading')}</h3>
          <ul>{data.unlinked.map((u) => <li key={u.currency}>{t('admin.tripResults.results.unlinkedRow', { currency: u.currency, cost: formatMoney(u.costMinor, u.currency), paid: formatMoney(u.paidMinor, u.currency), unpaid: formatMoney(u.unpaidMinor, u.currency) })}</li>)}</ul>
        </>
      ) : null}
      <h3>{t('admin.tripResults.results.checksHeading')}</h3>
      <ul>
        {data.reconciliation.map((c) => (
          <li key={`${c.name}-${c.currency}`}>{t('admin.tripResults.results.checkRow', { currency: c.currency, what: checkName(c.name), reported: formatMoney(c.reportedMinor, c.currency), ledger: formatMoney(c.ledgerMinor, c.currency), outcome: outcome(c.matches) })}</li>
        ))}
      </ul>
      <h3>{t('admin.tripResults.results.fxHeading')}</h3>
      {data.fx.pairs.length === 0 ? <p>{t('admin.tripResults.results.fxNone')}</p> : (
        <ul>
          {data.fx.pairs.map((p) => (
            <li key={`${p.supplierCurrency}-${p.bankCurrency}`}>{t('admin.tripResults.results.fxRow', { supplier: p.supplierCurrency, bank: p.bankCurrency, payments: p.payments, supplierAmount: formatMoney(p.supplierAmountMinor, p.supplierCurrency), bankAmount: formatMoney(p.bankAmountMinor, p.bankCurrency), rate: rateText(p.averageRateE9), bankCurrency: p.bankCurrency, supplierCurrency: p.supplierCurrency })}</li>
          ))}
          {data.fx.ledger.map((l) => <li key={l.currency}>{t('admin.tripResults.results.fxLedger', { currency: l.currency, fromPayments: formatMoney(l.fxFromPaymentsMinor, l.currency), inLedger: formatMoney(l.fxInLedgerMinor, l.currency), outcome: outcome(l.matches) })}</li>)}
        </ul>
      )}
      <p>{t('admin.tripResults.results.footer')}</p>
    </Section>
  );
}
