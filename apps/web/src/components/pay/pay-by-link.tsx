'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { PaymentLinkView, PaymentMethod } from '@mt/shared';
import { Status } from '@/components/auth/field';
import { api, takeFragmentToken } from '@/lib/api-client';
import { PAY_LINK_STORAGE_KEY, payByLinkBody, payLinkErrorKey } from '@/lib/account';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { formatDate } from '@/lib/catalogue-format';
import { formatInstant, newIdempotencyKey, safeRedirect } from '@/lib/checkout';
import { t } from '@/lib/i18n';

type Loaded = { kind: 'loading' } | { kind: 'noToken' } | { kind: 'error'; key: string } | { kind: 'ok'; token: string; view: PaymentLinkView };

const storage = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * Paying through a payment link (task 5.1). The token comes from the address fragment (never sent to a server in a URL)
 * and goes to the API in a request body. The page shows the trip and the amount due now as the API says, and sends a
 * method, never an amount. It cannot accept the booking terms: that needs the customer's own sign-in.
 */
export function PayByLink() {
  const [state, setState] = useState<Loaded>({ kind: 'loading' });
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef(new Map<string, string>());

  useEffect(() => {
    const token = takeFragmentToken() ?? storage()?.getItem(PAY_LINK_STORAGE_KEY) ?? null;
    if (!token) {
      setState({ kind: 'noToken' });
      return;
    }
    // Kept in this tab only, so the page still works after a reload and the return page can ask how it went.
    storage()?.setItem(PAY_LINK_STORAGE_KEY, token);
    api<PaymentLinkView>('/payment-links/view', { method: 'POST', body: { token } })
      .then((r) => {
        if (r.status !== 200) {
          if (r.status === 404) storage()?.removeItem(PAY_LINK_STORAGE_KEY);
          setState({ kind: 'error', key: payLinkErrorKey(r.status, r.body.code) });
          return;
        }
        const view = r.body as PaymentLinkView;
        setMethod(view.liveAttempt && view.methods.includes(view.liveAttempt.method) ? view.liveAttempt.method : view.methods.includes('card') ? 'card' : (view.methods[0] ?? ''));
        setState({ kind: 'ok', token, view });
      })
      .catch(() => setState({ kind: 'error', key: 'network' }));
  }, []);

  async function pay(token: string) {
    if (busy) return;
    setError(null);
    if (!method) return setError(t('payLink.errors.chooseMethod'));
    setBusy(true);
    try {
      if (!keys.current.has(method)) keys.current.set(method, newIdempotencyKey());
      const r = await api<{ nextAction?: { type: string; url: string } }>('/payment-links/payments', { method: 'POST', body: payByLinkBody(token, method), headers: { 'Idempotency-Key': keys.current.get(method)! } });
      if (r.status === 201) {
        const target = safeRedirect(r.body.nextAction?.url);
        if (target) return window.location.assign(target);
        if (!r.body.nextAction) return window.location.assign('/pay/return');
        return setError(t('payLink.errors.generic'));
      }
      setError(t(`payLink.errors.${payLinkErrorKey(r.status, r.body.code)}`));
    } catch {
      setError(t('payLink.errors.network'));
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') return <p className="notice" role="status">{t('payLink.loading')}</p>;
  if (state.kind === 'noToken' || state.kind === 'error') {
    return (
      <div className="stack">
        <Status message={t(state.kind === 'noToken' ? 'payLink.noToken' : `payLink.errors.${state.key}`)} />
        <p><Link className="link-block" href="/account/sign-in">{t('payLink.signIn')}</Link></p>
      </div>
    );
  }
  const v = state.view;
  return (
    <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); void pay(state.token); }}>
      <section className="stack" aria-labelledby="link-trip-heading">
        <h2 id="link-trip-heading">{t('payLink.tripHeading')}</h2>
        <dl>
          <div><dt>{t('account.reference')}</dt><dd>{v.reference}</dd></div>
          <div><dt>{t('account.detail.trip')}</dt><dd>{t('account.list.trip', { race: localisedText(v.race.name), year: v.editionYear, pkg: localisedText(v.package.name) })}</dd></div>
          <div><dt>{t('account.dates')}</dt><dd>{t('account.dateRange', { from: formatDate(v.departureDate), to: formatDate(v.returnDate) })}</dd></div>
        </dl>
        <p><strong>{t('payLink.amountDue', { amount: formatMoney(v.amountDueMinor, v.currency) })}</strong></p>
        <p>{t('payLink.validUntil', { when: formatInstant(v.expiresAt) })}</p>
        {v.liveAttempt ? <p className="notice" role="status">{t('payLink.inProgress')}</p> : null}
      </section>
      {!v.termsAccepted ? (
        <div className="stack">
          <p className="notice" role="status">{t('payLink.termsFirst')}</p>
          <p><Link className="btn" href="/account/sign-in">{t('payLink.signIn')}</Link></p>
        </div>
      ) : !v.payable ? (
        <p className="notice" role="status">{t('checkout.notPayable.no_payment_method_available')}</p>
      ) : (
        <>
          <fieldset className="stack">
            <legend>{t('checkout.methodsHeading')}</legend>
            {v.methods.map((m) => (
              <label key={m} className="choice">
                <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} />
                <span>{t(`checkout.methods.${m}`)}</span>
              </label>
            ))}
            <p>{t('checkout.hostedNote')}</p>
          </fieldset>
          <div>
            <Status message={error} />
            {busy ? <p className="notice" role="status">{t('checkout.paying')}</p> : null}
          </div>
          <p><button className="btn" type="submit" disabled={busy} aria-disabled={busy}>{t('payLink.pay')}</button></p>
        </>
      )}
    </form>
  );
}
