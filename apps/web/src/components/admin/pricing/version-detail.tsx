'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { api } from '@/lib/api-client';
import { enAU } from '@/lib/catalogue-panel';
import { formatInstant } from '@/lib/panel-time';
import { versionPhase, type VersionDetail, type VersionList } from '@/lib/pricing-panel';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { Section, useLoad } from '../catalogue/kit';
import { useRunner } from './pricing-kit';
import { PreviewPanel } from './preview-panel';
import { PublishPanel } from './publish-panel';
import { Completeness, RateEditor } from './rate-editor';
import type { PricedPackage } from './pricing-types';

/** One price version: its rates, what it lacks, a preview with the API's engine, and publishing. */
export function VersionDetailView({ packageId, versionId }: { packageId: string; versionId: string }) {
  const { data: pkg, error: pkgError } = useLoad<PricedPackage>(`/admin/catalogue/packages/${packageId}`);
  const { data: version, error, reload } = useLoad<VersionDetail>(`/admin/pricing/price-versions/${versionId}`);
  const { data: list, reload: reloadList } = useLoad<VersionList>(`/admin/pricing/packages/${packageId}/price-versions`);
  const { data: rules } = useLoad<{ items: Array<{ id: string; label: string }> }>('/admin/pricing/rules?includeArchived=true');
  const [dirty, setDirty] = useState(false);
  const runner = useRunner();
  const refresh = useCallback(async () => {
    await Promise.all([reload(), reloadList()]);
  }, [reload, reloadList]);

  if (!version || !pkg || !list) return error || pkgError ? <Status message={error ?? pkgError} /> : <p role="status">{t('admin.common.loading')}</p>;
  if (version.packageId !== packageId) return <Status message={t('admin.pricing.errors.price_version_not_found')} />;

  const phase = versionPhase(version, list.currentId, Date.now());
  const editable = phase === 'draft';
  const base = `/admin/packages/${packageId}/prices`;
  const blocked = dirty ? 'unsaved' : version.missing.length > 0 ? 'incomplete' : null;

  return (
    <div className="stack">
      <p>
        <Link href={base}>{t('admin.pricing.detail.back', { name: enAU(pkg.name) || pkg.slug })}</Link>
      </p>
      <h2>{version.label}</h2>
      <p>
        {t(`admin.pricing.detail.phase.${phase}`)}
        {version.validFrom ? ` ${t('admin.pricing.detail.starts', { when: formatInstant(version.validFrom) })}` : ''}
        {version.validTo ? ` ${t('admin.pricing.detail.ends', { when: formatInstant(version.validTo) })}` : ''}
      </p>

      {editable ? <Completeness pkg={pkg} version={version} dirty={dirty} /> : null}

      <Section id="rates" title={t('admin.pricing.detail.ratesTitle')}>
        <RateEditor key={`${version.id}-${version.version}`} pkg={pkg} version={version} editable={editable} onSaved={refresh} onDirty={setDirty} />
      </Section>

      <PreviewPanel pkg={pkg} versions={list.items} defaultVersionId={version.id} rules={rules?.items ?? []} packageId={packageId} />

      {editable ? <PublishPanel version={version} list={list} blocked={blocked} onDone={refresh} /> : null}

      {phase === 'scheduled' && version.id === list.lastId ? (
        <Section id="withdraw" title={t('admin.pricing.detail.withdrawTitle')}>
          <p>{t('admin.pricing.detail.withdrawHelp')}</p>
          {runner.prompt}
          <div className="actions">
            <button
              type="button" className="btn" disabled={runner.busy}
              onClick={async () => {
                const r = await runner.run(() => api(`/admin/pricing/price-versions/${version.id}/withdraw`, { method: 'POST', body: { version: version.version } }));
                if (r) window.location.assign(base);
              }}
            >
              {t('admin.pricing.detail.withdrawButton')}
            </button>
          </div>
          {runner.status}
        </Section>
      ) : null}

      {editable ? (
        <Section id="discard" title={t('admin.pricing.detail.discardTitle')}>
          <p>{t('admin.pricing.detail.discardHelp')}</p>
          {runner.prompt}
          <div className="actions">
            <button
              type="button" className="link-button" disabled={runner.busy}
              onClick={async () => {
                const r = await runner.run(() => api(`/admin/pricing/price-versions/${version.id}`, { method: 'DELETE' }));
                if (r) window.location.assign(base);
              }}
            >
              {t('admin.pricing.detail.discardButton')}
            </button>
          </div>
          {runner.status}
        </Section>
      ) : null}
    </div>
  );
}
