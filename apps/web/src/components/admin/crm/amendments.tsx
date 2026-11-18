'use client';

import { useState } from 'react';
import { Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/builder';
import { t } from '@/lib/i18n';
import { amendmentErrorKey, formFrom, staffBody, travellerKey } from '@/lib/amendments';
import type { AmendmentPreview, ConfigurationView, FormTraveller, Participation, StaffForm } from '@/lib/amendments';
import { Section, useLoad } from '../catalogue/kit';
import { useStepUp } from '../step-up';
import { formatMoment } from './crm-kit';

export interface AmendmentRow {
  id: string;
  toVersion: number;
  createdAt: string;
  initiatedBy: 'customer' | 'staff';
  changes: string[];
  currency: string;
  previousTotalMinor: string;
  newTotalMinor: string;
  priceDifferenceMinor: string;
  outstandingMinor: string;
  creditPendingMinor: string;
}

interface PackageView {
  hotels: Array<{ rooms: Array<{ id: string; name: Record<string, string>; minOccupancy: number; maxOccupancy: number }> }>;
  entryOptions: Array<{ raceDistanceId: string; raceDistance: { name: Record<string, string> } }>;
  participationOptions: Array<{ type: Participation }>;
  extras: Array<{ id: string; name: Record<string, string>; pricingUnit: 'per_person' | 'per_booking'; mandatory: boolean; maxPerBooking: number | null }>;
  maxExtraNightsBefore: number;
  maxExtraNightsAfter: number;
}

const AMENDABLE = ['deposit_paid', 'confirmed', 'balance_paid'];

function perPersonOf(pkg: PackageView | null | undefined): Set<string> {
  return new Set((pkg?.extras ?? []).filter((e) => e.pricingUnit === 'per_person').map((e) => e.id));
}
const name = (v: Record<string, string>) => v['en-AU'] ?? Object.values(v)[0] ?? '';
const kinds = (changes: string[]) => changes.map((c) => t(`amendments.kinds.${c}`)).join(', ');

/** The history of changes of a booking (task 6.3), with the money as each change left it, and the credit pending now. */
export function AmendmentHistory({ rows, currency, creditNowMinor }: { rows: AmendmentRow[]; currency: string; creditNowMinor: string | null }) {
  return (
    <>
      {rows.length === 0 ? <p>{t('admin.crm.amendments.none')}</p> : (
        <table>
          <caption className="visually-hidden">{t('admin.crm.amendments.historyCaption')}</caption>
          <thead>
            <tr>
              {(['version', 'when', 'by', 'what', 'previous', 'next', 'difference', 'outstanding', 'credit'] as const).map((c) => <th key={c} scope="col">{t(`admin.crm.amendments.columns.${c}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <th scope="row">{a.toVersion}</th>
                <td>{formatMoment(a.createdAt)}</td>
                <td>{t(`amendments.byStaffView.${a.initiatedBy}`)}</td>
                <td>{kinds(a.changes)}</td>
                <td>{formatMoney(a.previousTotalMinor, a.currency)}</td>
                <td>{formatMoney(a.newTotalMinor, a.currency)}</td>
                <td>{formatMoney(a.priceDifferenceMinor, a.currency)}</td>
                <td>{formatMoney(a.outstandingMinor, a.currency)}</td>
                <td>{formatMoney(a.creditPendingMinor, a.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creditNowMinor && creditNowMinor !== '0' ? <p className="notice" role="status">{t('admin.crm.amendments.currentCredit', { amount: formatMoney(creditNowMinor, currency) })}</p> : null}
    </>
  );
}

/**
 * The staff form for a change (task 6.3): keep, replace, remove or add travellers, rooms, nights and extras; a preview from
 * the API (the engine's price on the booking's basis), then "Apply" behind a step-up. Nothing is priced here.
 */
export function AmendmentPanel(props: {
  bookingId: string; packageId: string; status: string; version: number; configuration: ConfigurationView; rows: AmendmentRow[]; currency: string; onChanged(): Promise<void>;
}) {
  const { data: pkg } = useLoad<PackageView>(`/admin/catalogue/packages/${props.packageId}`);
  const { data: money } = useLoad<{ allocation?: { overpaidMinor?: string } }>(`/admin/payments/bookings/${props.bookingId}`);
  const perPersonIds = perPersonOf(pkg);
  const [form, setForm] = useState<StaffForm | null>(null);
  const [preview, setPreview] = useState<AmendmentPreview | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp();
  const amendable = AMENDABLE.includes(props.status);
  const current = form ?? (pkg ? formFrom(props.configuration, props.version, perPersonIds) : null);

  function change(next: StaffForm) {
    setForm(next);
    setPreview(null);
  }
  const rooms = pkg?.hotels.flatMap((h) => h.rooms) ?? [];
  const distances = pkg?.entryOptions ?? [];
  const types = (pkg?.participationOptions ?? []).map((p) => p.type);

  async function run(apply: boolean) {
    if (!current || busy) return;
    setBusy(true);
    try {
      let body;
      try {
        body = staffBody(current);
      } catch {
        setMessage({ text: t('amendments.errors.generic'), tone: 'error' });
        return;
      }
      const r = apply && preview
        ? await stepUp.run(() => api(`/admin/bookings/${props.bookingId}/amendments`, { method: 'POST', body: { ...body, previewDigest: preview.previewDigest }, headers: { 'Idempotency-Key': crypto.randomUUID() } }))
        : await api<AmendmentPreview & Record<string, unknown>>(`/admin/bookings/${props.bookingId}/amendments/preview`, { method: 'POST', body });
      if (!apply && r.status === 200) {
        setPreview(r.body as unknown as AmendmentPreview);
        setMessage(null);
      } else if (apply && (r.status === 201 || r.status === 200)) {
        setForm(null);
        setPreview(null);
        setMessage({ text: t('admin.crm.amendments.done'), tone: 'info' });
        await props.onChanged();
      } else setMessage({ text: t(amendmentErrorKey(r.body.code)), tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const setTraveller = (ri: number, ti: number, x: FormTraveller | null) => {
    if (!current) return;
    const next = structuredClone(current);
    if (x === null) next.rooms[ri]!.travellers.splice(ti, 1);
    else next.rooms[ri]!.travellers[ti] = x;
    change(next);
  };

  return (
    <Section id="booking-amendments" title={t('admin.crm.amendments.title')}>
      <p>{t('admin.crm.amendments.intro')}</p>
      <AmendmentHistory rows={props.rows} currency={props.currency} creditNowMinor={money?.allocation?.overpaidMinor ?? null} />
      <h3>{t('admin.crm.amendments.formHeading')}</h3>
      {!amendable ? <p>{t('admin.crm.amendments.notAmendable')}</p> : !current || !pkg ? <p role="status">{t('admin.common.loading')}</p> : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(false); }}>
          {current.rooms.map((room, ri) => (
            <fieldset key={ri}>
              <legend>{t('admin.crm.amendments.room', { n: ri + 1 })}</legend>
              <div className="field">
                <label htmlFor={`am-room-${ri}`}>{t('admin.crm.amendments.roomOption')}</label>
                <select id={`am-room-${ri}`} value={room.roomOptionId} onChange={(e) => { const n = structuredClone(current); n.rooms[ri]!.roomOptionId = e.target.value; change(n); }}>
                  {rooms.map((o) => <option key={o.id} value={o.id}>{name(o.name)}</option>)}
                </select>
              </div>
              <ul>
                {room.travellers.map((x, ti) => (
                  <li key={travellerKey(current, ri, ti)}>
                    {x.kind === 'keep' ? (
                      <>
                        <span>{t(x.slot === props.configuration.rooms.flatMap((r) => r.travellers)[0]?.slot ? 'admin.crm.amendments.placeLead' : 'admin.crm.amendments.place', { slot: x.slot })}: {t(`admin.crm.amendments.participationTypes.${x.participationType}`)}</span>{' '}
                        <button type="button" className="link-button" onClick={() => setTraveller(ri, ti, { kind: 'new', participationType: x.participationType, raceDistanceId: x.raceDistanceId, replacesSlot: x.slot })}>{t('admin.crm.amendments.replace')}</button>{' '}
                        <button type="button" className="link-button" onClick={() => setTraveller(ri, ti, null)}>{t('admin.crm.amendments.remove')}</button>
                      </>
                    ) : (
                      <span className="inline-fields">
                        <span>{t('admin.crm.amendments.newTraveller')}{x.replacesSlot !== null ? ` (${t('admin.crm.amendments.replaces', { slot: x.replacesSlot })})` : ''}</span>{' '}
                        <label htmlFor={`am-type-${ri}-${ti}`}>{t('admin.crm.amendments.participation')}</label>
                        <select id={`am-type-${ri}-${ti}`} value={x.participationType} onChange={(e) => setTraveller(ri, ti, { ...x, participationType: e.target.value as Participation })}>
                          {types.map((ty) => <option key={ty} value={ty}>{t(`admin.crm.amendments.participationTypes.${ty}`)}</option>)}
                        </select>
                        {x.participationType === 'runner_with_entry' ? (
                          <>
                            <label htmlFor={`am-dist-${ri}-${ti}`}>{t('admin.crm.amendments.distance')}</label>
                            <select id={`am-dist-${ri}-${ti}`} value={x.raceDistanceId ?? ''} onChange={(e) => setTraveller(ri, ti, { ...x, raceDistanceId: e.target.value })}>
                              <option value="" />
                              {distances.map((d) => <option key={d.raceDistanceId} value={d.raceDistanceId}>{name(d.raceDistance.name)}</option>)}
                            </select>
                          </>
                        ) : null}{' '}
                        <button type="button" className="link-button" onClick={() => setTraveller(ri, ti, null)}>{t('admin.crm.amendments.remove')}</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <button type="button" className="link-button" onClick={() => { const n = structuredClone(current); n.rooms[ri]!.travellers.push({ kind: 'new', participationType: types[0] ?? 'supporter', raceDistanceId: null, replacesSlot: null }); change(n); }}>{t('admin.crm.amendments.addTraveller')}</button>
            </fieldset>
          ))}
          <button type="button" className="link-button" onClick={() => { const n = structuredClone(current); n.rooms.push({ roomOptionId: rooms[0]?.id ?? '', travellers: [] }); change(n); }}>{t('admin.crm.amendments.addRoom')}</button>
          <div className="field">
            <label htmlFor="am-before">{t('admin.crm.amendments.nightsBefore')}</label>
            <input id="am-before" type="number" min={0} max={pkg.maxExtraNightsBefore} value={current.extraNightsBefore} onChange={(e) => change({ ...current, extraNightsBefore: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label htmlFor="am-after">{t('admin.crm.amendments.nightsAfter')}</label>
            <input id="am-after" type="number" min={0} max={pkg.maxExtraNightsAfter} value={current.extraNightsAfter} onChange={(e) => change({ ...current, extraNightsAfter: Number(e.target.value) })} />
          </div>
          <fieldset>
            <legend>{t('admin.crm.amendments.extras')}</legend>
            {pkg.extras.filter((e) => !e.mandatory).map((e) => e.pricingUnit === 'per_person' ? (
              current.rooms.flatMap((r, ri) => r.travellers.map((_x, ti) => travellerKey(current, ri, ti))).map((key, i) => {
                const on = (current.perPerson[e.id] ?? []).includes(key);
                return (
                  <div key={`${e.id}-${key}`} className="field field--check">
                    <input id={`am-extra-${e.id}-${i}`} type="checkbox" checked={on} onChange={() => change({ ...current, perPerson: { ...current.perPerson, [e.id]: on ? (current.perPerson[e.id] ?? []).filter((k) => k !== key) : [...(current.perPerson[e.id] ?? []), key] } })} />
                    <label htmlFor={`am-extra-${e.id}-${i}`}>{t('admin.crm.amendments.extraFor', { extra: name(e.name), who: String(i + 1) })}</label>
                  </div>
                );
              })
            ) : (
              <div key={e.id} className="field">
                <label htmlFor={`am-qty-${e.id}`}>{t('admin.crm.amendments.quantity', { extra: name(e.name) })}</label>
                <input id={`am-qty-${e.id}`} type="number" min={0} max={e.maxPerBooking ?? 1} value={current.perBooking[e.id] ?? 0} onChange={(ev) => change({ ...current, perBooking: { ...current.perBooking, [e.id]: Number(ev.target.value) } })} />
              </div>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="am-reason">{t('admin.crm.amendments.reason')}</label>
            <select id="am-reason" value={current.reasonCode} onChange={(e) => change({ ...current, reasonCode: e.target.value as StaffForm['reasonCode'] })}>
              {(['customer_request', 'correction', 'supplier_change', 'other'] as const).map((r) => <option key={r} value={r}>{t(`admin.crm.amendments.reasons.${r}`)}</option>)}
            </select>
          </div>
          <div className="actions">
            <button className="btn" type="submit" disabled={busy}>{t('admin.crm.amendments.preview')}</button>
          </div>
          {preview ? <PreviewSummary preview={preview} /> : null}
          {preview ? <div className="actions"><button className="btn" type="button" disabled={busy} onClick={() => void run(true)}>{t('admin.crm.amendments.apply')}</button></div> : null}
          {stepUp.prompt}
        </form>
      )}
      <Status message={message?.text ?? null} tone={message?.tone ?? 'error'} />
    </Section>
  );
}

/** The API's preview, shown as sent. */
export function PreviewSummary({ preview: p }: { preview: AmendmentPreview }) {
  const cur = p.currency;
  return (
    <div aria-live="polite">
      <h4>{t('admin.crm.amendments.previewHeading')}</h4>
      <dl>
        <dt>{t('amendments.previousTotal')}</dt><dd>{formatMoney(p.previousTotalMinor, cur)}</dd>
        <dt>{t('amendments.newTotal')}</dt><dd>{formatMoney(p.newTotalMinor, cur)}</dd>
        <dt>{t('amendments.difference')}</dt><dd>{formatMoney(p.priceDifferenceMinor, cur)}</dd>
        <dt>{t('amendments.outstandingAfter')}</dt><dd>{formatMoney(p.outstandingAfterMinor, cur)}</dd>
        {p.creditPendingAfterMinor !== '0' ? (<><dt>{t('amendments.creditAfter')}</dt><dd>{formatMoney(p.creditPendingAfterMinor, cur)}</dd></>) : null}
      </dl>
      {p.basisDriftMinor !== '0' ? <p>{t('admin.crm.amendments.drift', { amount: formatMoney(p.basisDriftMinor, cur) })}</p> : null}
      <p>{kinds(p.changes)}</p>
    </div>
  );
}
