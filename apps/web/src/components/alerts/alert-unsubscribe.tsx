'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../auth/field';

/** One click from the email: opening the link unsubscribes. Unsubscribing twice is harmless. */
export function AlertUnsubscribe() {
  const [state, setState] = useState<'working' | 'done' | 'invalid'>('working');

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const subscriptionId = q.get('s');
    const token = q.get('t');
    if (!subscriptionId || !token) {
      setState('invalid');
      return;
    }
    api('/alerts/unsubscribe', { method: 'POST', body: { subscriptionId, token } }).then((r) => setState(r.status === 200 ? 'done' : 'invalid'));
  }, []);

  if (state === 'working') return <p role="status">{t('alerts.unsubscribe.working')}</p>;
  return (
    <div className="stack">
      <Status tone={state === 'done' ? 'info' : 'error'} message={state === 'done' ? t('alerts.unsubscribe.done') : t('alerts.unsubscribe.invalid')} />
      <Link href="/races">{t('alerts.unsubscribe.browse')}</Link>
    </div>
  );
}
