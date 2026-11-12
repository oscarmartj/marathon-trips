'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RACE_STATUSES, RACE_TYPES } from '@mt/shared';
import { api } from '@/lib/api-client';
import { enAU, slugify, wholeNumber, withEnAU } from '@/lib/catalogue-panel';
import { t } from '@/lib/i18n';
import { RaceCsv } from './catalogue-csv';
import { CustomFieldFilter } from '../custom-fields/custom-field-filter';
import { problemMessage, useCustomFieldForm } from '../custom-fields/custom-field-inputs';
import { EntityForm, type FieldDef, Section, catalogueError, useLoad } from './kit';
import { LowStockNotice } from './low-stock-notice';
import { Status } from '../../auth/field';

interface RaceRow {
  id: string;
  slug: string;
  name: unknown;
  city: string;
  countryCode: string;
  status: string;
  editionCount: number;
  isDemo: boolean;
}
interface Page {
  items: RaceRow[];
  page: number;
  pageSize: number;
  total: number;
}

const PAGE_SIZE = 20;
const options = (keys: readonly string[], prefix: string) => keys.map((k) => ({ value: k, label: t(`${prefix}.${k}`) }));

/** The fields of a race form, shared by the new race form here and the details form on the race page. */
export function raceFields(): FieldDef[] {
  return [
    { key: 'name', label: t('admin.catalogue.races.fields.name'), type: 'text', required: true, maxLength: 150 },
    { key: 'slug', label: t('admin.catalogue.races.fields.slug'), type: 'text', maxLength: 80, hint: t('admin.catalogue.races.fields.slugHint') },
    { key: 'countryCode', label: t('admin.catalogue.races.fields.countryCode'), type: 'text', required: true, maxLength: 2, hint: t('admin.catalogue.races.fields.countryHint') },
    { key: 'city', label: t('admin.catalogue.races.fields.city'), type: 'text', required: true, maxLength: 100 },
    { key: 'timeZone', label: t('admin.catalogue.races.fields.timeZone'), type: 'text', required: true, maxLength: 60, hint: t('admin.catalogue.races.fields.timeZoneHint') },
    { key: 'raceType', label: t('admin.catalogue.races.fields.raceType'), type: 'select', options: options(RACE_TYPES, 'admin.catalogue.raceTypes') },
    {
      key: 'typicalMonth', label: t('admin.catalogue.races.fields.typicalMonth'), type: 'select',
      options: [{ value: '', label: t('admin.catalogue.common.notSet') }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: t(`admin.catalogue.months.m${i + 1}`) }))],
    },
    { key: 'summary', label: t('admin.catalogue.races.fields.summary'), type: 'textarea', required: true, maxLength: 2000 },
    { key: 'websiteUrl', label: t('admin.catalogue.races.fields.websiteUrl'), type: 'text', maxLength: 300, hint: t('admin.catalogue.races.fields.websiteHint') },
  ];
}

/** The API body for a race form. Languages other than en-AU already on the record are kept. */
export function raceBody(v: Record<string, string | boolean>, previous?: { name?: unknown; summary?: unknown }) {
  const name = String(v.name ?? '').trim();
  return {
    slug: String(v.slug ?? '').trim() || slugify(name),
    name: withEnAU(previous?.name, name),
    countryCode: String(v.countryCode ?? '').trim().toUpperCase(),
    city: String(v.city ?? '').trim(),
    timeZone: String(v.timeZone ?? '').trim(),
    raceType: String(v.raceType),
    typicalMonth: wholeNumber(String(v.typicalMonth ?? '')) ?? null,
    summary: withEnAU(previous?.summary, String(v.summary ?? '')),
    websiteUrl: String(v.websiteUrl ?? '').trim() || null,
  };
}

export const newRaceValues = { name: '', slug: '', countryCode: 'AU', city: '', timeZone: 'Australia/Brisbane', raceType: 'road', typicalMonth: '', summary: '', websiteUrl: '' };

/** Confirmed alert subscribers per race id, or null when the staff member may not see them. */
function useSubscriberCounts(): Map<string, number> | null {
  const [counts, setCounts] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    api<{ items: Array<{ raceId: string; confirmed: number }> }>('/admin/alerts/subscribers').then((r) => {
      if (r.status === 200) setCounts(new Map(r.body.items.map((i) => [i.raceId, i.confirmed])));
    });
  }, []);
  return counts;
}

/** Races list: search, filter by status, create, CSV and the low-stock warning. */
export function RacesPanel() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState<{ q: string; status: string; cf: string | null }>({ q: '', status: '', cf: null });
  const [status, setStatus] = useState('');
  const [cfPick, setCfPick] = useState<string | null>(null);
  const newCf = useCustomFieldForm('Race', undefined, true, 'new-race-cf');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...(applied.q ? { q: applied.q } : {}), ...(applied.status ? { status: applied.status } : {}), ...(applied.cf ? { cf: applied.cf } : {}) });
  const { data, error, reload } = useLoad<Page>(`/admin/catalogue/races?${params.toString()}`);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  // Subscriber counts need their own permission: without it the column is left out rather than showing an error.
  const subscribers = useSubscriberCounts();

  return (
    <div className="stack">
      <LowStockNotice />
      <Section id="races-list" title={t('admin.catalogue.races.listTitle')}>
        <form
          className="inline-form"
          role="search"
          aria-label={t('admin.catalogue.races.searchLabel')}
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ q: q.trim(), status, cf: cfPick });
            setPage(1);
          }}
        >
          <div className="field">
            <label htmlFor="races-q">{t('admin.catalogue.common.search')}</label>
            <input id="races-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="races-status">{t('admin.catalogue.races.fields.status')}</label>
            <select id="races-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('admin.catalogue.common.anyStatus')}</option>
              {RACE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`admin.catalogue.raceStatuses.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <CustomFieldFilter entityType="Race" idPrefix="races-cf" onChange={setCfPick} />
          <button className="btn" type="submit">
            {t('admin.catalogue.common.searchButton')}
          </button>
        </form>
        <Status message={error} />
        {data ? (
          data.items.length === 0 ? (
            <p role="status">{t('admin.catalogue.races.empty')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption>{t('admin.catalogue.races.caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.catalogue.races.fields.name')}</th>
                    <th scope="col">{t('admin.catalogue.races.fields.slug')}</th>
                    <th scope="col">{t('admin.catalogue.races.columns.location')}</th>
                    <th scope="col">{t('admin.catalogue.races.fields.status')}</th>
                    <th scope="col">{t('admin.catalogue.races.columns.editions')}</th>
                    {subscribers ? <th scope="col" title={t('admin.catalogue.races.columns.alertsHint')}>{t('admin.catalogue.races.columns.alerts')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">
                        <Link href={`/admin/races/${r.id}`}>{enAU(r.name) || r.slug}</Link>
                        {r.isDemo ? <> <span className="badge">{t('admin.catalogue.common.demo')}</span></> : null}
                      </th>
                      <td>{r.slug}</td>
                      <td>{r.city}, {r.countryCode}</td>
                      <td>{t(`admin.catalogue.raceStatuses.${r.status}`)}</td>
                      <td>{r.editionCount}</td>
                      {subscribers ? <td>{subscribers.get(r.id) ?? 0}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
        <nav className="actions" aria-label={t('admin.catalogue.common.pagination')}>
          <button className="btn" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {t('admin.catalogue.common.previous')}
          </button>
          <span role="status">{t('admin.catalogue.common.pageOf', { page, pages })}</span>
          <button className="btn" type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {t('admin.catalogue.common.next')}
          </button>
        </nav>
      </Section>

      <Section id="races-new" title={t('admin.catalogue.races.newTitle')}>
        <EntityForm
          id="new-race"
          fields={raceFields()}
          initial={newRaceValues}
          submit={t('admin.catalogue.races.create')}
          extra={newCf.extra}
          onSubmit={async (v) => {
            const custom = newCf.body();
            if (custom.problem) return { ok: false, message: problemMessage(custom.problem) };
            const r = await api<{ id: string }>('/admin/catalogue/races', { method: 'POST', body: { ...raceBody(v), ...custom.body } });
            if (r.status === 201) {
              window.location.assign(`/admin/races/${r.body.id}`);
              return { ok: true, message: t('admin.catalogue.races.created') };
            }
            return { ok: false, message: catalogueError(r) };
          }}
        />
      </Section>

      <Section id="races-csv" title={t('admin.catalogue.races.csvTitle')}>
        <p>{t('admin.catalogue.races.csvHelp')}</p>
        <RaceCsv onImported={() => void reload()} />
      </Section>
    </div>
  );
}

