'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { type CalendarItem, addableKinds, calendarPath, createBody, isStored, tripLabel } from '@/lib/keydates-panel';
import { Status } from '../../auth/field';
import { ActionButton, EntityForm, type FieldDef, Section, catalogueError, formatDay, outcome, useLoad } from '../catalogue/kit';

interface Calendar {
  today: string;
  items: CalendarItem[];
}
interface EditionOption {
  id: string;
  year: number;
  raceName: string;
}

const what = (i: CalendarItem): string => {
  const line = i.kind === 'allotment_release' ? t('admin.keydates.lines.allotment_release', { count: i.count ?? 0, detail: i.detail ?? '' })
    : i.kind === 'balance_due' ? t('admin.keydates.lines.balance_due', { count: i.count ?? 0 })
      : i.kind === 'custom' ? t('admin.keydates.lines.custom', { label: i.label ?? '' }) : t('admin.keydates.lines.entry_submission');
  return `${t(`admin.keydates.kinds.${i.kind}`)}: ${line}`;
};

/** One stored date's controls: a new date, and delete. The version travels with each call. */
function StoredControls({ item, onDone }: { item: CalendarItem; onDone: () => void }) {
  const [date, setDate] = useState(item.date);
  const [message, setMessage] = useState<string | null>(null);
  const id = `change-${item.keyDateId}`;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await api(`/admin/key-dates/${item.keyDateId}`, { method: 'PATCH', body: { dueDate: date, version: item.version } });
    if (r.status === 200) {
      setMessage(null);
      onDone();
    } else setMessage(catalogueError(r));
  }
  return (
    <div className="stack">
      <form onSubmit={save} className="inline-form">
        <label htmlFor={id}>{t('admin.keydates.changeDate', { what: what(item) })}</label>
        <input id={id} type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn" type="submit">{t('admin.keydates.saveDate')}</button>
      </form>
      <ActionButton text={t('admin.keydates.delete')} danger run={() => api(`/admin/key-dates/${item.keyDateId}?${new URLSearchParams({ version: String(item.version) }).toString()}`, { method: 'DELETE' })} onDone={onDone} />
      <Status message={message} />
    </div>
  );
}

/** The key dates calendar (task 7.3): what is coming up, what is overdue, and a form for dates of our own. */
export function KeyDatesPanel() {
  const [editionId, setEditionId] = useState('');
  const editions = useLoad<{ items: EditionOption[] }>('/admin/key-dates/editions');
  const cal = useLoad<Calendar>(calendarPath(editionId));
  const options = editions.data?.items ?? [];
  const fields: FieldDef[] = [
    { key: 'editionId', label: t('admin.keydates.fields.edition'), type: 'select', required: true, options: [{ value: '', label: '' }, ...options.map((e) => ({ value: e.id, label: tripLabel(e) }))] },
    { key: 'kind', label: t('admin.keydates.fields.kind'), type: 'select', required: true, options: addableKinds.map((k) => ({ value: k, label: t(`admin.keydates.kinds.${k}`) })) },
    { key: 'label', label: t('admin.keydates.fields.label'), type: 'text', maxLength: 120, hint: t('admin.keydates.fields.labelHint') },
    { key: 'dueDate', label: t('admin.keydates.fields.dueDate'), type: 'date', required: true },
  ];

  return (
    <div className="stack">
      <Section id="key-dates-list" title={t('admin.keydates.listTitle')}>
        <Status message={editions.error ?? cal.error} />
        <div className="field">
          <label htmlFor="key-dates-edition">{t('admin.keydates.filterLabel')}</label>
          <select id="key-dates-edition" value={editionId} onChange={(e) => setEditionId(e.target.value)}>
            <option value="">{t('admin.keydates.allEditions')}</option>
            {options.map((e) => <option key={e.id} value={e.id}>{tripLabel(e)}</option>)}
          </select>
        </div>
        <p className="field__hint">{t('admin.keydates.readOnlyHint')}</p>
        {cal.data ? (
          cal.data.items.length === 0 ? (
            <p role="status">{t('admin.keydates.empty')}</p>
          ) : (
            <table className="table">
              <caption>{t('admin.keydates.listCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.keydates.columns.date')}</th>
                  <th scope="col">{t('admin.keydates.columns.what')}</th>
                  <th scope="col">{t('admin.keydates.columns.trip')}</th>
                  <th scope="col">{t('admin.keydates.columns.state')}</th>
                  <th scope="col">{t('admin.keydates.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {cal.data.items.map((i) => (
                  <tr key={i.key + i.date} data-testid={`key-date-${i.key}`}>
                    <th scope="row">{formatDay(i.date)}</th>
                    <td>{what(i)}</td>
                    <td>{tripLabel(i.edition)}</td>
                    <td>
                      {i.overdue ? <span className="badge">{t('admin.keydates.overdue')}</span> : t('admin.keydates.upcoming')}
                      {' · '}
                      {i.taskId ? <a href="/admin/tasks">{t('admin.keydates.taskOpen')}</a> : t('admin.keydates.noTask')}
                    </td>
                    <td>{isStored(i) ? <StoredControls key={`${i.keyDateId}-${i.version}`} item={i} onDone={() => void cal.reload()} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
      </Section>
      <Section id="key-dates-new" title={t('admin.keydates.newTitle')}>
        <EntityForm
          key={options.length}
          id="new-key-date"
          fields={fields}
          initial={{ editionId: '', kind: 'entry_submission', label: '', dueDate: '' }}
          submit={t('admin.keydates.create')}
          resetOnSuccess
          onSubmit={async (v) => {
            const out = await outcome(() => api('/admin/key-dates', { method: 'POST', body: createBody(v) }), t('admin.keydates.created'));
            if (out.ok) void cal.reload();
            return out;
          }}
        />
      </Section>
    </div>
  );
}
