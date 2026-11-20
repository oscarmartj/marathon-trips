'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Status } from '../../auth/field';
import { CsvTools } from './csv-tools';
import { FiltersBar } from './filters-bar';
import { RecordPanel } from './record-panel';
import { TagChip } from './tag-chip';
import { type Meta, type QueryState, type TableRow, type TagView, emptyQuery, errText, formatDate, maybe, queryParams } from './shared';
import { ViewsMenu } from './views-menu';

const PAGE_SIZE = 25;

interface Props {
  entityType: string;
  /** Catalogue prefix for this table: <prefix>.caption, .columns.<key>, .values.<key>.<value>, .actions.<action>. */
  prefix: string;
  /** The form that creates or edits a record (null row = create). Entity-specific, so the page supplies it. */
  editor?: (row: TableRow | null, saved: () => void) => ReactNode;
}

interface Result {
  total: number;
  rows: TableRow[];
}

/** One table for every panel list: search, filters, views, bulk actions, CSV, tags, notes, history and soft delete. */
export function DataTable({ entityType, prefix, editor }: Props) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [query, setQuery] = useState<QueryState>(emptyQuery);
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Result | null>(null);
  const [tags, setTags] = useState<TagView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [action, setAction] = useState('');
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [bulkLines, setBulkLines] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const [m, tg] = await Promise.all([api<Meta>(`/admin/tables/${entityType}/meta`), api<TagView[]>('/admin/tags')]);
      if (m.status === 200) setMeta(m.body as unknown as Meta);
      else setMessage({ text: errText(m), tone: 'error' });
      if (tg.status === 200) setTags(tg.body as unknown as TagView[]);
      const open = new URLSearchParams(window.location.search).get('open');
      if (open) setOpenId(open);
    })();
  }, [entityType]);

  // Always reload with the latest query and page, and ignore a response that a newer request has overtaken.
  const latest = useRef({ query, page });
  latest.current = { query, page };
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const mine = ++sequence.current;
    const r = await api<Result>(`/admin/tables/${entityType}/rows?${queryParams(latest.current.query, latest.current.page, PAGE_SIZE)}`);
    if (mine !== sequence.current) return;
    if (r.status === 200) setResult(r.body as unknown as Result);
    else setMessage({ text: errText(r), tone: 'error' });
  }, [entityType]);
  useEffect(() => {
    if (meta) void load();
  }, [meta, load, query, page]);

  if (!meta) return message ? <Status message={message.text} /> : <p role="status">{t('admin.common.loading')}</p>;

  const apply = (next: QueryState) => {
    setQuery(next);
    setText(next.q);
    setPage(1);
    setSelected([]);
    setMessage(null);
    setBulkLines([]);
  };
  const col = (key: string) => maybe(`${prefix}.columns.${key}`, key);
  const rows = result?.rows ?? [];
  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const sortOf = (key: string) => query.sort.find((s) => s.field === key)?.dir;
  const toggleSort = (key: string) => {
    const dir = sortOf(key);
    apply({ ...query, q: query.q, sort: dir === 'asc' ? [{ field: key, dir: 'desc' }] : dir === 'desc' ? [] : [{ field: key, dir: 'asc' }] });
  };

  function cellText(c: Meta['columns'][number], v: unknown): string {
    if (v === null || v === undefined || v === '') return '';
    if (c.type === 'date') return formatDate(String(v));
    if (c.type === 'enum') return maybe(`${prefix}.values.${c.key}.${v}`, String(v));
    if (c.type === 'boolean') return v ? t('admin.table.filters.true') : t('admin.table.filters.false');
    return String(v);
  }

  async function runBulk() {
    const r = await api<{ status: string; results: Array<{ id: string; ok: boolean; code: string }> }>(`/admin/tables/${entityType}/bulk`, { method: 'POST', body: { action, ids: selected } });
    if (r.status !== 200) {
      setMessage({ text: errText(r), tone: 'error' });
      return;
    }
    const results = r.body.results;
    const failed = results.filter((x) => !x.ok);
    const byCode = new Map<string, number>();
    for (const f of failed) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
    setMessage({ text: t('admin.table.bulk.result', { ok: results.length - failed.length, total: results.length }), tone: 'info' });
    setBulkLines([...byCode].map(([code, count]) => t('admin.table.bulk.failedLine', { count, reason: errText({ status: 0, body: { code } }) })));
    setSelected([]);
    await load();
  }

  async function restoreOne(id: string) {
    const r = await api(`/admin/tables/${entityType}/${id}/restore`, { method: 'POST', body: {} });
    if (r.status === 200) await load();
    else setMessage({ text: errText(r), tone: 'error' });
  }

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    apply({ ...query, q: text });
  };
  const allOnPage = rows.length > 0 && rows.every((r) => selected.includes(r.id));
  const titleOf = (r: TableRow): string => `${r.title ?? r.id}`;

  return (
    <div className="stack">
      <form role="search" onSubmit={onSearch} className="inline-form">
        <div className="field">
          <label htmlFor="tbl-search">{t('admin.table.searchTable')}</label>
          <input id="tbl-search" type="search" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <button className="btn" type="submit">
          {t('admin.table.searchButton')}
        </button>
      </form>
      <details>
        <summary>{t('admin.table.filters.heading')}</summary>
        <FiltersBar meta={meta} prefix={prefix} query={query} tags={tags} onChange={apply} />
      </details>
      <details>
        <summary>{t('admin.table.views.heading')}</summary>
        <ViewsMenu entityType={entityType} query={query} onApply={(q) => apply(q)} />
      </details>
      {meta.can.export || meta.can.import ? (
        <details>
          <summary>{t('admin.table.csv.heading')}</summary>
          <CsvTools meta={meta} query={query} onImported={load} />
        </details>
      ) : null}
      {editor && meta.can.write ? (
        <details>
          <summary>{maybe(`${prefix}.form.new`, '')}</summary>
          {editor(null, load)}
        </details>
      ) : null}

      {message ? <Status message={message.text} tone={message.tone} /> : null}
      {bulkLines.length > 0 ? (
        <ul>
          {bulkLines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}

      {selected.length > 0 && meta.bulkActions.length > 0 ? (
        <fieldset className="inline-form">
          <legend>{t('admin.table.bulk.heading')}</legend>
          <p role="status">{t('admin.table.bulk.count', { count: selected.length })}</p>
          <div className="field">
            <label htmlFor="bulk-action">{t('admin.table.bulk.action')}</label>
            <select id="bulk-action" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">{t('admin.table.bulk.choose')}</option>
              {meta.bulkActions.map((a) => (
                <option key={a} value={a}>
                  {maybe(`${prefix}.actions.${a}`, a)}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="button" onClick={runBulk} disabled={action === ''}>
            {t('admin.table.bulk.apply')}
          </button>
          <button className="btn" type="button" onClick={() => setSelected([])}>
            {t('admin.table.bulk.clear')}
          </button>
        </fieldset>
      ) : null}

      <p role="status">{total === 0 ? t('admin.table.empty') : t('admin.table.summary', { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, total), total })}</p>
      <div className="table-wrap">
        <table className="table">
          <caption className="visually-hidden">{maybe(`${prefix}.caption`, entityType)}</caption>
          <thead>
            <tr>
              {meta.bulkActions.length > 0 ? (
                <th scope="col">
                  <input type="checkbox" aria-label={t('admin.table.selectAll')} checked={allOnPage} onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])} />
                </th>
              ) : null}
              {meta.columns.map((c) => {
                const dir = sortOf(c.key);
                return (
                  <th key={c.key} scope="col" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
                    {c.sortable ? (
                      <button className="link-button" type="button" onClick={() => toggleSort(c.key)}>
                        {col(c.key)}
                        {dir ? <span aria-hidden="true">{dir === 'asc' ? ' ▲' : ' ▼'}</span> : null}
                      </button>
                    ) : (
                      col(c.key)
                    )}
                  </th>
                );
              })}
              {meta.taggable ? <th scope="col">{col('tags')}</th> : null}
              <th scope="col">
                <span className="visually-hidden">{t('admin.table.actionsColumn')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid={`row-${r.id}`}>
                {meta.bulkActions.length > 0 ? (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t('admin.table.selectRow', { title: titleOf(r) })}
                      checked={selected.includes(r.id)}
                      onChange={(e) => setSelected(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))}
                    />
                  </td>
                ) : null}
                {meta.columns.map((c, i) => (
                  <td key={c.key}>
                    {i === 0 ? (
                      <button className="link-button" type="button" aria-label={t('admin.table.open', { title: titleOf(r) })} onClick={() => setOpenId(r.id)}>
                        {cellText(c, r[c.key])}
                      </button>
                    ) : (
                      cellText(c, r[c.key])
                    )}
                    {i === 0 && r.deletedAt ? <span className="tag"> ({t('admin.table.deletedBadge')})</span> : null}
                  </td>
                ))}
                {meta.taggable ? (
                  <td>
                    {(r.tags ?? []).map((tag) => (
                      <TagChip key={tag.id} tag={tag} />
                    ))}
                  </td>
                ) : null}
                <td>
                  {r.deletedAt && meta.can.delete ? (
                    <button className="link-button" type="button" onClick={() => restoreOne(r.id)}>
                      {t('admin.table.restore')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="actions" aria-label={t('admin.table.pagination')}>
        <button className="btn" type="button" onClick={() => setPage(page - 1)} disabled={page <= 1}>
          {t('admin.table.prev')}
        </button>
        <span>{t('admin.table.page', { page, pages })}</span>
        <button className="btn" type="button" onClick={() => setPage(page + 1)} disabled={page >= pages}>
          {t('admin.table.next')}
        </button>
      </nav>

      {openId ? (
        <RecordPanel
          key={openId}
          meta={meta}
          prefix={prefix}
          id={openId}
          tags={tags}
          editor={editor}
          onChanged={load}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
