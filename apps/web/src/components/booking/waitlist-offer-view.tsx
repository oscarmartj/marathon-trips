'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Status } from '@/components/auth/field';
import { PageHeader } from '@/components/page-header';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';
import { formatStands } from './quote-view';

export interface WaitlistEntryView {
  id: string;
  status: 'waiting' | 'offered' | 'converted' | 'expired' | 'withdrawn';
  reason: 'non_resident' | 'sold_out';
  offerExpiresAt: string | null;
  bookingReference: string | null;
  package: { name: Record<string, string> };
  /** The engine's price for the offer today; null when it cannot be priced. */
  price: { currency: string; totalMinor: string; depositMinor: string | null; balanceDueDate: string } | null;
}

const errorKey = (status: number, code?: string): string => {
  if (status === 401) return 'waitlist.offer.errors.signedOut';
  if (code === 'offer_no_longer_open' || code === 'entry_not_open') return 'waitlist.offer.errors.closed';
  if (code === 'catalogue_changed') return 'waitlist.offer.errors.changed';
  if (code === 'package_not_open' || code === 'package_departed') return 'waitlist.offer.errors.notOpen';
  if (code === 'busy_try_again') return 'waitlist.offer.errors.busy';
  return 'waitlist.offer.errors.generic';
};

/**
 * The customer's own waiting list entry (task 6.5). When a place has come up it shows the engine's price and two buttons:
 * accepting sends a booking request (not a booking, nothing is charged); declining gives the place to the next person.
 * Nothing is added up here.
 */
export function WaitlistOfferView({ view }: { view: WaitlistEntryView }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'accept' | 'withdraw' | null>(null);
  const [left, setLeft] = useState(false);

  async function run(what: 'accept' | 'withdraw') {
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      const r = await api<{ bookingReference?: string }>(`/waitlist/entries/${encodeURIComponent(view.id)}/${what}`, { method: 'POST', body: {} });
      if (r.status === 200 && what === 'accept' && typeof r.body.bookingReference === 'string') {
        window.location.assign(`/trips/requests/${encodeURIComponent(r.body.bookingReference)}`);
        return;
      }
      if (r.status === 200) {
        setLeft(true);
        return;
      }
      setError(t(errorKey(r.status, r.body.code)));
    } catch {
      setError(t('waitlist.offer.errors.network'));
    } finally {
      setBusy(null);
    }
  }

  const status = left ? 'withdrawn' : view.status;
  return (
    <>
      <PageHeader title={t('waitlist.offer.title')} intro={localisedText(view.package.name)} />
      <div className="container stack section">
        <p className="notice" role="status">{t(`waitlist.offer.status.${status}`)}</p>
        {status === 'offered' ? (
          <>
            <p>{t('waitlist.offer.notABooking')}</p>
            {view.offerExpiresAt ? <p>{t('waitlist.offer.holdUntil', { when: formatStands(view.offerExpiresAt) })}</p> : null}
            {view.price ? (
              <section aria-labelledby="offer-price">
                <h2 id="offer-price">{t('waitlist.offer.priceHeading')}</h2>
                <dl>
                  <dt>{t('waitlist.offer.total')}</dt>
                  <dd>{formatMoney(view.price.totalMinor, view.price.currency)}</dd>
                  {view.price.depositMinor ? (
                    <>
                      <dt>{t('waitlist.offer.deposit', { date: formatDate(view.price.balanceDueDate) })}</dt>
                      <dd>{formatMoney(view.price.depositMinor, view.price.currency)}</dd>
                    </>
                  ) : null}
                </dl>
              </section>
            ) : null}
            <Status message={error} />
            <p className="actions">
              <button className="btn" type="button" onClick={() => run('accept')} disabled={busy !== null} aria-disabled={busy !== null}>
                {busy === 'accept' ? t('waitlist.offer.accepting') : t('waitlist.offer.accept')}
              </button>{' '}
              <button className="btn btn-secondary" type="button" onClick={() => run('withdraw')} disabled={busy !== null} aria-disabled={busy !== null}>
                {busy === 'withdraw' ? t('waitlist.offer.working') : t('waitlist.offer.decline')}
              </button>
            </p>
          </>
        ) : null}
        {status === 'waiting' ? (
          <>
            <Status message={error} />
            <p>
              <button className="btn btn-secondary" type="button" onClick={() => run('withdraw')} disabled={busy !== null} aria-disabled={busy !== null}>
                {busy === 'withdraw' ? t('waitlist.offer.working') : t('waitlist.offer.leave')}
              </button>
            </p>
          </>
        ) : null}
        {status === 'converted' && view.bookingReference ? (
          <p>
            <Link href={`/trips/requests/${encodeURIComponent(view.bookingReference)}`}>{t('waitlist.offer.viewRequest')}</Link>
          </p>
        ) : null}
      </div>
    </>
  );
}
