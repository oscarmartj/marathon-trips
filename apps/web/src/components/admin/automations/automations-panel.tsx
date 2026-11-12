'use client';

import { useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { type RuleForm, type RuleView, bodyFromForm, emptyForm } from '@/lib/automations-panel';
import { Status } from '../../auth/field';
import { Section, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';
import { RuleEditor, automationError } from './rule-editor';

const when = (iso: string) => new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' });

/** Automations (task 7.4): the list, and a form for a new one. A new automation starts off and in test mode. */
export function AutomationsPanel() {
  const rules = useLoad<{ items: RuleView[] }>('/admin/automations');
  const [message, setMessage] = useState<string | null>(null);
  const { run, prompt } = useStepUp();
  const initial = useMemo(emptyForm, []);

  async function create(f: RuleForm) {
    const r = await run(() => api('/admin/automations', { method: 'POST', body: bodyFromForm(f) }));
    if (r.status === 201) window.location.assign(`/admin/automations/${(r.body as unknown as RuleView).id}`);
    else setMessage(automationError(r));
  }

  return (
    <div className="stack">
      <Status message={rules.error} />
      {prompt}
      <Section id="automations-list" title={t('admin.automations.listTitle')}>
        {rules.data && rules.data.items.length === 0 ? <p role="status">{t('admin.automations.none')}</p> : null}
        {rules.data && rules.data.items.length > 0 ? (
          <table className="table">
            <caption>{t('admin.automations.listCaption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.automations.columns.name')}</th>
                <th scope="col">{t('admin.automations.columns.trigger')}</th>
                <th scope="col">{t('admin.automations.columns.state')}</th>
                <th scope="col">{t('admin.automations.columns.lastRun')}</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.items.map((r) => (
                <tr key={r.id} data-testid={`automation-${r.id}`}>
                  <th scope="row"><a href={`/admin/automations/${r.id}`}>{r.name}</a></th>
                  <td>{r.triggerType === 'event' && r.eventType ? t(`admin.automations.events.${r.eventType.replace(/\./g, '_')}`) : t('admin.automations.onSchedule')}</td>
                  <td>{t(r.enabled ? (r.testMode ? 'admin.automations.state.onTest' : 'admin.automations.state.on') : 'admin.automations.state.off')}</td>
                  <td>{r.lastRun ? `${t(`admin.automations.runStatus.${r.lastRun.status}`)} · ${when(r.lastRun.startedAt)}` : t('admin.automations.never')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
      <Section id="automations-new" title={t('admin.automations.newTitle')}>
        <p>{t('admin.automations.newIntro')}</p>
        <RuleEditor initial={initial} submitLabel={t('admin.automations.create')} onSubmit={create} />
        <Status message={message} />
      </Section>
    </div>
  );
}
