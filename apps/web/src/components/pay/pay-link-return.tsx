'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaymentLinkRefreshView } from '@mt/shared';
import { Status } from '@/components/auth/field';
import { api } from '@/lib/api-client';
import { PAY_LINK_STORAGE_KEY, linkOutcome, payLinkErrorKey } from '@/lib/account';
import { REFRESH_EVERY_MS, REFRESH_MAX_TRIES } from '@/lib/checkout';
import { t } from '@/lib/i18n';

type Answer = { view: PaymentLinkRefreshView } | { error: string } | { noToken: true };

/**
 * Where a payment link's holder lands after the provider's page (task 5.1). The address carries nothing; the token kept
 * in this tab asks the API how the link's payment went. Nothing is reported as paid unless the API says so.
 */
export function PayLinkReturn() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [tries, setTries] = useState(0);
  const [checking, setChecking] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(async () => {
    let token: string | null = null;
    try {
      token = window.sessionStorage.getItem(PAY_LINK_STORAGE_KEY);
    } catch {
      token = null;
    }
    if (!token) {
      setAnswer({ noToken: true });
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      const r = await api<PaymentLinkRefreshView>('/payment-links/refresh', { method: 'POST', body: { token } });
      if (r.status === 200) {
        const view = r.body as PaymentLinkRefreshView;
        if (linkOutcome(view) === 'paid') window.sessionStorage.removeItem(PAY_LINK_STORAGE_KEY);
        setAnswer({ view });
      } else setAnswer({ error: payLinkErrorKey(r.status, r.body.code) });
    } catch {
      setAnswer({ error: 'network' });
    } finally {
      setChecking(false);
      setTries((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    void check();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [check]);

  const outcome = answer && 'view' in answer ? linkOutcome(answer.view) : null;
  useEffect(() => {
    if (outcome === 'processing' && tries < REFRESH_MAX_TRIES && !checking) timer.current = setTimeout(() => void check(), REFRESH_EVERY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [outcome, tries, checking, check]);

  if (!answer) return <p className="notice" role="status">{t('paymentReturn.checking')}</p>;
  if ('noToken' in answer || 'error' in answer) {
    return (
      <div className="stack">
        <Status message={t('noToken' in answer ? 'payLink.returnNoToken' : `payLink.errors.${answer.error}`)} />
        <p><Link href="/account">{t('payLink.toAccount')}</Link></p>
      </div>
    );
  }
  const key = outcome ?? 'none';
  return (
    <div className="stack" aria-live="polite">
      <h2>{t(`paymentReturn.${key}Heading`)}</h2>
      <p className={outcome === 'paid' ? 'notice' : undefined} role="status">{t(`payLink.return.${key}`)}</p>
      {outcome === 'processing' && tries >= REFRESH_MAX_TRIES ? <p><button className="btn" type="button" disabled={checking} onClick={() => { setTries(0); void check(); }}>{t('paymentReturn.checkAgain')}</button></p> : null}
      {outcome === 'failed' || outcome === 'none' ? <p><Link className="btn" href="/pay">{t('paymentReturn.tryAgain')}</Link></p> : null}
      <p><Link href="/account">{t('payLink.toAccount')}</Link></p>
    </div>
  );
}
