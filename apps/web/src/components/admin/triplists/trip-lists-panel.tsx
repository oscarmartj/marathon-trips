'use client';

import { useState } from 'react';
import type { Itinerary, ItineraryItem, ListedTraveller, RoomingList, TransferList, TripListKind, TripSummary } from '@mt/shared';
import { t } from '@/lib/i18n-admin';
import { guestName, listPath, tripLabel } from '@/lib/trip-lists-panel';
import { Status } from '../../auth/field';
import { Section, formatDay, useLoad } from '../catalogue/kit';

const people = (list: ListedTraveller[]) => (list.length === 0 ? t('admin.triplists.nobody') : list.map((g) => `${guestName(g, t('admin.triplists.detailsPending'))}${g.isLead ? ` (${t('admin.triplists.lead')})` : ''}`).join(', '));

/** A download link: the browser sends the staff cookie, the API answers with an attachment and no-store. */
function Download({ packageId, kind, list }: { packageId: string; kind: TripListKind; list: string }) {
  return <a className="btn" href={`/api${listPath(packageId, kind, 'csv')}`} download aria-label={t('admin.triplists.downloadList', { list })}>{t('admin.triplists.download')}</a>;
}

function Rooming({ packageId }: { packageId: string }) {
  const { data, error } = useLoad<RoomingList>(listPath(packageId, 'rooming-list'));
  return (
    <Section id="trip-rooming" title={t('admin.triplists.roomingTitle')}>
      <p className="field__hint">{t('admin.triplists.namesHint')}</p>
      <Status message={error} />
      {data ? (
        <>
          <p role="status">{t('admin.triplists.roomingTotals', { rooms: data.totals.rooms, guests: data.totals.guests, pending: data.totals.detailsPending })}</p>
          {data.hotels.length === 0 ? <p>{t('admin.triplists.roomingEmpty')}</p> : null}
          {data.hotels.map((h) => (
            <table key={h.hotelId} className="table">
              <caption>{t('admin.triplists.hotelCaption', { hotel: h.hotelName, city: h.city })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.triplists.columns.booking')}</th>
                  <th scope="col">{t('admin.triplists.columns.room')}</th>
                  <th scope="col">{t('admin.triplists.columns.guests')}</th>
                  <th scope="col">{t('admin.triplists.columns.checkIn')}</th>
                  <th scope="col">{t('admin.triplists.columns.checkOut')}</th>
                </tr>
              </thead>
              <tbody>
                {h.rooms.map((r, i) => (
                  <tr key={`${r.bookingReference}-${i}`}>
                    <th scope="row">{r.bookingReference}</th>
                    <td>{t('admin.triplists.roomLine', { room: r.roomName, occupancy: r.occupancy })}</td>
                    <td>{people(r.guests)}</td>
                    <td>{formatDay(r.checkIn)}</td>
                    <td>{formatDay(r.checkOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      ) : error ? null : <p role="status">{t('admin.common.loading')}</p>}
      <Download packageId={packageId} kind="rooming-list" list={t('admin.triplists.roomingTitle')} />
    </Section>
  );
}

function Transfers({ packageId }: { packageId: string }) {
  const { data, error } = useLoad<TransferList>(listPath(packageId, 'transfers'));
  return (
    <Section id="trip-transfers" title={t('admin.triplists.transfersTitle')}>
      <p className="field__hint">{t('admin.triplists.namesHint')}</p>
      <Status message={error} />
      {data ? (
        <>
          <p role="status">{t('admin.triplists.transfersTotals', { passengers: data.totals.passengers, pending: data.totals.detailsPending })}</p>
          {data.transfers.length === 0 ? <p>{t('admin.triplists.transfersEmpty')}</p> : null}
          {data.transfers.map((g) => (
            <table key={g.extraId} className="table">
              <caption>{[g.name, g.departure, g.origin || g.destination ? t('admin.triplists.route', { origin: g.origin ?? '?', destination: g.destination ?? '?' }) : null].filter(Boolean).join(' · ')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.triplists.columns.booking')}</th>
                  <th scope="col">{t('admin.triplists.columns.passengers')}</th>
                  <th scope="col">{t('admin.triplists.columns.quantity')}</th>
                  <th scope="col">{t('admin.triplists.columns.checkIn')}</th>
                  <th scope="col">{t('admin.triplists.columns.checkOut')}</th>
                </tr>
              </thead>
              <tbody>
                {g.bookings.map((b) => (
                  <tr key={b.bookingReference}>
                    <th scope="row">{b.bookingReference}</th>
                    <td>{people(b.passengers)}</td>
                    <td>{b.quantity}</td>
                    <td>{formatDay(b.checkIn)}</td>
                    <td>{formatDay(b.checkOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      ) : error ? null : <p role="status">{t('admin.common.loading')}</p>}
      <Download packageId={packageId} kind="transfers" list={t('admin.triplists.transfersTitle')} />
    </Section>
  );
}

const itemLine = (i: ItineraryItem): string => [t(`admin.triplists.itemKinds.${i.kind}`), i.title, i.detail].filter(Boolean).join(' · ');

function ItineraryList({ packageId }: { packageId: string }) {
  const { data, error } = useLoad<Itinerary>(listPath(packageId, 'itinerary'));
  return (
    <Section id="trip-itinerary" title={t('admin.triplists.itineraryTitle')}>
      <Status message={error} />
      {data ? (
        <>
          {data.raceDatesProvisional ? <p role="note">{t('admin.triplists.provisional')}</p> : null}
          <ol className="stack">
            {data.days.map((d) => (
              <li key={d.date}>
                <h3>{d.dayNumber === null ? formatDay(d.date) : t('admin.triplists.dayHeading', { day: d.dayNumber, date: formatDay(d.date) })}</h3>
                <ul>{d.items.map((i, n) => <li key={n}>{itemLine(i)}</li>)}</ul>
              </li>
            ))}
          </ol>
          {data.unscheduled.length > 0 ? (
            <>
              <h3>{t('admin.triplists.unscheduledTitle')}</h3>
              <p className="field__hint">{t('admin.triplists.unscheduledHint')}</p>
              <ul>{data.unscheduled.map((i, n) => <li key={n}>{itemLine(i)}</li>)}</ul>
            </>
          ) : null}
        </>
      ) : error ? null : <p role="status">{t('admin.common.loading')}</p>}
      <Download packageId={packageId} kind="itinerary" list={t('admin.triplists.itineraryTitle')} />
    </Section>
  );
}

/** Rooming list, transfers list and itinerary of one trip (task 7.1). Names are shown only here, to staff who hold the permission. */
export function TripListsPanel() {
  const [packageId, setPackageId] = useState('');
  const trips = useLoad<{ items: TripSummary[] }>('/admin/trip-ops/trips');
  const options = trips.data?.items ?? [];
  return (
    <div className="stack">
      <Section id="trip-picker" title={t('admin.triplists.pickTitle')}>
        <Status message={trips.error} />
        <div className="field">
          <label htmlFor="trip-lists-trip">{t('admin.triplists.pickLabel')}</label>
          <select id="trip-lists-trip" value={packageId} onChange={(e) => setPackageId(e.target.value)}>
            <option value="">{t('admin.triplists.pickNone')}</option>
            {options.map((o) => <option key={o.packageId} value={o.packageId}>{t('admin.triplists.pickOption', { trip: tripLabel(o), count: o.bookings })}</option>)}
          </select>
        </div>
        <p className="field__hint">{t('admin.triplists.listedHint')}</p>
      </Section>
      {packageId ? (
        <div className="stack" key={packageId}>
          <Rooming packageId={packageId} />
          <Transfers packageId={packageId} />
          <ItineraryList packageId={packageId} />
        </div>
      ) : null}
    </div>
  );
}
