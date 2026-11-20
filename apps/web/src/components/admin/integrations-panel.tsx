'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiResult } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Field, Status } from '../auth/field';
import { errorMessage, useStepUp } from './step-up';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  mine: boolean;
  status: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  lastUsedAt: string | null;
}
interface Scope {
  key: string;
  description: string;
}
interface WebhookRow {
  id: string;
  description: string;
  urlDisplay: string;
  eventTypes: string[];
  enabled: boolean;
  disabledReason: string | null;
  version: number;
}
interface EventType {
  type: string;
  description: string;
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-AU') : t('admin.integrations.never'));
const list = <T,>(r: ApiResult): T[] => (r.status === 200 ? (r.body as unknown as T[]) : []);

/** A secret the API shows once: it is never fetched again, so the page says so. */
function OneTimeSecret({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="card stack" role="status">
      <p>
        <strong>{label}</strong> {t('admin.integrations.copyNow')}
      </p>
      <output data-testid="one-time-secret">
        <code>{value}</code>
      </output>
    </div>
  );
}

/**
 * API keys and outgoing webhooks (task 8.4). The API decides everything: which scopes a key may have, which events a
 * webhook may receive, and when an authenticator code is needed. This page only shows and submits.
 */
export function IntegrationsPanel() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [events, setEvents] = useState<EventType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const { run, prompt } = useStepUp();

  async function load() {
    const [k, s, w, e] = await Promise.all([
      api('/admin/integrations/api-keys'), api('/admin/integrations/api-key-scopes'), api('/admin/integrations/webhooks'), api('/admin/integrations/webhook-events'),
    ]);
    setKeys(list<ApiKeyRow>(k));
    setScopes(list<Scope>(s));
    setHooks(list<WebhookRow>(w));
    setEvents(list<EventType>(e));
    if (k.status !== 200 && w.status !== 200) setError(errorMessage(k));
  }
  useEffect(() => {
    void load();
  }, []);

  async function createKey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = { name: String(form.get('keyName') ?? ''), scopes: form.getAll('scope').map(String), expiresInDays: Number(form.get('expiresInDays') ?? 90) };
    const r = await run(() => api('/admin/integrations/api-keys', { method: 'POST', body }));
    if (r.status === 201) {
      setToken((r.body as { token: string }).token);
      setError(null);
      e.currentTarget?.reset();
      await load();
    } else setError(r.status === 422 ? t('admin.integrations.invalid') : errorMessage(r));
  }

  async function revoke(k: ApiKeyRow) {
    const r = await run(() => api(`/admin/integrations/api-keys/${k.id}/revoke`, { method: 'POST' }));
    if (r.status === 204) await load();
    else setError(errorMessage(r));
  }

  async function createHook(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = { url: String(form.get('hookUrl') ?? ''), description: String(form.get('hookDescription') ?? ''), eventTypes: form.getAll('eventType').map(String) };
    const r = await run(() => api('/admin/integrations/webhooks', { method: 'POST', body }));
    if (r.status === 201) {
      setSecret((r.body as { secret: string }).secret);
      setError(null);
      await load();
    } else setError(r.status === 422 ? t('admin.integrations.invalid') : errorMessage(r));
  }

  async function hookAction(w: WebhookRow, action: 'toggle' | 'rotate' | 'test' | 'delete') {
    const call = {
      toggle: () => api(`/admin/integrations/webhooks/${w.id}`, { method: 'PATCH', body: { version: w.version, enabled: !w.enabled } }),
      rotate: () => api(`/admin/integrations/webhooks/${w.id}/rotate-secret`, { method: 'POST' }),
      test: () => api(`/admin/integrations/webhooks/${w.id}/test`, { method: 'POST' }),
      delete: () => api(`/admin/integrations/webhooks/${w.id}`, { method: 'DELETE' }),
    }[action];
    const r = await run(call);
    if (r.status >= 200 && r.status < 300) {
      if (action === 'rotate') setSecret((r.body as { secret: string }).secret);
      await load();
    } else setError(errorMessage(r));
  }

  if (!keys || !hooks) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;
  return (
    <div className="stack">
      <Status message={error} />
      {prompt}

      <section className="stack" aria-labelledby="api-keys-title">
        <h2 id="api-keys-title">{t('admin.integrations.keysTitle')}</h2>
        <p>{t('admin.integrations.keysIntro')}</p>
        <OneTimeSecret label={t('admin.integrations.tokenLabel')} value={token} />
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('admin.integrations.name')}</th>
              <th scope="col">{t('admin.integrations.prefix')}</th>
              <th scope="col">{t('admin.integrations.scopes')}</th>
              <th scope="col">{t('admin.integrations.expires')}</th>
              <th scope="col">{t('admin.integrations.lastUsed')}</th>
              <th scope="col">{t('admin.integrations.state')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('admin.staff.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} data-testid={`api-key-${k.prefix}`}>
                <td>{k.name}</td>
                <td>
                  <code>mtk_{k.prefix}_…</code>
                </td>
                <td>{k.scopes.join(', ')}</td>
                <td>{day(k.expiresAt)}</td>
                <td>{day(k.lastUsedAt)}</td>
                <td>{t(`admin.integrations.status.${k.status}`)}</td>
                <td>
                  {k.status === 'active' ? (
                    <button className="btn" type="button" onClick={() => revoke(k)}>
                      {t('admin.integrations.revoke')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {scopes.length > 0 ? (
          <form className="card stack form" onSubmit={createKey} aria-labelledby="new-key-title">
            <h3 id="new-key-title">{t('admin.integrations.newKey')}</h3>
            <Field label={t('admin.integrations.name')} id="keyName" required maxLength={80} />
            <Field label={t('admin.integrations.expiresInDays')} id="expiresInDays" type="number" min={1} max={365} defaultValue={90} required />
            <fieldset>
              <legend>{t('admin.integrations.scopes')}</legend>
              {scopes.map((s) => (
                <div key={s.key} className="field-inline">
                  <input type="checkbox" id={`scope-${s.key}`} name="scope" value={s.key} />
                  <label htmlFor={`scope-${s.key}`}>
                    <code>{s.key}</code> {s.description}
                  </label>
                </div>
              ))}
            </fieldset>
            <div className="actions">
              <button className="btn" type="submit">
                {t('admin.integrations.createKey')}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="webhooks-title">
        <h2 id="webhooks-title">{t('admin.integrations.hooksTitle')}</h2>
        <p>{t('admin.integrations.hooksIntro')}</p>
        <OneTimeSecret label={t('admin.integrations.secretLabel')} value={secret} />
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('admin.integrations.address')}</th>
              <th scope="col">{t('admin.integrations.events')}</th>
              <th scope="col">{t('admin.integrations.state')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('admin.staff.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((w) => (
              <tr key={w.id}>
                <td>
                  <code>{w.urlDisplay}</code> {w.description}
                </td>
                <td>{w.eventTypes.join(', ')}</td>
                <td>{w.enabled ? t('admin.flags.on') : w.disabledReason === 'consecutive_failures' ? t('admin.integrations.autoDisabled') : t('admin.flags.off')}</td>
                <td className="actions">
                  <button className="btn" type="button" onClick={() => hookAction(w, 'toggle')}>
                    {w.enabled ? t('admin.flags.turnOff') : t('admin.flags.turnOn')}
                  </button>
                  <button className="btn" type="button" onClick={() => hookAction(w, 'test')}>
                    {t('admin.integrations.sendTest')}
                  </button>
                  <button className="btn" type="button" onClick={() => hookAction(w, 'rotate')}>
                    {t('admin.integrations.rotate')}
                  </button>
                  <button className="btn" type="button" onClick={() => hookAction(w, 'delete')}>
                    {t('admin.integrations.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length > 0 ? (
          <form className="card stack form" onSubmit={createHook} aria-labelledby="new-hook-title">
            <h3 id="new-hook-title">{t('admin.integrations.newHook')}</h3>
            <Field label={t('admin.integrations.address')} id="hookUrl" type="url" required maxLength={2048} />
            <Field label={t('admin.integrations.description')} id="hookDescription" maxLength={200} />
            <fieldset>
              <legend>{t('admin.integrations.events')}</legend>
              {events.map((ev) => (
                <div key={ev.type} className="field-inline">
                  <input type="checkbox" id={`event-${ev.type}`} name="eventType" value={ev.type} />
                  <label htmlFor={`event-${ev.type}`}>
                    <code>{ev.type}</code> {ev.description}
                  </label>
                </div>
              ))}
            </fieldset>
            <div className="actions">
              <button className="btn" type="submit">
                {t('admin.integrations.createHook')}
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
