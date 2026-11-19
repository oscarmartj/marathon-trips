'use client';

import { t } from '@/lib/i18n';
import { moneyOrDash } from '@/lib/reconciliation-panel';
import { formatMoney } from '@/lib/builder';
import { Section, useLoad } from './catalogue/kit';

interface Money { heldMinor: string; overpaymentsMinor: string; customerDebtMinor: string; owedToSuppliersMinor: string | null; marginNotEarnedMinor: string | null; marginEarnedMinor: string; keepSeparateMinor: string; feesMinor: string; tripTravelled: boolean }
interface Row { packageId: string; trip: string; currency: string; bookings: number; costsNote: 'ok' | 'no_supplier_costs' | 'costs_in_other_currency'; feesImported: boolean; money: Money }
interface Total { currency: string; heldMinor: string; keepSeparateMinor: string; marginEarnedMinor: string; customerDebtMinor: string; feesMinor: string }
interface Report { asOf: string; today: string; rows: Row[]; totals: Total[] }

/** The customer money report (task 4.6): every figure is the API's; the page only formats them. */
export function CustomerMoneyPanel() {
  const { data } = useLoad<Report>('/admin/payments/reports/client-money');
  if (!data) return null;
  return (
    <Section id="customer-money" title={t('admin.customerMoney.title')}>
      <p>{t('admin.customerMoney.asOf', { when: new Date(data.asOf).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }), today: data.today })}</p>
      {data.rows.length === 0 ? <p>{t('admin.customerMoney.none')}</p> : (
        <div className="table-wrap">
          <table>
            <caption>{t('admin.customerMoney.caption')}</caption>
            <thead>
              <tr>
                {(['trip', 'bookings', 'held', 'owed', 'notEarned', 'over', 'debt', 'earned', 'keep', 'fees'] as const).map((k) => <th key={k} scope="col">{t(`admin.customerMoney.${k}`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.packageId}-${r.currency}`}>
                  <th scope="row">
                    {r.trip}
                    {r.costsNote !== 'ok' ? <><br /><small>{t(`admin.customerMoney.notes.${r.costsNote}`)}</small></> : null}
                    {!r.feesImported ? <><br /><small>{t('admin.customerMoney.feesNotImported')}</small></> : null}
                  </th>
                  <td>{r.bookings}</td>
                  <td>{formatMoney(r.money.heldMinor, r.currency)}</td>
                  <td>{moneyOrDash(r.money.owedToSuppliersMinor, r.currency)}</td>
                  <td>{moneyOrDash(r.money.marginNotEarnedMinor, r.currency)}</td>
                  <td>{formatMoney(r.money.overpaymentsMinor, r.currency)}</td>
                  <td>{formatMoney(r.money.customerDebtMinor, r.currency)}</td>
                  <td>{formatMoney(r.money.marginEarnedMinor, r.currency)}</td>
                  <td><strong>{formatMoney(r.money.keepSeparateMinor, r.currency)}</strong></td>
                  <td>{formatMoney(r.money.feesMinor, r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.totals.length > 0 ? (
        <>
          <h3>{t('admin.customerMoney.totalsHeading')}</h3>
          <ul>
            {data.totals.map((x) => (
              <li key={x.currency}>{t('admin.customerMoney.totalRow', { currency: x.currency, held: formatMoney(x.heldMinor, x.currency), keep: formatMoney(x.keepSeparateMinor, x.currency), earned: formatMoney(x.marginEarnedMinor, x.currency), debt: formatMoney(x.customerDebtMinor, x.currency), fees: formatMoney(x.feesMinor, x.currency) })}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p>{t('admin.customerMoney.footer')}</p>
    </Section>
  );
}
