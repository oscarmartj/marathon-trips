'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { AUTOMATION_ACTION_TYPES, AUTOMATION_EMAIL_TEMPLATES } from '@mt/shared';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import {
  type ActionRow, type ConditionRow, type RuleForm, EVENT_TYPES, WEEKDAYS, blankAction, factsFor, operatorsFor, valuesFor,
} from '@/lib/automations-panel';

interface Option {
  id: string;
  label: string;
}

/** The API's error code as a sentence; unknown codes fall back to a general message. */
export function automationError(r: { status: number; body: { code?: string } }): string {
  try {
    return t(`admin.automations.errors.${r.body?.code ?? ''}`);
  } catch {
    if (r.status === 403) return t('admin.common.forbidden');
    if (r.status === 409) return t('admin.common.conflict');
    return t('admin.common.error');
  }
}

/** Tags and outgoing webhooks to pick from; empty when the staff member cannot list them (ids can still be typed). */
function useOptions() {
  const [tags, setTags] = useState<Option[]>([]);
  const [hooks, setHooks] = useState<Option[]>([]);
  useEffect(() => {
    void api<Array<{ id: string; name: string }>>('/admin/tags').then((r) => {
      if (r.status === 200) setTags((r.body as unknown as Array<{ id: string; name: string }>).map((x) => ({ id: x.id, label: x.name })));
    });
    void api<Array<{ id: string; description: string; urlDisplay: string; eventTypes: string[] }>>('/admin/integrations/webhooks').then((r) => {
      if (r.status === 200) {
        const rows = r.body as unknown as Array<{ id: string; description: string; urlDisplay: string; eventTypes: string[] }>;
        setHooks(rows.filter((h) => h.eventTypes.includes('automations.rule.fired')).map((h) => ({ id: h.id, label: h.description || h.urlDisplay })));
      }
    });
  }, []);
  return { tags, hooks };
}

function IdPicker({ id, label, value, options, onChange }: { id: string; label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {options.length > 0 ? (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required>
          <option value="">{t('admin.automations.choose')}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      ) : (
        <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} required />
      )}
    </div>
  );
}

function ConditionEditor({ eventType, row, index, onChange, onRemove }: { eventType: string; row: ConditionRow; index: number; onChange: (r: ConditionRow) => void; onRemove: () => void }) {
  const facts = factsFor(eventType);
  const ops = operatorsFor(eventType, row.fact);
  const values = valuesFor(eventType, row.fact);
  const list = row.op === 'in' || row.op === 'not_in';
  const n = index + 1;
  return (
    <fieldset className="stack">
      <legend>{t('admin.automations.conditionN', { n })}</legend>
      <div className="field">
        <label htmlFor={`cond-fact-${index}`}>{t('admin.automations.fact')}</label>
        <select id={`cond-fact-${index}`} value={row.fact} onChange={(e) => onChange({ fact: e.target.value, op: operatorsFor(eventType, e.target.value)[0] ?? 'is', value: '' })}>
          {facts.map(([k]) => <option key={k} value={k}>{t(`admin.automations.facts.${k}`)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`cond-op-${index}`}>{t('admin.automations.operator')}</label>
        <select id={`cond-op-${index}`} value={row.op} onChange={(e) => onChange({ ...row, op: e.target.value as ConditionRow['op'] })}>
          {ops.map((o) => <option key={o} value={o}>{t(`admin.automations.operators.${o}`)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`cond-value-${index}`}>{t(list ? 'admin.automations.values' : 'admin.automations.value')}</label>
        {values && !list ? (
          <select id={`cond-value-${index}`} value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} required>
            <option value="">{t('admin.automations.choose')}</option>
            {values.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        ) : (
          <input id={`cond-value-${index}`} type="text" value={row.value} onChange={(e) => onChange({ ...row, value: e.target.value })} required />
        )}
        {list ? <p className="field__hint">{t('admin.automations.valuesHint')}</p> : null}
      </div>
      <button className="link-button" type="button" onClick={onRemove}>{t('admin.automations.removeCondition', { n })}</button>
    </fieldset>
  );
}

function ActionEditor({ row, index, tags, hooks, onChange, onRemove }: { row: ActionRow; index: number; tags: Option[]; hooks: Option[]; onChange: (r: ActionRow) => void; onRemove: () => void }) {
  const n = index + 1;
  const id = (k: string) => `action-${k}-${index}`;
  return (
    <fieldset className="stack">
      <legend>{t('admin.automations.actionN', { n })}</legend>
      <div className="field">
        <label htmlFor={id('type')}>{t('admin.automations.actionType')}</label>
        <select id={id('type')} value={row.type} onChange={(e) => onChange(blankAction(e.target.value as ActionRow['type']))}>
          {AUTOMATION_ACTION_TYPES.map((a) => <option key={a} value={a}>{t(`admin.automations.actions.${a}`)}</option>)}
        </select>
      </div>
      {row.type === 'create_task' ? (
        <>
          <div className="field">
            <label htmlFor={id('title')}>{t('admin.automations.taskTitle')}</label>
            <input id={id('title')} type="text" maxLength={200} value={row.title} onChange={(e) => onChange({ ...row, title: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor={id('description')}>{t('admin.automations.taskDescription')}</label>
            <textarea id={id('description')} rows={3} maxLength={2000} value={row.description} onChange={(e) => onChange({ ...row, description: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={id('due')}>{t('admin.automations.taskDue')}</label>
            <input id={id('due')} type="number" min={0} max={8760} value={row.dueInHours} onChange={(e) => onChange({ ...row, dueInHours: e.target.value })} />
          </div>
        </>
      ) : null}
      {row.type === 'add_tag' || row.type === 'remove_tag' ? (
        <IdPicker id={id('tag')} label={t('admin.automations.tag')} value={row.tagId} options={tags} onChange={(v) => onChange({ ...row, tagId: v })} />
      ) : null}
      {row.type === 'close_tasks' ? (
        <div className="field field--check">
          <input id={id('only')} type="checkbox" checked={row.onlyThisRule} onChange={(e) => onChange({ ...row, onlyThisRule: e.target.checked })} />
          <label htmlFor={id('only')}>{t('admin.automations.onlyThisRule')}</label>
        </div>
      ) : null}
      {row.type === 'send_email' ? (
        <div className="field">
          <label htmlFor={id('template')}>{t('admin.automations.template')}</label>
          <select id={id('template')} value={row.template} onChange={(e) => onChange({ ...row, template: e.target.value })}>
            {AUTOMATION_EMAIL_TEMPLATES.map((x) => <option key={x} value={x}>{t(`admin.automations.templates.${x}`)}</option>)}
          </select>
          <p className="field__hint">{t('admin.automations.templateHint')}</p>
        </div>
      ) : null}
      {row.type === 'call_webhook' ? (
        <IdPicker id={id('hook')} label={t('admin.automations.webhook')} value={row.subscriptionId} options={hooks} onChange={(v) => onChange({ ...row, subscriptionId: v })} />
      ) : null}
      <button className="link-button" type="button" onClick={onRemove}>{t('admin.automations.removeAction', { n })}</button>
    </fieldset>
  );
}

/** The form for a rule's trigger, conditions and actions. Saving is the caller's: it gets the form state. */
interface EditorProps {
  initial: RuleForm;
  submitLabel: string;
  onSubmit(f: RuleForm): Promise<void>;
}

export function RuleEditor({ initial, submitLabel, onSubmit }: EditorProps) {
  const [form, setForm] = useState<RuleForm>(initial);
  const { tags, hooks } = useOptions();
  useEffect(() => {
    setForm(initial);
  }, [initial]);
  const set = (patch: Partial<RuleForm>) => setForm((f) => ({ ...f, ...patch }));
  const event = form.triggerType === 'event';

  async function submit(e: FormEvent) {
    e.preventDefault();
    await onSubmit(form);
  }

  return (
    <form className="form stack" onSubmit={submit}>
      <div className="field">
        <label htmlFor="rule-name">{t('admin.automations.name')}</label>
        <input id="rule-name" type="text" maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} required />
      </div>
      <div className="field">
        <label htmlFor="rule-trigger">{t('admin.automations.trigger')}</label>
        <select
          id="rule-trigger" value={event ? form.eventType : 'schedule'}
          onChange={(e) => (e.target.value === 'schedule' ? set({ triggerType: 'schedule', conditions: [] }) : set({ triggerType: 'event', eventType: e.target.value, conditions: [] }))}
        >
          {EVENT_TYPES.map((ev) => <option key={ev} value={ev}>{t(`admin.automations.events.${ev.replace(/\./g, '_')}`)}</option>)}
          <option value="schedule">{t('admin.automations.onSchedule')}</option>
        </select>
      </div>
      {!event ? (
        <fieldset className="stack">
          <legend>{t('admin.automations.schedule')}</legend>
          <div className="field">
            <label htmlFor="rule-frequency">{t('admin.automations.frequency')}</label>
            <select id="rule-frequency" value={form.frequency} onChange={(e) => set({ frequency: e.target.value as RuleForm['frequency'], weekdays: [] })}>
              <option value="daily">{t('admin.automations.daily')}</option>
              <option value="weekly">{t('admin.automations.weekly')}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="rule-time">{t('admin.automations.time')}</label>
            <input id="rule-time" type="time" step={300} value={form.time} onChange={(e) => set({ time: e.target.value })} required />
            <p className="field__hint">{t('admin.automations.timeHint')}</p>
          </div>
          {form.frequency === 'weekly' ? (
            <div className="field">
              <span>{t('admin.automations.weekdays')}</span>
              {WEEKDAYS.map((d) => (
                <span key={d} className="field--check">
                  <input
                    id={`weekday-${d}`} type="checkbox" checked={form.weekdays.includes(d)}
                    onChange={(e) => set({ weekdays: e.target.checked ? [...form.weekdays, d] : form.weekdays.filter((x) => x !== d) })}
                  />
                  <label htmlFor={`weekday-${d}`}>{t(`admin.automations.days.${d}`)}</label>
                </span>
              ))}
            </div>
          ) : null}
        </fieldset>
      ) : (
        <section className="stack" aria-labelledby="rule-conditions-title">
          <h3 id="rule-conditions-title">{t('admin.automations.conditionsTitle')}</h3>
          <p className="field__hint">{t('admin.automations.conditionsHint')}</p>
          {form.conditions.map((c, i) => (
            <ConditionEditor
              key={i} eventType={form.eventType} row={c} index={i}
              onChange={(r) => set({ conditions: form.conditions.map((x, j) => (j === i ? r : x)) })}
              onRemove={() => set({ conditions: form.conditions.filter((_, j) => j !== i) })}
            />
          ))}
          <button
            className="btn btn--secondary" type="button" disabled={form.conditions.length >= 10}
            onClick={() => { const [first] = factsFor(form.eventType); set({ conditions: [...form.conditions, { fact: first?.[0] ?? '', op: operatorsFor(form.eventType, first?.[0] ?? '')[0] ?? 'is', value: '' }] }); }}
          >
            {t('admin.automations.addCondition')}
          </button>
        </section>
      )}
      <section className="stack" aria-labelledby="rule-actions-title">
        <h3 id="rule-actions-title">{t('admin.automations.actionsTitle')}</h3>
        <p className="field__hint">{t('admin.automations.actionsHint')}</p>
        {form.actions.map((a, i) => (
          <ActionEditor
            key={i} row={a} index={i} tags={tags} hooks={hooks}
            onChange={(r) => set({ actions: form.actions.map((x, j) => (j === i ? r : x)) })}
            onRemove={() => set({ actions: form.actions.filter((_, j) => j !== i) })}
          />
        ))}
        <button className="btn btn--secondary" type="button" disabled={form.actions.length >= 10} onClick={() => set({ actions: [...form.actions, blankAction('create_task')] })}>
          {t('admin.automations.addAction')}
        </button>
      </section>
      <div className="actions">
        <button className="btn" type="submit">{submitLabel}</button>
      </div>
    </form>
  );
}
