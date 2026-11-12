'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { PriceBreakdownJson } from '@mt/shared';
import { Field, Status } from '@/components/auth/field';
import { WaitlistConfirmation } from '@/components/booking/waitlist-confirmation';
import { QuoteSummary } from '@/components/builder/quote-summary';
import { api } from '@/lib/api-client';
import { toQuoteRequest, type BuilderState } from '@/lib/builder';
import { IdempotencyKeys, countryProblem, parseWaitlistJoined, rememberReturnTo, requestErrorKey, toBookingRequest, type WaitlistJoined } from '@/lib/booking-request';
import type { PackageDetail } from '@/lib/catalogue';
import { t } from '@/lib/i18n';
import { isBreakdown } from '@/lib/quote-loader';

type Session = 'checking' | 'signed-out' | 'signed-in';

/**
 * Sends a booking request (task 2.4), or joins the waiting list when the API says the contact lives outside the
 * countries we sell to (task 2.6): shows the API's current price for the configuration, asks for the lead contact,
 * and posts the configuration and the contact. Never an amount: the API prices it again and keeps that price.
 */
export function BookingRequestForm({ pkg, state, here }: { pkg: PackageDetail; state: BuilderState; here: string }) {
  const [session, setSession] = useState<Session>('checking');
  const [breakdown, setBreakdown] = useState<PriceBreakdownJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [countryError, setCountryError] = useState<string | null>(null);
  const [joined, setJoined] = useState<WaitlistJoined | null>(null);
  const keys = useRef(new IdempotencyKeys());
  const quote = useMemo(() => toQuoteRequest(pkg, state), [pkg, state]);

  useEffect(() => {
    api('/auth/customer/session').then((r) => setSession(r.status === 200 ? 'signed-in' : 'signed-out')).catch(() => setSession('signed-out'));
    api('/pricing/quotes', { method: 'POST', body: quote })
      .then((r) => (r.status === 200 && isBreakdown(r.body) ? setBreakdown(r.body) : setError(t(requestErrorKey(r.status, r.body.code)))))
      .catch(() => setError(t('bookingRequest.errors.network')));
  }, [quote]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending) return;
    const f = new FormData(e.currentTarget);
    const body = toBookingRequest(quote, {
      givenName: String(f.get('givenName') ?? ''), familyName: String(f.get('familyName') ?? ''), phone: String(f.get('phone') ?? ''), countryOfResidence: String(f.get('countryOfResidence') ?? ''),
    });
    const problem = countryProblem(body.contact.countryOfResidence);
    if (problem) {
      setCountryError(t(problem.key, problem.params));
      document.getElementById('countryOfResidence')?.focus();
      return;
    }
    setCountryError(null);
    setSending(true);
    setError(null);
    try {
      const r = await api<{ reference: string }>('/booking-requests', { method: 'POST', body, headers: { 'Idempotency-Key': keys.current.keyFor(body) } });
      // Outside the countries we sell to the API answers with a waiting list entry, not a request (task 2.6).
      const waitlisted = r.status === 201 ? parseWaitlistJoined(r.body) : null;
      if (waitlisted) {
        setJoined(waitlisted);
        return;
      }
      if (r.status === 201 && typeof r.body.reference === 'string') {
        window.location.assign(`/trips/requests/${encodeURIComponent(r.body.reference)}`);
        return;
      }
      if (r.status === 401) setSession('signed-out');
      setError(t(requestErrorKey(r.status, r.body.code)));
    } catch {
      setError(t('bookingRequest.errors.network'));
    } finally {
      setSending(false);
    }
  }

  if (joined) return <WaitlistConfirmation joined={joined} />;
  return (
    <div className="stack">
      <p className="notice">{t('bookingRequest.notABooking')}</p>
      {breakdown ? <QuoteSummary pkg={pkg} breakdown={breakdown} /> : null}
      <Status message={error} />
      {session === 'checking' ? <p role="status">{t('bookingRequest.checking')}</p> : null}
      {session === 'signed-out' ? (
        <div className="stack">
          <p>{t('bookingRequest.signInFirst')}</p>
          <a className="btn" href="/account/sign-in" onClick={() => rememberReturnTo(window.localStorage, here)}>
            {t('bookingRequest.signIn')}
          </a>
        </div>
      ) : null}
      {session === 'signed-in' ? (
        <form className="stack form" onSubmit={submit} noValidate>
          <h2>{t('bookingRequest.contactHeading')}</h2>
          <Field label={t('bookingRequest.givenName')} id="givenName" autoComplete="given-name" required maxLength={100} />
          <Field label={t('bookingRequest.familyName')} id="familyName" autoComplete="family-name" required maxLength={100} />
          <Field label={t('bookingRequest.phone')} id="phone" type="tel" autoComplete="tel" maxLength={20} />
          <Field
            label={t('bookingRequest.country')} id="countryOfResidence" autoComplete="country" required maxLength={3} defaultValue="AU"
            aria-describedby={countryError ? 'countryHint countryError' : 'countryHint'} aria-invalid={countryError ? true : undefined}
          />
          {countryError ? <p id="countryError" className="form-error" role="alert">{countryError}</p> : null}
          <p id="countryHint">{t('bookingRequest.countryHint')}</p>
          <p>{t('bookingRequest.whatHappensNext')}</p>
          <button className="btn" type="submit" disabled={sending || !breakdown} aria-disabled={sending || !breakdown}>
            {sending ? t('bookingRequest.sending') : t('bookingRequest.send')}
          </button>
        </form>
      ) : null}
    </div>
  );
}
