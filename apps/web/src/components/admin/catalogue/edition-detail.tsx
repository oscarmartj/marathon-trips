'use client';

import Link from 'next/link';
import { EDITION_STATUSES, POOL_KINDS } from '@mt/shared';
import { api } from '@/lib/api-client';
import { enAU, nightsBetween, slugify, wholeNumber, withEnAU } from '@/lib/catalogue-panel';
import { t } from '@/lib/i18n-admin';
import { Status } from '../../auth/field';
import { PackageCsv } from './catalogue-csv';
import { problemMessage, useCustomFieldForm } from '../custom-fields/custom-field-inputs';
import { ActionButton, type BodySubmit, EntityForm, Section, catalogueError, formatDay, outcome, useLoad } from './kit';
import { LowStockNotice } from './low-stock-notice';
import { EditionDates, EditionForm, type RaceView } from './race-detail';

interface EditionView {
  id: string;
  raceId: string;
  year: number;
  startDate: string | null;
  endDate: string | null;
  dateStatus: 'provisional' | 'confirmed';
  status: string;
  notes: unknown;
  version: number;
  packages: Array<{ id: string; slug: string; name: unknown; saleStatus: string; checkInDate: string; checkOutDate: string }>;
}
interface Pool {
  id: string;
  kind: string;
  label: string;
  capacity: number;
  remaining: number;
  lowStockThreshold: number | null;
  confirmedBySupplier: boolean;
  confirmationNote: string | null;
  lowStock: boolean;
  state: 'available' | 'low' | 'none';
  version: number;
}

const poolKindOptions = POOL_KINDS.map((k) => ({ value: k, label: t(`admin.catalogue.poolKinds.${k}`) }));

/** An edition: dates, status, stock pools and packages. */
export function EditionDetail({ id }: { id: string }) {
  const { data: edition, error, reload } = useLoad<EditionView>(`/admin/catalogue/editions/${id}`);
  const { data: race } = useLoad<RaceView>(edition ? `/admin/catalogue/races/${edition.raceId}` : null);
  const { data: pools, reload: reloadPools } = useLoad<Pool[]>(`/admin/catalogue/editions/${id}/pools`);
  const newPackageCf = useCustomFieldForm('Package', undefined, true, 'new-package-cf');
  if (!edition) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;

  return (
    <div className="stack">
      <p>
        <Link href={`/admin/races/${edition.raceId}`}>{t('admin.catalogue.editions.backToRace', { race: race ? enAU(race.name) || race.slug : '' })}</Link>
      </p>
      <h2>{t('admin.catalogue.editions.heading', { race: race ? enAU(race.name) || race.slug : '', year: edition.year })}</h2>
      {edition.dateStatus === 'provisional' ? <p className="notice" role="note">{t('admin.catalogue.editions.provisionalNotice')}</p> : null}
      <LowStockNotice editionId={id} />

      <Section id="edition-status" title={t('admin.catalogue.editions.statusTitle')}>
        <p>{t('admin.catalogue.editions.statusNow', { status: t(`admin.catalogue.editionStatuses.${edition.status}`) })}</p>
        <p>{t('admin.catalogue.editions.statusHelp')}</p>
        <div className="actions">
          {EDITION_STATUSES.filter((s) => s !== edition.status).map((s) => (
            <ActionButton key={s} text={t(`admin.catalogue.editionStatusActions.${s}`)} run={() => api(`/admin/catalogue/editions/${id}/status`, { method: 'POST', body: { status: s, version: edition.version } })} onDone={() => void reload()} />
          ))}
        </div>
      </Section>

      <Section id="edition-details" title={t('admin.catalogue.editions.detailsTitle')}>
        <p>
          <EditionDates edition={edition} />
        </p>
        <EditionForm
          key={edition.version}
          id="edition"
          initial={{ year: String(edition.year), startDate: edition.startDate ?? '', endDate: edition.endDate ?? '', dateStatus: edition.dateStatus }}
          submit={t('admin.catalogue.common.save')}
          onSubmit={async (body) => {
            const out = await outcome(() => api(`/admin/catalogue/editions/${id}`, { method: 'PATCH', body: { ...body, version: edition.version } }), t('admin.catalogue.common.saved'));
            if (out.ok) void reload();
            return out;
          }}
        />
      </Section>

      <Section id="edition-pools" title={t('admin.catalogue.pools.title')}>
        <p>{t('admin.catalogue.pools.help')}</p>
        {pools && pools.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <caption>{t('admin.catalogue.pools.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.catalogue.pools.label')}</th>
                  <th scope="col">{t('admin.catalogue.pools.kind')}</th>
                  <th scope="col">{t('admin.catalogue.pools.capacity')}</th>
                  <th scope="col">{t('admin.catalogue.pools.remaining')}</th>
                  <th scope="col">{t('admin.catalogue.pools.threshold')}</th>
                  <th scope="col">{t('admin.catalogue.pools.confirmed')}</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.label}</th>
                    <td>{t(`admin.catalogue.poolKinds.${p.kind}`)}</td>
                    <td>{p.capacity}</td>
                    <td>
                      {p.remaining} {p.state !== 'available' ? <span className="badge badge--warn">{t(p.state === 'none' ? 'admin.catalogue.pools.soldOut' : 'admin.catalogue.pools.low')}</span> : null}
                    </td>
                    <td>{p.lowStockThreshold ?? t('admin.catalogue.common.notSet')}</td>
                    <td>{p.confirmedBySupplier ? t('admin.catalogue.common.yes') : t('admin.catalogue.common.no')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>{t('admin.catalogue.pools.empty')}</p>
        )}
        {(pools ?? []).map((p) => (
          <details key={`${p.id}-${p.version}`}>
            <summary>{t('admin.catalogue.pools.edit', { label: p.label })}</summary>
            <PoolForm
              id={`pool-${p.id}`}
              initial={{ label: p.label, kind: p.kind, capacity: String(p.capacity), lowStockThreshold: p.lowStockThreshold === null ? '' : String(p.lowStockThreshold), confirmedBySupplier: p.confirmedBySupplier, confirmationNote: p.confirmationNote ?? '' }}
              submit={t('admin.catalogue.common.save')}
              editing
              onSubmit={async (body) => {
                const out = await outcome(() => api(`/admin/catalogue/pools/${p.id}`, { method: 'PATCH', body: { ...body, version: p.version } }), t('admin.catalogue.common.saved'));
                if (out.ok) void reloadPools();
                return out;
              }}
            />
          </details>
        ))}
        <h3>{t('admin.catalogue.pools.add')}</h3>
        <PoolForm
          id="new-pool"
          initial={{ label: '', kind: 'entry', capacity: '', lowStockThreshold: '', confirmedBySupplier: false, confirmationNote: '' }}
          submit={t('admin.catalogue.pools.addButton')}
          resetOnSuccess
          onSubmit={async (body) => {
            const out = await outcome(() => api(`/admin/catalogue/editions/${id}/pools`, { method: 'POST', body }), t('admin.catalogue.common.saved'));
            if (out.ok) void reloadPools();
            return out;
          }}
        />
      </Section>

      <Section id="edition-packages" title={t('admin.catalogue.packages.title')}>
        {edition.packages.length === 0 ? (
          <p>{t('admin.catalogue.packages.empty')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption>{t('admin.catalogue.packages.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.catalogue.packages.fields.name')}</th>
                  <th scope="col">{t('admin.catalogue.packages.fields.slug')}</th>
                  <th scope="col">{t('admin.catalogue.packages.columns.stay')}</th>
                  <th scope="col">{t('admin.catalogue.packages.fields.saleStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {edition.packages.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">
                      <Link href={`/admin/packages/${p.id}`}>{enAU(p.name) || p.slug}</Link>
                    </th>
                    <td>{p.slug}</td>
                    <td>{t('admin.catalogue.packages.stay', { from: formatDay(p.checkInDate), to: formatDay(p.checkOutDate), nights: nightsBetween(p.checkInDate.slice(0, 10), p.checkOutDate.slice(0, 10)) })}</td>
                    <td>{t(`admin.catalogue.saleStatuses.${p.saleStatus}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>{t('admin.catalogue.packages.add')}</h3>
        <EntityForm
          id="new-package"
          fields={[
            { key: 'name', label: t('admin.catalogue.packages.fields.name'), type: 'text', required: true, maxLength: 150 },
            { key: 'slug', label: t('admin.catalogue.packages.fields.slug'), type: 'text', maxLength: 80, hint: t('admin.catalogue.races.fields.slugHint') },
            { key: 'checkInDate', label: t('admin.catalogue.packages.fields.checkInDate'), type: 'date', required: true },
            { key: 'checkOutDate', label: t('admin.catalogue.packages.fields.checkOutDate'), type: 'date', required: true },
            { key: 'balanceDueDate', label: t('admin.catalogue.packages.fields.balanceDueDate'), type: 'date', required: true },
            { key: 'maxTravellers', label: t('admin.catalogue.packages.fields.maxTravellers'), type: 'number', required: true, min: 1, max: 50 },
          ]}
          initial={{ name: '', slug: '', checkInDate: '', checkOutDate: '', balanceDueDate: '', maxTravellers: '4' }}
          submit={t('admin.catalogue.packages.addButton')}
          extra={newPackageCf.extra}
          onSubmit={async (v) => {
            const custom = newPackageCf.body();
            if (custom.problem) return { ok: false, message: problemMessage(custom.problem) };
            const name = String(v.name).trim();
            const r = await api<{ id: string }>(`/admin/catalogue/editions/${id}/packages`, {
              method: 'POST',
              body: { ...custom.body, slug: String(v.slug).trim() || slugify(name), name: withEnAU(undefined, name), checkInDate: v.checkInDate, checkOutDate: v.checkOutDate, balanceDueDate: v.balanceDueDate, maxTravellers: wholeNumber(String(v.maxTravellers)) ?? 0 },
            });
            if (r.status === 201) {
              window.location.assign(`/admin/packages/${r.body.id}`);
              return { ok: true, message: t('admin.catalogue.common.saved') };
            }
            return { ok: false, message: catalogueError(r) };
          }}
        />
      </Section>

      <Section id="edition-csv" title={t('admin.catalogue.packages.csvTitle')}>
        <p>{t('admin.catalogue.packages.csvHelp')}</p>
        <PackageCsv editionId={id} onImported={() => void reload()} />
      </Section>
    </div>
  );
}

function PoolForm({
  id, initial, submit, editing = false, resetOnSuccess = false, onSubmit,
}: {
  id: string;
  initial: Record<string, string | boolean>;
  submit: string;
  editing?: boolean;
  resetOnSuccess?: boolean;
  onSubmit: BodySubmit;
}) {
  return (
    <EntityForm
      id={id}
      fields={[
        { key: 'label', label: t('admin.catalogue.pools.label'), type: 'text', required: true, maxLength: 120 },
        ...(editing ? [] : [{ key: 'kind', label: t('admin.catalogue.pools.kind'), type: 'select' as const, options: poolKindOptions }]),
        { key: 'capacity', label: t('admin.catalogue.pools.capacity'), type: 'number', required: true, min: 0, max: 100000 },
        { key: 'lowStockThreshold', label: t('admin.catalogue.pools.threshold'), type: 'number', min: 0, max: 100000, hint: t('admin.catalogue.pools.thresholdHint') },
        { key: 'confirmedBySupplier', label: t('admin.catalogue.pools.confirmedLabel'), type: 'checkbox', hint: t('admin.catalogue.pools.confirmedHint') },
        { key: 'confirmationNote', label: t('admin.catalogue.pools.note'), type: 'textarea', maxLength: 1000 },
      ]}
      initial={initial}
      submit={submit}
      resetOnSuccess={resetOnSuccess}
      onSubmit={(v) =>
        onSubmit({
          ...(editing ? {} : { kind: v.kind }),
          label: String(v.label).trim(),
          capacity: wholeNumber(String(v.capacity)) ?? -1,
          lowStockThreshold: wholeNumber(String(v.lowStockThreshold)) ?? null,
          confirmedBySupplier: v.confirmedBySupplier === true,
          confirmationNote: String(v.confirmationNote).trim() || null,
        })
      }
    />
  );
}
