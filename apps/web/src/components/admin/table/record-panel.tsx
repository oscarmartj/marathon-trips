'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { TagChip } from './tag-chip';
import { type Meta, type TableRow, type TagView, errText, formatDate, maybe } from './shared';

interface Note {
  id: string;
  body: string;
  pinned: boolean;
  version: number;
  createdAt: string;
  author: { id: string; email: string | null; you: boolean };
}

interface HistoryEntry {
  id: string;
  occurredAt: string;
  actorType: string;
  action: string;
  fields: Array<{ field: string; before?: unknown; after?: unknown; hidden?: boolean }>;
  reason: string | null;
}

interface Props {
  meta: Meta;
  prefix: string;
  id: string;
  tags: TagView[];
  editor?: (row: TableRow | null, saved: () => void) => ReactNode;
  onChanged: () => void;
  onClose: () => void;
}

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? t('admin.table.record.empty') : typeof v === 'object' ? JSON.stringify(v) : String(v));

function Notes({ meta, id, canAnnotate }: { meta: Meta; id: string; canAnnotate: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const load = useCallback(async () => {
    const r = await api<Note[]>(`/admin/tables/${meta.entityType}/${id}/notes`);
    if (r.status === 200) setNotes(r.body as unknown as Note[]);
  }, [meta.entityType, id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const r = await api(`/admin/tables/${meta.entityType}/${id}/notes`, { method: 'POST', body: { body, pinned } });
    if (r.status === 201) {
      setBody('');
      setPinned(false);
      setMessage({ text: t('admin.table.record.noteAdded'), tone: 'info' });
      await load();
    } else setMessage({ text: errText(r), tone: 'error' });
  }

  async function remove(n: Note) {
    const r = await api(`/admin/tables/${meta.entityType}/${id}/notes/${n.id}`, { method: 'DELETE' });
    if (r.status === 204) await load();
    else setMessage({ text: errText(r), tone: 'error' });
  }

  return (
    <section aria-labelledby="rec-notes" className="stack">
      <h3 id="rec-notes">{t('admin.table.record.notes')}</h3>
      {notes.length === 0 ? <p>{t('admin.table.record.noNotes')}</p> : null}
      <ul className="plain-list">
        {notes.map((n) => (
          <li key={n.id} className="card">
            <p>{n.body}</p>
            <p>
              {n.pinned ? <strong>{t('admin.table.record.pinned')} </strong> : null}
              {n.author.you ? t('admin.table.record.you') : (n.author.email ?? t('admin.table.record.colleague'))}
              {' · '}
              <time dateTime={n.createdAt}>{formatDate(n.createdAt)}</time>
            </p>
            {n.author.you ? (
              <button className="link-button" type="button" onClick={() => remove(n)}>
                {t('admin.table.record.deleteNote')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canAnnotate ? (
        <form onSubmit={add} className="stack">
          <div className="field">
            <label htmlFor="note-body">{t('admin.table.record.noteLabel')}</label>
            <textarea id="note-body" rows={3} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} required />
          </div>
          <label className="check">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            <span>{t('admin.table.record.pin')}</span>
          </label>
          <button className="btn" type="submit" disabled={body.trim() === ''}>
            {t('admin.table.record.addNote')}
          </button>
        </form>
      ) : null}
      {message ? <Status message={message.text} tone={message.tone} /> : null}
    </section>
  );
}

function History({ meta, id, prefix, refresh }: { meta: Meta; id: string; prefix: string; refresh: number }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await api<HistoryEntry[]>(`/admin/tables/${meta.entityType}/${id}/history`);
      setEntries(r.status === 200 ? (r.body as unknown as HistoryEntry[]) : null);
    })();
  }, [meta.entityType, id, refresh]);
  if (entries === null) return null;
  const actor = (e: HistoryEntry) => (e.actorType === 'staff' ? t('admin.table.record.actorStaff') : e.actorType === 'system' ? t('admin.table.record.actorSystem') : t('admin.table.record.actorOther'));
  return (
    <section aria-labelledby="rec-history" className="stack">
      <h3 id="rec-history">{t('admin.table.record.history')}</h3>
      {entries.length === 0 ? <p>{t('admin.table.record.noHistory')}</p> : null}
      <ol className="plain-list">
        {entries.map((e) => (
          <li key={e.id} className="card">
            <p>
              <strong>{e.action}</strong>
              {' · '}
              {t('admin.table.record.by', { actor: actor(e), time: new Date(e.occurredAt).toLocaleString('en-AU') })}
            </p>
            {e.reason ? <p>{t('admin.table.record.reason', { reason: e.reason })}</p> : null}
            <ul>
              {e.fields.map((f) => (
                <li key={f.field}>
                  {f.hidden ? (
                    <span>
                      {maybe(`${prefix}.columns.${f.field}`, f.field)}: {t('admin.table.record.hidden')}
                    </span>
                  ) : (
                    <span>
                      {maybe(`${prefix}.columns.${f.field}`, f.field)}: {t('admin.table.record.before')} <del>{show(f.before)}</del> {t('admin.table.record.after')} <ins>{show(f.after)}</ins>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RecordPanel({ meta, prefix, id, tags, editor, onChanged, onClose }: Props) {
  const [row, setRow] = useState<TableRow | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [version, setVersion] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    const r = await api<TableRow>(`/admin/tables/${meta.entityType}/${id}`);
    if (r.status === 200) {
      const next = r.body as unknown as TableRow;
      setRow(next);
      setChosen((next.tags ?? []).map((x) => x.id));
    } else setMessage({ text: errText(r), tone: 'error' });
  }, [meta.entityType, id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    heading.current?.focus();
  }, [id]);

  const changed = async () => {
    setVersion((v) => v + 1);
    await load();
    onChanged();
  };

  async function saveTags() {
    const r = await api(`/admin/tables/${meta.entityType}/${id}/tags`, { method: 'PUT', body: { tagIds: chosen } });
    if (r.status === 200) {
      setMessage({ text: t('admin.table.record.tagsSaved'), tone: 'info' });
      await changed();
    } else setMessage({ text: errText(r), tone: 'error' });
  }

  async function setDeleted(deleted: boolean) {
    const r = await api(`/admin/tables/${meta.entityType}/${id}/${deleted ? 'delete' : 'restore'}`, { method: 'POST', body: {} });
    if (r.status === 200) await changed();
    else setMessage({ text: errText(r), tone: 'error' });
  }

  const deleted = Boolean(row?.deletedAt);
  const title = typeof row?.title === 'string' ? row.title : id;
  return (
    <aside className="panel stack" aria-labelledby="rec-heading">
      <div className="actions">
        <h2 id="rec-heading" tabIndex={-1} ref={heading}>
          {title}
        </h2>
        <button className="btn" type="button" onClick={onClose}>
          {t('admin.table.record.close')}
        </button>
      </div>
      {deleted ? <p className="notice">{t('admin.table.record.deleted')}</p> : null}
      {message ? <Status message={message.text} tone={message.tone} /> : null}
      {editor && meta.can.write && !deleted ? editor(row, changed) : null}
      {meta.softDelete && meta.can.delete ? (
        <button className="btn" type="button" onClick={() => setDeleted(!deleted)}>
          {deleted ? t('admin.table.record.restore') : t('admin.table.record.delete')}
        </button>
      ) : null}
      {meta.taggable ? (
        <section aria-labelledby="rec-tags" className="stack">
          <h3 id="rec-tags">{t('admin.table.record.tags')}</h3>
          {meta.can.annotate && !deleted ? (
            tags.length === 0 ? (
              <p>{t('admin.table.record.noTagDefs')}</p>
            ) : (
              <>
                {tags.map((tag) => (
                  <label key={tag.id} className="check">
                    <input type="checkbox" checked={chosen.includes(tag.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, tag.id] : chosen.filter((x) => x !== tag.id))} />
                    <TagChip tag={tag} />
                  </label>
                ))}
                <button className="btn" type="button" onClick={saveTags}>
                  {t('admin.table.record.saveTags')}
                </button>
              </>
            )
          ) : (
            <p>{(row?.tags ?? []).map((tag) => <TagChip key={tag.id} tag={tag} />)}</p>
          )}
        </section>
      ) : null}
      {meta.notes ? <Notes meta={meta} id={id} canAnnotate={meta.can.annotate && !deleted} /> : null}
      <History meta={meta} id={id} prefix={prefix} refresh={version} />
    </aside>
  );
}
