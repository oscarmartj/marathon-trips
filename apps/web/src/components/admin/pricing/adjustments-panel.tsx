'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { enAU } from '@/lib/catalogue-panel';
import { formatInstant } from '@/lib/panel-time';
import { bpsToText, formatMinor } from '@/lib/pricing-panel';
import { t } from '@/lib/i18n';
import { Section, useLoad } from '../catalogue/kit';
import { AdjustmentFormView, type Audience, type ScopeOption } from './adjustment-form';
import { isVersionConflict, useRunner } from './pricing-kit';

interface Row {
  id: string;
  version: number;
  label: string;
  kind?: string;
  direction?: string;
  code?: string;
  effectMode: string;
  valueBps: number | null;
  valueMinor: string | null;
  currency: string | null;
  per: string;
  appliesTo: string;
  enabled: boolean;
  archivedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  scopeType: string;
  editionId: string | null;
  packageId: string | null;
  priority?: number;
  maxRedemptions?: number | null;
  maxPerCustomer?: number | null;
  redeemedCount?: number;
  [key: string]: unknown;
}
interface PackageRow {
  id: string;
  name: unknown;
  slug: string;
  edition: { id: string; year: number };
  race: { name: unknown; slug: string };
}

/** What a rule or code does, in words, from the stored values. Only text is cut and joined: no amount is worked out. */
export function effectText(r: Pick<Row, 'effectMode' | 'valueBps' | 'valueMinor' | 'currency' | 'per' | 'appliesTo' | 'direction'>): string {
  const surcharge = r.direction === 'surcharge';
  const target = t(`admin.pricing.targetsShort.${r.appliesTo}`);
  if (r.effectMode === 'percent') return t(surcharge ? 'admin.pricing.effect.percentSurcharge' : 'admin.pricing.effect.percentDiscount', { value: bpsToText(r.valueBps ?? 0), target });
  return t(surcharge ? 'admin.pricing.effect.fixedSurcharge' : 'admin.pricing.effect.fixedDiscount', { amount: formatMinor(r.valueMinor ?? '0', r.currency ?? 'AUD'), target, per: t(`admin.pricing.persShort.${r.per}`) });
}

function statusOf(r: Row): 'archived' | 'enabled' | 'disabled' {
  return r.archivedAt ? 'archived' : r.enabled ? 'enabled' : 'disabled';
}

/** Price rules and promo codes: lists with their effect, scope, validity and use, and the forms to add and change them. */
export function AdjustmentsPanel({ packageId, editionId }: { packageId?: string; editionId?: string }) {
  const [scopeType, setScopeType] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const query = new URLSearchParams({ includeArchived: String(includeArchived), ...(packageId ? { packageId } : {}), ...(editionId ? { editionId } : {}) }).toString();
  const rules = useLoad<{ items: Row[] }>(`/admin/pricing/rules?${query}`);
  const codes = useLoad<{ items: Row[] }>(`/admin/pricing/promo-codes?${query}`);
  const packagesLoad = useLoad<{ items: PackageRow[] }>('/admin/catalogue/packages?page=1&pageSize=50');
  const [editing, setEditing] = useState<{ audience: Audience; id: string } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const runner = useRunner();

  const { editions, packages } = useMemo(() => {
    const pk = packagesLoad.data?.items ?? [];
    const pkgOptions: ScopeOption[] = pk.map((p) => ({ value: p.id, label: `${enAU(p.race.name) || p.race.slug} ${p.edition.year}: ${enAU(p.name) || p.slug}` }));
    const ed = new Map<string, string>();
    for (const p of pk) ed.set(p.edition.id, `${enAU(p.race.name) || p.race.slug} ${p.edition.year}`);
    return { editions: [...ed].map(([value, label]) => ({ value, label })), packages: pkgOptions };
  }, [packagesLoad.data]);
  const scopeLabel = (r: Row): string => {
    if (r.scopeType === 'global') return t('admin.pricing.scopes.globalLong');
    const list = r.scopeType === 'package' ? packages : editions;
    const id = r.packageId ?? r.editionId;
    return list.find((o) => o.value === id)?.label ?? t(`admin.pricing.scopes.${r.scopeType}Unknown`);
  };
  // The scope named in the address may be beyond the first 50 packages: it is still offered.
  const withNamed = (list: ScopeOption[], id: string | undefined, label: string) => (id && !list.some((o) => o.value === id) ? [...list, { value: id, label }] : list);
  const packageOptions = withNamed(packages, packageId, t('admin.pricing.scopes.thisPackage'));
  const editionOptions = withNamed(editions, editionId, t('admin.pricing.scopes.thisEdition'));
  const defaultScope = packageId ? { scopeType: 'package', scopeId: packageId } : editionId ? { scopeType: 'edition', scopeId: editionId } : undefined;

  const visible = (items: Row[] | undefined) => (items ?? []).filter((r) => scopeType === '' || r.scopeType === scopeType);
  const reloadAll = async () => {
    await Promise.all([rules.reload(), codes.reload()]);
  };
  // After someone else's change the form starts again from what is saved (a new key); after our own save it keeps what was typed.
  const reloadFresh = async () => {
    await reloadAll();
    setEpoch((n) => n + 1);
  };
  const edited = editing ? (editing.audience === 'rule' ? rules.data : codes.data)?.items.find((r) => r.id === editing.id) : undefined;

  async function act(audience: Audience, r: Row, what: 'toggle' | 'archive') {
    const base = audience === 'rule' ? '/admin/pricing/rules' : '/admin/pricing/promo-codes';
    const call = what === 'toggle'
      ? () => api(`${base}/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled, version: r.version } })
      : () => api(`${base}/${r.id}/archive`, { method: 'POST', body: { version: r.version } });
    const done = await runner.run(call, t(what === 'archive' ? 'admin.pricing.list.archived' : r.enabled ? 'admin.pricing.list.disabled' : 'admin.pricing.list.enabledNow'));
    if (done) {
      if (what === 'archive' && editing?.id === r.id) setEditing(null);
      await reloadAll();
    }
  }

  const table = (audience: Audience, items: Row[]) => (
    <div className="table-wrap">
      <table className="table">
        <caption>{t(`admin.pricing.list.${audience}.caption`)}</caption>
        <thead>
          <tr>
            {audience === 'promo' ? <th scope="col">{t('admin.pricing.list.columns.code')}</th> : null}
            <th scope="col">{t('admin.pricing.list.columns.label')}</th>
            <th scope="col">{t('admin.pricing.list.columns.effect')}</th>
            <th scope="col">{t('admin.pricing.list.columns.scope')}</th>
            <th scope="col">{t('admin.pricing.list.columns.validity')}</th>
            {audience === 'promo' ? <th scope="col">{t('admin.pricing.list.columns.used')}</th> : null}
            <th scope="col">{t('admin.pricing.list.columns.status')}</th>
            <th scope="col">{t('admin.catalogue.common.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const status = statusOf(r);
            const row = audience === 'promo' ? { ...r, direction: 'discount' } : r;
            return (
              <tr key={r.id}>
                {audience === 'promo' ? <th scope="row">{r.code}</th> : null}
                {audience === 'rule' ? <th scope="row">{r.label}</th> : <td>{r.label}</td>}
                <td>
                  {effectText(row)}
                  {audience === 'rule' ? <span className="field__hint"> {t(`admin.pricing.kinds.${r.kind ?? 'custom'}`)}</span> : null}
                </td>
                <td>{scopeLabel(r)}</td>
                <td>{validityText(r)}</td>
                {audience === 'promo' ? <td>{r.maxRedemptions ? t('admin.pricing.list.usedOf', { count: String(r.redeemedCount ?? 0), max: r.maxRedemptions }) : t('admin.pricing.list.used', { count: String(r.redeemedCount ?? 0) })}</td> : null}
                <td>{t(`admin.pricing.list.statuses.${status}`)}</td>
                <td>
                  {status === 'archived' ? null : (
                    <div className="actions">
                      <button type="button" className="link-button" onClick={() => setEditing({ audience, id: r.id })}>
                        {t('admin.pricing.list.edit', { label: audience === 'promo' ? (r.code ?? r.label) : r.label })}
                      </button>
                      <button type="button" className="link-button" disabled={runner.busy} onClick={() => void act(audience, r, 'toggle')}>
                        {t(r.enabled ? 'admin.pricing.list.disable' : 'admin.pricing.list.enable', { label: audience === 'promo' ? (r.code ?? r.label) : r.label })}
                      </button>
                      <button type="button" className="link-button" disabled={runner.busy} onClick={() => void act(audience, r, 'archive')}>
                        {t('admin.pricing.list.archive', { label: audience === 'promo' ? (r.code ?? r.label) : r.label })}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const list = (audience: Audience, load: typeof rules) => {
    const items = visible(load.data?.items);
    return load.data ? (items.length === 0 ? <p>{t(`admin.pricing.list.${audience}.empty`)}</p> : table(audience, items)) : load.error ? <p className="form-error" role="alert">{load.error}</p> : <p role="status">{t('admin.common.loading')}</p>;
  };

  return (
    <div className="stack">
      {packageId ? (
        <p>
          {t('admin.pricing.list.filteredPackage')} <Link href={`/admin/packages/${packageId}/prices`}>{t('admin.pricing.list.toPrices')}</Link> | <Link href="/admin/pricing">{t('admin.pricing.list.showAll')}</Link>
        </p>
      ) : null}
      {runner.prompt}

      <Section id="adjust-filters" title={t('admin.pricing.list.filtersTitle')}>
        <div className="inline-form">
          <div className="field">
            <label htmlFor="adjust-scope">{t('admin.pricing.list.scopeFilter')}</label>
            <select id="adjust-scope" value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
              <option value="">{t('admin.pricing.list.allScopes')}</option>
              {(['global', 'edition', 'package'] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`admin.pricing.scopes.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--check">
            <label htmlFor="adjust-archived">
              <input id="adjust-archived" type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> {t('admin.pricing.list.showArchived')}
            </label>
          </div>
        </div>
        {runner.status}
        {isVersionConflict(runner.failure) ? (
          <button type="button" className="link-button" onClick={() => void reloadAll()}>
            {t('admin.pricing.common.reload')}
          </button>
        ) : null}
      </Section>

      <Section id="rules-list" title={t('admin.pricing.list.rule.title')}>
        <p>{t('admin.pricing.list.rule.help')}</p>
        {list('rule', rules)}
      </Section>

      <Section id="codes-list" title={t('admin.pricing.list.promo.title')}>
        <p>{t('admin.pricing.list.promo.help')}</p>
        {list('promo', codes)}
      </Section>

      {editing && edited ? (
        <Section id="adjust-edit" title={t(`admin.pricing.form.${editing.audience}.editTitle`, { label: editing.audience === 'promo' ? (edited.code ?? edited.label) : edited.label })}>
          <AdjustmentFormView
            key={`${edited.id}-${epoch}`} audience={editing.audience} row={edited} editions={editionOptions} packages={packageOptions}
            onSaved={reloadAll} onReload={reloadFresh} onCancel={() => setEditing(null)}
          />
        </Section>
      ) : null}

      <Section id="rule-new" title={t('admin.pricing.form.rule.newTitle')}>
        <AdjustmentFormView audience="rule" editions={editionOptions} packages={packageOptions} defaultScope={defaultScope} onSaved={reloadAll} />
      </Section>

      <Section id="promo-new" title={t('admin.pricing.form.promo.newTitle')}>
        <AdjustmentFormView audience="promo" editions={editionOptions} packages={packageOptions} defaultScope={defaultScope} onSaved={reloadAll} />
      </Section>
    </div>
  );
}

function validityText(r: Row): string {
  if (!r.validFrom && !r.validTo) return t('admin.pricing.list.always');
  if (r.validFrom && r.validTo) return t('admin.pricing.list.fromTo', { from: formatInstant(r.validFrom), to: formatInstant(r.validTo) });
  return r.validFrom ? t('admin.pricing.list.from', { from: formatInstant(r.validFrom) }) : t('admin.pricing.list.until', { to: formatInstant(r.validTo) });
}
