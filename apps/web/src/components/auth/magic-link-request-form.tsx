'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Field, Status } from './field';

/** The answer is the same whether or not the address has an account. */
export function MagicLinkRequestForm() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await api('/auth/customer/magic-link', { method: 'POST', body: { email: new FormData(e.currentTarget).get('email') } });
    if (r.status === 202) {
      setSent(true);
      setError(null);
    } else setError(r.status === 429 ? t('auth.staff.rateLimited') : t('auth.customer.error'));
  }

  if (sent) return <Status tone="info" message={t('auth.customer.sent')} />;
  return (
    <form className="stack form" onSubmit={submit} noValidate>
      <Status message={error} />
      <Field label={t('auth.customer.email')} id="email" type="email" autoComplete="email" required />
      <button className="btn" type="submit">
        {t('auth.customer.send')}
      </button>
    </form>
  );
}
