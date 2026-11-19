'use client';

import { useState } from 'react';
import { ALLOTMENT_KINDS, COST_BASES } from '@mt/shared';
import { api } from '@/lib/api-client';
import { fromMinor, formatMinor, toMinor } from '@/lib/supplier-format';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { problemMessage, useCustomFieldForm } from '../custom-fields/custom-field-inputs';
import { ActionButton, EntityForm, type FieldDef, Section, formatDay, outcome, useLoad } from '../catalogue/kit';
import { SupplierPayments } from './supplier-payments';
import { supplierBody, supplierFields } from './suppliers-panel';

interface Contact { id: string; name: string; email: string | null; phone: string | null; role: string }
interface Contract { id: string; reference: string; editionId: string | null; signedAt: string | null; validFrom: string | null; validTo: string | null; terms: string; version: number }
interface Supplier {
  id: string; name: string; kind: string; countryCode: string; defaultCurrency: string; paymentTerms: string; notes: string; version: number; isDemo: boolean; customFields?: Record<string, unknown>;
  contacts: Contact[]; contracts: Contract[];
}
interface Allotment {
  id: string; kind: string; quantity: number; releaseDate: string | null; unitCostMinor: string; currency: string; status: 'held' | 'released'; version: number;
  contract: { reference: string }; pool: { label: string; capacity: number; consumed: number };
}
interface Cost {
  id: string; description: string; basis: string; quantity: number; unitAmountMinor: string; amountMinor: string; currency: string; dueDate: string | null; status: string; version: number;
}
interface CoveragePool { poolId: string; label: string; kind: string }

const optionalDate = (v: string | boolean | undefined): string | null => (String(v).trim() ? String(v).trim() : null);

function pickContract(s: Supplier | null, id: string): Contract | undefined {
  return s?.contracts.find((c) => c.id === id) ?? s?.contracts[0];
}

/** One supplier: details, contacts, contracts, contracted allotments and cost prices. The browser only displays amounts. */
export function SupplierDetail({ id }: { id: string }) {
  const supplier = useLoad<Supplier>(`/admin/suppliers/${id}`);
  const allotments = useLoad<{ items: Allotment[]; committedCost: Array<{ currency: string; amountMinor: string }> }>(`/admin/suppliers/${id}/allotments`);
  const costs = useLoad<{ items: Cost[]; summary: Array<{ currency: string; status: string; amountMinor: string }> }>(`/admin/suppliers/${id}/costs`);
  const [contractId, setContractId] = useState('');
  const s = supplier.data;
  const cf = useCustomFieldForm('Supplier', s?.customFields, false, 'supplier-cf');
  const chosen = pickContract(s, contractId);
  const coverage = useLoad<{ items: CoveragePool[] }>(chosen?.editionId ? `/admin/suppliers/coverage?editionId=${chosen.editionId}` : null);
  const reloadAll = () => { void supplier.reload(); void allotments.reload(); void costs.reload(); };

  if (!s) return supplier.error ? <Status message={supplier.error} /> : <p role="status">{t('admin.common.loading')}</p>;
  const cur = s.defaultCurrency;

  const contactFields: FieldDef[] = [
    { key: 'name', label: t('admin.suppliers.contacts.name'), type: 'text', required: true, maxLength: 150 },
    { key: 'email', label: t('admin.suppliers.contacts.email'), type: 'text', maxLength: 200 },
    { key: 'phone', label: t('admin.suppliers.contacts.phone'), type: 'text', maxLength: 40 },
    { key: 'role', label: t('admin.suppliers.contacts.role'), type: 'text', maxLength: 100 },
  ];
  const contractFields: FieldDef[] = [
    { key: 'reference', label: t('admin.suppliers.contracts.reference'), type: 'text', required: true, maxLength: 80 },
    { key: 'editionId', label: t('admin.suppliers.contracts.editionId'), type: 'text', maxLength: 40, hint: t('admin.suppliers.contracts.editionHint') },
    { key: 'signedAt', label: t('admin.suppliers.contracts.signedAt'), type: 'date' },
    { key: 'validFrom', label: t('admin.suppliers.contracts.validFrom'), type: 'date' },
    { key: 'validTo', label: t('admin.suppliers.contracts.validTo'), type: 'date' },
    { key: 'terms', label: t('admin.suppliers.contracts.terms'), type: 'textarea', maxLength: 8000 },
  ];
  const contractBody = (v: Record<string, string | boolean>) => ({
    reference: String(v.reference).trim(), editionId: optionalDate(v.editionId), signedAt: optionalDate(v.signedAt), validFrom: optionalDate(v.validFrom), validTo: optionalDate(v.validTo), terms: String(v.terms).trim(),
  });
  const allotmentFields: FieldDef[] = [
    { key: 'poolId', label: t('admin.suppliers.allotments.pool'), type: 'select', required: true, options: [{ value: '', label: t('admin.suppliers.allotments.choosePool') }, ...(coverage.data?.items ?? []).map((p) => ({ value: p.poolId, label: t('admin.suppliers.allotments.poolOption', { kind: t(`admin.catalogue.poolKinds.${p.kind}`), label: p.label }) }))] },
    { key: 'quantity', label: t('admin.suppliers.allotments.quantity'), type: 'number', required: true, min: 1 },
    { key: 'releaseDate', label: t('admin.suppliers.allotments.releaseDate'), type: 'date' },
    { key: 'unitCost', label: t('admin.suppliers.allotments.unitCost', { currency: cur }), type: 'text', required: true, hint: t('admin.suppliers.amountHint') },
    { key: 'currency', label: t('admin.suppliers.fields.currencyShort'), type: 'text', required: true, maxLength: 3 },
  ];
  const costFields: FieldDef[] = [
    { key: 'description', label: t('admin.suppliers.costs.description'), type: 'text', required: true, maxLength: 300 },
    { key: 'basis', label: t('admin.suppliers.costs.basis'), type: 'select', required: true, options: COST_BASES.map((b) => ({ value: b, label: t(`admin.suppliers.costs.bases.${b}`) })) },
    { key: 'quantity', label: t('admin.suppliers.costs.quantity'), type: 'number', required: true, min: 1 },
    { key: 'unit', label: t('admin.suppliers.costs.unitAmount'), type: 'text', required: true, hint: t('admin.suppliers.amountHint') },
    { key: 'currency', label: t('admin.suppliers.fields.currencyShort'), type: 'text', required: true, maxLength: 3 },
    { key: 'dueDate', label: t('admin.suppliers.costs.dueDate'), type: 'date' },
    { key: 'contractId', label: t('admin.suppliers.costs.contract'), type: 'select', options: [{ value: '', label: t('admin.catalogue.common.notSet') }, ...s.contracts.map((c) => ({ value: c.id, label: c.reference }))] },
  ];
  const badAmount = { ok: false as const, message: t('admin.suppliers.errors.bad_amount') };

  return (
    <div className="stack">
      <Section id="supplier-details" title={t('admin.suppliers.detailsTitle')}>
        {s.isDemo ? <span className="badge">{t('admin.catalogue.common.demo')}</span> : null}
        <EntityForm
          id="supplier-edit"
          fields={supplierFields()}
          initial={{ name: s.name, kind: s.kind, countryCode: s.countryCode, defaultCurrency: s.defaultCurrency, paymentTerms: s.paymentTerms, notes: s.notes }}
          submit={t('admin.catalogue.common.save')}
          extra={cf.extra}
          onSubmit={async (v) => {
            const custom = cf.body();
            if (custom.problem) return { ok: false, message: problemMessage(custom.problem) };
            const out = await outcome(() => api(`/admin/suppliers/${s.id}`, { method: 'PATCH', body: { ...supplierBody(v), ...custom.body, version: s.version } }), t('admin.catalogue.common.saved'));
            if (out.ok) void supplier.reload();
            return out;
          }}
        />
        <ActionButton danger text={t('admin.suppliers.delete')} run={() => api(`/admin/suppliers/${s.id}`, { method: 'DELETE' })} onDone={() => { window.location.assign('/admin/suppliers'); }} />
      </Section>

      <Section id="supplier-contacts" title={t('admin.suppliers.contacts.title')}>
        {s.contacts.length === 0 ? <p role="status">{t('admin.suppliers.contacts.empty')}</p> : (
          <ul className="stack">
            {s.contacts.map((c) => (
              <li key={c.id} className="stack">
                <strong>{c.name}</strong> <span>{[c.role, c.email, c.phone].filter(Boolean).join(', ')}</span>
                <ActionButton danger text={t('admin.suppliers.contacts.delete', { name: c.name })} run={() => api(`/admin/suppliers/contacts/${c.id}`, { method: 'DELETE' })} onDone={() => void supplier.reload()} />
              </li>
            ))}
          </ul>
        )}
        <EntityForm
          id="new-contact" fields={contactFields} initial={{ name: '', email: '', phone: '', role: '' }} submit={t('admin.suppliers.contacts.add')} resetOnSuccess
          onSubmit={async (v) => {
            const out = await outcome(() => api(`/admin/suppliers/${s.id}/contacts`, { method: 'POST', body: { name: String(v.name).trim(), email: optionalDate(v.email), phone: optionalDate(v.phone), role: String(v.role).trim() } }), t('admin.suppliers.contacts.added'));
            if (out.ok) void supplier.reload();
            return out;
          }}
        />
      </Section>

      <Section id="supplier-contracts" title={t('admin.suppliers.contracts.title')}>
        {s.contracts.length === 0 ? <p role="status">{t('admin.suppliers.contracts.empty')}</p> : (
          <ul className="stack">
            {s.contracts.map((c) => (
              <li key={`${c.id}-${c.version}`} className="stack">
                <strong>{c.reference}</strong>{' '}
                <span>{t('admin.suppliers.contracts.dates', { from: formatDay(c.validFrom) || t('admin.catalogue.common.notSet'), to: formatDay(c.validTo) || t('admin.catalogue.common.notSet') })}</span>
                <details>
                  <summary>{t('admin.suppliers.contracts.edit', { reference: c.reference })}</summary>
                  <EntityForm
                    id={`contract-${c.id}`} fields={contractFields} submit={t('admin.catalogue.common.save')}
                    initial={{ reference: c.reference, editionId: c.editionId ?? '', signedAt: c.signedAt ?? '', validFrom: c.validFrom ?? '', validTo: c.validTo ?? '', terms: c.terms }}
                    onSubmit={async (v) => {
                      const out = await outcome(() => api(`/admin/suppliers/contracts/${c.id}`, { method: 'PATCH', body: { ...contractBody(v), version: c.version } }), t('admin.catalogue.common.saved'));
                      if (out.ok) void supplier.reload();
                      return out;
                    }}
                  />
                  <ActionButton danger text={t('admin.suppliers.contracts.delete')} run={() => api(`/admin/suppliers/contracts/${c.id}`, { method: 'DELETE' })} onDone={() => void supplier.reload()} />
                </details>
              </li>
            ))}
          </ul>
        )}
        <EntityForm
          id="new-contract" fields={contractFields} initial={{ reference: '', editionId: '', signedAt: '', validFrom: '', validTo: '', terms: '' }} submit={t('admin.suppliers.contracts.add')} resetOnSuccess
          onSubmit={async (v) => {
            const out = await outcome(() => api(`/admin/suppliers/${s.id}/contracts`, { method: 'POST', body: contractBody(v) }), t('admin.suppliers.contracts.added'));
            if (out.ok) void supplier.reload();
            return out;
          }}
        />
      </Section>

      <Section id="supplier-allotments" title={t('admin.suppliers.allotments.title')}>
        <Status message={allotments.error} />
        {allotments.data && allotments.data.items.length === 0 ? <p role="status">{t('admin.suppliers.allotments.empty')}</p> : null}
        <ul className="stack">
          {(allotments.data?.items ?? []).map((a) => (
            <li key={`${a.id}-${a.version}`} className="stack">
              <span>
                {t('admin.suppliers.allotments.line', {
                  quantity: a.quantity, kind: t(`admin.suppliers.allotments.kinds.${a.kind}`), pool: a.pool.label, contract: a.contract.reference,
                  cost: formatMinor(a.unitCostMinor, a.currency), date: a.releaseDate ? formatDay(a.releaseDate) : t('admin.suppliers.allotments.noDate'),
                })}
              </span>
              <span className="badge">{t(`admin.suppliers.allotments.status.${a.status}`)}</span>
              {a.status === 'held' ? (
                <>
                  <ActionButton text={t('admin.suppliers.allotments.release')} run={() => api(`/admin/suppliers/allotments/${a.id}/release`, { method: 'POST', body: { version: a.version } })} onDone={reloadAll} />
                  <ActionButton danger text={t('admin.suppliers.allotments.delete')} run={() => api(`/admin/suppliers/allotments/${a.id}`, { method: 'DELETE' })} onDone={reloadAll} />
                </>
              ) : null}
            </li>
          ))}
        </ul>
        {(allotments.data?.committedCost ?? []).map((c) => (
          <p key={c.currency}>{t('admin.suppliers.allotments.committed', { amount: formatMinor(c.amountMinor, c.currency) })}</p>
        ))}
        {s.contracts.length === 0 ? <p role="note">{t('admin.suppliers.allotments.needContract')}</p> : (
          <>
            <div className="field">
              <label htmlFor="allotment-contract">{t('admin.suppliers.allotments.contract')}</label>
              <select id="allotment-contract" value={chosen?.id ?? ''} onChange={(e) => setContractId(e.target.value)}>
                {s.contracts.map((c) => <option key={c.id} value={c.id}>{c.reference}</option>)}
              </select>
            </div>
            {chosen && !chosen.editionId ? <p role="note">{t('admin.suppliers.allotments.needEdition')}</p> : (
              <EntityForm
                key={chosen?.id} id="new-allotment" fields={allotmentFields} initial={{ poolId: '', quantity: '1', releaseDate: '', unitCost: '', currency: cur }} submit={t('admin.suppliers.allotments.add')} resetOnSuccess
                onSubmit={async (v) => {
                  const unit = toMinor(String(v.unitCost), String(v.currency).trim().toUpperCase());
                  if (unit === null) return badAmount;
                  const out = await outcome(() => api(`/admin/suppliers/contracts/${chosen!.id}/allotments`, { method: 'POST', body: { poolId: String(v.poolId), quantity: Number(v.quantity), releaseDate: optionalDate(v.releaseDate), unitCostMinor: unit, currency: String(v.currency).trim().toUpperCase() } }), t('admin.suppliers.allotments.added'));
                  if (out.ok) reloadAll();
                  return out;
                }}
              />
            )}
          </>
        )}
        <p className="field__hint">{t('admin.suppliers.allotments.kindsNote', { kinds: ALLOTMENT_KINDS.map((k) => t(`admin.suppliers.allotments.kinds.${k}`)).join(', ') })}</p>
      </Section>

      <Section id="supplier-costs" title={t('admin.suppliers.costs.title')}>
        <Status message={costs.error} />
        {costs.data && costs.data.items.length === 0 ? <p role="status">{t('admin.suppliers.costs.empty')}</p> : null}
        <ul className="stack">
          {(costs.data?.items ?? []).map((c) => (
            <li key={`${c.id}-${c.version}`} className="stack">
              <span>
                {t('admin.suppliers.costs.line', { description: c.description, quantity: c.quantity, unit: formatMinor(c.unitAmountMinor, c.currency), total: formatMinor(c.amountMinor, c.currency), date: c.dueDate ? formatDay(c.dueDate) : t('admin.suppliers.allotments.noDate') })}
              </span>
              <span className="badge">{t(`admin.suppliers.costs.status.${c.status}`)}</span>
              {c.status === 'planned' || c.status === 'due' ? (
                <>
                  <ActionButton text={c.status === 'planned' ? t('admin.suppliers.costs.markDue') : t('admin.suppliers.costs.markPlanned')} run={() => api(`/admin/suppliers/costs/${c.id}/status`, { method: 'POST', body: { status: c.status === 'planned' ? 'due' : 'planned', version: c.version } })} onDone={() => void costs.reload()} />
                  <ActionButton danger text={t('admin.suppliers.costs.cancel')} run={() => api(`/admin/suppliers/costs/${c.id}/status`, { method: 'POST', body: { status: 'cancelled', version: c.version } })} onDone={() => void costs.reload()} />
                  <details>
                    <summary>{t('admin.suppliers.costs.edit', { description: c.description })}</summary>
                    <EntityForm
                      id={`cost-${c.id}`} fields={costFields} submit={t('admin.catalogue.common.save')}
                      initial={{ description: c.description, basis: c.basis, quantity: String(c.quantity), unit: fromMinor(c.unitAmountMinor, c.currency), currency: c.currency, dueDate: c.dueDate ?? '', contractId: '' }}
                      onSubmit={async (v) => {
                        const unit = toMinor(String(v.unit), String(v.currency).trim().toUpperCase());
                        if (unit === null) return badAmount;
                        const out = await outcome(() => api(`/admin/suppliers/costs/${c.id}`, { method: 'PATCH', body: { description: String(v.description).trim(), basis: String(v.basis), quantity: Number(v.quantity), unitAmountMinor: unit, currency: String(v.currency).trim().toUpperCase(), dueDate: optionalDate(v.dueDate), version: c.version } }), t('admin.catalogue.common.saved'));
                        if (out.ok) void costs.reload();
                        return out;
                      }}
                    />
                  </details>
                </>
              ) : null}
            </li>
          ))}
        </ul>
        {(costs.data?.summary ?? []).map((row) => (
          <p key={`${row.currency}-${row.status}`}>{t('admin.suppliers.costs.summaryLine', { status: t(`admin.suppliers.costs.status.${row.status}`), amount: formatMinor(row.amountMinor, row.currency) })}</p>
        ))}
        <EntityForm
          id="new-cost" fields={costFields} initial={{ description: '', basis: 'per_room', quantity: '1', unit: '', currency: cur, dueDate: '', contractId: '' }} submit={t('admin.suppliers.costs.add')} resetOnSuccess
          onSubmit={async (v) => {
            const unit = toMinor(String(v.unit), String(v.currency).trim().toUpperCase());
            if (unit === null) return badAmount;
            const out = await outcome(() => api(`/admin/suppliers/${s.id}/costs`, { method: 'POST', body: { description: String(v.description).trim(), basis: String(v.basis), quantity: Number(v.quantity), unitAmountMinor: unit, currency: String(v.currency).trim().toUpperCase(), dueDate: optionalDate(v.dueDate), contractId: optionalDate(v.contractId) } }), t('admin.suppliers.costs.added'));
            if (out.ok) void costs.reload();
            return out;
          }}
        />
      </Section>

      <SupplierPayments supplierId={s.id} costs={costs.data?.items ?? []} contracts={s.contracts} onChange={() => void costs.reload()} />
    </div>
  );
}
