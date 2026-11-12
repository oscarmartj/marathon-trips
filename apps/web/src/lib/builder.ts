import type { QuoteRequest } from '@mt/shared';
import type { PackageDetail, PackageExtra, PackageRoom } from './catalogue';

// The package builder's model. Nothing here adds, multiplies or rounds money: a quote request is a configuration
// (choices, never an amount) and the answer is shown as the API sent it. The only thing done to an amount is
// formatting its digit string (formatMoney).

// Types only come from @mt/shared, so the validation library stays out of the browser bundle.
export type ParticipationType = 'runner_with_entry' | 'runner_own_entry' | 'supporter';
export const UI_MAX_ROOMS = 4;
export const PARTICIPATION_ORDER: readonly ParticipationType[] = ['runner_with_entry', 'runner_own_entry', 'supporter'];
export const isRunner = (t: ParticipationType): boolean => t !== 'supporter';

export interface TravellerState { type: ParticipationType; distanceId: string }
export interface RoomState { roomOptionId: string; travellers: TravellerState[] }
export interface ExtraState { slots: number[]; quantity: number }
export interface BuilderState { rooms: RoomState[]; nightsBefore: number; nightsAfter: number; extras: Record<string, ExtraState> }

const offeredTypes = (pkg: PackageDetail): ParticipationType[] => PARTICIPATION_ORDER.filter((t) => pkg.participation.includes(t) && (t !== 'runner_with_entry' || pkg.entries.length > 0));
export const allRooms = (pkg: PackageDetail): PackageRoom[] => pkg.hotels.flatMap((h) => h.rooms);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.trunc(n) : lo));
const roomLimits = (r: PackageRoom): { min: number; max: number } => ({ min: clamp(r.minOccupancy, 1, 4), max: clamp(r.maxOccupancy, 1, 4) });

/** A traveller as first offered: a runner with an entry when the package has entries, else the first kind it offers. */
export function defaultTraveller(pkg: PackageDetail): TravellerState {
  const type = offeredTypes(pkg)[0] ?? 'supporter';
  return { type, distanceId: type === 'runner_with_entry' ? (pkg.entries[0]?.distance.id ?? '') : '' };
}

export function defaultRoom(pkg: PackageDetail, roomId?: string): RoomState | null {
  const room = allRooms(pkg).find((r) => r.id === roomId) ?? allRooms(pkg).find((r) => r.availability !== 'none') ?? allRooms(pkg)[0];
  if (!room) return null;
  return { roomOptionId: room.id, travellers: Array.from({ length: roomLimits(room).min }, () => defaultTraveller(pkg)) };
}

export function defaultState(pkg: PackageDetail): BuilderState {
  const room = defaultRoom(pkg);
  return { rooms: room ? [room] : [], nightsBefore: 0, nightsAfter: 0, extras: {} };
}

// ---- URL <-> state. The address holds the choices so a configuration can be shared or reloaded. ----

type Params = Record<string, string | string[] | undefined>;
const all = (p: Params, k: string): string[] => { const v = p[k]; return v === undefined ? [] : Array.isArray(v) ? v : [v]; };
const int = (v: string | undefined): number => (v !== undefined && /^\d{1,3}$/.test(v) ? Number(v) : 0);

/** Reads a configuration from the page's search parameters. Anything unknown or out of range is dropped or clamped, so a bad link never breaks the page. */
export function parseBuilderParams(pkg: PackageDetail, params: Params): BuilderState {
  const base = defaultState(pkg);
  const rooms: RoomState[] = [];
  const types = offeredTypes(pkg);
  for (const raw of all(params, 'r').slice(0, UI_MAX_ROOMS)) {
    const [roomId, ...parts] = raw.split('~');
    const room = allRooms(pkg).find((r) => r.id === roomId);
    if (!room) continue;
    const { min, max } = roomLimits(room);
    const travellers: TravellerState[] = [];
    for (const part of parts.slice(0, max)) {
      const [type, distanceId = ''] = part.split(':');
      if (!types.includes(type as ParticipationType)) continue;
      const entry = pkg.entries.find((e) => e.distance.id === distanceId);
      travellers.push({ type: type as ParticipationType, distanceId: type === 'runner_with_entry' ? (entry?.distance.id ?? pkg.entries[0]?.distance.id ?? '') : '' });
    }
    while (travellers.length < min) travellers.push(defaultTraveller(pkg));
    rooms.push({ roomOptionId: room.id, travellers });
  }
  const extras: Record<string, ExtraState> = {};
  for (const raw of all(params, 'x')) {
    const [id, value = ''] = raw.split(':');
    const extra = pkg.extras.find((e) => e.id === id);
    if (!extra || extra.mandatory) continue;
    extras[extra.id] = extra.pricingUnit === 'per_person'
      ? { slots: [...new Set(value.split(',').filter((s) => /^\d{1,2}$/.test(s)).map(Number).filter((n) => n >= 1))].sort((a, b) => a - b), quantity: 0 }
      : { slots: [], quantity: clamp(int(value), 0, extra.maxPerBooking ?? 1) };
  }
  return {
    rooms: rooms.length > 0 ? rooms : base.rooms,
    nightsBefore: clamp(int(first(params.nb)), 0, pkg.maxExtraNightsBefore),
    nightsAfter: clamp(int(first(params.na)), 0, pkg.maxExtraNightsAfter),
    extras,
  };
}
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The query string for a configuration, in a stable order (the package's own `edition` and `package` parameters are kept by the caller). */
export function builderToSearch(state: BuilderState): string {
  const sp = new URLSearchParams();
  for (const r of state.rooms) sp.append('r', [r.roomOptionId, ...r.travellers.map((t) => (t.type === 'runner_with_entry' ? `${t.type}:${t.distanceId}` : t.type))].join('~'));
  if (state.nightsBefore > 0) sp.set('nb', String(state.nightsBefore));
  if (state.nightsAfter > 0) sp.set('na', String(state.nightsAfter));
  for (const [id, e] of Object.entries(state.extras).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (e.slots.length > 0) sp.append('x', `${id}:${e.slots.join(',')}`);
    else if (e.quantity > 0) sp.append('x', `${id}:${e.quantity}`);
  }
  return sp.toString();
}

// ---- State -> quote request ----

export const travellersOf = (state: BuilderState): TravellerState[] => state.rooms.flatMap((r) => r.travellers);
const eligible = (audience: PackageExtra['availableTo'], t: TravellerState): boolean => audience === 'all' || (audience === 'runners' ? isRunner(t.type) : !isRunner(t.type));

/** Which traveller slots (1-based, across rooms) may take an extra. */
export const eligibleSlots = (extra: PackageExtra, state: BuilderState): number[] =>
  travellersOf(state).flatMap((t, i) => (eligible(extra.availableTo, t) ? [i + 1] : []));

/**
 * The request the API prices: choices only. There is no field for an amount, a date or a rule (the API rejects them,
 * and this function never makes them). Mandatory extras are left out because the API always adds them.
 */
export function toQuoteRequest(pkg: PackageDetail, state: BuilderState): QuoteRequest {
  const extras: QuoteRequest['extras'] = [];
  for (const extra of pkg.extras) {
    const chosen = state.extras[extra.id];
    if (extra.mandatory || !chosen) continue;
    if (extra.pricingUnit === 'per_person') {
      const slots = chosen.slots.filter((s) => eligibleSlots(extra, state).includes(s));
      if (slots.length > 0) extras.push({ extraId: extra.id, travellerSlots: slots });
    } else if (chosen.quantity > 0) extras.push({ extraId: extra.id, quantity: chosen.quantity });
  }
  return {
    packageId: pkg.id,
    rooms: state.rooms.map((r) => ({
      roomOptionId: r.roomOptionId,
      travellers: r.travellers.map((t) => (t.type === 'runner_with_entry' ? { participationType: t.type, raceDistanceId: t.distanceId } : { participationType: t.type })),
    })),
    extraNightsBefore: state.nightsBefore,
    extraNightsAfter: state.nightsAfter,
    extras,
  };
}

// ---- Showing the API's answer ----

/** The message key for a failed quote, chosen by status only (never by reading the API's message). */
export function quoteErrorKey(status: number): string {
  if (status === 0) return 'builder.errors.network';
  if (status === 404) return 'builder.errors.notOpen';
  if (status === 409) return 'builder.errors.notReady';
  if (status === 422) return 'builder.errors.unavailable';
  if (status === 429) return 'builder.errors.tooMany';
  return 'builder.errors.generic';
}

const fractionDigits = (currency: string): number => {
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

/**
 * Formats an amount the API sent as a string of digits in minor units ("123450" AUD is "$1,234.50"). The decimal point
 * is placed by string operations and the decimal string goes to Intl, so no number (and no float) ever holds the money.
 * `sign` puts a minus in front for a discount line.
 */
export function formatMoney(minor: string, currency: string, sign: '' | '-' = ''): string {
  if (!/^-?\d+$/.test(minor)) return '';
  const negative = minor.startsWith('-') !== (sign === '-');
  const digits = minor.replace(/^-/, '').replace(/^0+(?=\d)/, '');
  const places = fractionDigits(currency);
  const padded = digits.padStart(places + 1, '0');
  const decimal = places > 0 ? `${padded.slice(0, -places)}.${padded.slice(-places)}` : padded;
  const text = new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(decimal as Intl.StringNumericLiteral);
  return negative && /[1-9]/.test(digits) ? `-${text}` : text;
}
