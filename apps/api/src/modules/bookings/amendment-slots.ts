// Places across changes of a booking (task 6.3; plan docs/plans/6.3-booking-amendments.md, sections 4 and 7). Pure.
// The engine numbers travellers 1..N in the order of rooms; a booking's places keep their numbers for life, because
// traveller details hang on them. These functions map one to the other and say what a change changed.
import type { AmendmentTravellerRequest } from '@mt/shared';
import { conflict, unprocessable } from '../../platform/http/api-error';
import type { PriceBreakdown } from '../pricing';
import type { SnapshotConfiguration } from './snapshot-schema';

export type ParticipationType = 'runner_with_entry' | 'runner_own_entry' | 'supporter';

/** The most places a booking can ever number (the snapshot schema's slot limit). */
export const MAX_PLACE_NUMBER = 80;

export interface CurrentPlace {
  slot: number;
  participationType: ParticipationType;
  raceDistanceId: string | null;
  isLead: boolean;
}

export interface NewPlace {
  slot: number;
  participationType: ParticipationType;
  raceDistanceId: string | null;
  isLead: boolean;
  /** The place this one replaces (its details are carried), or null for a new traveller. */
  replacesSlot: number | null;
}

export interface EngineRoom {
  roomOptionId: string;
  travellers: Array<{ participationType: ParticipationType; raceDistanceId?: string }>;
}

export interface PlacePlan {
  rooms: EngineRoom[];
  /** positionToSlot[p - 1] is the place number of engine position p. */
  positionToSlot: number[];
  kept: number[];
  /** Places removed or replaced by this change. */
  retired: number[];
  added: NewPlace[];
}

export type RoomRequest = { roomOptionId: string; travellers: AmendmentTravellerRequest[] };

/**
 * The places of a change from the staff's rooms: every current place either stays (`keepSlot`), is replaced by a new one
 * (`replacesSlot`) or, for staff only, is removed by leaving it out. The lead's place can only go if a new place replaces
 * it, and that place becomes the lead. New places take numbers after the highest one the booking ever used.
 */
export function planPlaces(current: readonly CurrentPlace[], highestEverSlot: number, rooms: readonly RoomRequest[], mayRemove: boolean): PlacePlan {
  const bySlot = new Map(current.map((p) => [p.slot, p]));
  const lead = current.find((p) => p.isLead);
  const used = new Set<number>();
  const use = (slot: number) => {
    if (!bySlot.has(slot)) throw unprocessable('place_unknown', 'That place is not part of this booking');
    if (used.has(slot)) throw unprocessable('place_listed_twice', 'A place is listed twice');
    used.add(slot);
  };
  let next = highestEverSlot;
  const positionToSlot: number[] = [];
  const kept: number[] = [];
  const added: NewPlace[] = [];
  const engineRooms: EngineRoom[] = rooms.map((room) => ({
    roomOptionId: room.roomOptionId,
    travellers: room.travellers.map((t) => {
      if ('keepSlot' in t) {
        use(t.keepSlot);
        const p = bySlot.get(t.keepSlot)!;
        kept.push(p.slot);
        positionToSlot.push(p.slot);
        return { participationType: p.participationType, ...(p.raceDistanceId ? { raceDistanceId: p.raceDistanceId } : {}) };
      }
      if (t.replacesSlot !== undefined) use(t.replacesSlot);
      next += 1;
      if (next > MAX_PLACE_NUMBER) throw conflict('amendment_limit_reached', 'This booking cannot take more changes of travellers. Contact us.');
      const isLead = lead !== undefined && t.replacesSlot === lead.slot;
      added.push({ slot: next, participationType: t.participationType, raceDistanceId: t.raceDistanceId ?? null, isLead, replacesSlot: t.replacesSlot ?? null });
      positionToSlot.push(next);
      return { participationType: t.participationType, ...(t.raceDistanceId ? { raceDistanceId: t.raceDistanceId } : {}) };
    }),
  }));
  const retired = current.filter((p) => !kept.includes(p.slot)).map((p) => p.slot);
  const removed = retired.filter((s) => !added.some((a) => a.replacesSlot === s));
  if (lead && !kept.includes(lead.slot) && !added.some((a) => a.isLead)) throw unprocessable('lead_place_required', "The lead traveller's place can only be replaced, not removed");
  if (removed.length > 0 && !mayRemove) throw unprocessable('place_missing', 'Every place of the booking must be kept');
  return { rooms: engineRooms, positionToSlot, kept, retired, added };
}

/** Keeps every place where it is: the rooms of a configuration, as the customer's changes leave them. */
export function keepAllRooms(configuration: SnapshotConfiguration): RoomRequest[] {
  return configuration.rooms.map((r) => ({ roomOptionId: r.roomOptionId, travellers: r.travellers.map((t) => ({ keepSlot: t.slot })) }));
}

/** Engine positions of a configuration whose travellers carry place numbers (positions follow the order of rooms). */
export function slotToPosition(configuration: Pick<SnapshotConfiguration, 'rooms'>): Map<number, number> {
  const map = new Map<number, number>();
  let p = 0;
  for (const r of configuration.rooms) for (const t of r.travellers) map.set(t.slot, ++p);
  return map;
}

/** A stored configuration (place numbers) as a request for the engine (positions), mandatory extras included. */
export function requestOf(configuration: SnapshotConfiguration): { rooms: EngineRoom[]; extraNightsBefore: number; extraNightsAfter: number; extras: Array<{ extraId: string; travellerSlots?: number[]; quantity?: number }> } {
  const pos = slotToPosition(configuration);
  return {
    rooms: configuration.rooms.map((r) => ({ roomOptionId: r.roomOptionId, travellers: r.travellers.map((t) => ({ participationType: t.participationType, ...(t.raceDistanceId ? { raceDistanceId: t.raceDistanceId } : {}) })) })),
    extraNightsBefore: configuration.extraNightsBefore,
    extraNightsAfter: configuration.extraNightsAfter,
    extras: configuration.extras.map((e) => (e.travellerSlots.length > 0 ? { extraId: e.extraId, travellerSlots: e.travellerSlots.map((s) => pos.get(s)!) } : { extraId: e.extraId, quantity: e.quantity })),
  };
}

const KEY_SLOT = /^([a-z_]+(?::[0-9a-f-]{36})?):(\d{1,2})$/;

/**
 * The engine's breakdown with every traveller slot renamed from engine position to place number: the configuration, the
 * extras' slots, the line keys and slots, and the per-traveller amounts. A bijection on labels; no amount changes.
 */
export function relabelSlots(b: PriceBreakdown, positionToSlot: readonly number[]): PriceBreakdown {
  const to = (p: number): number => {
    const s = positionToSlot[p - 1];
    if (s === undefined) throw new Error(`no place for engine position ${p}`);
    return s;
  };
  return {
    ...b,
    configuration: {
      ...b.configuration,
      rooms: b.configuration.rooms.map((r) => ({ ...r, travellers: r.travellers.map((t) => ({ ...t, slot: to(t.slot) })) })),
      extras: b.configuration.extras.map((e) => ({ ...e, travellerSlots: e.travellerSlots.map(to).sort((x, y) => x - y) })),
    },
    lines: b.lines.map((l) => {
      const m = l.travellerSlot === null ? null : KEY_SLOT.exec(l.key);
      return { ...l, travellerSlot: l.travellerSlot === null ? null : to(l.travellerSlot), key: m ? `${m[1]}:${to(Number(m[2]))}` : l.key };
    }),
    perTraveller: b.perTraveller.map((p) => ({ ...p, slot: to(p.slot) })),
  };
}

export type AmendmentChangeKind = 'room' | 'nights' | 'travellers_added' | 'travellers_removed' | 'participation' | 'extras';

/** What a change changed, from the two configurations (both with place numbers) and the places it retired and added. */
export function changesBetween(before: SnapshotConfiguration, after: SnapshotConfiguration, places: Pick<PlacePlan, 'retired' | 'added'>): AmendmentChangeKind[] {
  const out: AmendmentChangeKind[] = [];
  const rooms = (c: SnapshotConfiguration) => c.rooms.map((r) => `${r.roomOptionId}:${r.occupancy}:${r.travellers.map((t) => t.slot).sort((a, b) => a - b).join(',')}`).sort().join('|');
  const replaced = places.added.filter((a) => a.replacesSlot !== null);
  if (rooms(before) !== rooms(after) && !roomsOnlyRenumbered(before, after, replaced)) out.push('room');
  if (before.extraNightsBefore !== after.extraNightsBefore || before.extraNightsAfter !== after.extraNightsAfter) out.push('nights');
  if (places.added.some((a) => a.replacesSlot === null)) out.push('travellers_added');
  if (places.retired.some((s) => !places.added.some((a) => a.replacesSlot === s))) out.push('travellers_removed');
  if (replaced.length > 0) out.push('participation');
  const extras = (c: SnapshotConfiguration, rename: (s: number) => number) => c.extras.map((e) => `${e.extraId}:${e.quantity}:${e.travellerSlots.map(rename).sort((a, b) => a - b).join(',')}`).sort().join('|');
  const renamed = new Map(replaced.map((a) => [a.replacesSlot!, a.slot]));
  if (extras(before, (s) => renamed.get(s) ?? s) !== extras(after, (s) => s)) out.push('extras');
  return out;
}

/** True when the rooms only differ because replaced places took new numbers (a change of distance in the same room). */
function roomsOnlyRenumbered(before: SnapshotConfiguration, after: SnapshotConfiguration, replaced: readonly NewPlace[]): boolean {
  const renamed = new Map(replaced.map((a) => [a.replacesSlot!, a.slot]));
  const key = (c: SnapshotConfiguration, rename: (s: number) => number) =>
    c.rooms.map((r) => `${r.roomOptionId}:${r.occupancy}:${r.travellers.map((t) => rename(t.slot)).sort((a, b) => a - b).join(',')}`).sort().join('|');
  return key(before, (s) => renamed.get(s) ?? s) === key(after, (s) => s);
}

/** The engine's lines as key → amount, for comparing two pricings of the same configuration (the drift check). */
export function linesByKey(b: Pick<PriceBreakdown, 'lines'> | { lines: Array<{ key: string; amountMinor: bigint | string }> }): Map<string, string> {
  return new Map(b.lines.map((l) => [l.key, String(l.amountMinor)]));
}
