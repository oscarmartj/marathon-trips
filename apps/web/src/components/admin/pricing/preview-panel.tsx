'use client';

import type { PriceBreakdownJson } from '@mt/shared';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatLineAmount, formatMinor, toQuoteRequest, travellerCount, type QuoteFormState, type VersionRow } from '@/lib/pricing-panel';
import { isBreakdown } from '@/lib/quote-loader';
import { t } from '@/lib/i18n-admin';
import { Section, formatDay } from '../catalogue/kit';
import { CheckField, Live, SelectField, TextField, useRunner } from './pricing-kit';
import { namesOf, type Names } from './pricing-names';
import type { PricedPackage } from './pricing-types';

export interface RuleLabel {
  id: string;
  label: string;
}
type Trace = Array<{ ruleId: string; outcome: string }>;
type Line = PriceBreakdownJson['lines'][number];

const PARTICIPATION_ORDER = ['runner_with_entry', 'runner_own_entry', 'supporter'] as const;

function lineText(line: Line, names: Names, breakdown: PriceBreakdownJson, rules: Map<string, string>): string {
  switch (line.kind) {
    case 'room':
      return t('admin.pricing.preview.line.room', { room: names.room(line.refId ?? '') });
    case 'extra_nights':
      return t('admin.pricing.preview.line.extraNights', { room: names.room(line.refId ?? ''), count: line.quantity });
    case 'participation': {
      const traveller = breakdown.configuration.rooms.flatMap((r) => r.travellers).find((x) => x.slot === line.travellerSlot);
      return t('admin.pricing.preview.line.participation', { what: names.participation(traveller?.participationType ?? 'runner_own_entry', traveller?.participationType === 'runner_with_entry' ? line.refId : null), slot: line.travellerSlot ?? 0 });
    }
    case 'extra':
      return t('admin.pricing.preview.line.extra', { extra: names.extra(line.refId ?? '') });
    case 'promo':
      return t('admin.pricing.preview.line.promo');
    default:
      return t('admin.pricing.preview.line.rule', { rule: (line.refId && rules.get(line.refId)) || t('admin.pricing.preview.line.ruleUnknown') });
  }
}

/**
 * Prices a configuration with the API (`POST /admin/pricing/quotes`), a draft version included, and draws the answer as
 * it came: the browser adds nothing up. The panel also gets why each rule did or did not apply.
 */
export function PreviewPanel({ pkg, versions, defaultVersionId, rules, packageId }: { pkg: PricedPackage; versions: VersionRow[]; defaultVersionId: string; rules: RuleLabel[]; packageId: string }) {
  const names = useMemo(() => namesOf(pkg), [pkg]);
  const rooms = pkg.hotels.flatMap((h) => h.rooms.map((r) => ({ ...r, hotel: h.hotel.name })));
  const types = PARTICIPATION_ORDER.filter((p) => pkg.participationOptions.some((o) => o.enabled && o.type === p) && (p !== 'runner_with_entry' || pkg.entryOptions.length > 0));
  const firstTraveller = () => ({ participationType: types[0] ?? 'supporter', raceDistanceId: types[0] === 'runner_with_entry' ? (pkg.entryOptions[0]?.raceDistance.id ?? '') : '' });
  const [form, setForm] = useState<QuoteFormState>({
    priceVersionId: defaultVersionId,
    rooms: rooms[0] ? [{ roomOptionId: rooms[0].id, travellers: [firstTraveller()] }] : [],
    extraNightsBefore: '0', extraNightsAfter: '0', extras: [], promoCode: '',
  });
  const [result, setResult] = useState<{ breakdown: PriceBreakdownJson; trace: Trace } | null>(null);
  const runner = useRunner();
  const ruleNames = useMemo(() => new Map(rules.map((r) => [r.id, r.label])), [rules]);
  const slots = travellerCount(form);
  const set = (patch: Partial<QuoteFormState>) => setForm((f) => ({ ...f, ...patch }));
  const setRoom = (i: number, next: QuoteFormState['rooms'][number]) => set({ rooms: form.rooms.map((r, j) => (j === i ? next : r)) });
  const distanceOptions = pkg.entryOptions.map((e) => ({ value: e.raceDistance.id, label: names.distance(e.raceDistance.id) }));
  const offersNights = pkg.maxExtraNightsBefore + pkg.maxExtraNightsAfter > 0;

  async function price(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    const r = await runner.run(() => api('/admin/pricing/quotes', { method: 'POST', body: toQuoteRequest(packageId, form, names.extraUnit) }));
    if (!r) return;
    if (!isBreakdown(r.body)) {
      runner.clear();
      setResult(null);
      return;
    }
    const trace = (r.body as unknown as { trace?: unknown }).trace;
    setResult({ breakdown: r.body, trace: Array.isArray(trace) ? (trace as Trace) : [] });
  }

  return (
    <Section id="preview" title={t('admin.pricing.preview.title')}>
      <p>{t('admin.pricing.preview.help')}</p>
      {runner.prompt}
      <form className="form stack" onSubmit={price} aria-label={t('admin.pricing.preview.formLabel')}>
        <SelectField
          id="preview-version" label={t('admin.pricing.preview.version')} value={form.priceVersionId} onChange={(v) => set({ priceVersionId: v })}
          options={versions.filter((v) => v.status !== 'archived').map((v) => ({ value: v.id, label: `${v.label} (${t(`admin.pricing.statuses.${v.status}`)})` }))}
        />
        {form.rooms.map((room, i) => (
          <fieldset key={i} className="stack">
            <legend>{t('admin.pricing.preview.roomLegend', { number: i + 1 })}</legend>
            <SelectField
              id={`preview-room-${i}`} label={t('admin.pricing.preview.room')} value={room.roomOptionId}
              onChange={(v) => setRoom(i, { ...room, roomOptionId: v })}
              options={rooms.map((r) => ({ value: r.id, label: `${r.hotel}: ${names.room(r.id)}` }))}
            />
            {room.travellers.map((tr, j) => (
              <div className="inline-form" key={j}>
                <SelectField
                  id={`preview-type-${i}-${j}`} label={t('admin.pricing.preview.travellerType', { number: j + 1 })} value={tr.participationType}
                  onChange={(v) => setRoom(i, { ...room, travellers: room.travellers.map((x, k) => (k === j ? { participationType: v, raceDistanceId: v === 'runner_with_entry' ? (x.raceDistanceId || (distanceOptions[0]?.value ?? '')) : '' } : x)) })}
                  options={types.map((p) => ({ value: p, label: t(`admin.catalogue.participation.${p}`) }))}
                />
                {tr.participationType === 'runner_with_entry' ? (
                  <SelectField
                    id={`preview-distance-${i}-${j}`} label={t('admin.pricing.preview.distance', { number: j + 1 })} value={tr.raceDistanceId}
                    onChange={(v) => setRoom(i, { ...room, travellers: room.travellers.map((x, k) => (k === j ? { ...x, raceDistanceId: v } : x)) })} options={distanceOptions}
                  />
                ) : null}
                {room.travellers.length > 1 ? (
                  <button type="button" className="link-button" onClick={() => { setRoom(i, { ...room, travellers: room.travellers.filter((_x, k) => k !== j) }); set({ extras: [] }); }}>
                    {t('admin.pricing.preview.removeTraveller', { number: j + 1 })}
                  </button>
                ) : null}
              </div>
            ))}
            <div className="actions">
              {room.travellers.length < 4 ? (
                <button type="button" className="btn" onClick={() => { setRoom(i, { ...room, travellers: [...room.travellers, firstTraveller()] }); set({ extras: [] }); }}>
                  {t('admin.pricing.preview.addTraveller', { number: i + 1 })}
                </button>
              ) : null}
              {form.rooms.length > 1 ? (
                <button type="button" className="link-button" onClick={() => set({ rooms: form.rooms.filter((_r, k) => k !== i), extras: [] })}>
                  {t('admin.pricing.preview.removeRoom', { number: i + 1 })}
                </button>
              ) : null}
            </div>
          </fieldset>
        ))}
        {rooms.length > 0 && form.rooms.length < 5 ? (
          <div className="actions">
            <button type="button" className="btn" onClick={() => set({ rooms: [...form.rooms, { roomOptionId: rooms[0]!.id, travellers: [firstTraveller()] }], extras: [] })}>
              {t('admin.pricing.preview.addRoom')}
            </button>
          </div>
        ) : null}
        {offersNights ? (
          <div className="inline-form">
            <TextField id="preview-before" label={t('admin.pricing.preview.nightsBefore')} type="number" min={0} max={pkg.maxExtraNightsBefore} inputMode="numeric" value={form.extraNightsBefore} onChange={(v) => set({ extraNightsBefore: v })} />
            <TextField id="preview-after" label={t('admin.pricing.preview.nightsAfter')} type="number" min={0} max={pkg.maxExtraNightsAfter} inputMode="numeric" value={form.extraNightsAfter} onChange={(v) => set({ extraNightsAfter: v })} />
          </div>
        ) : null}
        {pkg.extras.length > 0 ? (
          <fieldset className="stack">
            <legend>{t('admin.pricing.preview.extras')}</legend>
            {pkg.extras.map((x) => {
              const chosen = form.extras.find((e) => (e.extraId === x.id));
              const perBooking = x.pricingUnit === 'per_booking';
              return (
                <div key={x.id} className="stack">
                  <CheckField
                    id={`preview-extra-${x.id}`} label={`${names.extra(x.id)} (${t(`admin.catalogue.pricingUnits.${x.pricingUnit}`)})`} checked={chosen !== undefined}
                    onChange={(on) => set({ extras: on ? [...form.extras, { extraId: x.id, slots: perBooking ? [] : Array.from({ length: slots }, (_v, k) => k + 1), quantity: '1' }] : form.extras.filter((e) => e.extraId !== x.id) })}
                  />
                  {chosen && perBooking ? (
                    <TextField
                      id={`preview-quantity-${x.id}`} label={t('admin.pricing.preview.quantity', { extra: names.extra(x.id) })} type="number" min={1} max={x.maxPerBooking ?? 1} inputMode="numeric" value={chosen.quantity}
                      onChange={(v) => set({ extras: form.extras.map((e) => (e.extraId === x.id ? { ...e, quantity: v } : e)) })}
                    />
                  ) : null}
                  {chosen && !perBooking ? (
                    <div className="actions" role="group" aria-label={t('admin.pricing.preview.whoTakes', { extra: names.extra(x.id) })}>
                      {Array.from({ length: slots }, (_v, k) => k + 1).map((slot) => (
                        <label key={slot} htmlFor={`preview-slot-${x.id}-${slot}`}>
                          <input
                            id={`preview-slot-${x.id}-${slot}`} type="checkbox" checked={chosen.slots.includes(slot)}
                            onChange={(e) => set({ extras: form.extras.map((c) => (c.extraId === x.id ? { ...c, slots: e.target.checked ? [...c.slots, slot] : c.slots.filter((s) => s !== slot) } : c)) })}
                          />{' '}
                          {t('admin.pricing.preview.traveller', { number: slot })}
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        ) : null}
        <TextField id="preview-promo" label={t('admin.pricing.preview.promo')} hint={t('admin.pricing.preview.promoHint')} maxLength={40} value={form.promoCode} onChange={(v) => set({ promoCode: v })} />
        <div className="actions">
          <button className="btn" type="submit" disabled={runner.busy || form.rooms.length === 0}>
            {t('admin.pricing.preview.price')}
          </button>
        </div>
        {runner.status}
      </form>
      <Live>{result ? <Breakdown breakdown={result.breakdown} trace={result.trace} names={names} ruleNames={ruleNames} versionLabel={versions.find((v) => v.id === result.breakdown.priceVersionId)?.label ?? ''} /> : null}</Live>
    </Section>
  );
}

function Breakdown({ breakdown: b, trace, names, ruleNames, versionLabel }: { breakdown: PriceBreakdownJson; trace: Trace; names: Names; ruleNames: Map<string, string>; versionLabel: string }) {
  const money = (minor: string) => (formatMinor(minor, b.currency));
  return (
    <div className="stack" data-testid="preview-result">
      <h3>{t('admin.pricing.preview.resultTitle')}</h3>
      <p>{t('admin.pricing.preview.pricedWith', { version: versionLabel || t('admin.pricing.preview.thisVersion'), from: formatDay(b.departureDate), to: formatDay(b.returnDate) })}</p>
      <p className="quote-total">
        <span>{t('admin.pricing.preview.total')}</span> <strong data-testid="preview-total">{money(b.totalMinor)}</strong>
      </p>
      <div className="table-wrap">
        <table className="table">
          <caption>{t('admin.pricing.preview.linesCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.pricing.preview.columns.item')}</th>
              <th scope="col">{t('admin.pricing.preview.columns.quantity')}</th>
              <th scope="col">{t('admin.pricing.preview.columns.each')}</th>
              <th scope="col">{t('admin.pricing.preview.columns.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {b.lines.map((l) => (
              <tr key={l.key}>
                <th scope="row">
                  {lineText(l, names, b, ruleNames)}
                  {l.cappedFromMinor !== null ? <span className="field__hint"> {t('admin.pricing.preview.capped', { was: money(l.cappedFromMinor) })}</span> : null}
                </th>
                <td>{l.quantity}</td>
                <td>{formatLineAmount(l.direction, l.unitAmountMinor, b.currency)}</td>
                <td>{formatLineAmount(l.direction, l.amountMinor, b.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="quote-terms">
        <dt>{t('admin.pricing.preview.accommodation')}</dt>
        <dd>{money(b.subtotals.accommodation)}</dd>
        <dt>{t('admin.pricing.preview.participation')}</dt>
        <dd>{money(b.subtotals.participation)}</dd>
        <dt>{t('admin.pricing.preview.extrasTotal')}</dt>
        <dd>{money(b.subtotals.extras)}</dd>
        <dt>{t('admin.pricing.preview.surcharges')}</dt>
        <dd>{money(b.surchargesMinor)}</dd>
        <dt>{t('admin.pricing.preview.discounts')}</dt>
        <dd>{`-${money(b.discountsMinor)}`}</dd>
        {b.depositMinor !== null && b.balanceMinor !== null ? (
          <>
            <dt>{t('admin.pricing.preview.deposit')}</dt>
            <dd data-testid="preview-deposit">{money(b.depositMinor)}</dd>
            <dt>{t('admin.pricing.preview.balance', { date: formatDay(b.balanceDueDate) })}</dt>
            <dd>{money(b.balanceMinor)}</dd>
          </>
        ) : (
          <>
            <dt>{t('admin.pricing.preview.deposit')}</dt>
            <dd>{t('admin.pricing.preview.noDeposit')}</dd>
          </>
        )}
        <dt>{t('admin.pricing.preview.promoStatus')}</dt>
        <dd>{t(`admin.pricing.preview.promoStatuses.${b.promo.status}`)}</dd>
      </dl>
      {trace.length > 0 ? (
        <>
          <h4>{t('admin.pricing.preview.traceTitle')}</h4>
          <ul>
            {trace.map((x) => (
              <li key={x.ruleId}>{t('admin.pricing.preview.traceLine', { rule: ruleNames.get(x.ruleId) ?? t('admin.pricing.preview.line.ruleUnknown'), outcome: t(`admin.pricing.preview.outcomes.${x.outcome}`) })}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
