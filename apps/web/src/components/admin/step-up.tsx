'use client';

import { useRef, useState, type FormEvent } from 'react';
import { api, type ApiResult } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Field, Status } from '../auth/field';

/**
 * Runs an admin action; if the API answers step_up_required, asks for a fresh authenticator code and runs it again.
 * The API decides which actions need it (the permission manifest), not this page.
 */
interface Action {
  (): Promise<ApiResult>;
}

export function useStepUp() {
  const pending = useRef<Action | null>(null);
  const resolver = useRef<((r: ApiResult) => void) | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: Action): Promise<ApiResult> {
    const r = await action();
    if (r.status !== 403 || r.body.code !== 'step_up_required') return r;
    pending.current = action;
    setAsking(true);
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('stepUpCode') ?? '').replace(/\s/g, '');
    const r = await api('/auth/staff/step-up', { method: 'POST', body: { code } });
    if (r.status !== 200) {
      if (r.body.code === 'session_revoked') window.location.assign('/admin/sign-in');
      setError(r.status === 429 ? t('auth.staff.rateLimited') : t('auth.staff.invalidCode'));
      return;
    }
    setAsking(false);
    setError(null);
    const result = await pending.current!();
    resolver.current?.(result);
  }

  function cancel() {
    setAsking(false);
    resolver.current?.({ status: 403, body: { code: 'step_up_required' } });
  }

  const prompt = asking ? (
    <form className="card stack form" onSubmit={confirm} aria-labelledby="step-up-title">
      <h2 id="step-up-title">{t('auth.stepUp.title')}</h2>
      <p>{t('auth.stepUp.help')}</p>
      <Status message={error} />
      <Field label={t('auth.stepUp.codeLabel')} id="stepUpCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus />
      <div className="actions">
        <button className="btn" type="submit">
          {t('auth.stepUp.confirm')}
        </button>
        <button className="link-button" type="button" onClick={cancel}>
          {t('auth.stepUp.cancel')}
        </button>
      </div>
    </form>
  ) : null;
  return { run, prompt };
}

export const errorMessage = (r: { status: number }): string => {
  if (r.status === 403) return t('admin.common.forbidden');
  if (r.status === 409) return t('admin.common.conflict');
  return t('admin.common.error');
};
