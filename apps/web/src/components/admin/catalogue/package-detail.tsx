'use client';

import Link from 'next/link';
import { EXTRA_KINDS, PARTICIPATION_TYPES, ROOM_TYPES, SALE_STATUSES } from '@mt/shared';
import { api } from '@/lib/api-client';
import { bpsToPercent, dollarsToMinor, enAU, minorToDollars, percentToBps, slugify, wholeNumber, withEnAU, withOptionalEnAU } from '@/lib/catalogue-panel';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { ActionButton, type ApiCall, EntityForm, type Outcome, Section, catalogueError, outcome, useLoad } from './kit';
import type { RaceView } from './race-detail';

type Deposit = { mode: 'per_person' | 'per_booking'; amountMinor: string } | { mode: 'percent'; bps: number } | null;
interface PoolRef {
  id: string;
  label: string;
}
interface PackageView {
  id: string;
  editionId: string;
  slug: string;
  name: unknown;
  saleStatus: string;
  checkInDate: string;
  checkOutDate: string;
  balanceDueDate: string;
  includes: unknown;
  excludes: unknown;
  instantBooking: boolean;
  autoConfirmOnDeposit: boolean;
  deposit: Deposit;
  minTravellers: number;
  maxTravellers: number;
  maxExtraNightsBefore: number;
  maxExtraNightsAfter: number;
  currency: string;
  version: number;
  edition: { id: string; year: number; raceId: string; race: { id: string; slug: string; isDemo: boolean; status: string } };
  participationOptions: Array<{ type: string; enabled: boolean }>;
  entryOptions: Array<{ id: string; raceDistance: { id: string; name: unknown }; entryPool: PoolRef }>;
  hotels: Array<{
    id: string;
    hotel: { id: string; name: string; city: string };
    rooms: Array<{ id: string; roomType: string; name: unknown; minOccupancy: number; maxOccupancy: number; roomPool: PoolRef }>;
  }>;
  extras: Array<{ id: string; kind: string; name: unknown; pricingUnit: string; availableTo: string; mandatory: boolean; maxPerBooking: number | null; pool: PoolRef | null }>;
}
interface PoolView extends PoolRef {
  kind: string;
}
const pick = (keys: readonly string[], prefix: string) => keys.map((k) => ({ value: k, label: t(`${prefix}.${k}`) }));
const poolOptions = (pools: PoolView[] | null, kind: string, none?: string) => [
  ...(none ? [{ value: '', label: none }] : []),
  ...(pools ?? []).filter((p) => p.kind === kind).map((p) => ({ value: p.id, label: p.label })),
];

/** A package: details, deposit, sale status, participation, entries, hotels and rooms, extras, and copying it to another edition. */
export function PackageDetail({ id }: { id: string }) {
  const { data: pkg, error, reload } = useLoad<PackageView>(`/admin/catalogue/packages/${id}`);
  const { data: race } = useLoad<RaceView>(pkg ? `/admin/catalogue/races/${pkg.edition.raceId}` : null);
  const { data: pools, reload: reloadPools } = useLoad<PoolView[]>(pkg ? `/admin/catalogue/editions/${pkg.editionId}/pools` : null);
  const { data: hotels } = useLoad<Array<{ id: string; name: string; city: string }>>(pkg ? '/admin/catalogue/hotels' : null);
  if (!pkg) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;

  const base = `/admin/catalogue/packages/${id}`;
  const done = () => {
    void reload();
    void reloadPools();
  };
  const save = async (call: ApiCall, okText = t('admin.catalogue.common.saved')): Promise<Outcome> => {
    const o = await outcome(call, okText);
    if (o.ok) done();
    return o;
  };
  const participation = new Set(pkg.participationOptions.filter((o) => o.enabled).map((o) => o.type));
  const otherEditions = (race?.editions ?? []).filter((e) => (e.id !== pkg.editionId));
  const raceName = race ? enAU(race.name) || race.slug : '';

  return (
    <div className="stack">
      <p>
        <Link href={`/admin/editions/${pkg.editionId}`}>{t('admin.catalogue.packages.backToEdition', { race: raceName, year: pkg.edition.year })}</Link>
        {' | '}
        <Link href={`/admin/packages/${id}/preview`}>{t('admin.catalogue.packages.previewLink')}</Link>
      </p>
      <h2>{enAU(pkg.name) || pkg.slug}</h2>
      {pkg.edition.race.isDemo ? <p className="notice" role="note">{t('admin.catalogue.races.demoNotice')}</p> : null}

      <Section id="package-sale" title={t('admin.catalogue.packages.saleTitle')}>
        <p>{t('admin.catalogue.packages.saleNow', { status: t(`admin.catalogue.saleStatuses.${pkg.saleStatus}`) })}</p>
        <p>{t('admin.catalogue.packages.saleHelp')}</p>
        <div className="actions">
          {SALE_STATUSES.filter((s) => s !== pkg.saleStatus).map((s) => (
            <ActionButton key={s} text={t(`admin.catalogue.saleStatusActions.${s}`)} run={() => api(`${base}/sale-status`, { method: 'POST', body: { status: s, version: pkg.version } })} onDone={done} />
          ))}
        </div>
      </Section>

      <Section id="package-details" title={t('admin.catalogue.packages.detailsTitle')}>
        <EntityForm
          key={pkg.version}
          id="package"
          fields={[
            { key: 'name', label: t('admin.catalogue.packages.fields.name'), type: 'text', required: true, maxLength: 150 },
            { key: 'slug', label: t('admin.catalogue.packages.fields.slug'), type: 'text', required: true, maxLength: 80 },
            { key: 'checkInDate', label: t('admin.catalogue.packages.fields.checkInDate'), type: 'date', required: true },
            { key: 'checkOutDate', label: t('admin.catalogue.packages.fields.checkOutDate'), type: 'date', required: true },
            { key: 'balanceDueDate', label: t('admin.catalogue.packages.fields.balanceDueDate'), type: 'date', required: true },
            { key: 'minTravellers', label: t('admin.catalogue.packages.fields.minTravellers'), type: 'number', required: true, min: 1, max: 50 },
            { key: 'maxTravellers', label: t('admin.catalogue.packages.fields.maxTravellers'), type: 'number', required: true, min: 1, max: 50 },
            { key: 'maxExtraNightsBefore', label: t('admin.catalogue.packages.fields.maxExtraNightsBefore'), type: 'number', required: true, min: 0, max: 30 },
            { key: 'maxExtraNightsAfter', label: t('admin.catalogue.packages.fields.maxExtraNightsAfter'), type: 'number', required: true, min: 0, max: 30 },
            { key: 'instantBooking', label: t('admin.catalogue.packages.fields.instantBooking'), type: 'checkbox' },
            { key: 'autoConfirmOnDeposit', label: t('admin.catalogue.packages.fields.autoConfirmOnDeposit'), type: 'checkbox' },
            { key: 'includes', label: t('admin.catalogue.packages.fields.includes'), type: 'textarea', maxLength: 5000 },
            { key: 'excludes', label: t('admin.catalogue.packages.fields.excludes'), type: 'textarea', maxLength: 5000 },
          ]}
          initial={{
            name: enAU(pkg.name), slug: pkg.slug, checkInDate: pkg.checkInDate, checkOutDate: pkg.checkOutDate, balanceDueDate: pkg.balanceDueDate,
            minTravellers: String(pkg.minTravellers), maxTravellers: String(pkg.maxTravellers), maxExtraNightsBefore: String(pkg.maxExtraNightsBefore), maxExtraNightsAfter: String(pkg.maxExtraNightsAfter),
            instantBooking: pkg.instantBooking, autoConfirmOnDeposit: pkg.autoConfirmOnDeposit, includes: enAU(pkg.includes), excludes: enAU(pkg.excludes),
          }}
          submit={t('admin.catalogue.common.save')}
          onSubmit={(v) =>
            save(() =>
              api(base, {
                method: 'PATCH',
                body: {
                  name: withEnAU(pkg.name, String(v.name)), slug: String(v.slug).trim(), checkInDate: v.checkInDate, checkOutDate: v.checkOutDate, balanceDueDate: v.balanceDueDate,
                  minTravellers: wholeNumber(String(v.minTravellers)) ?? 0, maxTravellers: wholeNumber(String(v.maxTravellers)) ?? 0,
                  maxExtraNightsBefore: wholeNumber(String(v.maxExtraNightsBefore)) ?? -1, maxExtraNightsAfter: wholeNumber(String(v.maxExtraNightsAfter)) ?? -1,
                  instantBooking: v.instantBooking === true, autoConfirmOnDeposit: v.autoConfirmOnDeposit === true,
                  includes: withOptionalEnAU(pkg.includes, String(v.includes)), excludes: withOptionalEnAU(pkg.excludes, String(v.excludes)), version: pkg.version,
                },
              }),
            )
          }
        />
      </Section>

      <DepositSection pkg={pkg} onSave={(deposit) => save(() => api(base, { method: 'PATCH', body: { deposit, version: pkg.version } }))} />

      <Section id="package-participation" title={t('admin.catalogue.packages.participationTitle')}>
        <EntityForm
          key={[...participation].sort().join(',')}
          id="participation"
          fields={PARTICIPATION_TYPES.map((p) => ({ key: p, label: t(`admin.catalogue.participation.${p}`), type: 'checkbox' as const }))}
          initial={Object.fromEntries(PARTICIPATION_TYPES.map((p) => [p, participation.has(p)]))}
          submit={t('admin.catalogue.common.save')}
          onSubmit={(v) => save(() => api(`${base}/participation`, { method: 'PUT', body: { types: PARTICIPATION_TYPES.filter((p) => v[p] === true) } }))}
        />
      </Section>

      <Section id="package-entries" title={t('admin.catalogue.packages.entriesTitle')}>
        <p>{t('admin.catalogue.packages.entriesHelp')}</p>
        <ul>
          {pkg.entryOptions.map((o) => (
            <li key={o.id}>
              {t('admin.catalogue.packages.entryLine', { distance: enAU(o.raceDistance.name), pool: o.entryPool.label })}{' '}
              <ActionButton danger text={t('admin.catalogue.common.remove')} run={() => api(`${base}/entry-options/${o.id}`, { method: 'DELETE' })} onDone={done} />
            </li>
          ))}
        </ul>
        <EntityForm
          id="entry"
          fields={[
            { key: 'raceDistanceId', label: t('admin.catalogue.packages.entryDistance'), type: 'select', options: (race?.distances ?? []).map((d) => ({ value: d.id, label: enAU(d.name) })), required: true },
            { key: 'entryPoolId', label: t('admin.catalogue.packages.entryPool'), type: 'select', options: poolOptions(pools, 'entry'), required: true },
          ]}
          initial={{ raceDistanceId: race?.distances[0]?.id ?? '', entryPoolId: poolOptions(pools, 'entry')[0]?.value ?? '' }}
          key={`entry-${race?.distances.length}-${pools?.length}`}
          submit={t('admin.catalogue.packages.entryAdd')}
          onSubmit={(v) => save(() => api(`${base}/entry-options`, { method: 'POST', body: { raceDistanceId: v.raceDistanceId, entryPoolId: v.entryPoolId } }))}
        />
      </Section>

      <Section id="package-hotels" title={t('admin.catalogue.packages.hotelsTitle')}>
        {pkg.hotels.map((h) => (
          <div key={h.id} className="stack">
            <h3>
              {h.hotel.name} <span>({h.hotel.city})</span>
            </h3>
            {h.rooms.length > 0 ? (
              <ul>
                {h.rooms.map((r) => (
                  <li key={r.id}>
                    {t('admin.catalogue.packages.roomLine', { name: enAU(r.name), type: t(`admin.catalogue.roomTypes.${r.roomType}`), min: r.minOccupancy, max: r.maxOccupancy, pool: r.roomPool.label })}{' '}
                    <ActionButton danger text={t('admin.catalogue.common.remove')} run={() => api(`${base}/rooms/${r.id}`, { method: 'DELETE' })} onDone={done} />
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('admin.catalogue.packages.noRooms')}</p>
            )}
            <details>
              <summary>{t('admin.catalogue.packages.addRoom', { hotel: h.hotel.name })}</summary>
              <EntityForm
                key={`room-${h.id}-${pools?.length}`}
                id={`room-${h.id}`}
                fields={[
                  { key: 'name', label: t('admin.catalogue.packages.roomName'), type: 'text', required: true, maxLength: 100 },
                  { key: 'roomType', label: t('admin.catalogue.packages.roomType'), type: 'select', options: pick(ROOM_TYPES, 'admin.catalogue.roomTypes') },
                  { key: 'minOccupancy', label: t('admin.catalogue.packages.minOccupancy'), type: 'number', required: true, min: 1, max: 4 },
                  { key: 'maxOccupancy', label: t('admin.catalogue.packages.maxOccupancy'), type: 'number', required: true, min: 1, max: 4 },
                  { key: 'roomPoolId', label: t('admin.catalogue.packages.roomPool'), type: 'select', options: poolOptions(pools, 'room'), required: true },
                ]}
                initial={{ name: '', roomType: 'double', minOccupancy: '1', maxOccupancy: '2', roomPoolId: poolOptions(pools, 'room')[0]?.value ?? '' }}
                submit={t('admin.catalogue.packages.addRoomButton')}
                resetOnSuccess
                onSubmit={(v) =>
                  save(() => api(`${base}/hotels/${h.id}/rooms`, { method: 'POST', body: { name: withEnAU(undefined, String(v.name)), roomType: v.roomType, minOccupancy: wholeNumber(String(v.minOccupancy)) ?? 0, maxOccupancy: wholeNumber(String(v.maxOccupancy)) ?? 0, roomPoolId: v.roomPoolId } }))
                }
              />
            </details>
            {h.rooms.length === 0 ? <ActionButton danger text={t('admin.catalogue.packages.unlinkHotel')} run={() => api(`${base}/hotels/${h.id}`, { method: 'DELETE' })} onDone={done} /> : null}
          </div>
        ))}
        <h3>{t('admin.catalogue.packages.linkHotel')}</h3>
        <p>
          {t('admin.catalogue.packages.linkHotelHelp')} <Link href="/admin/hotels">{t('admin.catalogue.packages.manageHotels')}</Link>
        </p>
        <EntityForm
          key={`hotel-${hotels?.length}-${pkg.hotels.length}`}
          id="link-hotel"
          fields={[{ key: 'hotelId', label: t('admin.catalogue.packages.hotel'), type: 'select', required: true, options: (hotels ?? []).filter((h) => !pkg.hotels.some((x) => x.hotel.id === h.id)).map((h) => ({ value: h.id, label: `${h.name} (${h.city})` })) }]}
          initial={{ hotelId: (hotels ?? []).find((h) => !pkg.hotels.some((x) => x.hotel.id === h.id))?.id ?? '' }}
          submit={t('admin.catalogue.packages.linkHotelButton')}
          onSubmit={(v) => save(() => api(`${base}/hotels`, { method: 'POST', body: { hotelId: v.hotelId } }))}
        />
      </Section>

      <Section id="package-extras" title={t('admin.catalogue.packages.extrasTitle')}>
        {pkg.extras.length === 0 ? (
          <p>{t('admin.catalogue.packages.noExtras')}</p>
        ) : (
          <ul>
            {pkg.extras.map((x) => (
              <li key={x.id}>
                {t('admin.catalogue.packages.extraLine', { name: enAU(x.name), kind: t(`admin.catalogue.extraKinds.${x.kind}`), unit: t(`admin.catalogue.pricingUnits.${x.pricingUnit}`), audience: t(`admin.catalogue.audiences.${x.availableTo}`) })}
                {x.mandatory ? ` ${t('admin.catalogue.packages.mandatoryTag')}` : ''}{' '}
                <ActionButton danger text={t('admin.catalogue.common.remove')} run={() => api(`${base}/extras/${x.id}`, { method: 'DELETE' })} onDone={done} />
              </li>
            ))}
          </ul>
        )}
        <h3>{t('admin.catalogue.packages.addExtra')}</h3>
        <EntityForm
          key={`extra-${pools?.length}`}
          id="extra"
          fields={[
            { key: 'name', label: t('admin.catalogue.packages.extraName'), type: 'text', required: true, maxLength: 150 },
            { key: 'kind', label: t('admin.catalogue.packages.extraKind'), type: 'select', options: pick(EXTRA_KINDS, 'admin.catalogue.extraKinds') },
            { key: 'pricingUnit', label: t('admin.catalogue.packages.pricingUnit'), type: 'select', options: pick(['per_person', 'per_booking'], 'admin.catalogue.pricingUnits') },
            { key: 'availableTo', label: t('admin.catalogue.packages.availableTo'), type: 'select', options: pick(['all', 'runners', 'supporters'], 'admin.catalogue.audiences') },
            { key: 'mandatory', label: t('admin.catalogue.packages.mandatory'), type: 'checkbox', hint: t('admin.catalogue.packages.mandatoryHint') },
            { key: 'maxPerBooking', label: t('admin.catalogue.packages.maxPerBooking'), type: 'number', min: 1, max: 100 },
            { key: 'poolId', label: t('admin.catalogue.packages.extraPool'), type: 'select', options: poolOptions(pools, 'extra', t('admin.catalogue.packages.noStockLimit')) },
          ]}
          initial={{ name: '', kind: 'excursion', pricingUnit: 'per_person', availableTo: 'all', mandatory: false, maxPerBooking: '', poolId: '' }}
          submit={t('admin.catalogue.packages.addExtraButton')}
          resetOnSuccess
          onSubmit={(v) =>
            save(() =>
              api(`${base}/extras`, {
                method: 'POST',
                body: { name: withEnAU(undefined, String(v.name)), kind: v.kind, pricingUnit: v.pricingUnit, availableTo: v.availableTo, mandatory: v.mandatory === true, maxPerBooking: wholeNumber(String(v.maxPerBooking)) ?? null, poolId: String(v.poolId) || null },
              }),
            )
          }
        />
      </Section>

      <Section id="package-duplicate" title={t('admin.catalogue.packages.duplicateTitle')}>
        <p>{t('admin.catalogue.packages.duplicateHelp')}</p>
        {otherEditions.length === 0 ? (
          <p>{t('admin.catalogue.packages.duplicateNoEdition')}</p>
        ) : (
          <EntityForm
            key={`dup-${otherEditions.length}`}
            id="duplicate"
            fields={[
              { key: 'targetEditionId', label: t('admin.catalogue.packages.duplicateTarget'), type: 'select', required: true, options: otherEditions.map((e) => ({ value: e.id, label: String(e.year) })) },
              { key: 'name', label: t('admin.catalogue.packages.fields.name'), type: 'text', required: true, maxLength: 150 },
              { key: 'slug', label: t('admin.catalogue.packages.fields.slug'), type: 'text', maxLength: 80, hint: t('admin.catalogue.races.fields.slugHint') },
              { key: 'checkInDate', label: t('admin.catalogue.packages.fields.checkInDate'), type: 'date', required: true },
              { key: 'checkOutDate', label: t('admin.catalogue.packages.fields.checkOutDate'), type: 'date', required: true },
              { key: 'balanceDueDate', label: t('admin.catalogue.packages.fields.balanceDueDate'), type: 'date', required: true },
            ]}
            initial={{ targetEditionId: otherEditions[0]!.id, name: enAU(pkg.name), slug: '', checkInDate: '', checkOutDate: '', balanceDueDate: '' }}
            submit={t('admin.catalogue.packages.duplicateButton')}
            onSubmit={async (v) => {
              const name = String(v.name).trim();
              const r = await api<{ id: string }>(`${base}/duplicate`, {
                method: 'POST',
                body: { targetEditionId: v.targetEditionId, name: withEnAU(pkg.name, name), slug: String(v.slug).trim() || slugify(name), checkInDate: v.checkInDate, checkOutDate: v.checkOutDate, balanceDueDate: v.balanceDueDate },
              });
              if (r.status === 201) {
                window.location.assign(`/admin/packages/${r.body.id}`);
                return { ok: true, message: t('admin.catalogue.packages.duplicated') };
              }
              return { ok: false, message: catalogueError(r) };
            }}
          />
        )}
      </Section>

      {pkg.saleStatus === 'draft' ? (
        <Section id="package-delete" title={t('admin.catalogue.packages.deleteTitle')}>
          <p>{t('admin.catalogue.packages.deleteHelp')}</p>
          <ActionButton danger text={t('admin.catalogue.packages.deleteButton')} run={() => api(base, { method: 'DELETE' })} onDone={() => window.location.assign(`/admin/editions/${pkg.editionId}`)} />
        </Section>
      ) : null}
    </div>
  );
}

/** The deposit as configured in 1.1: staff type dollars or a percentage; the amount is turned into integer cents with string operations. */
interface SaveDeposit {
  (deposit: Deposit): Promise<Outcome>;
}

function DepositSection({ pkg, onSave }: { pkg: PackageView; onSave: SaveDeposit }) {
  const d = pkg.deposit;
  const mode = d?.mode ?? '';
  const amount = d && d.mode !== 'percent' ? minorToDollars(d.amountMinor) : '';
  const percent = d && d.mode === 'percent' ? bpsToPercent(d.bps) : '';
  return (
    <Section id="package-deposit" title={t('admin.catalogue.packages.depositTitle')}>
      <p>{d ? t(d.mode === 'percent' ? 'admin.catalogue.packages.depositPercent' : d.mode === 'per_person' ? 'admin.catalogue.packages.depositPerPerson' : 'admin.catalogue.packages.depositPerBooking', { amount: d.mode === 'percent' ? bpsToPercent(d.bps) : `${pkg.currency} ${minorToDollars(d.amountMinor)}` }) : t('admin.catalogue.packages.depositNone')}</p>
      <p>{t('admin.catalogue.packages.depositHelp')}</p>
      <EntityForm
        key={`${pkg.version}`}
        id="deposit"
        fields={[
          {
            key: 'mode', label: t('admin.catalogue.packages.depositMode'), type: 'select',
            options: [{ value: '', label: t('admin.catalogue.packages.depositModes.none') }, { value: 'per_person', label: t('admin.catalogue.packages.depositModes.per_person') }, { value: 'per_booking', label: t('admin.catalogue.packages.depositModes.per_booking') }, { value: 'percent', label: t('admin.catalogue.packages.depositModes.percent') }],
          },
          { key: 'amount', label: t('admin.catalogue.packages.depositAmount', { currency: pkg.currency }), type: 'text', hint: t('admin.catalogue.packages.depositAmountHint') },
          { key: 'percent', label: t('admin.catalogue.packages.depositPercentField'), type: 'text', hint: t('admin.catalogue.packages.depositPercentHint') },
        ]}
        initial={{ mode, amount, percent }}
        submit={t('admin.catalogue.common.save')}
        onSubmit={(v) => {
          if (v.mode === '') return onSave(null);
          if (v.mode === 'percent') {
            const bps = percentToBps(String(v.percent));
            return bps === null ? Promise.resolve({ ok: false, message: t('admin.catalogue.errors.bad_percent') } as Outcome) : onSave({ mode: 'percent', bps });
          }
          const minor = dollarsToMinor(String(v.amount));
          return minor === null || minor === '0' ? Promise.resolve({ ok: false, message: t('admin.catalogue.errors.bad_amount') } as Outcome) : onSave({ mode: v.mode as 'per_person' | 'per_booking', amountMinor: minor });
        }}
      />
    </Section>
  );
}
