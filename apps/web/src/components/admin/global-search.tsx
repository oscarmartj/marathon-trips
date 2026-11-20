'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Status } from '../auth/field';
import { errText } from './table/shared';

interface Hit {
  entityType: string;
  entityId: string;
  title: string;
  subtitle: string | null;
}

/** Where each searchable entity opens in the panel. Add a line when a table gets its page. */
const RECORD_PATHS: Record<string, string> = { Task: '/admin/tasks' };

export function GlobalSearch() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim() === '') return;
    const r = await api<Hit[]>(`/admin/search?q=${encodeURIComponent(q.trim())}`);
    if (r.status === 200) {
      setHits(r.body as unknown as Hit[]);
      setError(null);
    } else setError(errText(r));
  }

  return (
    <div role="search" className="stack">
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="global-search">{t('admin.table.search.label')}</label>
          <input id="global-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn btn--accent" type="submit">
          {t('admin.table.search.button')}
        </button>
      </form>
      <div aria-live="polite">
        <Status message={error} />
        {hits ? (
          hits.length === 0 ? (
            <p>{t('admin.table.search.none')}</p>
          ) : (
            <ul aria-label={t('admin.table.search.results')} className="plain-list">
              {hits.map((h) => (
                <li key={`${h.entityType}-${h.entityId}`}>
                  {RECORD_PATHS[h.entityType] ? <a href={`${RECORD_PATHS[h.entityType]}?open=${h.entityId}`}>{h.title}</a> : h.title}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  );
}
