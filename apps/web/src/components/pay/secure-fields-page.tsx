'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { CardSessionView, CardSubmitResult } from '@mt/shared';
import { Status } from '@/components/auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { CARD_SESSION_REF, cardPageErrorKey, cardPageFailureKey, loadScriptOnce } from '@/lib/card-page';
import { safeRedirect } from '@/lib/checkout';
import { t } from '@/lib/i18n';
import { ACCESS_CODE, SECURE_FIELD_CODE, SECURE_FIELD_CONTAINERS, secureAuthoriseBody, secureFieldsErrorKey, secureSubmitBody } from '@/lib/secure-fields-page';

/** What eWAY's script exposes (plan 9.1, section 2; UNVERIFIED until the sandbox run). */
interface SecureFieldEvent { secureFieldCode?: unknown; fieldValid?: unknown; valueIsValid?: unknown }
interface EwayGlobal {
  setupSecureField(config: { publicApiKey: string; fieldDivId: string; fieldType: string }, callback: (e: SecureFieldEvent) => void): void;
}
interface CerberusGlobal {
  run(opts: { accessCode: string; onComplete: (result: unknown) => void }): void;
}
declare global {
  interface Window {
    eWAY?: EwayGlobal;
    Cerberus?: CerberusGlobal;
  }
}

type Loaded = { kind: 'loading' } | { kind: 'error'; key: string } | { kind: 'ok'; view: CardSessionView };

/**
 * eWAY's card page (task 9.1). The card is typed into eWAY's iframes; this page never sees it. It sends eWAY's
 * single-use code once, runs the bank's check in eWAY's 3-D Secure script, then asks for the one charge. The amount
 * is the one the API returns.
 */
export function SecureFieldsPage({ sessionRef }: { sessionRef: string }) {
  const [state, setState] = useState<Loaded>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const code = useRef<string | null>(null);
  const valid = useRef<Record<string, boolean>>({});

  useEffect(() => {
    if (!CARD_SESSION_REF.test(sessionRef)) {
      setState({ kind: 'error', key: 'notFound' });
      return;
    }
    api<CardSessionView>('/payments/card-sessions/view', { method: 'POST', body: { ref: sessionRef } })
      .then((r) => setState(r.status === 200 ? { kind: 'ok', view: r.body as CardSessionView } : { kind: 'error', key: cardPageErrorKey(r.status, r.body.code) }))
      .catch(() => setState({ kind: 'error', key: 'network' }));
  }, [sessionRef]);

  const card = state.kind === 'ok' ? state.view.card : undefined;
  useEffect(() => {
    if (!card) return;
    let cancelled = false;
    loadScriptOnce(card.scriptUrl)
      .then(() => {
        if (cancelled || !window.eWAY) return;
        for (const f of SECURE_FIELD_CONTAINERS) {
          window.eWAY.setupSecureField({ publicApiKey: card.publishableKey, fieldDivId: f.id, fieldType: f.fieldType }, (e) => {
            valid.current[f.fieldType] = e.fieldValid === true && e.valueIsValid === true;
            if (typeof e.secureFieldCode === 'string' && SECURE_FIELD_CODE.test(e.secureFieldCode)) code.current = e.secureFieldCode;
          });
        }
      })
      .catch(() => setError(t('cardPage.errors.fieldsUnavailable')));
    return () => {
      cancelled = true;
    };
  }, [card]);

  /** The bank's check in eWAY's script; resolves when it says it is done (the API reads the outcome). */
  function challenge(accessCode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!window.Cerberus) return reject(new Error('cerberus'));
      window.Cerberus.run({ accessCode, onComplete: () => resolve() });
    });
  }

  function follow(body: CardSubmitResult): boolean {
    if (body.next !== 'redirect') return false;
    const target = safeRedirect(body.url) ?? (body.url.startsWith(`${window.location.origin}/`) ? body.url : null);
    if (target) window.location.assign(target);
    else setError(t('cardPage.errors.generic'));
    return true;
  }

  async function pay() {
    if (busy || !card) return;
    setError(null);
    const secureFieldCode = code.current;
    if (!secureFieldCode || SECURE_FIELD_CONTAINERS.some((f) => valid.current[f.fieldType] !== true)) return setError(t('cardPage.errors.checkCard'));
    setBusy(true);
    try {
      const r = await api<CardSubmitResult>('/payments/card-sessions/secure-fields/submit', { method: 'POST', body: secureSubmitBody(sessionRef, secureFieldCode) });
      if (r.status !== 200) return setError(t(`cardPage.errors.${secureFieldsErrorKey(r.status, r.body.code)}`));
      const first = r.body as CardSubmitResult;
      if (follow(first)) return;
      if (first.next === 'authenticate' && ACCESS_CODE.test(first.accessCode)) {
        try {
          await challenge(first.accessCode);
        } catch {
          return setError(t('cardPage.errors.challengeUnavailable'));
        }
        const a = await api<CardSubmitResult>('/payments/card-sessions/secure-fields/authorise', { method: 'POST', body: secureAuthoriseBody(sessionRef, first.accessCode, secureFieldCode) });
        if (a.status !== 200) return setError(t(`cardPage.errors.${secureFieldsErrorKey(a.status, a.body.code)}`));
        if (follow(a.body as CardSubmitResult)) return;
      }
      setState({ kind: 'ok', view: { ...(state.kind === 'ok' ? state.view : { amountMinor: '0', currency: 'AUD' }), status: 'processing', card: undefined } });
    } catch {
      setError(t('cardPage.errors.network'));
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') return <p className="notice" role="status">{t('cardPage.loading')}</p>;
  if (state.kind === 'error') {
    return (
      <div className="stack">
        <Status message={t(`cardPage.errors.${state.key}`)} />
        <p><Link className="link-block" href="/account">{t('cardPage.toAccount')}</Link></p>
      </div>
    );
  }
  const v = state.view;
  const amount = formatMoney(v.amountMinor, v.currency);
  if (v.status === 'processing') return <p className="notice" role="status">{t('cardPage.processing')}</p>;
  if (v.status === 'finished') {
    return (
      <div className="stack">
        <p className="notice" role="status">{v.failed ? t(`cardPage.failed.${cardPageFailureKey(v.failed)}`) : t('cardPage.finished')}</p>
        {v.returnUrl ? <p><a className="btn" href={v.returnUrl}>{t('cardPage.continue')}</a></p> : null}
      </div>
    );
  }
  if (!card) return <p className="notice" role="status">{t('cardPage.unavailable')}</p>;
  return (
    <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); void pay(); }}>
      <p><strong>{t('cardPage.amount', { amount })}</strong></p>
      <p>{t('cardPage.secureFieldsNote')}</p>
      {SECURE_FIELD_CONTAINERS.map((c) => (
        <div key={c.id} className="stack">
          <span id={`${c.id}-label`} className="label">{t(c.label)}</span>
          <div id={c.id} className="hosted-field" role="group" aria-labelledby={`${c.id}-label`} />
        </div>
      ))}
      <div aria-live="polite">
        <Status message={error} />
        {busy ? <p className="notice" role="status">{t('cardPage.paying')}</p> : null}
      </div>
      <p><button className="btn" type="submit" disabled={busy} aria-disabled={busy}>{t('cardPage.pay', { amount })}</button></p>
    </form>
  );
}
