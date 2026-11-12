'use client';

import { useEffect, useState } from 'react';
import { api, takeFragmentToken } from '@/lib/api-client';
import { takeReturnTo } from '@/lib/booking-request';
import { t } from '@/lib/i18n';
import { Status } from './field';

/**
 * Reads the token from the URL fragment and only uses it up when the person presses the button (M4), so a mail
 * scanner that opens the link signs nobody in.
 */
export function MagicLinkVerify() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<'checking' | 'ready' | 'invalid'>('checking');

  useEffect(() => {
    const tk = takeFragmentToken();
    setToken(tk);
    if (!tk) {
      setState('invalid');
      return;
    }
    api<{ email: string }>('/auth/customer/magic-link/inspect', { method: 'POST', body: { token: tk } }).then((r) => {
      if (r.status === 200) {
        setEmail(r.body.email);
        setState('ready');
      } else setState('invalid');
    });
  }, []);

  async function confirm() {
    const r = await api('/auth/customer/magic-link/verify', { method: 'POST', body: { token } });
    // Back to the booking request that sent the person here (task 2.4), if any and if it is one of our request pages.
    if (r.status === 200) window.location.assign(takeReturnTo(window.localStorage) ?? '/account');
    else setState('invalid');
  }

  if (state === 'checking') return <p role="status">{t('auth.customer.checking')}</p>;
  if (state === 'invalid') {
    return (
      <div className="stack">
        <Status message={t('auth.customer.invalidLink')} />
        <a href="/account/sign-in">{t('auth.customer.requestNew')}</a>
      </div>
    );
  }
  return (
    <button className="btn" type="button" onClick={confirm}>
      {t('auth.customer.continueAs', { email: email ?? '' })}
    </button>
  );
}
