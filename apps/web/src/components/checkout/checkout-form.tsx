'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { CheckoutTermsView, PaymentMethod, PaymentPlanView } from '@mt/shared';
import { Status } from '@/components/auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { formatDate } from '@/lib/catalogue-format';
import { acceptTermsBody, checkoutErrorKey, formatInstant, newIdempotencyKey, safeRedirect, startPaymentBody } from '@/lib/checkout';
import { t } from '@/lib/i18n';

/** The terms in paragraphs: blank lines separate them, as in the content manager. */
const paragraphs = (body: string): string[] => body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/**
 * Checkout (task 3.5): the plan as the API holds it, the methods the API says are open for the customer's country, the
 * booking terms with their version, and one button. The page sends a method, never an amount; the provider's own page
 * takes the payment details.
 */
export function CheckoutForm({ plan, initialTerms }: { plan: PaymentPlanView; initialTerms: CheckoutTermsView }) {
  const [terms, setTerms] = useState(initialTerms);
  const [method, setMethod] = useState<PaymentMethod | ''>(plan.liveAttempt && plan.methods.includes(plan.liveAttempt.method) ? plan.liveAttempt.method : plan.methods.includes('card') ? 'card' : (plan.methods[0] ?? ''));
  const [accepted, setAccepted] = useState(initialTerms.acceptedAt !== null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per method: a retry of the same choice is the same payment, another method is a new one.
  const keys = useRef(new Map<string, string>());

  const fail = (key: string) => setError(t(`checkout.errors.${key}`));

  async function reloadTerms(): Promise<void> {
    const r = await api<CheckoutTermsView>(`/booking-requests/${encodeURIComponent(plan.reference)}/checkout-terms`);
    if (r.status === 200 && typeof r.body.digest === 'string') {
      setTerms(r.body as CheckoutTermsView);
      setAccepted(r.body.acceptedAt != null);
    }
  }

  async function pay() {
    if (busy) return;
    setError(null);
    if (!method) return fail('chooseMethod');
    if (!accepted) return fail('acceptFirst');
    setBusy(true);
    try {
      if (terms.acceptedAt === null) {
        const a = await api<{ acceptedAt: string }>(`/booking-requests/${encodeURIComponent(plan.reference)}/terms-acceptance`, { method: 'POST', body: acceptTermsBody(terms) });
        if (a.status !== 200) {
          if (a.body.code === 'terms_changed') await reloadTerms().then(() => setAccepted(false));
          fail(checkoutErrorKey(a.status, a.body.code));
          return;
        }
        setTerms({ ...terms, acceptedAt: a.body.acceptedAt });
      }
      if (!keys.current.has(method)) keys.current.set(method, newIdempotencyKey());
      const r = await api<{ status: string; nextAction?: { type: string; url: string } }>(`/booking-requests/${encodeURIComponent(plan.reference)}/payments`, {
        method: 'POST', body: startPaymentBody(method), headers: { 'Idempotency-Key': keys.current.get(method)! },
      });
      if (r.status === 201) {
        const target = safeRedirect(r.body.nextAction?.url);
        if (target) {
          window.location.assign(target);
          return;
        }
        // No page to go to (the payment is already settled or closed): the return page says where it stands.
        if (!r.body.nextAction) {
          window.location.assign(`/payments/return?ref=${encodeURIComponent(plan.reference)}`);
          return;
        }
        fail('badRedirect');
        return;
      }
      if (r.body.code === 'terms_not_accepted') await reloadTerms().then(() => setAccepted(false));
      fail(checkoutErrorKey(r.status, r.body.code));
    } catch {
      fail('network');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void pay();
      }}
    >
      <section className="stack" aria-labelledby="plan-heading">
        <h2 id="plan-heading">{t('checkout.planHeading')}</h2>
        <dl>
          <div>
            <dt>{t('checkout.reference')}</dt>
            <dd>{plan.reference}</dd>
          </div>
          {plan.items.map((i) => (
            <div key={i.sequence}>
              <dt>{t(`checkout.item.${i.kind}`)}</dt>
              <dd>
                {t('checkout.itemLine', { amount: formatMoney(i.amountMinor, plan.currency), date: formatDate(i.dueDate) })}
                {' · '}
                {i.paidMinor !== '0' ? t('checkout.itemPaid', { amount: formatMoney(i.paidMinor, plan.currency) }) : t('checkout.itemUnpaid')}
              </dd>
            </div>
          ))}
        </dl>
        {plan.nextPayable ? <p><strong>{t('checkout.payNow', { amount: formatMoney(plan.nextPayable.amountMinor, plan.currency) })}</strong></p> : null}
        {plan.liveAttempt ? <p className="notice" role="status">{t(plan.liveAttempt.status === 'requires_action' || plan.liveAttempt.status === 'created' ? 'checkout.attempt.open' : 'checkout.attempt.pending')}</p> : null}
        {plan.depositDueBy ? <p>{t('checkout.payNowUntil', { when: formatInstant(plan.depositDueBy) })}</p> : null}
      </section>

      <fieldset className="stack">
        <legend>{t('checkout.methodsHeading')}</legend>
        <p>{t('checkout.methodsNote')}</p>
        {plan.methods.map((m) => (
          <label key={m} className="choice">
            <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} />
            <span>{t(`checkout.methods.${m}`)}</span>
          </label>
        ))}
        <p>{t('checkout.hostedNote')}</p>
      </fieldset>

      <section className="stack" aria-labelledby="terms-heading">
        <h2 id="terms-heading">{t('checkout.termsHeading')}</h2>
        <p>{t('checkout.termsVersion', { version: terms.version })}</p>
        {/* Focusable so a keyboard can scroll the text. */}
        <div className="terms-text" tabIndex={0} role="region" aria-label={t('checkout.termsText')}>
          <h3>{terms.title}</h3>
          {terms.intro ? <p>{terms.intro}</p> : null}
          {paragraphs(terms.body).map((p, i) => <p key={i}>{p}</p>)}
        </div>
        <p><Link href="/legal/terms" target="_blank" rel="noopener">{t('checkout.termsFull')}</Link></p>
        <label className="choice">
          <input type="checkbox" name="terms" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} aria-describedby={error ? 'checkout-status' : undefined} />
          <span>{t('checkout.termsAccept', { version: terms.version })}</span>
        </label>
        {terms.acceptedAt ? <p>{t('checkout.termsAccepted', { when: formatInstant(terms.acceptedAt) })}</p> : null}
      </section>

      <div id="checkout-status">
        <Status message={error} />
        {busy ? <p className="notice" role="status">{t('checkout.paying')}</p> : null}
      </div>
      <p>
        <button className="btn" type="submit" disabled={busy} aria-disabled={busy}>
          {t('checkout.pay')}
        </button>
      </p>
    </form>
  );
}
