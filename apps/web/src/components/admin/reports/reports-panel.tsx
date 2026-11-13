'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import {
  type BuilderForm, type Entity, type ReportResult, type SavedReportView, FUNNEL_RANGES, TIMES, cell, columnsOf, editableHere, emptyForm, formOf, funnelPath, groupsOf,
  saveBody, toggleColumn, toggleRecipient, withEntity,
} from '@/lib/reports-panel';
import { Status } from '../../auth/field';
import { ActionButton, Section, catalogueError, useLoad } from '../catalogue/kit';

interface Catalogue {
  entities: Array<{ entity: Entity; allowed: boolean }>;
  races: Array<{ id: string; name: string }>;
  recipients: Array<{ id: string; email: string }>;
}

/** A result as a table: the first column names the row, then one column per chosen value. */
function ResultTable({ result, caption, id }: { result: ReportResult; caption: string; id: string }) {
  return result.rows.length === 0 ? (
    <p role="status">{t('admin.reports.noData')}</p>
  ) : (
    <>
      <table className="table" data-testid={id}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t(`admin.reports.groups.${result.groupBy}`)}</th>
            {result.columns.map((c) => <th scope="col" key={c}>{t(`admin.reports.columns.${c}`)}</th>)}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              {result.columns.map((c) => <td key={c}>{cell(c, r.values[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {result.truncated ? <p className="field__hint">{t('admin.reports.truncated')}</p> : null}
    </>
  );
}

function Funnel() {
  const [days, setDays] = useState<number>(30);
  const funnel = useLoad<ReportResult>(funnelPath(days));
  return (
    <Section id="reports-funnel" title={t('admin.reports.funnelTitle')}>
      <p>{t('admin.reports.funnelIntro')}</p>
      <div className="field">
        <label htmlFor="funnel-days">{t('admin.reports.period')}</label>
        <select id="funnel-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {FUNNEL_RANGES.map((d) => <option key={d} value={d}>{t('admin.reports.lastDays', { days: d })}</option>)}
        </select>
      </div>
      <Status message={funnel.error} />
      {funnel.data ? (
        <>
          <p className="field__hint">{t('admin.reports.between', { from: funnel.data.from, to: funnel.data.to })}</p>
          <ResultTable result={funnel.data} caption={t('admin.reports.funnelCaption')} id="funnel-table" />
        </>
      ) : funnel.error ? null : <p role="status">{t('admin.common.loading')}</p>}
      <p className="field__hint">{t('admin.reports.visitsNote')}</p>
    </Section>
  );
}

function Builder({ catalogue, editing, onSaved, onCancel }: { catalogue: Catalogue; editing: SavedReportView | null; onSaved: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<BuilderForm>(editing ? formOf(editing) : emptyForm());
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const set = (patch: Partial<BuilderForm>) => setForm((f) => ({ ...f, ...patch }));
  const allowed = new Map(catalogue.entities.map((e) => [e.entity, e.allowed]));

  async function preview() {
    const body = saveBody(form);
    const r = await api<ReportResult>('/admin/reports/preview', { method: 'POST', body: { definition: body.definition } });
    if (r.status === 200) {
      setResult(r.body as unknown as ReportResult);
      setMessage(null);
    } else setMessage({ text: catalogueError(r), tone: 'error' });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = editing
      ? await api(`/admin/reports/${editing.id}`, { method: 'PATCH', body: { ...saveBody(form), version: editing.version } })
      : await api('/admin/reports', { method: 'POST', body: saveBody(form) });
    if (r.status === 200 || r.status === 201) {
      setMessage({ text: t('admin.reports.saved'), tone: 'info' });
      if (!editing) setForm(emptyForm());
      onSaved();
    } else setMessage({ text: catalogueError(r), tone: 'error' });
  }

  return (
    <Section id="reports-builder" title={editing ? t('admin.reports.editTitle', { name: editing.name }) : t('admin.reports.newTitle')}>
      <form onSubmit={save} className="form stack" aria-describedby="reports-builder-note">
        <p id="reports-builder-note" className="field__hint">{t('admin.reports.builderNote')}</p>
        <div className="field">
          <label htmlFor="rb-name">{t('admin.reports.fields.name')} <span aria-hidden="true">*</span></label>
          <input id="rb-name" required maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="rb-entity">{t('admin.reports.fields.entity')}</label>
          <select id="rb-entity" value={form.entity} onChange={(e) => setForm(withEntity(form, e.target.value as Entity))}>
            {(['funnel', 'bookings'] as const).map((en) => (
              <option key={en} value={en} disabled={allowed.get(en) === false}>{t(`admin.reports.entities.${en}`)}</option>
            ))}
          </select>
        </div>
        <fieldset className="field">
          <legend>{t('admin.reports.fields.columns')}</legend>
          {columnsOf(form.entity).map((c) => (
            <label key={c} className="field--check">
              <input type="checkbox" checked={form.columns.includes(c)} onChange={(e) => setForm(toggleColumn(form, c, e.target.checked))} /> {t(`admin.reports.columns.${c}`)}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="rb-group">{t('admin.reports.fields.groupBy')}</label>
          <select id="rb-group" value={form.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
            {groupsOf(form.entity).map((g) => <option key={g} value={g}>{t(`admin.reports.groups.${g}`)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rb-race">{t('admin.reports.fields.race')}</label>
          <select id="rb-race" value={form.raceId} onChange={(e) => set({ raceId: e.target.value })}>
            <option value="">{t('admin.reports.allRaces')}</option>
            {catalogue.races.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rb-days">{t('admin.reports.fields.days')}</label>
          <select id="rb-days" value={form.days} onChange={(e) => set({ days: e.target.value })}>
            {FUNNEL_RANGES.map((d) => <option key={d} value={d}>{t('admin.reports.lastDays', { days: d })}</option>)}
          </select>
        </div>
        <div className="field field--check">
          <label htmlFor="rb-scheduled"><input id="rb-scheduled" type="checkbox" checked={form.scheduled} onChange={(e) => set({ scheduled: e.target.checked })} /> {t('admin.reports.fields.scheduled')}</label>
        </div>
        {form.scheduled ? (
          <div className="stack" data-testid="schedule-fields">
            <div className="field">
              <label htmlFor="rb-frequency">{t('admin.reports.fields.frequency')}</label>
              <select id="rb-frequency" value={form.frequency} onChange={(e) => set({ frequency: e.target.value as 'weekly' | 'monthly' })}>
                <option value="weekly">{t('admin.reports.weekly')}</option>
                <option value="monthly">{t('admin.reports.monthly')}</option>
              </select>
            </div>
            {form.frequency === 'weekly' ? (
              <div className="field">
                <label htmlFor="rb-weekday">{t('admin.reports.fields.weekday')}</label>
                <select id="rb-weekday" value={form.weekday} onChange={(e) => set({ weekday: e.target.value })}>
                  {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{t(`admin.reports.weekdays.${d}`)}</option>)}
                </select>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="rb-dom">{t('admin.reports.fields.dayOfMonth')}</label>
                <select id="rb-dom" value={form.dayOfMonth} onChange={(e) => set({ dayOfMonth: e.target.value })}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="rb-time">{t('admin.reports.fields.time')}</label>
              <select id="rb-time" value={form.time} onChange={(e) => set({ time: e.target.value })}>
                {TIMES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <fieldset className="field">
              <legend>{t('admin.reports.fields.recipients')}</legend>
              <p className="field__hint">{t('admin.reports.recipientsHint')}</p>
              {(catalogue.recipients ?? []).map((r) => (
                <label key={r.id} className="field--check">
                  <input type="checkbox" checked={form.recipientUserIds.includes(r.id)} onChange={(e) => setForm(toggleRecipient(form, r.id, e.target.checked))} /> {r.email}
                </label>
              ))}
            </fieldset>
          </div>
        ) : null}
        <div className="actions">
          <button className="btn" type="submit">{editing ? t('admin.reports.saveChanges') : t('admin.reports.save')}</button>
          <button className="btn btn--secondary" type="button" onClick={() => void preview()}>{t('admin.reports.preview')}</button>
          {editing ? <button className="link-button" type="button" onClick={onCancel}>{t('admin.reports.cancelEdit')}</button> : null}
        </div>
        {message ? <Status message={message.text} tone={message.tone} /> : null}
      </form>
      {result ? <ResultTable result={result} caption={t('admin.reports.previewCaption')} id="preview-table" /> : null}
    </Section>
  );
}

const describeSchedule = (r: SavedReportView): string => {
  const s = r.schedule;
  if (!s) return t('admin.reports.notScheduled');
  return s.frequency === 'weekly'
    ? t('admin.reports.scheduleWeekly', { day: t(`admin.reports.weekdays.${s.weekday ?? 1}`), time: s.time, count: r.recipientUserIds.length })
    : t('admin.reports.scheduleMonthly', { day: s.dayOfMonth ?? 1, time: s.time, count: r.recipientUserIds.length });
};

/** The funnel per race and the report builder (task 7.7). */
export function ReportsPanel() {
  const list = useLoad<{ items: SavedReportView[] }>('/admin/reports');
  const catalogue = useLoad<Catalogue>('/admin/reports/catalogue');
  const [editing, setEditing] = useState<SavedReportView | null>(null);
  const [shown, setShown] = useState<{ id: string; result: ReportResult } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  async function run(id: string) {
    const r = await api<ReportResult>(`/admin/reports/${id}/run`, { method: 'POST' });
    if (r.status === 200) {
      setShown({ id, result: r.body as unknown as ReportResult });
      setRunError(null);
    } else setRunError(catalogueError(r));
  }

  return (
    <div className="stack">
      <Funnel />
      <Section id="reports-saved" title={t('admin.reports.savedTitle')}>
        <Status message={list.error ?? catalogue.error ?? runError} />
        {list.data ? (
          list.data.items.length === 0 ? (
            <p role="status">{t('admin.reports.empty')}</p>
          ) : (
            <table className="table">
              <caption>{t('admin.reports.savedCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.reports.fields.name')}</th>
                  <th scope="col">{t('admin.reports.fields.entity')}</th>
                  <th scope="col">{t('admin.reports.fields.sending')}</th>
                  <th scope="col">{t('admin.reports.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.id} data-testid={`report-${r.id}`}>
                    <th scope="row">{r.name}</th>
                    <td>{t(`admin.reports.entities.${r.entity}`)}</td>
                    <td>{describeSchedule(r)}</td>
                    <td>
                      <button type="button" className="btn btn--secondary" onClick={() => void run(r.id)}>{t('admin.reports.run', { name: r.name })}</button>{' '}
                      {editableHere(r) ? <button type="button" className="btn btn--secondary" onClick={() => setEditing(r)}>{t('admin.reports.edit', { name: r.name })}</button> : null}{' '}
                      <ActionButton text={t('admin.reports.delete', { name: r.name })} danger run={() => api(`/admin/reports/${r.id}?version=${r.version}`, { method: 'DELETE' })} onDone={() => { setShown(null); void list.reload(); }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : list.error ? null : <p role="status">{t('admin.common.loading')}</p>}
        {shown ? <ResultTable result={shown.result} caption={t('admin.reports.resultCaption')} id="run-table" /> : null}
      </Section>
      {catalogue.data ? (
        <Builder
          key={editing?.id ?? 'new'}
          catalogue={catalogue.data}
          editing={editing}
          onSaved={() => { setEditing(null); void list.reload(); }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
