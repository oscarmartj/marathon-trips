'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { type QueryState, errText, queryBody } from './shared';

interface View {
  id: string;
  name: string;
  shared: boolean;
  mine: boolean;
  version: number;
  query: QueryState | null;
}

export function ViewsMenu({ entityType, query, onApply }: { entityType: string; query: QueryState; onApply: (q: QueryState, name: string) => void }) {
  const [views, setViews] = useState<View[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);

  const load = useCallback(async () => {
    const r = await api<View[]>(`/admin/tables/${entityType}/views`);
    if (r.status === 200) setViews(r.body as unknown as View[]);
  }, [entityType]);
  useEffect(() => {
    void load();
  }, [load]);

  const current = views.find((v) => v.id === selected);

  function apply() {
    if (!current) return;
    if (!current.query) setMessage({ text: t('admin.table.views.stale'), tone: 'error' });
    else {
      onApply({ ...current.query, q: current.query.q ?? '' }, current.name);
      setMessage({ text: t('admin.table.views.applied', { name: current.name }), tone: 'info' });
    }
  }

  async function save() {
    const r = await api(`/admin/tables/${entityType}/views`, { method: 'POST', body: { name: name.trim(), query: queryBody(query), shared } });
    if (r.status === 201) {
      setMessage({ text: t('admin.table.views.saved'), tone: 'info' });
      setName('');
      await load();
    } else setMessage({ text: errText(r), tone: 'error' });
  }

  async function remove() {
    if (!current) return;
    const r = await api(`/admin/tables/${entityType}/views/${current.id}`, { method: 'DELETE' });
    if (r.status === 204) {
      setMessage({ text: t('admin.table.views.deleted'), tone: 'info' });
      setSelected('');
      await load();
    } else setMessage({ text: errText(r), tone: 'error' });
  }

  return (
    <fieldset className="stack">
      <legend>{t('admin.table.views.heading')}</legend>
      <div className="inline-form">
        <div className="field">
          <label htmlFor="view-select">{t('admin.table.views.choose')}</label>
          <select id="view-select" value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">{views.length ? '' : t('admin.table.views.none')}</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.shared && !v.mine ? t('admin.table.views.shared', { name: v.name }) : v.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" type="button" onClick={apply} disabled={!current}>
          {t('admin.table.views.apply')}
        </button>
        <button className="btn" type="button" onClick={remove} disabled={!current}>
          {t('admin.table.views.delete')}
        </button>
      </div>
      <div className="inline-form">
        <div className="field">
          <label htmlFor="view-name">{t('admin.table.views.name')}</label>
          <input id="view-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <span>{t('admin.table.views.share')}</span>
        </label>
        <button className="btn" type="button" onClick={save} disabled={name.trim() === ''}>
          {t('admin.table.views.save')}
        </button>
      </div>
      {message ? <Status message={message.text} tone={message.tone} /> : null}
    </fieldset>
  );
}
