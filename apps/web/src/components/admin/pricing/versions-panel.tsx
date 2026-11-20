'use client';

import Link from 'next/link';
import { useState } from 'react';
import { enAU } from '@/lib/catalogue-panel';
import { formatInstant } from '@/lib/panel-time';
import { versionPhase, type VersionList, type VersionRow } from '@/lib/pricing-panel';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Status } from '../../auth/field';
import { Section, useLoad } from '../catalogue/kit';
import { type AsyncAction, CheckField, TextField, isVersionConflict, useRunner } from './pricing-kit';
import type { PricedPackage } from './pricing-types';

/** The price versions of a package: which is in force, which are scheduled, and a form for a new draft. */
export function VersionsPanel({ packageId }: { packageId: string }) {
  const { data: pkg, error: pkgError } = useLoad<PricedPackage>(`/admin/catalogue/packages/${packageId}`);
  const { data: list, error, reload } = useLoad<VersionList>(`/admin/pricing/packages/${packageId}/price-versions`);
  const runner = useRunner();
  const [label, setLabel] = useState('');
  const [copyCurrent, setCopyCurrent] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  if (!list || !pkg) return error || pkgError ? <Status message={error ?? pkgError} /> : <p role="status">{t('admin.common.loading')}</p>;

  const now = Date.now();
  const byId = new Map(list.items.map((v) => [v.id, v]));
  const current = list.currentId ? byId.get(list.currentId) : undefined;
  const base = `/admin/packages/${packageId}/prices`;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const text = label.trim();
    if (text === '' || text.length > 100) {
      setLabelError(t('admin.pricing.versions.labelError'));
      return;
    }
    setLabelError(null);
    const body = { label: text, copyCurrent: copyCurrent && list!.currentId !== null };
    const r = await runner.run(() => (api(`/admin/pricing/packages/${packageId}/price-versions`, { method: 'POST', body })));
    if (r) window.location.assign(`${base}/${(r.body as { id: string }).id}`);
  }

  return (
    <div className="stack">
      <p>
        <Link href={`/admin/packages/${packageId}`}>{t('admin.pricing.versions.backToPackage', { name: enAU(pkg.name) || pkg.slug })}</Link>
        {' | '}
        <Link href={`/admin/pricing?packageId=${packageId}`}>{t('admin.pricing.versions.rulesLink')}</Link>
      </p>
      <h2>{enAU(pkg.name) || pkg.slug}</h2>
      {runner.prompt}

      <Section id="versions-now" title={t('admin.pricing.versions.nowTitle')}>
        {current ? (
          <p>{t('admin.pricing.versions.inForce', { label: current.label, since: formatInstant(current.validFrom) })}</p>
        ) : (
          <p className="notice" role="note">{t('admin.pricing.versions.noneInForce')}</p>
        )}
        <p>{t('admin.pricing.versions.help')}</p>
      </Section>

      <Section id="versions-list" title={t('admin.pricing.versions.listTitle')}>
        {list.items.length === 0 ? (
          <p>{t('admin.pricing.versions.empty')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption>{t('admin.pricing.versions.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.pricing.versions.columns.label')}</th>
                  <th scope="col">{t('admin.pricing.versions.columns.status')}</th>
                  <th scope="col">{t('admin.pricing.versions.columns.starts')}</th>
                  <th scope="col">{t('admin.pricing.versions.columns.ends')}</th>
                  <th scope="col">{t('admin.catalogue.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((v) => (
                  <VersionRowView key={v.id} v={v} phase={versionPhase(v, list.currentId, now)} isLast={v.id === list.lastId} base={base} runner={runner} onChanged={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {runner.status}
        {isVersionConflict(runner.failure) ? (
          <button type="button" className="link-button" onClick={() => void reload()}>
            {t('admin.pricing.common.reload')}
          </button>
        ) : null}
      </Section>

      <Section id="versions-new" title={t('admin.pricing.versions.newTitle')}>
        <p>{t('admin.pricing.versions.newHelp')}</p>
        <form className="form stack catalogue-form" onSubmit={create}>
          <p className="field__hint">{t('admin.catalogue.common.requiredNote')}</p>
          <TextField id="version-label" label={t('admin.pricing.versions.fields.label')} hint={t('admin.pricing.versions.fields.labelHint')} required maxLength={100} value={label} onChange={setLabel} error={labelError} />
          {list.currentId ? <CheckField id="version-copy" label={t('admin.pricing.versions.fields.copy', { label: current?.label ?? '' })} checked={copyCurrent} onChange={setCopyCurrent} /> : null}
          <div className="actions">
            <button className="btn" type="submit" disabled={runner.busy}>
              {t('admin.pricing.versions.create')}
            </button>
          </div>
        </form>
      </Section>
    </div>
  );
}

function VersionRowView({ v, phase, isLast, base, runner, onChanged }: { v: VersionRow; phase: ReturnType<typeof versionPhase>; isLast: boolean; base: string; runner: ReturnType<typeof useRunner>; onChanged: AsyncAction }) {
  return (
    <tr>
      <th scope="row">{v.label}</th>
      <td>{t(`admin.pricing.phases.${phase}`)}</td>
      <td>{v.validFrom ? formatInstant(v.validFrom) : t('admin.catalogue.common.notSet')}</td>
      <td>{v.validTo ? formatInstant(v.validTo) : phase === 'draft' || phase === 'archived' ? t('admin.catalogue.common.notSet') : t('admin.pricing.versions.openEnded')}</td>
      <td>
        <div className="actions">
          <Link href={`${base}/${v.id}`}>{t(phase === 'draft' ? 'admin.pricing.versions.openDraft' : 'admin.pricing.versions.view', { label: v.label })}</Link>
          {phase === 'scheduled' && isLast ? (
            <button
              type="button" className="link-button" disabled={runner.busy}
              onClick={async () => {
                const r = await runner.run(() => api(`/admin/pricing/price-versions/${v.id}/withdraw`, { method: 'POST', body: { version: v.version } }), t('admin.pricing.versions.withdrawn'));
                if (r) await onChanged();
              }}
            >
              {t('admin.pricing.versions.withdraw', { label: v.label })}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
