'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { CustomFieldEntity } from '@mt/shared';
import { api } from '@/lib/api-client';
import { type CustomFieldDef, type FormValue, type FormValues, customFieldPatch, fieldLabel, initialValues, offeredOptions } from '@/lib/custom-fields-panel';
import { enAU } from '@/lib/catalogue-panel';
import { t } from '@/lib/i18n';

/**
 * The active custom fields for one kind of record: null while loading, an empty list when there are none or when this
 * staff member may not read field definitions (the form then simply has no custom fields).
 */
export function useCustomFieldDefs(entityType: CustomFieldEntity): CustomFieldDef[] | null {
  const [defs, setDefs] = useState<CustomFieldDef[] | null>(null);
  useEffect(() => {
    let live = true;
    void api<{ items: CustomFieldDef[] }>(`/admin/custom-fields?entityType=${entityType}`).then((r) => {
      if (live) setDefs(r.status === 200 ? r.body.items : []);
    });
    return () => {
      live = false;
    };
  }, [entityType]);
  return defs;
}

/** One field per definition, labelled, with its own error text. The values are plain form state. */
export function CustomFieldInputs({ idPrefix, defs, values, onChange }: { idPrefix: string; defs: readonly CustomFieldDef[]; values: FormValues; onChange: (key: string, value: FormValue) => void }) {
  if (defs.length === 0) return null;
  return (
    <fieldset className="stack custom-fields">
      <legend>{t('admin.customFields.form.legend')}</legend>
      {defs.map((d) => {
        const id = `${idPrefix}-${d.key}`;
        const v = values[d.key];
        const text = typeof v === 'string' ? v : '';
        const label = (
          <>
            {fieldLabel(d)}
            {d.required ? <span aria-hidden="true"> *</span> : null}
          </>
        );
        if (d.type === 'multiselect') {
          const held = Array.isArray(v) ? v : [];
          return (
            <fieldset className="field" key={d.key} aria-required={d.required || undefined}>
              <legend>{label}</legend>
              {offeredOptions(d, held).map((o) => (
                <label key={o.value} className="field--check">
                  <input
                    type="checkbox"
                    checked={held.includes(o.value)}
                    onChange={(e) => onChange(d.key, e.target.checked ? [...held, o.value] : held.filter((x) => x !== o.value))}
                  />{' '}
                  {enAU(o.label) || o.value}
                </label>
              ))}
            </fieldset>
          );
        }
        let control: ReactNode;
        if (d.type === 'select' || d.type === 'boolean') {
          const options = d.type === 'boolean'
            ? [{ value: 'true', label: t('admin.customFields.form.yes') }, { value: 'false', label: t('admin.customFields.form.no') }]
            : offeredOptions(d, text).map((o) => ({ value: o.value, label: enAU(o.label) || o.value }));
          control = (
            <select id={id} value={text} required={d.required} onChange={(e) => onChange(d.key, e.target.value)}>
              <option value="">{t('admin.customFields.form.notSet')}</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        } else {
          control = (
            <input
              id={id}
              type={d.type === 'date' ? 'date' : 'text'}
              inputMode={d.type === 'number' ? 'decimal' : undefined}
              maxLength={d.type === 'text' ? (d.validation?.maxLength ?? 500) : undefined}
              required={d.required}
              value={text}
              onChange={(e) => onChange(d.key, e.target.value)}
            />
          );
        }
        return (
          <div className="field" key={d.key}>
            <label htmlFor={id}>{label}</label>
            {control}
          </div>
        );
      })}
    </fieldset>
  );
}

/**
 * Custom fields for one record form. Put `extra` in the form (the `extra` slot of EntityForm), and merge `body()` into
 * the request: `{ customFields }` with what changed, or nothing. `problem` names a field whose text could not be read.
 */
export function useCustomFieldForm(entityType: CustomFieldEntity, stored: unknown, creating: boolean, idPrefix: string) {
  const defs = useCustomFieldDefs(entityType);
  const list = useMemo(() => (defs ?? []), [defs]);
  const storedKey = JSON.stringify(stored ?? null);
  const [values, setValues] = useState<FormValues>({});
  useEffect(() => {
    setValues(initialValues(list, stored));
    // `stored` is compared by value through storedKey, so a reload with the same data does not wipe what is being typed.
  }, [list, storedKey]);

  const extra = <CustomFieldInputs idPrefix={idPrefix} defs={list} values={values} onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))} />;
  return {
    defs: list,
    extra,
    /** The body part for the request, and the first field whose text could not be read, if any. */
    body(): { body: { customFields?: Record<string, unknown> }; problem: { key: string; label: string; kind: 'number' | 'choice' } | null } {
      const { patch, invalid } = customFieldPatch(list, values, stored, creating);
      const first = list.find((d) => d.key === invalid[0]);
      return {
        body: patch ? { customFields: patch } : {},
        problem: first ? { key: first.key, label: fieldLabel(first), kind: first.type === 'number' ? 'number' : 'choice' } : null,
      };
    },
    reset: () => setValues(initialValues(list, stored)),
  };
}

/** The wording for a field whose text could not be read. */
export const problemMessage = (p: { label: string; kind: 'number' | 'choice' }): string => t(p.kind === 'number' ? 'admin.customFields.form.invalidNumber' : 'admin.customFields.form.invalidChoice', { label: p.label });
