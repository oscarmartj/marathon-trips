'use client';

import { useState } from 'react';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { type ColumnMeta, type Filter, type Meta, type QueryState, type TagView, maybe } from './shared';

interface Props {
  meta: Meta;
  prefix: string;
  query: QueryState;
  tags: TagView[];
  onChange: (q: QueryState) => void;
}

const colLabel = (prefix: string, key: string) => maybe(`${prefix}.columns.${key}`, key);

function valueLabel(prefix: string, c: ColumnMeta, f: Filter): string {
  const v = f.value;
  if (v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => maybe(`${prefix}.values.${c.key}.${x}`, String(x))).join(', ');
  if (c.type === 'boolean') return v ? t('admin.table.filters.true') : t('admin.table.filters.false');
  if (c.type === 'enum') return maybe(`${prefix}.values.${c.key}.${v}`, String(v));
  return String(v);
}

function parseValue(c: ColumnMeta, op: string, raw: string): Filter['value'] | null {
  if (op === 'empty' || op === 'notEmpty') return undefined;
  if (raw.trim() === '') return null;
  const one = (x: string) => (c.type === 'number' ? Number(x) : x.trim());
  if (op === 'in') return raw.split(',').map((x) => one(x)).filter((x) => x !== '' && !Number.isNaN(x as number));
  if (c.type === 'boolean') return raw === 'true';
  if (c.type === 'number') return Number.isNaN(Number(raw)) ? null : Number(raw);
  return raw.trim();
}

export function FiltersBar({ meta, prefix, query, tags, onChange }: Props) {
  const filterable = meta.columns.filter((c) => c.filterable);
  const [field, setField] = useState(filterable[0]?.key ?? '');
  const column = filterable.find(({ key }) => { return key === field; });
  const [op, setOp] = useState(column?.ops[0] ?? 'eq');
  const [raw, setRaw] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function pickField(key: string) {
    const c = filterable.find((x) => x.key === key)!;
    setField(key);
    setOp(c.ops[0] ?? 'eq');
    setRaw('');
  }

  function add() {
    if (!column) return;
    const value = parseValue(column, op, raw);
    if (value === null || (Array.isArray(value) && value.length === 0)) {
      setProblem(t('admin.table.errors.bad_filter_value'));
      return;
    }
    setProblem(null);
    onChange({ ...query, filters: [...query.filters, { field, op, ...(value === undefined ? {} : { value }) }] });
    setRaw('');
  }

  const needsValue = op !== 'empty' && op !== 'notEmpty';
  return (
    <fieldset className="stack">
      <legend>{t('admin.table.filters.heading')}</legend>
      <div className="inline-form">
        <div className="field">
          <label htmlFor="flt-field">{t('admin.table.filters.field')}</label>
          <select id="flt-field" value={field} onChange={(e) => pickField(e.target.value)}>
            {filterable.map((c) => (
              <option key={c.key} value={c.key}>
                {colLabel(prefix, c.key)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="flt-op">{t('admin.table.filters.op')}</label>
          <select id="flt-op" value={op} onChange={(e) => setOp(e.target.value)}>
            {(column?.ops ?? []).map((o) => (
              <option key={o} value={o}>
                {t(`admin.table.ops.${o}`)}
              </option>
            ))}
          </select>
        </div>
        {needsValue ? (
          <div className="field">
            <label htmlFor="flt-value">{t('admin.table.filters.value')}</label>
            {column?.type === 'enum' && op !== 'in' ? (
              <select id="flt-value" value={raw} onChange={(e) => setRaw(e.target.value)}>
                <option value="" />
                {(column.values ?? []).map((v) => (
                  <option key={v} value={v}>
                    {maybe(`${prefix}.values.${column.key}.${v}`, v)}
                  </option>
                ))}
              </select>
            ) : column?.type === 'boolean' ? (
              <select id="flt-value" value={raw} onChange={(e) => setRaw(e.target.value)}>
                <option value="" />
                <option value="true">{t('admin.table.filters.true')}</option>
                <option value="false">{t('admin.table.filters.false')}</option>
              </select>
            ) : (
              <input
                id="flt-value"
                type={op === 'in' ? 'text' : column?.type === 'date' ? 'date' : column?.type === 'number' ? 'number' : 'text'}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                aria-describedby={op === 'in' ? 'flt-hint' : undefined}
              />
            )}
          </div>
        ) : null}
        <button className="btn" type="button" onClick={add}>
          {t('admin.table.filters.add')}
        </button>
      </div>
      {op === 'in' ? <p id="flt-hint">{t('admin.table.filters.hintIn')}</p> : null}
      <Status message={problem} />
      {query.filters.length === 0 ? (
        <p>{t('admin.table.filters.none')}</p>
      ) : (
        <ul className="chips" aria-label={t('admin.table.filters.heading')}>
          {query.filters.map((f, i) => {
            const c = meta.columns.find((x) => x.key === f.field)!;
            const text =
              f.value === undefined
                ? t('admin.table.filters.chipNoValue', { field: colLabel(prefix, f.field), op: t(`admin.table.ops.${f.op}`) })
                : t('admin.table.filters.chip', { field: colLabel(prefix, f.field), op: t(`admin.table.ops.${f.op}`), value: valueLabel(prefix, c, f) });
            return (
              <li key={`${f.field}-${i}`} className="chip">
                {text}
                <button className="link-button" type="button" aria-label={t('admin.table.filters.remove', { label: text })} onClick={() => onChange({ ...query, filters: query.filters.filter((_, j) => j !== i) })}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="inline-form">
        {meta.softDelete && meta.can.delete ? (
          <div className="field">
            <label htmlFor="flt-deleted">{t('admin.table.filters.show')}</label>
            <select id="flt-deleted" value={query.deleted} onChange={(e) => onChange({ ...query, deleted: e.target.value as QueryState['deleted'] })}>
              <option value="exclude">{t('admin.table.filters.active')}</option>
              <option value="only">{t('admin.table.filters.onlyDeleted')}</option>
              <option value="include">{t('admin.table.filters.everything')}</option>
            </select>
          </div>
        ) : null}
      </div>
      {meta.taggable && tags.length > 0 ? (
        <fieldset>
          <legend>{t('admin.table.filters.tags')}</legend>
          {tags.map((tag) => (
            <label key={tag.id} className="check">
              <input
                type="checkbox"
                checked={query.tagIds.includes(tag.id)}
                onChange={(e) => onChange({ ...query, tagIds: e.target.checked ? [...query.tagIds, tag.id] : query.tagIds.filter((x) => x !== tag.id) })}
              />
              <span>{tag.name}</span>
            </label>
          ))}
          {query.tagIds.length > 1 ? (
            <div className="field">
              <label htmlFor="flt-tagmode">{t('admin.table.filters.tagMode')}</label>
              <select id="flt-tagmode" value={query.tagMode} onChange={(e) => onChange({ ...query, tagMode: e.target.value as 'any' | 'all' })}>
                <option value="any">{t('admin.table.filters.any')}</option>
                <option value="all">{t('admin.table.filters.all')}</option>
              </select>
            </div>
          ) : null}
        </fieldset>
      ) : null}
    </fieldset>
  );
}
