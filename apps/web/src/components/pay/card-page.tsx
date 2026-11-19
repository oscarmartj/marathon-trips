'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { CardSessionView, CardSubmitResult } from '@mt/shared';
import { Status } from '@/components/auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { CARD_FIELD_CONTAINERS, CARD_SESSION_REF, cardPageErrorKey, cardPageFailureKey, cardSubmitBody, loadScriptOnce } from '@/lib/card-page';
import { safeRedirect } from '@/lib/checkout';
import { t } from '@/lib/i18n';

/** What Pin's hosted fields script exposes (plan 4.4, section 2; its exact callback shape is unverified, A12). */
interface HostedFieldsInstance {
  tokenize(params: { publishable_api_key: string }, done: (err: unknown, response?: { token?: unknown }) => void): void;
}
interface HostedFieldsGlobal {
  create(opts: { sandbox: boolean; autocomplete: boolean; fields: Record<string, { selector: string }> }): HostedFieldsInstance;
}
declare global {
  interface Window {
    HostedFields?: HostedFieldsGlobal;
  }
}

type Loaded = { kind: 'loading' } | { kind: 'error'; key: string } | { kind: 'ok'; view: CardSessionView };

/**
 * The card page of a card session (task 4.4). The card is typed into the gateway's iframes; this page never sees it.
 * It shows the amount the API returns, posts only the single-use token the gateway gives, and follows the API's answer
 * (the bank's check, or the return page).
 */
export function CardPage({ sessionRef }: { sessionRef: string }) {
  const [state, setState] = useState<Loaded>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = useRef<HostedFieldsInstance | null>(null);

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
        if (cancelled || !window.HostedFields) return;
        fields.current = window.HostedFields.create({
          sandbox: card.sandbox, autocomplete: true,
          fields: Object.fromEntries(CARD_FIELD_CONTAINERS.map((c) => [c.field, { selector: `#${c.id}` }])),
        });
      })
      .catch(() => setError(t('cardPage.errors.fieldsUnavailable')));
    return () => {
      cancelled = true;
    };
  }, [card]);

  function tokenize(publishableKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!fields.current) return reject(new Error('fields'));
      fields.current.tokenize({ publishable_api_key: publishableKey }, (err, response) => {
        if (err || typeof response?.token !== 'string') return reject(new Error('tokenize'));
        resolve(response.token);
      });
    });
  }

  async function pay() {
    if (busy || !card) return;
    setError(null);
    setBusy(true);
    try {
      let token: string;
      try {
        token = await tokenize(card.publishableKey);
      } catch {
        return setError(t('cardPage.errors.checkCard'));
      }
      const r = await api<CardSubmitResult>('/payments/card-sessions/submit', { method: 'POST', body: cardSubmitBody(sessionRef, token) });
      if (r.status === 200) {
        const body = r.body as CardSubmitResult;
        if (body.next === 'redirect') {
          const target = safeRedirect(body.url) ?? (body.url.startsWith(`${window.location.origin}/`) ? body.url : null);
          if (target) return window.location.assign(target);
          return setError(t('cardPage.errors.generic'));
        }
        return setState({ kind: 'ok', view: { ...(state.kind === 'ok' ? state.view : { amountMinor: '0', currency: 'AUD' }), status: 'processing', card: undefined } });
      }
      setError(t(`cardPage.errors.${cardPageErrorKey(r.status, r.body.code)}`));
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
      <p>{t('cardPage.hostedNote')}</p>
      {CARD_FIELD_CONTAINERS.map((c) => (
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
