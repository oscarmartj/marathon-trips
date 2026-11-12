'use client';

import Link from 'next/link';
import { CLAIM_KINDS, DISTANCE_KINDS, RACE_STATUSES, type ClaimKind } from '@mt/shared';
import { api } from '@/lib/api-client';
import { enAU, withEnAU, wholeNumber } from '@/lib/catalogue';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { useStepUp } from '../step-up';
import { ActionButton, type BodySubmit, EntityForm, Section, catalogueError, formatDay, outcome, useLoad } from './kit';
import { raceBody, raceFields } from './races-panel';

interface Distance {
  id: string;
  kind: string;
  distanceMetres: number;
  name: unknown;
}
interface Claim {
  kind: string;
  enabled: boolean;
  evidenceNote: string;
}
export interface EditionRow {
  id: string;
  year: number;
  startDate: string | null;
  endDate: string | null;
  dateStatus: 'provisional' | 'confirmed';
  status: string;
}
export interface RaceView {
  id: string;
  slug: string;
  name: unknown;
  countryCode: string;
  city: string;
  timeZone: string;
  raceType: string;
  typicalMonth: number | null;
  summary: unknown;
  websiteUrl: string | null;
  status: string;
  version: number;
  isDemo: boolean;
  distances: Distance[];
  claims: Claim[];
  editions: EditionRow[];
}

const pickOptions = (keys: readonly string[], prefix: string) => keys.map((k) => ({ value: k, label: t(`${prefix}.${k}`) }));
const metres = (m: number) => t('admin.catalogue.common.km', { value: m % 1000 === 0 ? String(m / 1000) : (m / 1000).toFixed(3).replace(/0+$/, '') });

/** A race: details, status, distances, claims and editions. */
export function RaceDetail({ id }: { id: string }) {
  const { data: race, error, reload } = useLoad<RaceView>(`/admin/catalogue/races/${id}`);
  const stepUp = useStepUp();
  if (!race) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;

  const details = {
    name: enAU(race.name), slug: race.slug, countryCode: race.countryCode, city: race.city, timeZone: race.timeZone, raceType: race.raceType,
    typicalMonth: race.typicalMonth === null ? '' : String(race.typicalMonth), summary: enAU(race.summary), websiteUrl: race.websiteUrl ?? '',
  };
  const claimOf = (kind: ClaimKind) => race.claims.find((c) => (c.kind === kind));

  return (
    <div className="stack">
      <p>
        <Link href="/admin/races">{t('admin.catalogue.races.backToList')}</Link>
      </p>
      <h2>{enAU(race.name) || race.slug}</h2>
      {race.isDemo ? <p className="notice" role="note">{t('admin.catalogue.races.demoNotice')}</p> : null}

      <Section id="race-status" title={t('admin.catalogue.races.statusTitle')}>
        <p>{t('admin.catalogue.races.statusNow', { status: t(`admin.catalogue.raceStatuses.${race.status}`) })}</p>
        <p>{t('admin.catalogue.races.statusHelp')}</p>
        <div className="actions">
          {RACE_STATUSES.filter((s) => s !== race.status).map((s) => (
            <ActionButton key={s} text={t(`admin.catalogue.raceStatusActions.${s}`)} run={() => api(`/admin/catalogue/races/${id}/status`, { method: 'POST', body: { status: s, version: race.version } })} onDone={() => void reload()} />
          ))}
        </div>
      </Section>

      <Section id="race-details" title={t('admin.catalogue.races.detailsTitle')}>
        <EntityForm
          key={race.version}
          id="race"
          fields={raceFields()}
          initial={details}
          submit={t('admin.catalogue.common.save')}
          onSubmit={async (v) => {
            const out = await outcome(() => api(`/admin/catalogue/races/${id}`, { method: 'PATCH', body: { ...raceBody(v, race), version: race.version } }), t('admin.catalogue.common.saved'));
            if (out.ok) void reload();
            return out;
          }}
        />
      </Section>

      <Section id="race-distances" title={t('admin.catalogue.races.distancesTitle')}>
        {race.distances.length === 0 ? (
          <p>{t('admin.catalogue.races.noDistances')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption>{t('admin.catalogue.races.distancesCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.catalogue.races.distance.name')}</th>
                  <th scope="col">{t('admin.catalogue.races.distance.kind')}</th>
                  <th scope="col">{t('admin.catalogue.races.distance.length')}</th>
                  <th scope="col">{t('admin.catalogue.common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {race.distances.map((d) => (
                  <tr key={d.id}>
                    <th scope="row">{enAU(d.name)}</th>
                    <td>{t(`admin.catalogue.distanceKinds.${d.kind}`)}</td>
                    <td>{metres(d.distanceMetres)}</td>
                    <td>
                      <ActionButton danger text={t('admin.catalogue.common.remove')} run={() => api(`/admin/catalogue/distances/${d.id}`, { method: 'DELETE' })} onDone={() => void reload()} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>{t('admin.catalogue.races.addDistance')}</h3>
        <EntityForm
          id="distance"
          fields={[
            { key: 'name', label: t('admin.catalogue.races.distance.name'), type: 'text', required: true, maxLength: 100 },
            { key: 'kind', label: t('admin.catalogue.races.distance.kind'), type: 'select', options: pickOptions(DISTANCE_KINDS, 'admin.catalogue.distanceKinds') },
            { key: 'distanceMetres', label: t('admin.catalogue.races.distance.metres'), type: 'number', required: true, min: 1, max: 1000000 },
          ]}
          initial={{ name: '', kind: 'marathon', distanceMetres: '42195' }}
          submit={t('admin.catalogue.races.addDistanceButton')}
          resetOnSuccess
          onSubmit={async (v) => {
            const out = await outcome(() => api(`/admin/catalogue/races/${id}/distances`, { method: 'POST', body: { kind: v.kind, distanceMetres: wholeNumber(String(v.distanceMetres)) ?? 0, name: withEnAU(undefined, String(v.name)) } }), t('admin.catalogue.common.saved'));
            if (out.ok) void reload();
            return out;
          }}
        />
      </Section>

      <Section id="race-claims" title={t('admin.catalogue.races.claimsTitle')}>
        <p>{t('admin.catalogue.races.claimsHelp')}</p>
        {stepUp.prompt}
        {CLAIM_KINDS.map((kind) => {
          const c = claimOf(kind);
          return (
            <div key={`${kind}-${c?.enabled}-${c?.evidenceNote}`} className="stack">
              <h3>{t(`admin.catalogue.claimKinds.${kind}`)}</h3>
              <EntityForm
                id={`claim-${kind}`}
                fields={[
                  { key: 'enabled', label: t('admin.catalogue.races.claimOn'), type: 'checkbox' },
                  { key: 'evidenceNote', label: t('admin.catalogue.races.claimEvidence'), type: 'textarea', maxLength: 2000, hint: t('admin.catalogue.races.claimEvidenceHint') },
                ]}
                initial={{ enabled: c?.enabled ?? false, evidenceNote: c?.evidenceNote ?? '' }}
                submit={t('admin.catalogue.races.claimSave')}
                onSubmit={async (v) => {
                  const r = await stepUp.run(() => api(`/admin/catalogue/races/${id}/claims/${kind}`, { method: 'PUT', body: { enabled: v.enabled === true, evidenceNote: String(v.evidenceNote) } }));
                  if (r.status === 200) {
                    void reload();
                    return { ok: true, message: t('admin.catalogue.common.saved') };
                  }
                  return { ok: false, message: catalogueError(r) };
                }}
              />
            </div>
          );
        })}
      </Section>

      <Section id="race-editions" title={t('admin.catalogue.races.editionsTitle')}>
        {race.editions.length === 0 ? (
          <p>{t('admin.catalogue.races.noEditions')}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption>{t('admin.catalogue.races.editionsCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.catalogue.editions.year')}</th>
                  <th scope="col">{t('admin.catalogue.editions.dates')}</th>
                  <th scope="col">{t('admin.catalogue.editions.status')}</th>
                </tr>
              </thead>
              <tbody>
                {race.editions.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">
                      <Link href={`/admin/editions/${e.id}`}>{e.year}</Link>
                    </th>
                    <td>
                      <EditionDates edition={e} />
                    </td>
                    <td>{t(`admin.catalogue.editionStatuses.${e.status}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>{t('admin.catalogue.races.addEdition')}</h3>
        <EditionForm
          id="new-edition"
          initial={{ year: String(new Date().getFullYear() + 1), startDate: '', endDate: '', dateStatus: 'provisional' }}
          submit={t('admin.catalogue.races.addEditionButton')}
          showYear
          resetOnSuccess
          onSubmit={async (body) => {
            const r = await api<{ id: string }>(`/admin/catalogue/races/${id}/editions`, { method: 'POST', body });
            if (r.status === 201) {
              window.location.assign(`/admin/editions/${r.body.id}`);
              return { ok: true, message: t('admin.catalogue.common.saved') };
            }
            return { ok: false, message: catalogueError(r) };
          }}
        />
      </Section>
    </div>
  );
}

/** Dates of an edition, with a visible flag while they are provisional (phase 1 criterion). */
export function EditionDates({ edition }: { edition: Pick<EditionRow, 'startDate' | 'endDate' | 'dateStatus'> }) {
  const text = edition.startDate ? (edition.endDate && edition.endDate !== edition.startDate ? t('admin.catalogue.editions.range', { from: formatDay(edition.startDate), to: formatDay(edition.endDate) }) : formatDay(edition.startDate)) : t('admin.catalogue.editions.noDates');
  return (
    <>
      {text} <span className={edition.dateStatus === 'provisional' ? 'badge badge--warn' : 'badge'}>{t(`admin.catalogue.dateStatuses.${edition.dateStatus}`)}</span>
    </>
  );
}

/** The edition fields (year only on creation). Calls `onSubmit` with the API body. */
export function EditionForm({
  id, initial, submit, showYear = false, resetOnSuccess = false, onSubmit,
}: {
  id: string;
  initial: { year: string; startDate: string; endDate: string; dateStatus: string };
  submit: string;
  showYear?: boolean;
  resetOnSuccess?: boolean;
  onSubmit: BodySubmit;
}) {
  return (
    <EntityForm
      id={id}
      fields={[
        ...(showYear ? [{ key: 'year', label: t('admin.catalogue.editions.year'), type: 'number' as const, required: true, min: 2000, max: 2200 }] : []),
        { key: 'startDate', label: t('admin.catalogue.editions.startDate'), type: 'date' },
        { key: 'endDate', label: t('admin.catalogue.editions.endDate'), type: 'date' },
        { key: 'dateStatus', label: t('admin.catalogue.editions.dateStatus'), type: 'select', options: [{ value: 'provisional', label: t('admin.catalogue.dateStatuses.provisional') }, { value: 'confirmed', label: t('admin.catalogue.dateStatuses.confirmed') }], hint: t('admin.catalogue.editions.dateStatusHint') },
      ]}
      initial={initial}
      submit={submit}
      resetOnSuccess={resetOnSuccess}
      onSubmit={(v) =>
        onSubmit({
          ...(showYear ? { year: wholeNumber(String(v.year)) ?? 0 } : {}),
          startDate: String(v.startDate) || null,
          endDate: String(v.endDate) || null,
          dateStatus: String(v.dateStatus),
        })
      }
    />
  );
}
