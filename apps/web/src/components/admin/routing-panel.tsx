'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiResult } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { lostText } from '@/lib/gateways-panel';
import { countriesFrom, countriesText, limitFrom, limitsText, reasonText, routingWarningText, ruleErrorText } from '@/lib/routing-panel';
import type { RoutingWarning, RuleView } from '@/lib/routing-panel';
import { Field, Status } from '../auth/field';
import { errorMessage, useStepUp } from './step-up';

const METHODS = ['card', 'apple_pay', 'google_pay', 'payto', 'becs', 'payid_transfer', 'bpay', 'manual_other'] as const;
const items = <T,>(r: ApiResult): T[] => (r.status === 200 ? ((r.body as { items?: T[] }).items ?? []) : []);
const problem = (r: ApiResult): string => ruleErrorText(String(r.body.code ?? '')) ?? errorMessage(r);

type Account = { id: string; displayName: string; status: string };
interface Send {
  (confirm: boolean): Promise<ApiResult>;
}
type Pending = { label: string; send: Send; lost: Array<{ method: string; country: string }> };

/**
 * Routing rules (task 4.2): which account takes a new payment. The API checks every rule, says what a change would cost
 * customers and asks for an authenticator code when needed; the page only shows and asks. Amounts are typed in dollars
 * and sent as integer strings of cents.
 */
export function RoutingPanel() {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [warnings, setWarnings] = useState<RoutingWarning[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [preview, setPreview] = useState<{ route: Array<{ accountId: string; ruleId: string }>; reasons: Array<{ ruleId: string; reason: string | null }> } | null>(null);
  const { run, prompt } = useStepUp();

  async function load() {
    const [r, a, w] = await Promise.all([api('/admin/payments/routing-rules'), api('/admin/payments/provider-accounts'), api('/admin/payments/routing/warnings')]);
    if (r.status !== 200) {
      setError(errorMessage(r));
      return;
    }
    setRules(items<RuleView>(r));
    setAccounts(items<Account>(a));
    setWarnings(items<RoutingWarning>(w));
  }
  useEffect(() => {
    void load();
  }, []);

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? t('admin.gateways.unnamed');

  /** Sends a change; a coverage loss asks first, then sends it again with the confirmation. */
  async function change(label: string, send: Send, confirm = false) {
    const r = await run(() => send(confirm));
    if (r.status === 409 && r.body.code === 'coverage_loss_unconfirmed') {
      const details = (r.body.details as { lost?: Array<{ method: string; country: string }> } | undefined)?.lost ?? (r.body.lost as Array<{ method: string; country: string }> | undefined) ?? [];
      setPending({ label, send, lost: details });
      return;
    }
    setPending(null);
    if (r.status === 200 || r.status === 201) {
      setError(null);
      const serving = Array.isArray(r.body.backupsServing) && r.body.backupsServing.length > 0;
      setNotice(`${label}${serving ? ` ${t('admin.routing.backupsServing')}` : ''}`);
      await load();
    } else setError(problem(r));
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const min = limitFrom(String(data.get('rule-min') ?? ''));
    const max = limitFrom(String(data.get('rule-max') ?? ''));
    if (!min.ok || !max.ok) {
      setError(t('admin.routing.form.badAmount'));
      return;
    }
    const backup = String(data.get('rule-backup') ?? '');
    const body = {
      providerAccountId: String(data.get('rule-account') ?? ''), method: String(data.get('rule-method') ?? 'card'), countries: countriesFrom(String(data.get('rule-countries') ?? '')),
      currency: 'AUD', minAmountMinor: min.minor, maxAmountMinor: max.minor, priority: Number(data.get('rule-priority') ?? 100), enabled: data.get('rule-enabled') === 'on',
      fallbackForRuleId: backup === '' ? null : backup,
    };
    await change(t('admin.routing.saved'), (confirm) => api('/admin/payments/routing-rules', { method: 'POST', body: { ...body, ...(confirm ? { confirmCoverageLoss: true } : {}) } }));
  }

  async function runPreview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const amount = limitFrom(String(data.get('preview-amount') ?? ''));
    if (!amount.ok) {
      setError(t('admin.routing.form.badAmount'));
      return;
    }
    const qs = new URLSearchParams({ method: String(data.get('preview-method') ?? 'card'), country: String(data.get('preview-country') ?? 'AU').toUpperCase(), currency: 'AUD' });
    if (amount.minor !== null) qs.set('amountMinor', amount.minor);
    const r = await api(`/admin/payments/routing/preview?${qs.toString()}`);
    if (r.status === 200) {
      setError(null);
      setPreview(r.body as never);
    } else setError(problem(r));
  }

  if (!rules) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;
  const primaries = rules.filter((r) => r.fallbackForRuleId === null);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const reasonLine = (id: string, reason: string | null) => {
    const r = byId.get(id)!;
    return `${t(`admin.gateways.method.${r.method}`)} · ${r.accountName}: ${reasonText(reason)}`;
  };
  const ruleLabel = (id: string | null) => {
    const r = rules.find((x) => x.id === id);
    return r ? t('admin.routing.backupOf', { method: t(`admin.gateways.method.${r.method}`), account: r.accountName }) : t('admin.routing.primary');
  };
  return (
    <section className="stack" aria-labelledby="routing-title">
      <h2 id="routing-title">{t('admin.routing.title')}</h2>
      <p>{t('admin.routing.intro')}</p>
      <Status message={error} />
      <Status message={notice} tone="info" />
      {prompt}

      {warnings.length > 0 ? (
        <section className="card stack" aria-labelledby="routing-warnings-title">
          <h3 id="routing-warnings-title">{t('admin.routing.warning.title')}</h3>
          <ul>
            {warnings.map((w, i) => (
              <li key={`${w.code}-${w.accountId ?? w.ruleId ?? i}-${w.method ?? ''}-${w.country ?? ''}`}>{routingWarningText(w, accounts)}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {pending ? (
        <section className="card stack" role="alertdialog" aria-labelledby="routing-confirm-title" aria-describedby="routing-confirm-intro">
          <h3 id="routing-confirm-title">{t('admin.routing.confirm.title')}</h3>
          <p id="routing-confirm-intro">{t('admin.routing.confirm.intro', { lost: lostText(pending.lost) })}</p>
          <div className="actions">
            <button className="btn" type="button" onClick={() => void change(pending.label, pending.send, true)}>
              {t('admin.routing.confirm.proceed')}
            </button>
            <button className="link-button" type="button" onClick={() => setPending(null)}>
              {t('admin.routing.confirm.cancel')}
            </button>
          </div>
        </section>
      ) : null}

      {rules.length === 0 ? <p>{t('admin.routing.none')}</p> : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('admin.routing.columns.method')}</th>
              <th scope="col">{t('admin.routing.columns.account')}</th>
              <th scope="col">{t('admin.routing.columns.countries')}</th>
              <th scope="col">{t('admin.routing.columns.limits')}</th>
              <th scope="col">{t('admin.routing.columns.priority')}</th>
              <th scope="col">{t('admin.routing.columns.backup')}</th>
              <th scope="col">{t('admin.routing.columns.state')}</th>
              <th scope="col">{t('admin.routing.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} data-testid={`rule-${r.id}`}>
                <td>{t(`admin.gateways.method.${r.method}`)}</td>
                <td>{r.accountName}</td>
                <td>{countriesText(r.countries)}</td>
                <td>{limitsText(r)}</td>
                <td>{r.priority}</td>
                <td>{r.fallbackForRuleId ? ruleLabel(r.fallbackForRuleId) : t('admin.routing.primary')}</td>
                <td>
                  {r.enabled ? t('admin.routing.state.on') : t('admin.routing.state.off')}
                  {r.matchesAdapter ? '' : ` (${t('admin.routing.state.outside')})`}
                </td>
                <td>
                  <div className="actions">
                    <button className="link-button" type="button" onClick={() => void change(t('admin.routing.saved'), (confirm) => api(`/admin/payments/routing-rules/${r.id}`, { method: 'PATCH', body: { version: r.version, enabled: !r.enabled, ...(confirm ? { confirmCoverageLoss: true } : {}) } }))}>
                      {r.enabled ? t('admin.routing.action.disable') : t('admin.routing.action.enable')}
                    </button>
                    <button className="link-button" type="button" onClick={() => void change(t('admin.routing.removed'), (confirm) => api(`/admin/payments/routing-rules/${r.id}/delete`, { method: 'POST', body: { version: r.version, ...(confirm ? { confirmCoverageLoss: true } : {}) } }))}>
                      {t('admin.routing.action.delete')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="actions">
        {accounts.filter((a) => a.status === 'active' || a.status === 'paused').map((a) => (
          <button key={a.id} className="link-button" type="button" onClick={() => void change(t('admin.routing.saved'), () => api(`/admin/payments/provider-accounts/${a.id}/routing-rules/defaults`, { method: 'POST', body: {} }))}>
            {t('admin.routing.action.defaults')}: {a.displayName}
          </button>
        ))}
      </div>

      <form className="card stack" onSubmit={(e) => void add(e)} aria-labelledby="routing-add-title">
        <h3 id="routing-add-title">{t('admin.routing.form.title')}</h3>
        <div className="field">
          <label htmlFor="rule-account">{t('admin.routing.form.account')}</label>
          <select id="rule-account" name="rule-account" required>
            {accounts.filter((a) => a.status === 'active' || a.status === 'paused').map((a) => (
              <option key={a.id} value={a.id}>{a.displayName}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-method">{t('admin.routing.form.method')}</label>
          <select id="rule-method" name="rule-method" defaultValue="card">
            {METHODS.map((m) => (
              <option key={m} value={m}>{t(`admin.gateways.method.${m}`)}</option>
            ))}
          </select>
        </div>
        <Field id="rule-countries" label={t('admin.routing.form.countries')} autoComplete="off" />
        <Field id="rule-min" label={t('admin.routing.form.min')} inputMode="decimal" autoComplete="off" />
        <Field id="rule-max" label={t('admin.routing.form.max')} inputMode="decimal" autoComplete="off" />
        <Field id="rule-priority" label={t('admin.routing.form.priority')} type="number" min={0} max={1000} defaultValue={100} required />
        <div className="field">
          <label htmlFor="rule-backup">{t('admin.routing.form.backup')}</label>
          <select id="rule-backup" name="rule-backup" defaultValue="">
            <option value="">{t('admin.routing.form.noBackup')}</option>
            {primaries.map((r) => (
              <option key={r.id} value={r.id}>{t('admin.routing.backupOf', { method: t(`admin.gateways.method.${r.method}`), account: accountName(r.providerAccountId) })}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-enabled">
            <input id="rule-enabled" name="rule-enabled" type="checkbox" defaultChecked /> {t('admin.routing.form.enabled')}
          </label>
        </div>
        <button className="btn" type="submit">{t('admin.routing.form.submit')}</button>
      </form>

      <form className="card stack" onSubmit={(e) => void runPreview(e)} aria-labelledby="routing-preview-title">
        <h3 id="routing-preview-title">{t('admin.routing.preview.title')}</h3>
        <div className="field">
          <label htmlFor="preview-method">{t('admin.routing.preview.method')}</label>
          <select id="preview-method" name="preview-method" defaultValue="card">
            {METHODS.map((m) => (
              <option key={m} value={m}>{t(`admin.gateways.method.${m}`)}</option>
            ))}
          </select>
        </div>
        <Field id="preview-country" label={t('admin.routing.preview.country')} defaultValue="AU" maxLength={2} autoComplete="off" />
        <Field id="preview-amount" label={t('admin.routing.preview.amount')} inputMode="decimal" autoComplete="off" />
        <button className="btn" type="submit">{t('admin.routing.preview.submit')}</button>
        {preview ? (
          <div role="status" className="stack">
            {preview.route.length === 0 ? <p>{t('admin.routing.preview.nobody')}</p> : (
              <>
                <p>{t('admin.routing.preview.order')}</p>
                <ol>
                  {preview.route.map((c) => (
                    <li key={c.ruleId}>{accountName(c.accountId)}</li>
                  ))}
                </ol>
              </>
            )}
            <ul>
              {preview.reasons.map((x) => (byId.has(x.ruleId) ? <li key={x.ruleId}>{reasonLine(x.ruleId, x.reason)}</li> : null))}
            </ul>
          </div>
        ) : null}
      </form>
    </section>
  );
}
