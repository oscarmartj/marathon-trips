'use client';

import { useState } from 'react';
import { Status } from '@/components/auth/field';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';
import type { CancellationPolicyPublicView } from '@mt/shared';
import { CancellationPolicyTerms } from '@/components/cancellation/policy-terms';
import { policyRef } from '@/lib/cancellation';

/** The instant the price stops standing, in Brisbane time (the API holds an instant, not a day). */
export const formatStands = (iso: string): string =>
  new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Australia/Brisbane' }).format(new Date(iso));

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
  /** Task 6.4: the cancellation policy accepting binds to; sent back on accept. */
  cancellationPolicy?: CancellationPolicyPublicView | null;
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
      const r = await api<{ bookingReference: string }>(`/quotes/${encodeURIComponent(view.reference)}/accept`, { method: 'POST', body: { cancellationPolicy: policyRef(view.cancellationPolicy) } });
      if (r.status === 200 && typeof r.body.bookingReference === 'string') {
        window.location.assign(`/trips/requests/${encodeURIComponent(r.body.bookingReference)}`);
        return;
      }
      let key = 'quote.errors.generic';
      if (r.status === 401) key = 'quote.errors.signedOut';
      else if (r.body.code === 'quote_expired') key = 'quote.errors.quote_expired';
      else if (r.body.code === 'quote_not_available' || r.body.code === 'package_not_open' || r.body.code === 'package_departed') key = 'quote.errors.quote_not_available';
      else if (r.body.code === 'busy_try_again') key = 'quote.errors.busy';
      else if (r.body.code === 'cancellation_policy_changed') key = 'quote.errors.policyChanged';
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
  const rows: Array<[string, string]> = [
    [t('quote.reference'), view.reference],
    [t('bookingRequest.confirmation.dates'), t('bookingRequest.confirmation.dateRange', { from: formatDate(view.departureDate), to: formatDate(view.returnDate) })],
    ...lines.filter(([, v]) => v !== '0').map(([label, v]): [string, string] => [label, formatMoney(v, view.currency)]),
    [t('bookingRequest.confirmation.total'), formatMoney(view.totalMinor, view.currency)],
    [t('bookingRequest.confirmation.deposit'), t('bookingRequest.confirmation.depositLine', { amount: formatMoney(view.depositMinor, view.currency), date: formatDate(view.balanceDueDate) })],
  ];
  return (
    <>
      <PageHeader title={t('quote.title')} intro={localisedText(view.package.name)} />
      <div className="container stack section">
        {view.acceptable ? (
          <div className="notice" role="status">
            <p>{t('quote.notABooking')}</p>
            <p>{t('quote.nothingCharged')}</p>
            {view.expiresAt ? <p>{t('quote.stands', { when: formatStands(view.expiresAt) })}</p> : null}
          </div>
        ) : (
          <p className="notice" role="status">{t(`quote.status.${view.status}`)}</p>
        )}
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {view.acceptable ? <CancellationPolicyTerms policy={view.cancellationPolicy ?? null} /> : null}
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
