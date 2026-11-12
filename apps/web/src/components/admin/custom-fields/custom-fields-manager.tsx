'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, type CustomFieldEntity, type CustomFieldType } from '@mt/shared';
import { api, type ApiResult } from '@/lib/api-client';
import {
  CUSTOMER_VISIBLE_ENTITIES, RULE_KEYS, type BodyResult, type CustomFieldDef, definitionBody, definitionFormValues, fieldLabel, updateDefinitionBody,
} from '@/lib/custom-fields-panel';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { ActionButton, EntityForm, type FieldDef, Section, catalogueError, outcome, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';

/** Call signatures are written as interfaces because the copy test reads an arrow followed by text and a tag as page text. */
interface BodyCall {
  (body: Record<string, unknown>): Promise<ApiResult>;
}

/** A change that would show stored values to customers: waits for a yes (with the number of records) and a fresh authenticator code. */
interface PublishAsk {
  def: CustomFieldDef;
  kind: 'enable' | 'restore';
  /** The PATCH body for `enable`. */
  body?: Record<string, unknown>;
  records: number;
}

const RULE_FIELDS: Record<string, Pick<FieldDef, 'type'>> = {
  minLength: { type: 'number' }, maxLength: { type: 'number' }, min: { type: 'text' }, max: { type: 'text' }, integer: { type: 'checkbox' },
  minDate: { type: 'date' }, maxDate: { type: 'date' }, minItems: { type: 'number' }, maxItems: { type: 'number' },
};

/** Form fields for the limits of the given types. */
function ruleFields(types: readonly CustomFieldType[]): FieldDef[] {
  const keys = [...new Set(types.flatMap((ty) => RULE_KEYS[ty]))];
  return keys.map((key) => ({ key, label: t(`admin.customFields.fields.${key}`), ...RULE_FIELDS[key]! }));
}

const needsOptions = (ty: CustomFieldType) => ty === 'select' || ty === 'multiselect';

function describeRules(d: CustomFieldDef): string {
  const rules = d.validation ?? {};
  return RULE_KEYS[d.type]
    .filter((k) => rules[k] !== undefined && rules[k] !== false)
    .map((k) => t(`admin.customFields.rules.${k}`, { value: String(rules[k]) }))
    .join(', ');
}

/** The settings page: define, change, archive and restore custom fields for each kind of record. */
export function CustomFieldsManager() {
  const [entity, setEntity] = useState<CustomFieldEntity>('Race');
  const [editing, setEditing] = useState<string | null>(null);
  const list = useLoad<{ items: CustomFieldDef[] }>(`/admin/custom-fields?entityType=${entity}&includeArchived=true`);
  const items = list.data?.items ?? [];
  const current = items.find((d) => (d.id === editing)) ?? null;
  const canShow = CUSTOMER_VISIBLE_ENTITIES.includes(entity);
  const { run: withStepUp, prompt } = useStepUp();
  const [ask, setAsk] = useState<PublishAsk | null>(null);
  const [askMessage, setAskMessage] = useState<string | null>(null);
  const run = async (build: BodyResult, call: BodyCall, message: string) => {
    if (!build.ok) return { ok: false as const, message: t(`admin.customFields.formErrors.${build.code}`) };
    const out = await outcome(() => withStepUp(() => call(build.body)), message);
    if (out.ok) void list.reload();
    return out;
  };

  /** Looks up how many records hold a value, then waits for the person to confirm. */
  const askToPublish = async (def: CustomFieldDef, kind: PublishAsk['kind'], body?: Record<string, unknown>) => {
    const usage = await api<{ records: number }>(`/admin/custom-fields/${def.id}/usage`);
    setAskMessage(null);
    setAsk({ def, kind, body, records: usage.status === 200 ? usage.body.records : -1 });
  };

  const confirmPublish = async () => {
    if (!ask) return;
    const { def, kind, body } = ask;
    const r = await withStepUp(() => (kind === 'restore' ? api(`/admin/custom-fields/${def.id}/restore`, { method: 'POST', body: { version: def.version } }) : api(`/admin/custom-fields/${def.id}`, { method: 'PATCH', body })));
    if (r.status >= 200 && r.status < 300) {
      setAsk(null);
      setAskMessage(null);
      void list.reload();
    } else setAskMessage(catalogueError(r));
  };

  return (
    <div className="stack">
      <p>
        <Link href="/admin/settings">{t('admin.customFields.backToSettings')}</Link>
      </p>
      <div className="field">
        <label htmlFor="cf-entity">{t('admin.customFields.recordType')}</label>
        <select
          id="cf-entity"
          value={entity}
          onChange={(e) => {
            setEntity(e.target.value as CustomFieldEntity);
            setEditing(null);
          }}
        >
          {CUSTOM_FIELD_ENTITIES.map((e) => (
            <option key={e} value={e}>
              {t(`admin.customFields.entities.${e}`)}
            </option>
          ))}
        </select>
      </div>

      {prompt}
      {ask ? (
        <section className="card stack" aria-labelledby="cf-publish-title">
          <h2 id="cf-publish-title">{t('admin.customFields.publish.title', { label: fieldLabel(ask.def) })}</h2>
          <p>
            {ask.records < 0
              ? t('admin.customFields.publish.countUnknown')
              : ask.records === 0
                ? t('admin.customFields.publish.countNone')
                : ask.records === 1
                  ? t('admin.customFields.publish.countOne')
                  : t('admin.customFields.publish.countMany', { count: String(ask.records) })}
          </p>
          <p>{t('admin.customFields.publish.help')}</p>
          <Status message={askMessage} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => void confirmPublish()}>
              {t('admin.customFields.publish.confirm')}
            </button>
            <button type="button" className="link-button" onClick={() => setAsk(null)}>
              {t('admin.customFields.publish.cancel')}
            </button>
          </div>
        </section>
      ) : null}

      <Section id="cf-list" title={t('admin.customFields.listTitle')}>
        <Status message={list.error} />
        {list.data ? (
          items.length === 0 ? (
            <p role="status">{t('admin.customFields.empty')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption>{t('admin.customFields.listCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.customFields.columns.label')}</th>
                    <th scope="col">{t('admin.customFields.columns.key')}</th>
                    <th scope="col">{t('admin.customFields.columns.type')}</th>
                    <th scope="col">{t('admin.customFields.columns.rules')}</th>
                    <th scope="col">{t('admin.customFields.columns.order')}</th>
                    <th scope="col">{t('admin.customFields.columns.status')}</th>
                    <th scope="col">{t('admin.customFields.columns.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((d) => (
                    <tr key={d.id}>
                      <th scope="row">{fieldLabel(d)}</th>
                      <td>
                        <code>{d.key}</code>
                      </td>
                      <td>{t(`admin.customFields.types.${d.type}`)}</td>
                      <td>
                        {[d.required ? t('admin.customFields.required') : '', d.visibleToCustomer ? t('admin.customFields.customerVisible') : '', describeRules(d)].filter(Boolean).join(', ')}
                      </td>
                      <td>{d.displayOrder}</td>
                      <td>{d.archivedAt ? t('admin.customFields.archived') : t('admin.customFields.active')}</td>
                      <td>
                        {d.archivedAt ? (
                          d.visibleToCustomer ? (
                            <button type="button" className="btn" onClick={() => void askToPublish(d, 'restore')}>
                              {t('admin.customFields.restore')}
                              <span className="visually-hidden"> {fieldLabel(d)}</span>
                            </button>
                          ) : (
                            <ActionButton text={t('admin.customFields.restore')} run={() => withStepUp(() => api(`/admin/custom-fields/${d.id}/restore`, { method: 'POST', body: { version: d.version } }))} onDone={() => void list.reload()} />
                          )
                        ) : (
                          <>
                            <button type="button" className="btn" onClick={() => setEditing(editing === d.id ? null : d.id)} aria-expanded={editing === d.id}>
                              {t('admin.customFields.edit')}
                              <span className="visually-hidden"> {fieldLabel(d)}</span>
                            </button>{' '}
                            <ActionButton danger text={t('admin.customFields.archive')} run={() => api(`/admin/custom-fields/${d.id}/archive`, { method: 'POST', body: { version: d.version } })} onDone={() => void list.reload()} />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
        <p className="field__hint">{t('admin.customFields.archiveHelp')}</p>
      </Section>

      {current && !current.archivedAt ? (
        <Section id="cf-edit" title={t('admin.customFields.editTitle', { label: fieldLabel(current) })}>
          <p>{t('admin.customFields.editHelp')}</p>
          <EntityForm
            key={`${current.id}-${current.version}`}
            id="cf-edit-form"
            fields={[
              { key: 'label', label: t('admin.customFields.fields.label'), type: 'text', required: true, maxLength: 80 },
              ...(needsOptions(current.type) ? ([{ key: 'options', label: t('admin.customFields.fields.options'), type: 'textarea', hint: t('admin.customFields.fields.optionsHint') }] as FieldDef[]) : []),
              ...ruleFields([current.type]),
              { key: 'required', label: t('admin.customFields.fields.required'), type: 'checkbox' },
              ...(canShow ? ([{ key: 'visibleToCustomer', label: t('admin.customFields.fields.visibleToCustomer'), type: 'checkbox' }] as FieldDef[]) : []),
              { key: 'displayOrder', label: t('admin.customFields.fields.displayOrder'), type: 'number', min: 0, max: 1000, hint: t('admin.customFields.fields.displayOrderHint') },
            ]}
            initial={definitionFormValues(current)}
            submit={t('admin.catalogue.common.save')}
            onSubmit={async (v) => {
              const build = updateDefinitionBody(current, v);
              if (build.ok && build.body.visibleToCustomer === true && !current.visibleToCustomer) {
                await askToPublish(current, 'enable', build.body);
                return { ok: false as const, message: t('admin.customFields.publish.confirmBelow') };
              }
              return run(build, (body) => api(`/admin/custom-fields/${current.id}`, { method: 'PATCH', body }), t('admin.customFields.saved'));
            }}
          />
        </Section>
      ) : null}

      <Section id="cf-new" title={t('admin.customFields.newTitle')}>
        <EntityForm
          key={entity}
          id="cf-new-form"
          fields={[
            { key: 'label', label: t('admin.customFields.fields.label'), type: 'text', required: true, maxLength: 80, hint: t('admin.customFields.fields.labelHint') },
            { key: 'key', label: t('admin.customFields.fields.key'), type: 'text', maxLength: 40, hint: t('admin.customFields.fields.keyHint') },
            { key: 'type', label: t('admin.customFields.fields.type'), type: 'select', options: CUSTOM_FIELD_TYPES.map((ty) => ({ value: ty, label: t(`admin.customFields.types.${ty}`) })) },
            { key: 'options', label: t('admin.customFields.fields.options'), type: 'textarea', hint: t('admin.customFields.fields.optionsHint') },
            ...ruleFields(CUSTOM_FIELD_TYPES),
            { key: 'required', label: t('admin.customFields.fields.required'), type: 'checkbox' },
            ...(canShow ? ([{ key: 'visibleToCustomer', label: t('admin.customFields.fields.visibleToCustomer'), type: 'checkbox' }] as FieldDef[]) : []),
            { key: 'displayOrder', label: t('admin.customFields.fields.displayOrder'), type: 'number', min: 0, max: 1000, hint: t('admin.customFields.fields.displayOrderHint') },
          ]}
          initial={{ label: '', key: '', type: 'text', options: '', required: false, visibleToCustomer: false, displayOrder: '0', integer: false }}
          submit={t('admin.customFields.create')}
          resetOnSuccess
          onSubmit={(v) => run(definitionBody(v, entity), (body) => api('/admin/custom-fields', { method: 'POST', body }), t('admin.customFields.created'))}
        />
      </Section>
    </div>
  );
}

