'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';

/** Placeholder for the customer area (task 5.1): who is signed in, and signing out. */
export function AccountSummary() {
  const [email, setEmail] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    api<{ email: string }>('/auth/customer/session').then((r) => setEmail(r.status === 200 ? r.body.email : null));
  }, []);

  async function signOut() {
    await api('/auth/customer/sign-out', { method: 'POST', body: {} });
    setEmail(null);
  }

  if (email === undefined) return null;
  if (email === null) {
    return (
      <p>
        {t('auth.customer.notSignedIn')} <a href="/account/sign-in">{t('auth.customer.signInLink')}</a>
      </p>
    );
  }
  return (
    <div className="stack">
      <p>{t('auth.customer.signedInAs', { email })}</p>
      <button className="btn" type="button" onClick={signOut}>
        {t('auth.customer.signOut')}
      </button>
    </div>
  );
}
