'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Status } from '../../auth/field';
import { type TableRow, errText } from './shared';

const STATUSES = ['open', 'done', 'cancelled'] as const;

/** Create (row null) or edit a task. The shared table calls it as the entity-specific part of the example table. */
export function TaskEditor({ row, saved }: { row: TableRow | null; saved: () => void }) {
  const [title, setTitle] = useState(typeof row?.title === 'string' ? row.title : '');
  const [description, setDescription] = useState(typeof row?.description === 'string' ? row.description : '');
  const [due, setDue] = useState(typeof row?.dueAt === 'string' ? row.dueAt.slice(0, 10) : '');
  const [status, setStatus] = useState(typeof row?.status === 'string' ? row.status : 'open');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const id = row ? `edit-${row.id}` : 'new';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const common = { title: title.trim(), description: description.trim() === '' ? null : description.trim(), dueAt: due === '' ? null : due };
    const r = row
      ? await api(`/admin/tasks/${row.id}`, { method: 'PATCH', body: { ...common, version: row.version ?? 0, ...(status !== row.status ? { status } : {}) } })
      : await api('/admin/tasks', { method: 'POST', body: common });
    if (r.status === 200 || r.status === 201) {
      setMessage({ text: t(row ? 'admin.tasks.form.saved' : 'admin.tasks.form.created'), tone: 'info' });
      if (!row) {
        setTitle('');
        setDescription('');
        setDue('');
      }
      saved();
    } else setMessage({ text: errText(r), tone: 'error' });
  }

  return (
    <form onSubmit={submit} className="form stack">
      <div className="field">
        <label htmlFor={`${id}-title`}>{t('admin.tasks.form.title')}</label>
        <input id={`${id}-title`} value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-description`}>{t('admin.tasks.form.description')}</label>
        <textarea id={`${id}-description`} rows={3} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-due`}>{t('admin.tasks.form.due')}</label>
        <input id={`${id}-due`} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      {row ? (
        <div className="field">
          <label htmlFor={`${id}-status`}>{t('admin.tasks.form.status')}</label>
          <select id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`admin.tasks.values.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <button className="btn" type="submit" disabled={title.trim() === ''}>
        {t(row ? 'admin.tasks.form.save' : 'admin.tasks.form.create')}
      </button>
      {message ? <Status message={message.text} tone={message.tone} /> : null}
    </form>
  );
}
