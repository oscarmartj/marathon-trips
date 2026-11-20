'use client';

import { useEffect, useState } from 'react';
import type { CustomFieldEntity } from '@mt/shared';
import { buildFilter, fieldLabel, filterOps, filterParam } from '@/lib/custom-fields-panel';
import { enAU } from '@/lib/catalogue-panel';
import { t } from '@/lib/i18n-admin';
import { useCustomFieldDefs } from './custom-field-inputs';

/** Operators the filter bar offers; "is one of" stays an API-only option. */
const shownOps = (type: Parameters<typeof filterOps>[0]) => filterOps(type).filter((o) => o !== 'in');

/**
 * A custom field filter for a list's search form. It reports the `cf` parameter to apply (or null) whenever the pick
 * changes; the list applies it when the form is submitted. Renders nothing when the record type has no custom fields.
 */
export function CustomFieldFilter({ entityType, idPrefix, onChange }: { entityType: CustomFieldEntity; idPrefix: string; onChange: (param: string | null) => void }) {
  const defs = useCustomFieldDefs(entityType);
  const [key, setKey] = useState('');
  const [op, setOp] = useState('');
  const [value, setValue] = useState('');
  const def = defs?.find((d) => d.key === key);

  useEffect(() => {
    const filter = def && op ? buildFilter(def, op, value) : null;
    onChange(filter ? filterParam([filter]) : null);
  }, [def, op, value, onChange]);

  if (!defs || defs.length === 0) return null;
  const ops = def ? shownOps(def.type) : [];
  const choices = def?.type === 'boolean'
    ? [{ value: 'true', label: t('admin.customFields.form.yes') }, { value: 'false', label: t('admin.customFields.form.no') }]
    : def && (def.type === 'select' || def.type === 'multiselect')
      ? (def.options ?? []).map((o) => ({ value: o.value, label: enAU(o.label) || o.value }))
      : null;

  return (
    <fieldset className="inline-form custom-fields">
      <legend>{t('admin.customFields.filter.legend')}</legend>
      <div className="field">
        <label htmlFor={`${idPrefix}-field`}>{t('admin.customFields.filter.field')}</label>
        <select
          id={`${idPrefix}-field`}
          value={key}
          onChange={(e) => {
            const next = defs.find((d) => d.key === e.target.value);
            setKey(e.target.value);
            setOp(next ? (shownOps(next.type)[0] ?? '') : '');
            setValue('');
          }}
        >
          <option value="">{t('admin.customFields.filter.none')}</option>
          {defs.map((d) => (
            <option key={d.key} value={d.key}>
              {fieldLabel(d)}
            </option>
          ))}
        </select>
      </div>
      {def ? (
        <>
          <div className="field">
            <label htmlFor={`${idPrefix}-op`}>{t('admin.customFields.filter.operator')}</label>
            <select id={`${idPrefix}-op`} value={op} onChange={(e) => setOp(e.target.value)}>
              {ops.map((o) => (
                <option key={o} value={o}>
                  {t(`admin.customFields.ops.${o}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${idPrefix}-value`}>{t('admin.customFields.filter.value')}</label>
            {choices ? (
              <select id={`${idPrefix}-value`} value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">{t('admin.customFields.form.notSet')}</option>
                {choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            ) : (
              <input id={`${idPrefix}-value`} type={def.type === 'date' ? 'date' : 'text'} inputMode={def.type === 'number' ? 'decimal' : undefined} value={value} onChange={(e) => setValue(e.target.value)} />
            )}
          </div>
        </>
      ) : null}
    </fieldset>
  );
}
