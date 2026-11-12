'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaymentRefreshView } from '@mt/shared';
import { Status } from '@/components/auth/field';
import { api } from '@/lib/api-client';
import { REFRESH_EVERY_MS, REFRESH_MAX_TRIES, outcomeOf } from '@/lib/checkout';
import { t } from '@/lib/i18n';

type Answer = { view: PaymentRefreshView } | { error: 'signedOut' | 'network' | 'delayed' };

/**
 * Where the customer lands after the provider's page (task 3.5). The address only names the booking; what is said about
 * the payment comes from the API, which reads the provider when the payment is still open. A payment is never reported
 * as received on the strength of the address or of this page being opened.
 */
export function PaymentReturn({ reference }: { reference: string }) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [tries, setTries] = useState(0);
  const [checking, setChecking] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await api<PaymentRefreshView>(`/booking-requests/${encodeURIComponent(reference)}/payments/refresh`, { method: 'POST', body: {} });
      if (r.status === 200) setAnswer({ view: r.body as PaymentRefreshView });
      else if (r.status === 401 || r.status === 404) setAnswer({ error: 'signedOut' });
      else if (r.status === 503) setAnswer({ error: 'delayed' });
      else setAnswer({ error: 'network' });
    } catch {
      setAnswer({ error: 'network' });
    } finally {
      setChecking(false);
      setTries((n) => n + 1);
    }
  }, [reference]);

  useEffect(() => {
    void check();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [check]);

  const outcome = answer && 'view' in answer ? outcomeOf(answer.view) : null;
  // Keep asking, a few times, while the provider has not given its final answer.
  useEffect(() => {
    if (outcome === 'processing' && tries < REFRESH_MAX_TRIES && !checking) timer.current = setTimeout(() => void check(), REFRESH_EVERY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [outcome, tries, checking, check]);

  const booking = `/trips/requests/${encodeURIComponent(reference)}`;
  if (!answer) return <p className="notice" role="status">{t('paymentReturn.checking')}</p>;
  if ('error' in answer) {
    return (
      <div className="stack">
        <Status message={t(answer.error === 'signedOut' ? 'paymentReturn.signedOut' : answer.error === 'delayed' ? 'paymentReturn.delayed' : 'paymentReturn.network')} />
        <p><Link href={answer.error === 'signedOut' ? '/account/sign-in' : booking}>{t(answer.error === 'signedOut' ? 'paymentReturn.signIn' : 'paymentReturn.viewBooking')}</Link></p>
      </div>
    );
  }
  const key = outcome === 'paid' ? 'paid' : outcome === 'processing' ? 'processing' : outcome === 'failed' ? 'failed' : 'none';
  return (
    <div className="stack" aria-live="polite">
      <h2>{t(`paymentReturn.${key}Heading`)}</h2>
      <p className={outcome === 'paid' ? 'notice' : undefined} role="status">{t(`paymentReturn.${key}`)}</p>
      <dl>
        <div>
          <dt>{t('paymentReturn.bookingStatus')}</dt>
          <dd>{t(`bookingRequest.status.${answer.view.bookingStatus}`)}</dd>
        </div>
      </dl>
      {outcome === 'processing' && tries >= REFRESH_MAX_TRIES ? <p><button className="btn" type="button" disabled={checking} onClick={() => { setTries(0); void check(); }}>{t('paymentReturn.checkAgain')}</button></p> : null}
      {outcome === 'failed' || outcome === 'none' ? <p><Link className="btn" href={`/checkout/${encodeURIComponent(reference)}`}>{t('paymentReturn.tryAgain')}</Link></p> : null}
      <p><Link href={booking}>{t('paymentReturn.viewBooking')}</Link></p>
    </div>
  );
}
