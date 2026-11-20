'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { QUOTE_STATUSES } from '@mt/shared';
import { Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { localisedText } from '@/lib/catalogue';
import { t } from '@/lib/i18n-admin';
import { Section, formatDay, useLoad } from '../catalogue/kit';
import { crmError, formatMoment, fullName, statusLabel } from './crm-kit';

interface PackageRow {
  id: string;
  name: Record<string, string>;
  edition: { year: number };
  race: { name: Record<string, string> };
}
interface PackageOptions {
  id: string;
  maxExtraNightsBefore: number;
  maxExtraNightsAfter: number;
  participationOptions: Array<{ type: string; enabled: boolean }>;
  entryOptions: Array<{ id: string; raceDistance: { id: string; name: Record<string, string> } }>;
  hotels: Array<{ id: string; hotel: { name: string }; rooms: Array<{ id: string; name: Record<string, string>; minOccupancy: number; maxOccupancy: number }> }>;
}

/**
 * Prepares a quote for a customer: the choices only (package, room, who is travelling, extra nights). The API prices them
 * with the same engine as the public site and keeps the result; nothing here adds up an amount.
 */
export function NewQuoteForm({ customerId }: { customerId: string }) {
  const [packageId, setPackageId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [count, setCount] = useState('1');
  const [type, setType] = useState('');
  const [distanceId, setDistanceId] = useState('');
  const [before, setBefore] = useState('0');
  const [after, setAfter] = useState('0');
  const [days, setDays] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const packages = useLoad<{ items: PackageRow[] }>('/admin/catalogue/packages?page=1&pageSize=50');
  const options = useLoad<PackageOptions>(packageId ? `/admin/catalogue/packages/${packageId}` : null);
  const pkg = packageId ? options.data : null;
  const rooms = pkg?.hotels.flatMap((h) => h.rooms.map((r) => ({ ...r, hotel: h.hotel.name }))) ?? [];
  const room = rooms.find((r) => r.id === roomId);
  const types = pkg?.participationOptions.filter((p) => p.enabled && (p.type !== 'runner_with_entry' || pkg.entryOptions.length > 0)).map((p) => p.type) ?? [];
  const chosenType = types.includes(type) ? type : (types[0] ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pkg || !room || !chosenType) {
      setMessage(t('admin.crm.quote.chooseFirst'));
      return;
    }
    const traveller = chosenType === 'runner_with_entry' ? { participationType: chosenType, raceDistanceId: distanceId || pkg.entryOptions[0]!.raceDistance.id } : { participationType: chosenType };
    const r = await api<{ id: string }>('/admin/quotes', {
      method: 'POST',
      body: {
        customerId,
        configuration: {
          packageId,
          rooms: [{ roomOptionId: room.id, travellers: Array.from({ length: Number(count) }, () => traveller) }],
          extraNightsBefore: Number(before), extraNightsAfter: Number(after), extras: [],
        },
        ...(days ? { validForDays: Number(days) } : {}),
      },
    });
    if (r.status === 201 || r.status === 200) window.location.assign(`/admin/quotes/${r.body.id}`);
    else setMessage(crmError(r));
  }

  return (
    <form className="form stack" onSubmit={submit}>
      <h3>{t('admin.crm.quote.new')}</h3>
      <p>{t('admin.crm.quote.newHelp')}</p>
      <Status message={packages.error} />
      <div className="field">
        <label htmlFor="quote-package">{t('admin.crm.quote.package')}</label>
        <select id="quote-package" value={packageId} onChange={(e) => { setPackageId(e.target.value); setRoomId(''); setDistanceId(''); }}>
          <option value="">{t('admin.crm.quote.choose')}</option>
          {packages.data?.items.map((p) => (
            <option key={p.id} value={p.id}>{t('admin.crm.quote.packageOption', { race: localisedText(p.race.name), year: String(p.edition.year), name: localisedText(p.name) })}</option>
          ))}
        </select>
      </div>
      {pkg ? (
        <>
          <div className="field">
            <label htmlFor="quote-room">{t('admin.crm.quote.room')}</label>
            <select id="quote-room" value={roomId} onChange={(e) => { setRoomId(e.target.value); const r = rooms.find((x) => x.id === e.target.value); if (r) setCount(String(r.minOccupancy)); }}>
              <option value="">{t('admin.crm.quote.choose')}</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{t('admin.crm.quote.roomOption', { hotel: r.hotel, name: localisedText(r.name), min: String(r.minOccupancy), max: String(r.maxOccupancy) })}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="quote-count">{t('admin.crm.quote.travellers')}</label>
            <input id="quote-count" type="number" min={room?.minOccupancy ?? 1} max={room?.maxOccupancy ?? 4} value={count} onChange={(e) => setCount(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="quote-type">{t('admin.crm.quote.participation')}</label>
            <select id="quote-type" value={chosenType} onChange={(e) => setType(e.target.value)}>
              {types.map((p) => (
                <option key={p} value={p}>{t(`admin.crm.quote.types.${p}`)}</option>
              ))}
            </select>
          </div>
          {chosenType === 'runner_with_entry' ? (
            <div className="field">
              <label htmlFor="quote-distance">{t('admin.crm.quote.distance')}</label>
              <select id="quote-distance" value={distanceId || pkg.entryOptions[0]?.raceDistance.id} onChange={(e) => setDistanceId(e.target.value)}>
                {pkg.entryOptions.map((o) => (
                  <option key={o.id} value={o.raceDistance.id}>{localisedText(o.raceDistance.name)}</option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="quote-before">{t('admin.crm.quote.nightsBefore')}</label>
            <input id="quote-before" type="number" min={0} max={pkg.maxExtraNightsBefore} value={before} onChange={(e) => setBefore(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="quote-after">{t('admin.crm.quote.nightsAfter')}</label>
            <input id="quote-after" type="number" min={0} max={pkg.maxExtraNightsAfter} value={after} onChange={(e) => setAfter(e.target.value)} />
          </div>
        </>
      ) : null}
      <div className="field">
        <label htmlFor="quote-days">{t('admin.crm.quote.validFor')}</label>
        <input id="quote-days" type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} aria-describedby="quote-days-hint" />
        <p id="quote-days-hint" className="field__hint">{t('admin.crm.quote.validForHint')}</p>
      </div>
      <div className="actions">
        <button className="btn" type="submit">{t('admin.crm.quote.create')}</button>
      </div>
      <Status message={message} />
    </form>
  );
}

interface QuoteRow {
  id: string;
  reference: string;
  status: string;
  currency: string;
  totalMinor: string;
  expiresAt: string | null;
  customer: { id: string; givenName: string; familyName: string; email: string };
  package: { name: Record<string, string> };
}

/** Quotes across customers, by state. */
export function QuotesPanel() {
  const [status, setStatus] = useState('');
  const list = useLoad<{ items: QuoteRow[] }>(`/admin/quotes?limit=50${status ? `&status=${status}` : ''}`);
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="quote-status">{t('admin.crm.quotes.filter')}</label>
        <select id="quote-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('admin.crm.inbox.tabAll')}</option>
          {QUOTE_STATUSES.map((s) => (
            <option key={s} value={s}>{statusLabel('quote', s)}</option>
          ))}
        </select>
      </div>
      <Status message={list.error} />
      {list.data ? (
        list.data.items.length === 0 ? <p role="status">{t('admin.crm.quotes.empty')}</p> : (
          <table className="table">
            <caption>{t('admin.crm.quotes.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.crm.columns.reference')}</th>
                <th scope="col">{t('admin.crm.columns.customer')}</th>
                <th scope="col">{t('admin.crm.columns.status')}</th>
                <th scope="col">{t('admin.crm.columns.total')}</th>
                <th scope="col">{t('admin.crm.quote.expires')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((q) => (
                <tr key={q.id}>
                  <th scope="row"><Link href={`/admin/quotes/${q.id}`}>{q.reference}</Link></th>
                  <td>{fullName(q.customer)}</td>
                  <td>{statusLabel('quote', q.status)}</td>
                  <td>{formatMoney(q.totalMinor, q.currency)}</td>
                  <td>{q.expiresAt ? formatMoment(q.expiresAt) : t('admin.crm.quote.notSent')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <p role="status">{t('admin.common.loading')}</p>
      )}
    </div>
  );
}

interface QuoteView extends QuoteRow {
  version: number;
  depositMinor: string;
  departureDate: string;
  returnDate: string;
  balanceDueDate: string;
  validForDays: number;
  sentAt: string | null;
  acceptedAt: string | null;
  booking: { id: string; reference: string; status: string } | null;
}

/** One quote: what was offered, until when, and send or withdraw. */
export function QuoteDetail({ id }: { id: string }) {
  const { data: q, error, reload } = useLoad<QuoteView>(`/admin/quotes/${id}`);
  const [message, setMessage] = useState<string | null>(null);
  if (!q) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;
  async function act(action: 'send' | 'withdraw') {
    if (!q) return;
    const r = await api(`/admin/quotes/${id}/${action}`, { method: 'POST', body: { version: q.version } });
    if (r.status === 200) {
      setMessage(null);
      await reload();
    } else setMessage(crmError(r));
  }
  return (
    <Section id="quote-summary" title={t('admin.crm.quote.summary', { reference: q.reference })}>
      <dl>
        <dt>{t('admin.crm.columns.status')}</dt>
        <dd>{statusLabel('quote', q.status)}</dd>
        <dt>{t('admin.crm.columns.customer')}</dt>
        <dd><Link href={`/admin/customers/${q.customer.id}`}>{fullName(q.customer)}</Link></dd>
        <dt>{t('admin.crm.quote.package')}</dt>
        <dd>{localisedText(q.package.name)}</dd>
        <dt>{t('admin.crm.booking.dates')}</dt>
        <dd>{t('admin.crm.booking.dateRange', { from: formatDay(q.departureDate), to: formatDay(q.returnDate) })}</dd>
        <dt>{t('admin.crm.columns.total')}</dt>
        <dd>{formatMoney(q.totalMinor, q.currency)}</dd>
        <dt>{t('admin.crm.booking.deposit')}</dt>
        <dd>{t('admin.crm.booking.depositLine', { amount: formatMoney(q.depositMinor, q.currency), date: formatDay(q.balanceDueDate) })}</dd>
        <dt>{t('admin.crm.quote.expires')}</dt>
        <dd>{q.expiresAt ? formatMoment(q.expiresAt) : t('admin.crm.quote.validForLine', { days: String(q.validForDays) })}</dd>
        {q.booking ? (
          <>
            <dt>{t('admin.crm.quote.booking')}</dt>
            <dd><Link href={`/admin/bookings/${q.booking.id}`}>{q.booking.reference}</Link></dd>
          </>
        ) : null}
      </dl>
      <div className="actions">
        {q.status === 'draft' ? <button className="btn" type="button" onClick={() => void act('send')}>{t('admin.crm.quote.send')}</button> : null}
        {q.status === 'draft' || q.status === 'sent' ? <button className="link-button" type="button" onClick={() => void act('withdraw')}>{t('admin.crm.quote.withdraw')}</button> : null}
      </div>
      <Status message={message} />
    </Section>
  );
}
