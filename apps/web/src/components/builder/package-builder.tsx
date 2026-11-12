'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import {
  allRooms, builderToSearch, defaultRoom, defaultTraveller, eligibleSlots, PARTICIPATION_ORDER, quoteErrorKey, UI_MAX_ROOMS,
  type BuilderState, type ParticipationType, type RoomState,
} from '@/lib/builder';
import { localisedText, type PackageDetail, type PackageExtra, type PackageRoom } from '@/lib/catalogue';
import { t } from '@/lib/i18n';
import { createQuoteLoader, type QuoteOutcome } from '@/lib/quote-loader';
import { QuoteSummary } from './quote-summary';

const DEBOUNCE_MS = 300;
const range = (lo: number, hi: number): number[] => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
const limits = (r: PackageRoom) => ({ min: Math.min(4, Math.max(1, r.minOccupancy)), max: Math.min(4, Math.max(1, r.maxOccupancy)) });
const availabilitySuffix = (a: string): string => (a === 'low' || a === 'none' ? ` (${t(`builder.availability.${a}`)})` : '');

type Pending = { state: 'pending' } | QuoteOutcome;

/**
 * The package builder. It holds the visitor's choices and asks the API what they cost; it never works out a price.
 * The address bar follows the choices so a configuration can be shared or reloaded.
 */
export function PackageBuilder({ pkg, initial, urlBase }: { pkg: PackageDetail; initial: BuilderState; urlBase: string }) {
  const [state, setState] = useState<BuilderState>(initial);
  const [result, setResult] = useState<Pending>({ state: 'pending' });
  const loader = useRef<ReturnType<typeof createQuoteLoader> | null>(null);

  useEffect(() => {
    loader.current = createQuoteLoader(
      (request) => api('/pricing/quotes', { method: 'POST', body: request }),
      (outcome) => setResult(outcome),
    );
  }, []);

  useEffect(() => {
    setResult({ state: 'pending' });
    const timer = setTimeout(() => {
      window.history.replaceState(null, '', `${urlBase}&${builderToSearch(state)}`);
      void loader.current?.(pkg, state);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pkg, state, urlBase]);

  const mandatory = pkg.extras.filter((x) => x.mandatory);
  const optional = pkg.extras.filter((x) => !x.mandatory);
  const set = (patch: Partial<BuilderState>) => setState((s) => ({ ...s, ...patch }));
  const setRoom = (index: number, room: RoomState) => set({ rooms: state.rooms.map((r, i) => (i === index ? room : r)) });

  function changeRoomType(index: number, roomId: string) {
    const room = allRooms(pkg).find((r) => r.id === roomId);
    if (!room) return;
    const { min, max } = limits(room);
    const kept = state.rooms[index]!.travellers.slice(0, max);
    while (kept.length < min) kept.push(defaultTraveller(pkg));
    setRoom(index, { roomOptionId: roomId, travellers: kept });
  }

  function changeOccupancy(index: number, count: number) {
    const travellers = state.rooms[index]!.travellers.slice(0, count);
    while (travellers.length < count) travellers.push(defaultTraveller(pkg));
    setRoom(index, { ...state.rooms[index]!, travellers });
  }

  function changeTraveller(roomIndex: number, travellerIndex: number, type: ParticipationType, distanceId: string) {
    const room = state.rooms[roomIndex]!;
    setRoom(roomIndex, {
      ...room,
      travellers: room.travellers.map((tr, i) => (i === travellerIndex ? { type, distanceId: type === 'runner_with_entry' ? (distanceId || (pkg.entries[0]?.distance.id ?? '')) : '' } : tr)),
    });
  }

  function toggleSlot(extra: PackageExtra, slot: number, on: boolean) {
    const slots = new Set(state.extras[extra.id]?.slots ?? []);
    if (on) slots.add(slot);
    else slots.delete(slot);
    set({ extras: { ...state.extras, [extra.id]: { slots: [...slots].sort((a, b) => a - b), quantity: 0 } } });
  }

  const offered = PARTICIPATION_ORDER.filter((p) => pkg.participation.includes(p) && (p !== 'runner_with_entry' || pkg.entries.length > 0));

  return (
    <div className="builder">
      <form className="stack" onSubmit={(e) => e.preventDefault()} aria-label={t('races.build.title')}>
        <h2>{t('builder.roomsHeading')}</h2>
        <p className="field__hint">{t('builder.travellerLimits', { min: pkg.minTravellers, max: pkg.maxTravellers })}</p>
        {state.rooms.map((room, ri) => {
          const current = allRooms(pkg).find((r) => r.id === room.roomOptionId);
          const { min, max } = current ? limits(current) : { min: 1, max: 1 };
          return (
            <fieldset key={ri} className="stack">
              <legend>{t('builder.roomHeading', { number: ri + 1 })}</legend>
              <div className="field">
                <label htmlFor={`room-${ri}`}>{t('builder.roomChoice')}</label>
                <select id={`room-${ri}`} value={room.roomOptionId} onChange={(e) => changeRoomType(ri, e.target.value)}>
                  {pkg.hotels.map((h) => (
                    <optgroup key={h.id} label={h.name}>
                      {h.rooms.map((r) => (
                        <option key={r.id} value={r.id} disabled={r.availability === 'none' && r.id !== room.roomOptionId}>
                          {localisedText(r.name)}{availabilitySuffix(r.availability)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              {min < max ? (
                <div className="field">
                  <label htmlFor={`occupancy-${ri}`}>{t('builder.occupancy')}</label>
                  <select id={`occupancy-${ri}`} value={room.travellers.length} onChange={(e) => changeOccupancy(ri, Number(e.target.value))}>
                    {range(min, max).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              ) : null}
              {room.travellers.map((tr, ti) => (
                <div key={ti} className="traveller">
                  <h3>{t('builder.travellerHeading', { number: travellersBefore(state, ri) + ti + 1 })}</h3>
                  <div className="field">
                    <label htmlFor={`type-${ri}-${ti}`}>{t('builder.participation')}</label>
                    <select id={`type-${ri}-${ti}`} value={tr.type} onChange={(e) => changeTraveller(ri, ti, e.target.value as ParticipationType, tr.distanceId)}>
                      {offered.map((p) => <option key={p} value={p}>{t(`builder.participationTypes.${p}`)}</option>)}
                    </select>
                  </div>
                  {tr.type === 'runner_with_entry' ? (
                    <div className="field">
                      <label htmlFor={`distance-${ri}-${ti}`}>{t('builder.distance')}</label>
                      <select id={`distance-${ri}-${ti}`} value={tr.distanceId} onChange={(e) => changeTraveller(ri, ti, tr.type, e.target.value)}>
                        {pkg.entries.map((en) => (
                          <option key={en.id} value={en.distance.id} disabled={en.availability === 'none' && en.distance.id !== tr.distanceId}>
                            {localisedText(en.distance.name) || t(`races.distanceKinds.${en.distance.kind}`)}{availabilitySuffix(en.availability)}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>
              ))}
              {state.rooms.length > 1 ? (
                <button type="button" className="link-button" onClick={() => set({ rooms: state.rooms.filter((_, i) => i !== ri) })}>
                  {t('builder.removeRoom', { number: ri + 1 })}
                </button>
              ) : null}
            </fieldset>
          );
        })}
        {state.rooms.length < UI_MAX_ROOMS ? (
          <button type="button" className="btn" onClick={() => { const r = defaultRoom(pkg, state.rooms[state.rooms.length - 1]?.roomOptionId); if (r) set({ rooms: [...state.rooms, r] }); }}>
            {t('builder.addRoom')}
          </button>
        ) : (
          <p className="field__hint">{t('builder.roomLimit', { max: UI_MAX_ROOMS })}</p>
        )}

        {pkg.maxExtraNightsBefore > 0 || pkg.maxExtraNightsAfter > 0 ? (
          <fieldset className="stack">
            <legend>{t('builder.nightsHeading')}</legend>
            <p className="field__hint">{t('builder.nightsIntro')}</p>
            {pkg.maxExtraNightsBefore > 0 ? (
              <div className="field">
                <label htmlFor="nights-before">{t('builder.nightsBefore', { max: pkg.maxExtraNightsBefore })}</label>
                <select id="nights-before" value={state.nightsBefore} onChange={(e) => set({ nightsBefore: Number(e.target.value) })}>
                  {range(0, pkg.maxExtraNightsBefore).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            ) : null}
            {pkg.maxExtraNightsAfter > 0 ? (
              <div className="field">
                <label htmlFor="nights-after">{t('builder.nightsAfter', { max: pkg.maxExtraNightsAfter })}</label>
                <select id="nights-after" value={state.nightsAfter} onChange={(e) => set({ nightsAfter: Number(e.target.value) })}>
                  {range(0, pkg.maxExtraNightsAfter).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {pkg.extras.length > 0 ? (
          <fieldset className="stack">
            <legend>{t('builder.extrasHeading')}</legend>
            {mandatory.length > 0 ? (
              <>
                <h3>{t('builder.extrasIncluded')}</h3>
                <ul>
                  {mandatory.map((x) => <li key={x.id}>{localisedText(x.name)}</li>)}
                </ul>
              </>
            ) : null}
            {optional.map((x) => {
              const slots = eligibleSlots(x, state);
              const chosen = state.extras[x.id];
              const audience = x.availableTo !== 'all' ? <span className="field__hint"> {t(`builder.audience.${x.availableTo}`)}</span> : null;
              if (x.pricingUnit === 'per_booking') {
                const max = x.maxPerBooking ?? 1;
                return (
                  <div key={x.id} className="field">
                    <label htmlFor={`extra-${x.id}`}>{t('builder.extraQuantity', { name: localisedText(x.name) })}{audience}{availabilitySuffix(x.availability)}</label>
                    <select id={`extra-${x.id}`} value={chosen?.quantity ?? 0} disabled={x.availability === 'none' || slots.length === 0}
                      onChange={(e) => set({ extras: { ...state.extras, [x.id]: { slots: [], quantity: Number(e.target.value) } } })}>
                      {range(0, max).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                );
              }
              return (
                <fieldset key={x.id} className="stack" disabled={x.availability === 'none'}>
                  <legend>{t('builder.extraForWho', { name: localisedText(x.name) })}{audience}{availabilitySuffix(x.availability)}</legend>
                  {slots.map((slot) => (
                    <div key={slot} className="field field--check">
                      <label>
                        <input type="checkbox" checked={chosen?.slots.includes(slot) ?? false} onChange={(e) => toggleSlot(x, slot, e.target.checked)} />
                        {t('builder.travellerLabel', { number: slot })}
                      </label>
                    </div>
                  ))}
                </fieldset>
              );
            })}
            {optional.length === 0 ? <p>{t('builder.extrasNone')}</p> : null}
          </fieldset>
        ) : null}
      </form>

      <section className="builder__result" aria-labelledby="result-heading" aria-live="polite" aria-busy={'state' in result}>
        <h2 id="result-heading">{t('builder.resultHeading')}</h2>
        {'state' in result ? <p>{t('builder.updating')}</p> : null}
        {!('state' in result) && result.ok ? <QuoteSummary pkg={pkg} breakdown={result.breakdown} /> : null}
        {!('state' in result) && result.ok ? (
          <p>
            {/* Same configuration, on the request page next to this one (task 2.4); the price is asked again there. */}
            <a className="btn" href={`request${urlBase}&${builderToSearch(state)}`}>
              {t('bookingRequest.requestThisTrip')}
            </a>
          </p>
        ) : null}
        {!('state' in result) && !result.ok ? <p className="form-error" role="alert">{t(quoteErrorKey(result.status))}</p> : null}
      </section>
    </div>
  );
}

/** How many travellers sit in the rooms before this one, so headings count 1, 2, 3 across rooms like the API's slots. */
function travellersBefore(state: BuilderState, roomIndex: number): number {
  return state.rooms.slice(0, roomIndex).reduce((n, r) => n + r.travellers.length, 0);
}
