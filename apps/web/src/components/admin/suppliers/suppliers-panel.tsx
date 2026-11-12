'use client';

import Link from 'next/link';
import { SUPPLIER_KINDS } from '@mt/shared';
import { useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { CustomFieldFilter } from '../custom-fields/custom-field-filter';
import { problemMessage, useCustomFieldDefs, useCustomFieldForm } from '../custom-fields/custom-field-inputs';
import { EntityForm, type FieldDef, Section, formatDay, outcome, useLoad } from '../catalogue/kit';

interface SupplierRow {
  id: string;
  name: string;
  kind: string;
  countryCode: string;
  defaultCurrency: string;
}
interface ReleaseRow {
  id: string;
  quantity: number;
  releaseDate: string;
  overdue: boolean;
  placesLeftToSell: number;
  contract: { reference: string; supplier: { id: string; name: string } };
  pool: { label: string };
}

export const supplierFields = (): FieldDef[] => [
  { key: 'name', label: t('admin.suppliers.fields.name'), type: 'text', required: true, maxLength: 150 },
  { key: 'kind', label: t('admin.suppliers.fields.kind'), type: 'select', required: true, options: SUPPLIER_KINDS.map((k) => ({ value: k, label: t(`admin.suppliers.kinds.${k}`) })) },
  { key: 'countryCode', label: t('admin.suppliers.fields.countryCode'), type: 'text', required: true, maxLength: 2, hint: t('admin.suppliers.fields.countryHint') },
  { key: 'defaultCurrency', label: t('admin.suppliers.fields.defaultCurrency'), type: 'text', required: true, maxLength: 3, hint: t('admin.suppliers.fields.currencyHint') },
  { key: 'paymentTerms', label: t('admin.suppliers.fields.paymentTerms'), type: 'textarea', maxLength: 1000 },
  { key: 'notes', label: t('admin.suppliers.fields.notes'), type: 'textarea', maxLength: 4000 },
];

export const supplierBody = (v: Record<string, string | boolean>) => ({
  name: String(v.name).trim(), kind: String(v.kind), countryCode: String(v.countryCode).trim().toUpperCase(), defaultCurrency: String(v.defaultCurrency).trim().toUpperCase(),
  paymentTerms: String(v.paymentTerms).trim(), notes: String(v.notes).trim(),
});

/** Suppliers: the list, the release dates coming up, and a form to add one. Amounts are shown by the detail page. */
export function SuppliersPanel() {
  const [appliedCf, setAppliedCf] = useState<string | null>(null);
  const [cfPick, setCfPick] = useState<string | null>(null);
  const cfDefs = useCustomFieldDefs('Supplier');
  const newCf = useCustomFieldForm('Supplier', undefined, true, 'new-supplier-cf');
  const list = useLoad<{ items: SupplierRow[] }>(`/admin/suppliers?${new URLSearchParams({ pageSize: '100', ...(appliedCf ? { cf: appliedCf } : {}) }).toString()}`);
  const releases = useLoad<{ items: ReleaseRow[] }>('/admin/suppliers/releases?withinDays=60');
  return (
    <div className="stack">
      <Section id="releases" title={t('admin.suppliers.releases.title')}>
        <Status message={releases.error} />
        {releases.data ? (
          releases.data.items.length === 0 ? (
            <p role="status">{t('admin.suppliers.releases.empty')}</p>
          ) : (
            <ul className="stack">
              {releases.data.items.map((r) => (
                <li key={r.id}>
                  <Link href={`/admin/suppliers/${r.contract.supplier.id}`}>{r.contract.supplier.name}</Link>
                  {': '}
                  {t('admin.suppliers.releases.line', { quantity: r.quantity, pool: r.pool.label, date: formatDay(r.releaseDate), left: r.placesLeftToSell })}
                  {r.overdue ? <span className="badge">{t('admin.suppliers.releases.overdue')}</span> : null}
                </li>
              ))}
            </ul>
          )
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
      </Section>
      <Section id="suppliers-list" title={t('admin.suppliers.listTitle')}>
        {cfDefs && cfDefs.length > 0 ? (
          <form
            className="inline-form"
            role="search"
            aria-label={t('admin.suppliers.filterLabel')}
            onSubmit={(e) => {
              e.preventDefault();
              setAppliedCf(cfPick);
            }}
          >
            <CustomFieldFilter entityType="Supplier" idPrefix="suppliers-cf" onChange={setCfPick} />
            <button className="btn" type="submit">
              {t('admin.catalogue.common.searchButton')}
            </button>
          </form>
        ) : null}
        <Status message={list.error} />
        {list.data ? (
          list.data.items.length === 0 ? (
            <p role="status">{t('admin.suppliers.empty')}</p>
          ) : (
            <ul className="stack">
              {list.data.items.map((s) => (
                <li key={s.id}>
                  <Link href={`/admin/suppliers/${s.id}`}>{s.name}</Link>
                  {' '}
                  <span>{t('admin.suppliers.summary', { kind: t(`admin.suppliers.kinds.${s.kind}`), country: s.countryCode, currency: s.defaultCurrency })}</span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
      </Section>
      <Section id="suppliers-new" title={t('admin.suppliers.newTitle')}>
        <EntityForm
          id="new-supplier"
          fields={supplierFields()}
          initial={{ name: '', kind: 'hotel', countryCode: 'AU', defaultCurrency: 'AUD', paymentTerms: '', notes: '' }}
          submit={t('admin.suppliers.create')}
          resetOnSuccess
          extra={newCf.extra}
          onSubmit={async (v) => {
            const custom = newCf.body();
            if (custom.problem) return { ok: false, message: problemMessage(custom.problem) };
            const out = await outcome(() => api('/admin/suppliers', { method: 'POST', body: { ...supplierBody(v), ...custom.body } }), t('admin.suppliers.created'));
            if (out.ok) {
              newCf.reset();
              void list.reload();
            }
            return out;
          }}
        />
      </Section>
    </div>
  );
}
