'use client';

import { useState, type FormEvent } from 'react';
import { t } from '@/lib/i18n';
import { formatMinor } from '@/lib/supplier-format';
import { SCHEDULE_BUCKETS, bucketLabel } from '@/lib/supplier-payments';
import { Field, Status } from '../../auth/field';
import { Section, formatDay, useLoad } from '../catalogue/kit';

interface Item { costItemId: string; supplierId: string; supplierName: string; contractReference: string | null; description: string; dueDate: string | null; bucket: string; status: string; amountMinor: string; currency: string }
interface Release { allotmentId: string; supplierId: string; supplierName: string; contractReference: string; poolLabel: string; releaseDate: string; passed: boolean; quantity: number; atStakeMinor: string; currency: string }
interface Schedule {
  today: string; from: string; to: string; leadDays: number; items: Item[]; totals: Array<{ bucket: string; currency: string; amountMinor: string }>;
  releases: Release[]; releaseTotals: Array<{ currency: string; atStakeMinor: string }>;
}

/** The rows of one bucket and its heading. */
function bucketOf(data: Schedule, bucket: string): { rows: Item[]; title: string } {
  return { rows: data.items.filter((i) => i.bucket === bucket), title: bucketLabel(bucket, data.leadDays) };
}

/** Task 6.2: what is owed to suppliers and when. Every amount and total is the API's; the page only formats them. */
export function SupplierSchedulePanel() {
  const [query, setQuery] = useState('');
  const { data, error } = useLoad<Schedule>(`/admin/suppliers/payments/schedule${query}`);

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const q = new URLSearchParams();
    for (const k of ['from', 'to', 'currency']) {
      const v = String(f.get(k) ?? '').trim();
      if (v) q.set(k, k === 'currency' ? v.toUpperCase() : v);
    }
    setQuery(q.size ? `?${q.toString()}` : '');
  }

  return (
    <div className="stack">
      <div className="card stack">
        <form className="stack form" onSubmit={apply} aria-label={t('admin.nav.supplierPayments')}>
          <Field label={t('admin.catalogue.editions.startDate')} id="from" type="date" />
          <Field label={t('admin.catalogue.editions.endDate')} id="to" type="date" />
          <Field label={t('admin.suppliers.fields.currencyShort')} id="currency" maxLength={3} />
          <div className="actions"><button className="btn" type="submit">{t('admin.table.filters.show')}</button></div>
        </form>
        <Status message={error} />
        {data ? <p>{t('admin.supplierSchedule.today', { date: formatDay(data.today) })}</p> : null}
      </div>
      {data ? SCHEDULE_BUCKETS.map((bucket) => {
        const { rows, title } = bucketOf(data, bucket);
        return (
          <Section key={bucket} id={`bucket-${bucket}`} title={title}>
            {rows.length === 0 ? <p role="status">{t('admin.suppliers.payments.owedEmpty')}</p> : (
              <div className="table-wrap">
                <table>
                  <caption>{title}</caption>
                  <thead>
                    <tr>{[t('admin.nav.supplier'), t('admin.suppliers.allotments.contract'), t('admin.suppliers.costs.description'), t('admin.suppliers.costs.dueDate'), t('admin.dashboard.payments.amount')].map((h) => <th key={h} scope="col">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.costItemId}>
                        <th scope="row"><a href={`/admin/suppliers/${r.supplierId}#supplier-payments-title`}>{r.supplierName}</a></th>
                        <td>{r.contractReference ?? ''}</td>
                        <td>{r.description}</td>
                        <td>{r.dueDate ? formatDay(r.dueDate) : ''}</td>
                        <td>{formatMinor(r.amountMinor, r.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <ul aria-label={t('admin.customerMoney.totalsHeading')}>
              {data.totals.filter((x) => x.bucket === bucket).map((x) => <li key={x.currency}>{t('admin.supplierSchedule.totalRow', { currency: x.currency, amount: formatMinor(x.amountMinor, x.currency) })}</li>)}
            </ul>
          </Section>
        );
      }) : null}
      {data ? (
        <Section id="schedule-releases" title={t('admin.supplierSchedule.releasesHeading')}>
          <p>{t('admin.supplierSchedule.releasesHint')}</p>
          {data.releases.length === 0 ? <p role="status">{t('admin.supplierSchedule.noReleases')}</p> : (
            <div className="table-wrap">
              <table>
                <caption>{t('admin.supplierSchedule.releasesHeading')}</caption>
                <thead>
                  <tr>{[t('admin.nav.supplier'), t('admin.suppliers.allotments.contract'), t('admin.suppliers.allotments.pool'), t('admin.suppliers.allotments.releaseDate'), t('admin.suppliers.allotments.quantity'), t('admin.supplierSchedule.atStake')].map((h) => <th key={h} scope="col">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {data.releases.map((r) => (
                    <tr key={r.allotmentId}>
                      <th scope="row"><a href={`/admin/suppliers/${r.supplierId}`}>{r.supplierName}</a></th>
                      <td>{r.contractReference}</td>
                      <td>{r.poolLabel}</td>
                      <td>{formatDay(r.releaseDate)}{r.passed ? <> <span className="badge">{t('admin.supplierSchedule.passed')}</span></> : null}</td>
                      <td>{r.quantity}</td>
                      <td>{formatMinor(r.atStakeMinor, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ul>{data.releaseTotals.map((x) => <li key={x.currency}>{t('admin.supplierSchedule.releaseTotal', { currency: x.currency, amount: formatMinor(x.atStakeMinor, x.currency) })}</li>)}</ul>
        </Section>
      ) : null}
    </div>
  );
}
