'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Field, Status } from './field';

const errorText = (status: number, code?: string): string => {
  if (status === 429) return t('auth.staff.rateLimited');
  if (code === 'invalid_credentials') return t('auth.staff.invalidCredentials');
  if (code === 'invalid_code') return t('auth.staff.invalidCode');
  if (code === 'mfa_expired') return t('auth.staff.expired');
  return t('auth.staff.error');
};

/** Password, then the authenticator code (or a recovery code). No session exists until the second step succeeds. */
export function StaffSignInForm() {
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    const r = await api('/auth/staff/sign-in', { method: 'POST', body: { email: form.get('email'), password: form.get('password') } });
    setBusy(false);
    if (r.status === 200) {
      setError(null);
      setStep('code');
    } else setError(errorText(r.status, r.body.code));
  }

  async function submitCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    const body = recovery ? { recoveryCode: String(form.get('recoveryCode') ?? '') } : { code: String(form.get('code') ?? '').replace(/\s/g, '') };
    const r = await api('/auth/staff/sign-in/second-factor', { method: 'POST', body });
    setBusy(false);
    if (r.status === 200) {
      window.location.assign('/admin');
      return;
    }
    setError(errorText(r.status, r.body.code));
    if (r.body.code === 'mfa_expired') setStep('password');
  }

  if (step === 'password') {
    return (
      <form className="stack form" onSubmit={submitPassword} noValidate>
        <Status message={error} />
        <Field label={t('auth.staff.email')} id="email" type="email" autoComplete="username" required />
        <Field label={t('auth.staff.password')} id="password" type="password" autoComplete="current-password" required />
        <button className="btn" type="submit" disabled={busy}>
          {t('auth.staff.continue')}
        </button>
      </form>
    );
  }
  return (
    <form className="stack form" onSubmit={submitCode} noValidate>
      <Status message={error} />
      <p>{t('auth.staff.codeIntro')}</p>
      {recovery ? (
        <Field label={t('auth.staff.recoveryLabel')} id="recoveryCode" autoComplete="off" required />
      ) : (
        <Field label={t('auth.staff.codeLabel')} id="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
      )}
      <button className="btn" type="submit" disabled={busy}>
        {t('auth.staff.signIn')}
      </button>
      <button className="link-button" type="button" onClick={() => setRecovery(!recovery)}>
        {recovery ? t('auth.staff.useCode') : t('auth.staff.useRecovery')}
      </button>
    </form>
  );
}
