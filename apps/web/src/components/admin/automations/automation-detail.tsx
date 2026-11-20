'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { type RuleForm, type RuleView, type RunView, bodyFromForm, codeKey, formFromRule, reasonKey, stepKey } from '@/lib/automations-panel';
import { Status } from '../../auth/field';
import { Section, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';
import { RuleEditor, automationError } from './rule-editor';

const when = (iso: string) => new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' });

interface TestResult {
  status: string;
  reasonCode: string | null;
  conditions: boolean[];
  steps: RunView['steps'];
}

function Steps({ steps }: { steps: RunView['steps'] }) {
  if (steps.length === 0) return null;
  return (
    <ol>
      {steps.map((s) => (
        <li key={s.index}>
          {t(`admin.automations.actions.${s.action}`)}: {t(stepKey(s))}
          {s.code ? ` (${t(codeKey(s.code))})` : ''}
        </li>
      ))}
    </ol>
  );
}

/** One automation: edit it, switch it on or off, run a test that changes nothing, and read its run log. */
export function AutomationDetail({ id }: { id: string }) {
  const rule = useLoad<RuleView>(`/admin/automations/${id}`);
  const runs = useLoad<{ items: RunView[] }>(`/admin/automations/${id}/runs`);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const { run, prompt } = useStepUp();
  const r = rule.data;
  const initial = useMemo(() => (r ? formFromRule(r) : null), [r]);

  async function after(res: { status: number; body: { code?: string } }, ok: string) {
    if (res.status >= 200 && res.status < 300) {
      setMessage({ text: ok, tone: 'info' });
      await rule.reload();
      await runs.reload();
    } else setMessage({ text: automationError(res), tone: 'error' });
  }

  async function save(f: RuleForm) {
    if (!r) return;
    await after(await run(() => api(`/admin/automations/${id}`, { method: 'PATCH', body: { ...bodyFromForm(f), version: r.version } })), t('admin.automations.saved'));
  }

  async function enable(testMode: boolean) {
    if (!r) return;
    await after(await run(() => api(`/admin/automations/${id}/enable`, { method: 'POST', body: { version: r.version, testMode } })), t(testMode ? 'admin.automations.enabledTest' : 'admin.automations.enabledReal'));
  }

  async function disable() {
    if (!r) return;
    await after(await run(() => api(`/admin/automations/${id}/disable`, { method: 'POST', body: { version: r.version } })), t('admin.automations.disabled'));
  }

  async function test(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const entityId = String(new FormData(e.currentTarget).get('testRecord') ?? '').trim();
    const res = await api<TestResult>(`/admin/automations/${id}/test`, { method: 'POST', body: entityId ? { entityId } : {} });
    if (res.status === 200) {
      setResult(res.body as unknown as TestResult);
      setMessage(null);
      await runs.reload();
    } else setMessage({ text: automationError(res), tone: 'error' });
  }

  if (!r || !initial) return rule.error ? <Status message={rule.error} /> : <p role="status">{t('admin.common.loading')}</p>;
  return (
    <div className="stack">
      {prompt}
      {message ? <Status message={message.text} tone={message.tone} /> : null}
      <Section id="automation-state" title={t('admin.automations.stateTitle')}>
        <p data-testid="automation-state">{t(r.enabled ? (r.testMode ? 'admin.automations.state.onTest' : 'admin.automations.state.on') : 'admin.automations.state.off')}</p>
        <p className="field__hint">{t('admin.automations.stateHint')}</p>
        {r.permissions.length > 0 ? (
          <p>{t('admin.automations.needs')} {r.permissions.map((p) => <code key={p}>{p} </code>)}</p>
        ) : null}
        <div className="actions">
          {!r.enabled || !r.testMode ? <button className="btn btn--secondary" type="button" onClick={() => void enable(true)}>{t('admin.automations.enableTest')}</button> : null}
          {!r.enabled || r.testMode ? <button className="btn" type="button" onClick={() => void enable(false)}>{t('admin.automations.enableReal')}</button> : null}
          {r.enabled ? <button className="btn btn--secondary" type="button" onClick={() => void disable()}>{t('admin.automations.disable')}</button> : null}
        </div>
      </Section>

      <Section id="automation-test" title={t('admin.automations.testTitle')}>
        <p>{t('admin.automations.testIntro')}</p>
        <form className="form stack" onSubmit={test}>
          {r.triggerType === 'event' ? (
            <div className="field">
              <label htmlFor="testRecord">{t('admin.automations.testRecord')}</label>
              <input id="testRecord" name="testRecord" type="text" required />
            </div>
          ) : null}
          <div className="actions">
            <button className="btn btn--secondary" type="submit">{t('admin.automations.runTest')}</button>
          </div>
        </form>
        {result ? (
          <div className="stack" role="status" data-testid="automation-test-result">
            <p>{t(`admin.automations.runStatus.${result.status}`)}{result.reasonCode ? `: ${t(reasonKey(result.reasonCode))}` : ''}</p>
            <Steps steps={result.steps} />
          </div>
        ) : null}
      </Section>

      <Section id="automation-edit" title={t('admin.automations.editTitle')}>
        <RuleEditor initial={initial} submitLabel={t('admin.automations.save')} onSubmit={save} />
      </Section>

      <Section id="automation-runs" title={t('admin.automations.runsTitle')}>
        {runs.data && runs.data.items.length === 0 ? <p role="status">{t('admin.automations.noRuns')}</p> : null}
        {runs.data && runs.data.items.length > 0 ? (
          <table className="table">
            <caption>{t('admin.automations.runsCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.automations.columns.when')}</th>
                <th scope="col">{t('admin.automations.columns.source')}</th>
                <th scope="col">{t('admin.automations.columns.record')}</th>
                <th scope="col">{t('admin.automations.columns.result')}</th>
                <th scope="col">{t('admin.automations.columns.steps')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((x) => (
                <tr key={x.id}>
                  <th scope="row">{when(x.startedAt)}</th>
                  <td>{t(`admin.automations.sources.${x.source}`)}{x.testMode ? ` · ${t('admin.automations.testBadge')}` : ''}</td>
                  <td>{x.entityType && x.entityId ? <code>{x.entityType} {x.entityId}</code> : '–'}</td>
                  <td>{t(`admin.automations.runStatus.${x.status}`)}{x.reasonCode ? `: ${t(reasonKey(x.reasonCode))}` : ''}</td>
                  <td><Steps steps={x.steps} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <Status message={runs.error} />
      </Section>
    </div>
  );
}
