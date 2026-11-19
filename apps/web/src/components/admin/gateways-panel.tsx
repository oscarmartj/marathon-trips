'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiResult } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { actionsFor, creatableText, credentialsFrom, lostText, statusText, testResultText, warningText } from '@/lib/gateways-panel';
import type { AccountStatus, AccountView, AdapterView, Warning } from '@/lib/gateways-panel';
import { Field, Status } from '../auth/field';
import { errorMessage, useStepUp } from './step-up';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-AU') : '');
const items = <T,>(r: ApiResult): T[] => (r.status === 200 ? ((r.body as { items?: T[] }).items ?? []) : []);

/** The API's own codes in words; anything else is the generic message for its status. */
function problem(r: ApiResult): string {
  const code = String(r.body.code ?? '');
  if (code === 'credentials_invalid') {
    const fields = ((r.body.fields as string[] | undefined) ?? []).map((f) => (f === '(unknown)' ? t('admin.gateways.errors.unknownField') : f)).join(', ');
    return t('admin.gateways.errors.credentials_invalid', { fields });
  }
  if (code === 'connection_test_failed') return t('admin.gateways.errors.connection_test_failed', { result: testResultText(String(r.body.connectionTest ?? '')) });
  if (['connection_test_required', 'archive_blocked', 'status_transition_not_allowed', 'version_conflict', 'live_mode_not_available'].includes(code)) return t(`admin.gateways.errors.${code}`);
  return errorMessage(r);
}

/** The webhook address, shown once in this component's state only: never stored, never fetched again. */
function OnceOnly({ label, url }: { label: string; url: string | null }) {
  if (!url) return null;
  return (
    <div className="card stack" role="status">
      <p>
        <strong>{label}</strong> {t('admin.gateways.url.copyNow')}
      </p>
      <output data-testid="webhook-url">
        <code>{url}</code>
      </output>
    </div>
  );
}

/**
 * Payment gateways (task 4.1): the adapters in the code, the accounts, their warnings and every change to them. The API
 * decides what is allowed, what a change would cost and when an authenticator code is needed; this page shows and asks.
 * Credential inputs are password fields, never pre-filled, cleared after each request.
 */
export function GatewaysPanel() {
  const [adapters, setAdapters] = useState<AdapterView[] | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState<{ account: string; value: string } | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [editing, setEditing] = useState<{ id: string; kind: 'credentials' | 'webhookSecret' } | null>(null);
  const [confirming, setConfirming] = useState<{ account: AccountView; to: AccountStatus; lost: Array<{ method: string; country: string }> } | null>(null);
  const { run, prompt } = useStepUp();

  async function load() {
    const [a, b, w] = await Promise.all([api('/admin/payments/adapters'), api('/admin/payments/provider-accounts'), api('/admin/payments/provider-accounts/warnings')]);
    if (a.status !== 200) {
      setError(errorMessage(a));
      return;
    }
    const list = items<AdapterView>(a);
    setAdapters(list);
    setAccounts(items<AccountView>(b));
    setWarnings(items<Warning>(w));
    setChosen((c) => c || list.find((x) => x.creatable)?.key || '');
  }
  useEffect(() => {
    void load();
  }, []);

  const adapterOf = (key: string) => adapters?.find((x) => (x.key === key));

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const adapter = adapterOf(chosen);
    if (!adapter) return;
    const body = { adapterKey: adapter.key, displayName: String(data.get('accountName') ?? ''), mode: 'test', credentials: credentialsFrom(data, adapter.credentialFields, 'new-') };
    const r = await run(() => api('/admin/payments/provider-accounts', { method: 'POST', body }));
    form.reset();
    if (r.status === 201) {
      setError(null);
      setUrl({ account: body.displayName, value: String(r.body.webhookUrl) });
      setNotice(`${t('admin.gateways.create.created')} ${testResultText(String(r.body.connectionTest))}${adapter.webhookSecret.source === 'entered' ? ` ${t('admin.gateways.create.secretAfter')}` : ''}`);
      await load();
    } else setError(problem(r));
  }

  async function changeStatus(a: AccountView, to: AccountStatus, confirmCoverageLoss = false) {
    const r = await run(() => api(`/admin/payments/provider-accounts/${a.id}/status`, { method: 'POST', body: { version: a.version, status: to, ...(confirmCoverageLoss ? { confirmCoverageLoss: true } : {}) } }));
    if (r.status === 409 && r.body.code === 'coverage_loss_unconfirmed') {
      setConfirming({ account: a, to, lost: (r.body.lost as Array<{ method: string; country: string }>) ?? [] });
      return;
    }
    setConfirming(null);
    if (r.status === 200) {
      setError(null);
      await load();
    } else setError(problem(r));
  }

  async function test(a: AccountView) {
    const r = await run(() => api(`/admin/payments/provider-accounts/${a.id}/connection-test`, { method: 'POST' }));
    if (r.status === 200) {
      setError(null);
      setNotice(`${a.displayName}: ${testResultText(String(r.body.result))}${r.body.recorded === false ? ` ${t('admin.gateways.test.notRecorded')}` : ''}`);
      await load();
    } else setError(problem(r));
  }

  async function newUrl(a: AccountView) {
    const r = await run(() => api(`/admin/payments/provider-accounts/${a.id}/webhook-url`, { method: 'POST', body: { version: a.version } }));
    if (r.status === 200) {
      setUrl({ account: a.displayName, value: String(r.body.webhookUrl) });
      await load();
    } else setError(problem(r));
  }

  async function saveSecrets(e: FormEvent<HTMLFormElement>, a: AccountView, kind: 'credentials' | 'webhookSecret') {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const adapter = adapterOf(a.adapterKey);
    const body = kind === 'credentials'
      ? { version: a.version, credentials: credentialsFrom(data, adapter?.credentialFields ?? [], 'edit-') }
      : { version: a.version, webhookSecret: String(data.get('edit-webhookSecret') ?? '') };
    const r = await run(() => api(`/admin/payments/provider-accounts/${a.id}/${kind === 'credentials' ? 'credentials' : 'webhook-secret'}`, { method: 'PUT', body }));
    form.reset();
    if (r.status === 200) {
      setEditing(null);
      setError(null);
      setNotice(t(kind === 'credentials' ? 'admin.gateways.credentials.saved' : 'admin.gateways.webhookSecret.saved'));
      await load();
    } else setError(problem(r));
  }

  if (!adapters) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;
  const creatable = adapters.filter((a) => (a.creatable));
  const selected = adapterOf(chosen);
  return (
    <div className="stack">
      <Status message={error} />
      <Status message={notice} tone="info" />
      {prompt}
      <OnceOnly label={url ? t('admin.gateways.url.label', { account: url.account }) : ''} url={url?.value ?? null} />

      {warnings.length > 0 ? (
        <section className="card stack" aria-labelledby="gateway-warnings-title">
          <h2 id="gateway-warnings-title">{t('admin.gateways.warning.title')}</h2>
          <ul>
            {warnings.map((w, i) => (
              <li key={`${w.code}-${w.accountId ?? w.country ?? i}`}>{warningText(w, accounts)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {confirming ? (
        <section className="card stack" role="alertdialog" aria-labelledby="coverage-title" aria-describedby="coverage-intro">
          <h2 id="coverage-title">{t('admin.gateways.confirm.title')}</h2>
          <p id="coverage-intro">{t('admin.gateways.confirm.intro', { lost: lostText(confirming.lost) })}</p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => void changeStatus(confirming.account, confirming.to, true)}>
              {t('admin.gateways.confirm.proceed')}
            </button>
            <button className="link-button" type="button" onClick={() => setConfirming(null)}>
              {t('admin.gateways.confirm.cancel')}
            </button>
          </div>
        </section>
      ) : null}

      <section className="stack" aria-labelledby="gateway-accounts-title">
        <h2 id="gateway-accounts-title">{t('admin.gateways.accounts.title')}</h2>
        {accounts.length === 0 ? <p>{t('admin.gateways.accounts.none')}</p> : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('admin.gateways.accounts.name')}</th>
                <th scope="col">{t('admin.gateways.accounts.gateway')}</th>
                <th scope="col">{t('admin.gateways.accounts.mode')}</th>
                <th scope="col">{t('admin.gateways.accounts.status')}</th>
                <th scope="col">{t('admin.gateways.accounts.lastTest')}</th>
                <th scope="col">{t('admin.gateways.accounts.webhook')}</th>
                <th scope="col">{t('admin.gateways.accounts.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const adapter = adapterOf(a.adapterKey);
                return (
                  <tr key={a.id} data-testid={`account-${a.id}`}>
                    <td>{a.displayName}</td>
                    <td>
                      {adapter?.displayName ?? a.adapterKey} ({t(`admin.gateways.adapterStatus.${['verified', 'experimental', 'planned'].includes(a.adapterStatus) ? a.adapterStatus : 'unknown'}`)})
                    </td>
                    <td>{a.mode === 'live' ? t('admin.gateways.accounts.liveMode') : t('admin.gateways.accounts.testMode')}</td>
                    <td>
                      {statusText(a.status)}
                      {a.status === 'paused' && a.pauseReasonCode && a.pauseReasonCode !== 'staff' ? ` (${t(`admin.gateways.pauseReason.${a.pauseReasonCode}`)})` : ''}
                    </td>
                    <td>
                      {testResultText(a.lastConnectionTestResult)} {when(a.lastConnectionTestAt)}{' '}
                      {a.lastConnectionTestResult ? (a.connectionTestCurrent ? t('admin.gateways.accounts.current') : t('admin.gateways.accounts.stale')) : ''}
                    </td>
                    <td>
                      {!a.webhookSecretSet ? t('admin.gateways.accounts.webhookSecretMissing') : a.lastWebhookRejection ? t('admin.gateways.accounts.webhookRejected', { reason: a.lastWebhookRejection.reason }) : a.lastWebhookReceivedAt ? t('admin.gateways.accounts.webhookReceived', { at: when(a.lastWebhookReceivedAt) }) : t('admin.gateways.accounts.webhookNone')}
                    </td>
                    <td>
                      <div className="actions">
                        {a.status !== 'archived' ? (
                          <button className="link-button" type="button" onClick={() => void test(a)}>
                            {t('admin.gateways.action.test')}
                          </button>
                        ) : null}
                        {actionsFor(a).map((x) => (
                          <button key={x.to} className="link-button" type="button" onClick={() => void changeStatus(a, x.to)}>
                            {x.label}
                          </button>
                        ))}
                        {adapter && adapter.credentialFields.length > 0 ? (
                          <button className="link-button" type="button" onClick={() => setEditing({ id: a.id, kind: 'credentials' })}>
                            {t('admin.gateways.action.credentials')}
                          </button>
                        ) : null}
                        {adapter?.webhookSecret.source === 'entered' ? (
                          <button className="link-button" type="button" onClick={() => setEditing({ id: a.id, kind: 'webhookSecret' })}>
                            {t('admin.gateways.action.webhookSecret')}
                          </button>
                        ) : null}
                        <button className="link-button" type="button" onClick={() => void newUrl(a)}>
                          {t('admin.gateways.action.webhookUrl')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {editing ? (() => {
          const a = accounts.find((x) => (x.id === editing.id));
          const adapter = a ? adapterOf(a.adapterKey) : undefined;
          if (!a || !adapter) return null;
          return (
            <form className="card stack form" onSubmit={(e) => void saveSecrets(e, a, editing.kind)} aria-labelledby="secrets-title" autoComplete="off">
              <h3 id="secrets-title">{t(editing.kind === 'credentials' ? 'admin.gateways.credentials.title' : 'admin.gateways.webhookSecret.title', { account: a.displayName })}</h3>
              {editing.kind === 'credentials' ? <p>{t('admin.gateways.credentials.intro')}</p> : null}
              {editing.kind === 'credentials'
                ? adapter.credentialFields.map((f) => <Field key={f.key} label={f.label} id={`edit-${f.key}`} type="password" autoComplete="off" spellCheck={false} />)
                : adapter.webhookSecret.source === 'entered' ? <Field label={adapter.webhookSecret.label} id="edit-webhookSecret" type="password" autoComplete="off" spellCheck={false} required /> : null}
              <div className="actions">
                <button className="btn" type="submit">
                  {t(editing.kind === 'credentials' ? 'admin.gateways.credentials.submit' : 'admin.gateways.webhookSecret.submit')}
                </button>
                <button className="link-button" type="button" onClick={() => setEditing(null)}>
                  {t('admin.gateways.credentials.cancel')}
                </button>
              </div>
            </form>
          );
        })() : null}
      </section>

      <section className="stack" aria-labelledby="gateway-create-title">
        <h2 id="gateway-create-title">{t('admin.gateways.create.title')}</h2>
        <p>{t('admin.gateways.create.intro')}</p>
        {creatable.length > 0 ? (
          <form className="card stack form" onSubmit={(e) => void create(e)} autoComplete="off">
            <div className="field">
              <label htmlFor="new-adapter">{t('admin.gateways.create.gateway')}</label>
              <select id="new-adapter" name="new-adapter" value={chosen} onChange={(e) => setChosen(e.currentTarget.value)}>
                {creatable.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.displayName}
                  </option>
                ))}
              </select>
            </div>
            <Field label={t('admin.gateways.create.name')} id="accountName" required maxLength={100} />
            {selected?.credentialFields.map((f) => <Field key={f.key} label={f.label} id={`new-${f.key}`} type="password" autoComplete="off" spellCheck={false} required />)}
            <div className="actions">
              <button className="btn" type="submit">
                {t('admin.gateways.create.submit')}
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="gateway-catalogue-title">
        <h2 id="gateway-catalogue-title">{t('admin.gateways.catalogue.title')}</h2>
        <p>{t('admin.gateways.catalogue.intro')}</p>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('admin.gateways.catalogue.name')}</th>
              <th scope="col">{t('admin.gateways.catalogue.adapterStatus')}</th>
              <th scope="col">{t('admin.gateways.catalogue.methods')}</th>
              <th scope="col">{t('admin.gateways.catalogue.currencies')}</th>
              <th scope="col">{t('admin.gateways.catalogue.availability')}</th>
            </tr>
          </thead>
          <tbody>
            {adapters.map((a) => (
              <tr key={a.key}>
                <td>{a.displayName}</td>
                <td>{t(`admin.gateways.adapterStatus.${a.status}`)}</td>
                <td>{a.methods.map((m) => t(`admin.gateways.method.${m}`)).join(', ')}</td>
                <td>{a.currencies.join(', ')}</td>
                <td>{creatableText(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
