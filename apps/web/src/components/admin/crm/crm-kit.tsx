'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Status } from '../../auth/field';
import { catalogueError } from '../catalogue/kit';

/** A message for a CRM error code: this area's own wording when it has one, else the catalogue's general wording. */
export function crmError(r: { status: number; body: { code?: string } }): string {
  const code = r.body?.code;
  if (code) {
    try {
      return t(`admin.crm.errors.${code}`);
    } catch {
      /* falls through */
    }
  }
  return catalogueError(r);
}

/** A moment in the business time zone (Australia/Brisbane), as staff read it. */
export const formatMoment = (iso: string | null | undefined): string =>
  iso ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' }).format(new Date(iso)) : '';

export const fullName = (c: { givenName: string; familyName: string }): string => `${c.givenName} ${c.familyName}`.trim();

export function statusLabel(kind: 'booking' | 'quote', status: string): string {
  try {
    return t(`admin.crm.${kind}Status.${status}`);
  } catch {
    return status;
  }
}

interface Note {
  id: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  author: { id: string; email: string | null; you: boolean };
}

/** Internal notes on a booking or a customer, through the shared table routes (task 0.5). Never shown to the customer. */
export function RecordNotes({ entityType, id }: { entityType: 'Booking' | 'Customer' | 'Complaint'; id: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [body, setBody] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const load = useCallback(async () => {
    const r = await api<Note[]>(`/admin/tables/${entityType}/${id}/notes`);
    if (r.status === 200) setNotes(r.body as unknown as Note[]);
    else if (r.status === 403) setNotes([]);
    else setMessage({ text: crmError(r), tone: 'error' });
  }, [entityType, id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    const r = await api(`/admin/tables/${entityType}/${id}/notes`, { method: 'POST', body: { body: body.trim(), pinned: false } });
    if (r.status === 201) {
      setBody('');
      setMessage({ text: t('admin.crm.notes.added'), tone: 'info' });
      await load();
    } else setMessage({ text: crmError(r), tone: 'error' });
  }

  const fieldId = `${entityType.toLowerCase()}-note`;
  return (
    <div className="stack">
      {notes === null ? <p role="status">{t('admin.common.loading')}</p> : notes.length === 0 ? <p>{t('admin.crm.notes.empty')}</p> : (
        <ul className="stack">
          {notes.map((n) => (
            <li key={n.id}>
              <p>{n.body}</p>
              <p className="field__hint">{t('admin.crm.notes.by', { who: n.author.you ? t('admin.crm.notes.you') : (n.author.email ?? t('admin.crm.notes.unknown')), when: formatMoment(n.createdAt) })}</p>
            </li>
          ))}
        </ul>
      )}
      <form className="form stack" onSubmit={add}>
        <div className="field">
          <label htmlFor={fieldId}>{t('admin.crm.notes.label')}</label>
          <textarea id={fieldId} rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} aria-describedby={`${fieldId}-hint`} />
          <p id={`${fieldId}-hint`} className="field__hint">{t('admin.crm.notes.hint')}</p>
        </div>
        <div className="actions">
          <button className="btn" type="submit">{t('admin.crm.notes.add')}</button>
        </div>
        <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
      </form>
    </div>
  );
}
