'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Field, Status } from '../auth/field';

/** Asks for an email address and starts the double confirmation. The answer is the same for every address. */
export function AlertForm({ raceSlug }: { raceSlug: string }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState('sending');
    const r = await api('/alerts/subscriptions', { method: 'POST', body: { email: email.trim(), raceSlug } });
    if (r.status === 202) setState('sent');
    else {
      setState('idle');
      setError(r.status === 422 ? t('alerts.invalidEmail') : r.status === 429 ? t('alerts.tooMany') : t('alerts.failed'));
    }
  }

  if (state === 'sent') return <Status tone="info" message={t('alerts.sent')} />;
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Field label={t('alerts.email')} id={`alert-email-${raceSlug}`} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      <Status message={error} />
      <button className="btn" type="submit" disabled={state === 'sending'}>
        {state === 'sending' ? t('alerts.sending') : t('alerts.submit')}
      </button>
    </form>
  );
}
