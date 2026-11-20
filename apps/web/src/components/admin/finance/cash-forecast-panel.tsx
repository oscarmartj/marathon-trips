'use client';

import { useState, type FormEvent } from 'react';
import { formatMoney } from '@/lib/builder';
import { FORECAST_BUCKETS, bucketTitle, forecastQuery } from '@/lib/finance-panel';
import { t } from '@/lib/i18n-admin';
import { Field, Status } from '../../auth/field';
import { Section, formatDay, useLoad } from '../catalogue/kit';

interface Amounts { instalmentsInMinor: string; tentativeInMinor: string; penaltiesInMinor: string; supplierOutMinor: string; firmNetMinor: string }
interface Day extends Amounts { date: string; runningNetMinor: string }
interface Currency {
  currency: string; days: Day[]; overdue: Amounts; earlier: Amounts; later: Amounts; undated: Amounts; all: Amounts;
  customerDebtMinor: string; toGiveBackMinor: string; refundsInFlightMinor: string;
}
interface Trip extends Amounts { packageId: string | null; currency: string; trip: string }
interface Forecast { today: string; from: string; to: string; currencies: Currency[]; trips: Trip[] }

const COLUMNS = ['instalments', 'tentative', 'penalties', 'suppliers', 'net'] as const;
const cells = (a: Amounts, c: string) => [a.instalmentsInMinor, a.tentativeInMinor, a.penaltiesInMinor, a.supplierOutMinor, a.firmNetMinor].map((v, i) => <td key={COLUMNS[i]}>{formatMoney(v, c)}</td>);

/** The cash forecast (task 6.6). Every figure is the API's; the page only formats them. */
export function CashForecastPanel() {
  const [query, setQuery] = useState('');
  const { data, error } = useLoad<Forecast>(`/admin/payments/reports/cash-forecast${query}`);
  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setQuery(forecastQuery(String(f.get('forecastFrom') ?? ''), String(f.get('forecastTo') ?? '')));
  }
  return (
    <Section id="cash-forecast" title={t('admin.tripResults.forecast.title')}>
      <form className="stack form" onSubmit={apply} aria-label={t('admin.tripResults.forecast.title')}>
        <Field label={t('admin.tripResults.forecast.from')} id="forecastFrom" type="date" />
        <Field label={t('admin.tripResults.forecast.to')} id="forecastTo" type="date" />
        <div className="actions"><button className="btn" type="submit">{t('admin.tripResults.forecast.show')}</button></div>
      </form>
      <Status message={error} />
      {data && data.currencies.length === 0 ? <p role="status">{t('admin.tripResults.forecast.none')}</p> : null}
      {data?.currencies.map((cur) => (
        <div key={cur.currency} className="stack">
          <h3>{cur.currency}</h3>
          <div className="table-wrap">
            <table>
              <caption>{t('admin.tripResults.forecast.caption', { currency: cur.currency })}</caption>
              <thead><tr><th scope="col">{t('admin.tripResults.forecast.date')}</th>{COLUMNS.map((k) => <th key={k} scope="col">{t(`admin.tripResults.forecast.${k}`)}</th>)}<th scope="col">{t('admin.tripResults.forecast.running')}</th></tr></thead>
              <tbody>
                {cur.days.map((d) => <tr key={d.date}><th scope="row">{formatDay(d.date)}</th>{cells(d, cur.currency)}<td>{formatMoney(d.runningNetMinor, cur.currency)}</td></tr>)}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <caption>{t('admin.tripResults.forecast.otherCaption', { currency: cur.currency })}</caption>
              <thead><tr><th scope="col">{t('admin.tripResults.forecast.bucket')}</th>{COLUMNS.map((k) => <th key={k} scope="col">{t(`admin.tripResults.forecast.${k}`)}</th>)}</tr></thead>
              <tbody>
                {FORECAST_BUCKETS.map((b) => <tr key={b}><th scope="row">{bucketTitle(b)}</th>{cells(cur[b], cur.currency)}</tr>)}
              </tbody>
            </table>
          </div>
          <p>{t('admin.tripResults.forecast.apartRow', { currency: cur.currency, debt: formatMoney(cur.customerDebtMinor, cur.currency), back: formatMoney(cur.toGiveBackMinor, cur.currency), flight: formatMoney(cur.refundsInFlightMinor, cur.currency) })}</p>
        </div>
      ))}
      {data && data.trips.length > 0 ? (
        <div className="table-wrap">
          <h3>{t('admin.tripResults.forecast.tripsHeading')}</h3>
          <table>
            <caption>{t('admin.tripResults.forecast.tripsCaption')}</caption>
            <thead><tr><th scope="col">{t('admin.tripResults.results.trip')}</th>{COLUMNS.map((k) => <th key={k} scope="col">{t(`admin.tripResults.forecast.${k}`)}</th>)}</tr></thead>
            <tbody>
              {data.trips.map((x) => <tr key={`${x.packageId ?? 'none'}-${x.currency}`}><th scope="row">{x.packageId ? x.trip : t('admin.tripResults.forecast.noTrip')} ({x.currency})</th>{cells(x, x.currency)}</tr>)}
            </tbody>
          </table>
        </div>
      ) : null}
      <p>{t('admin.tripResults.forecast.footer')}</p>
    </Section>
  );
}
