'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../auth/field';

const REF = /(?:^#|&)ref=([0-9a-f-]{36}\.[0-9a-f]{64})(?:&|$)/;

/**
 * Unsubscribing from marketing email (task 5.5). The reference comes in the fragment (it never reaches a server log)
 * and is taken off the address bar; one click on the button unsubscribes. Opening the page alone changes nothing, so
 * link scanners cannot unsubscribe anyone.
 */
export function MailUnsubscribe() {
  const [ref, setRef] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<'ready' | 'working' | 'done' | 'invalid'>('ready');

  useEffect(() => {
    const m = REF.exec(window.location.hash);
    if (m) window.history.replaceState(null, '', window.location.pathname);
    setRef(m ? m[1]! : null);
  }, []);

  async function unsubscribe() {
    if (!ref) return;
    setState('working');
    const r = await api(`/unsubscribe/${ref}`, { method: 'POST', body: {} });
    setState(r.status === 200 ? 'done' : 'invalid');
  }

  if (ref === undefined) return <noscript><p>{t('mailUnsubscribe.noScript')}</p></noscript>;
  if (ref === null || state === 'invalid') return <Status message={t('mailUnsubscribe.invalid')} />;
  if (state === 'done') return <Status tone="info" message={t('mailUnsubscribe.done')} />;
  return (
    <div className="stack">
      <p>{t('mailUnsubscribe.body')}</p>
      <div className="actions">
        <button className="btn" type="button" onClick={() => void unsubscribe()} disabled={state === 'working'}>
          {state === 'working' ? t('mailUnsubscribe.working') : t('mailUnsubscribe.button')}
        </button>
      </div>
    </div>
  );
}
