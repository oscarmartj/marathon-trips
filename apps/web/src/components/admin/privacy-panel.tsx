'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StaffPrivacyView } from '@mt/shared';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n-admin';
import { Status } from '../auth/field';
import { errorMessage, useStepUp } from './step-up';

const day = (iso: string) => formatDate(iso.slice(0, 10));

/** Saves the export the API sent as a file; nothing is kept in the page. */
function saveFile(data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `marathon-trips-data-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * A customer's privacy in the panel (task 5.5): marketing consent and its history, privacy requests, the owner's export
 * and erasure (both need a fresh authenticator code). Hidden for staff without privacy.customer.read.
 */
export function PrivacyPanel({ id, initial }: { id: string; initial?: StaffPrivacyView | null }) {
  const [view, setView] = useState<StaffPrivacyView | null | undefined>(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const { run, prompt } = useStepUp();

  const load = useCallback(async () => {
    const r = await api<StaffPrivacyView>(`/admin/privacy/customers/${id}`);
    setView(r.status === 200 ? r.body : null);
  }, [id]);
  useEffect(() => {
    if (initial === undefined) void load();
  }, [initial, load]);

  const fail = (r: { status: number; body: { code?: string } }) =>
    setMessage({ text: r.body.code === 'owner_only' ? t('admin.privacy.ownerOnly') : errorMessage(r), tone: 'error' });

  async function exportData(full: boolean) {
    const r = await run(() => api(`/admin/privacy/customers/${id}/export${full ? '?audience=full' : ''}`));
    if (r.status === 200) saveFile(r.body);
    else fail(r);
  }

  async function erase() {
    const r = await run(() => api(`/admin/privacy/customers/${id}/erasure`, { method: 'POST', body: {} }));
    if (r.status === 200) {
      setMessage({ text: t('admin.privacy.erasedDone'), tone: 'info' });
      await load();
    } else fail(r);
  }

  if (view === null) return null;
  if (view === undefined) return <p role="status">{t('admin.privacy.loading')}</p>;
  const consent = view.marketingConsent.granted && view.marketingConsent.recordedAt
    ? t('admin.privacy.consentYes', { date: day(view.marketingConsent.recordedAt) })
    : t('admin.privacy.consentNo');
  return (
    <section className="card stack" aria-labelledby="customer-privacy">
      <h2 id="customer-privacy">{t('admin.privacy.heading')}</h2>
      {prompt}
      {message ? <Status tone={message.tone} message={message.text} /> : null}
      {view.anonymised ? <p>{t('admin.privacy.erased')}</p> : null}
      <p>{t('admin.privacy.consent', { state: consent })}</p>
      {view.consentHistory.length > 0 ? (
        <>
          <h3>{t('admin.privacy.history')}</h3>
          <ul>
            {view.consentHistory.map((h, i) => (
              <li key={i}>{t('admin.privacy.historyLine', { date: day(h.recordedAt), state: t(h.granted ? 'admin.privacy.granted' : 'admin.privacy.withdrawn'), source: t(`admin.privacy.source.${h.source}`) })}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>{t('admin.privacy.requests')}</h3>
      {view.requests.length === 0 ? <p>{t('admin.privacy.noRequests')}</p> : (
        <ul>
          {view.requests.map((r, i) => (
            <li key={i}>{t('admin.privacy.requestLine', { date: day(r.requestedAt), kind: t(`admin.privacy.kind.${r.kind}`), status: t(`admin.privacy.status.${r.status}`), by: t(`admin.privacy.by.${r.requestedBy}`) })}</li>
          ))}
        </ul>
      )}
      <p className="muted">{t('admin.privacy.exportHelp')}</p>
      <div className="actions">
        <button className="btn" type="button" onClick={() => void exportData(false)}>{t('admin.privacy.export')}</button>
        <button className="link-button" type="button" onClick={() => void exportData(true)}>{t('admin.privacy.exportFull')}</button>
      </div>
      {view.anonymised ? null : (
        <div className="stack">
          <h3>{t('admin.privacy.eraseHeading')}</h3>
          <p>{t('admin.privacy.eraseHelp')}</p>
          {view.erasure.blockedBy ? <p role="status">{t(`admin.privacy.blocked.${view.erasure.blockedBy}`)}</p> : (
            <>
              <label className="checkbox">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.currentTarget.checked)} />{' '}
                {t('admin.privacy.eraseConfirm')}
              </label>
              <div className="actions">
                <button className="btn" type="button" disabled={!confirmed} onClick={() => void erase()}>{t('admin.privacy.erase')}</button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
