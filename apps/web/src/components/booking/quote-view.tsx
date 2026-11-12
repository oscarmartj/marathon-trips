'use client';

import { useState } from 'react';
import { Status } from '@/components/auth/field';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';
import { dateInBrisbane } from './request-confirmation';

export interface QuoteView {
  reference: string;
  status: string;
  acceptable: boolean;
  expiresAt: string | null;
  departureDate: string;
  returnDate: string;
  balanceDueDate: string;
  currency: string;
  totalMinor: string;
  depositMinor: string;
  bookingReference: string | null;
  package: { name: Record<string, string> };
  price: { subtotals: { accommodation: string; participation: string; extras: string }; surchargesMinor: string; discountsMinor: string };
}

/**
 * A quote the team prepared (task 2.5): the price exactly as the API holds it, until when it stands, and one button to accept.
 * Accepting asks the API to approve the places; nothing is charged here and nothing is added up in the browser.
 */
export function QuoteDetailView({ view }: { view: QuoteView }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ bookingReference: string }>(`/quotes/${encodeURIComponent(view.reference)}/accept`, { method: 'POST', body: {} });
      if (r.status === 200 && typeof r.body.bookingReference === 'string') {
        window.location.assign(`/trips/requests/${encodeURIComponent(r.body.bookingReference)}`);
        return;
      }
      let key = 'quote.errors.generic';
      if (r.status === 401) key = 'quote.errors.signedOut';
      else if (r.body.code === 'quote_expired') key = 'quote.errors.quote_expired';
      else if (r.body.code === 'quote_not_available' || r.body.code === 'package_not_open' || r.body.code === 'package_departed') key = 'quote.errors.quote_not_available';
      else if (r.body.code === 'busy_try_again') key = 'quote.errors.busy';
      setError(t(key));
    } catch {
      setError(t('quote.errors.network'));
    } finally {
      setBusy(false);
    }
  }

  const lines: Array<[string, string]> = [
    [t('quote.lines.accommodation'), view.price.subtotals.accommodation],
    [t('quote.lines.participation'), view.price.subtotals.participation],
    [t('quote.lines.extras'), view.price.subtotals.extras],
    [t('quote.lines.surcharges'), view.price.surchargesMinor],
    [t('quote.lines.discounts'), view.price.discountsMinor],
  ];
  return (
    <>
      <PageHeader title={t('quote.title')} intro={localisedText(view.package.name)} />
      <div className="container stack section">
        {view.acceptable ? (
          <div className="notice" role="status">
            <p>{t('quote.notABooking')}</p>
            <p>{t('quote.nothingCharged')}</p>
            {view.expiresAt ? <p>{t('quote.stands', { date: formatDate(dateInBrisbane(view.expiresAt)) })}</p> : null}
          </div>
        ) : (
          <p className="notice" role="status">{t(`quote.status.${view.status}`)}</p>
        )}
        <dl>
          <dt>{t('quote.reference')}</dt>
          <dd>{view.reference}</dd>
          <dt>{t('bookingRequest.confirmation.dates')}</dt>
          <dd>{t('bookingRequest.confirmation.dateRange', { from: formatDate(view.departureDate), to: formatDate(view.returnDate) })}</dd>
          {lines.filter(([, v]) => v !== '0').map(([label, v]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{formatMoney(v, view.currency)}</dd>
            </div>
          ))}
          <dt>{t('bookingRequest.confirmation.total')}</dt>
          <dd>{formatMoney(view.totalMinor, view.currency)}</dd>
          <dt>{t('bookingRequest.confirmation.deposit')}</dt>
          <dd>{t('bookingRequest.confirmation.depositLine', { amount: formatMoney(view.depositMinor, view.currency), date: formatDate(view.balanceDueDate) })}</dd>
        </dl>
        <Status message={error} />
        {view.acceptable ? (
          <p>
            <button className="btn" type="button" disabled={busy} aria-disabled={busy} onClick={() => void accept()}>
              {busy ? t('quote.accepting') : t('quote.accept')}
            </button>
          </p>
        ) : null}
        {view.bookingReference ? (
          <p>
            <a href={`/trips/requests/${encodeURIComponent(view.bookingReference)}`}>{t('quote.viewBooking')}</a>
          </p>
        ) : null}
      </div>
    </>
  );
}
