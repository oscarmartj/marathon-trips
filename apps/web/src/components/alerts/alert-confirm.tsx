'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, takeFragmentToken } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../auth/field';

/**
 * Reads the token from the URL fragment and only uses it up when the person presses the button, so a mail scanner
 * that opens the link confirms nobody.
 */
export function AlertConfirm() {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<'checking' | 'ready' | 'done' | 'invalid'>('checking');

  useEffect(() => {
    const tk = takeFragmentToken();
    setToken(tk);
    setState(tk ? 'ready' : 'invalid');
  }, []);

  async function confirm() {
    const r = await api('/alerts/confirm', { method: 'POST', body: { token } });
    setState(r.status === 200 ? 'done' : 'invalid');
  }

  if (state === 'checking') return <p role="status">{t('alerts.confirm.checking')}</p>;
  if (state === 'done') return <Status tone="info" message={t('alerts.confirm.done')} />;
  if (state === 'invalid') {
    return (
      <div className="stack">
        <Status message={t('alerts.confirm.invalid')} />
        <Link className="link-block" href="/races">{t('alerts.confirm.browse')}</Link>
      </div>
    );
  }
  return (
    <button className="btn" type="button" onClick={confirm}>
      {t('alerts.confirm.button')}
    </button>
  );
}
