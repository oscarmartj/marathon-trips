'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { AccountPrivacyView } from '@mt/shared';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/catalogue-format';
import { t } from '@/lib/i18n';
import { Status } from '../auth/field';

const day = (iso: string) => formatDate(iso.slice(0, 10));

/**
 * The customer's privacy choices (task 5.5): marketing consent, separate from everything else and unticked unless the API
 * says it was given; the data download (a plain link: the browser saves the file the API sends); and erasure.
 */
export function PrivacySettings({ initial }: { initial?: AccountPrivacyView | null }) {
  const [view, setView] = useState<AccountPrivacyView | null | undefined>(initial);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [confirmAccount, setConfirmAccount] = useState(false);
  const [deleted, setDeleted] = useState(false);

  async function load() {
    const r = await api<AccountPrivacyView>('/account/privacy');
    setView(r.status === 200 ? r.body : null);
    if (r.status === 409) setMessage({ text: t('account.privacy.closed'), tone: 'error' });
  }
  useEffect(() => {
    if (initial === undefined) void load();
  }, [initial]);

  async function saveConsent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!view) return;
    const granted = new FormData(e.currentTarget).get('marketing') === 'yes';
    const r = await api('/account/privacy/marketing-consent', { method: 'PUT', body: { granted, wordingKey: view.wordingKey } });
    if (r.status === 200) {
      setMessage({ text: t('account.privacy.marketing.saved'), tone: 'info' });
      await load();
    } else setMessage({ text: r.status === 422 ? t('account.privacy.marketing.outdated') : t('account.privacy.error'), tone: 'error' });
  }

  async function askErasure(confirm: boolean) {
    const r = await api<{ status: string }>('/account/privacy/erasure-request', { method: 'POST', body: confirm ? { confirm: true } : {} });
    if (r.status !== 200) {
      setMessage({ text: t('account.privacy.error'), tone: 'error' });
      return;
    }
    if (r.body.status === 'completed') setDeleted(true);
    else await load();
  }

  if (deleted) return <Status tone="info" message={t('account.privacy.erase.deleted')} />;
  if (view === undefined) return <p role="status">{t('account.privacy.loading')}</p>;
  if (view === null) {
    return (
      <div className="stack">
        {message ? <Status tone={message.tone} message={message.text} /> : null}
        <p>
          <a href="/account/sign-in">{t('account.privacy.signIn')}</a>
        </p>
      </div>
    );
  }
  return (
    <div className="stack">
      {message ? <Status tone={message.tone} message={message.text} /> : null}
      <section className="card stack" aria-labelledby="privacy-marketing">
        <h2 id="privacy-marketing">{t('account.privacy.marketing.heading')}</h2>
        <form className="stack form" onSubmit={saveConsent}>
          <p id="marketing-wording">{t('account.privacy.marketing.wording')}</p>
          <label className="checkbox">
            <input type="checkbox" name="marketing" value="yes" defaultChecked={view.marketingConsent.granted} aria-describedby="marketing-wording" />{' '}
            {t('account.privacy.marketing.label')}
          </label>
          <p className="muted">{t('account.privacy.marketing.alertsNote')}</p>
          {view.marketingConsent.recordedAt ? <p className="muted">{t('account.privacy.marketing.since', { date: day(view.marketingConsent.recordedAt) })}</p> : null}
          <div className="actions">
            <button className="btn" type="submit">{t('account.privacy.marketing.save')}</button>
          </div>
        </form>
      </section>
      <section className="card stack" aria-labelledby="privacy-download">
        <h2 id="privacy-download">{t('account.privacy.download.heading')}</h2>
        <p>{t('account.privacy.download.body')}</p>
        <p>
          <a className="btn" href="/api/account/privacy/export" download>{t('account.privacy.download.link')}</a>
        </p>
        <p className="muted">{t('account.privacy.download.limit')}</p>
      </section>
      <section className="card stack" aria-labelledby="privacy-erase">
        <h2 id="privacy-erase">{t('account.privacy.erase.heading')}</h2>
        {view.hasCustomerRecord ? (
          <>
            <p>{t('account.privacy.erase.body')}</p>
            {view.erasureRequest ? (
              <p role="status">{t('account.privacy.erase.received', { date: day(view.erasureRequest.requestedAt) })}</p>
            ) : (
              <div className="actions">
                <button className="btn" type="button" onClick={() => void askErasure(false)}>{t('account.privacy.erase.ask')}</button>
              </div>
            )}
          </>
        ) : (
          <>
            <p>{t('account.privacy.erase.accountBody')}</p>
            <label className="checkbox">
              <input type="checkbox" checked={confirmAccount} onChange={(e) => setConfirmAccount(e.currentTarget.checked)} />{' '}
              {t('account.privacy.erase.confirmLabel')}
            </label>
            <div className="actions">
              <button className="btn" type="button" disabled={!confirmAccount} onClick={() => void askErasure(true)}>{t('account.privacy.erase.deleteAccount')}</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
