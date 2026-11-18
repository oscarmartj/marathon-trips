'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, takeFragmentToken } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Field, Status } from './field';

interface Started {
  email: string;
  secret: string;
  uri: string;
}

/**
 * Staff set-up from a one-time link. The token is in the URL fragment, so it never reaches a server log; starting
 * does not use the link up, finishing does.
 */
export function EnrolForm() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState<Started | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(takeFragmentToken());
    setReady(true);
  }, []);

  async function start() {
    const r = await api<Started>('/auth/staff/enrolment/start', { method: 'POST', body: { token } });
    if (r.status === 200) setStarted(r.body);
    else setError(t('auth.enrol.missingLink'));
  }

  async function finish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const r = await api<{ recoveryCodes: string[] }>('/auth/staff/enrolment/complete', {
      method: 'POST', body: { token, password: form.get('password'), code: String(form.get('code') ?? '').replace(/\s/g, '') },
    });
    if (r.status === 200) setCodes(r.body.recoveryCodes);
    else if (r.body.code === 'password_too_common') setError(t('auth.enrol.passwordTooCommon'));
    else setError(r.body.code === 'invalid_code' ? t('auth.enrol.invalidCode') : t('auth.enrol.missingLink'));
  }

  if (!ready) return null;
  if (codes) {
    return (
      <section className="stack" aria-labelledby="recovery-title">
        <h2 id="recovery-title">{t('auth.enrol.recoveryTitle')}</h2>
        <p>{t('auth.enrol.recoveryHelp')}</p>
        <ul className="code-list">
          {codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
        <a className="btn" href="/admin/sign-in">
          {t('auth.enrol.goToSignIn')}
        </a>
      </section>
    );
  }
  if (!token) return <Status message={t('auth.enrol.missingLink')} />;
  if (!started) {
    return (
      <div className="stack">
        <Status message={error} />
        <button className="btn" type="button" onClick={start}>
          {t('auth.enrol.start')}
        </button>
      </div>
    );
  }
  return (
    <form className="stack form" onSubmit={finish} noValidate>
      <Status message={error} />
      <p>{t('auth.enrol.accountFor', { email: started.email })}</p>
      <p>{t('auth.enrol.secretHelp')}</p>
      <p>
        {t('auth.enrol.secretLabel')}: <code className="secret">{started.secret}</code>
      </p>
      <p>
        <a href={started.uri}>{t('auth.enrol.openInApp')}</a>
      </p>
      <Field label={t('auth.enrol.passwordLabel')} id="password" type="password" autoComplete="new-password" minLength={12} required />
      <Field label={t('auth.enrol.codeLabel')} id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
      <button className="btn" type="submit">
        {t('auth.enrol.finish')}
      </button>
    </form>
  );
}
