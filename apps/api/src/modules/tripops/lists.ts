import { toCsv, type CsvValue } from '../../platform/common/csv';
import type { Itinerary, ItineraryDay, ItineraryItem, ListedTraveller, RoomingList, TransferGroup, TransferList, TripSummary } from '@mt/shared';

// Pure builders for the trip lists (task 7.1): they take what the service read and return what the API sends. Nothing
// here touches the database, so the rules (who is listed, what is shown) can be tested as tables.

const DAY_MS = 86_400_000;
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const dayNumberOf = (date: string, from: string): number => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The en-AU text of a localised value, else the first text it has, else an empty string. */
export function localText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['en-AU'] === 'string') return o['en-AU'];
    const first = Object.values(o).find((x) => typeof x === 'string');
    if (typeof first === 'string') return first;
  }
  return '';
}

// ---- Travellers of a booking ----

export interface PlaceRow { slot: number; isLead: boolean; removedInVersion: number | null }
/** Only the two name columns of a traveller are ever read (data minimisation). */
export interface NameRow { slot: number; givenName: string; familyName: string }

/** The places that are still in the booking, with the names typed so far (null until typed). */
export function activeTravellers(places: readonly PlaceRow[], names: readonly NameRow[]): ListedTraveller[] {
  const byslot = new Map(names.map((n) => [n.slot, n]));
  return places
    .filter((p) => p.removedInVersion === null)
    .sort((a, b) => a.slot - b.slot)
    .map((p) => ({ slot: p.slot, givenName: byslot.get(p.slot)?.givenName ?? null, familyName: byslot.get(p.slot)?.familyName ?? null, isLead: p.isLead }));
}

/** The people of a booking that are in `slots`, in slot order. A slot that was removed is not listed. */
export const travellersIn = (all: readonly ListedTraveller[], slots: readonly number[]): ListedTraveller[] => all.filter((t) => slots.includes(t.slot));

const pending = (t: ListedTraveller): boolean => t.givenName === null;

// ---- Rooming list ----

export interface RoomingInput {
  trip: TripSummary;
  bookings: ReadonlyArray<{
    reference: string;
    status: string;
    checkIn: Date;
    checkOut: Date;
    travellers: ListedTraveller[];
    rooms: ReadonlyArray<{ id: string; occupancy: number; travellerSlots: number[]; roomType: string; roomName: unknown; hotel: { id: string; name: string; city: string; displayOrder: number } }>;
  }>;
}

export function buildRoomingList(input: RoomingInput): RoomingList {
  const hotels = new Map<string, { displayOrder: number; hotel: RoomingList['hotels'][number] }>();
  let rooms = 0;
  let guests = 0;
  let detailsPending = 0;
  for (const b of [...input.bookings].sort((x, y) => x.reference.localeCompare(y.reference))) {
    for (const r of [...b.rooms].sort((x, y) => x.id.localeCompare(y.id))) {
      const entry = hotels.get(r.hotel.id) ?? { displayOrder: r.hotel.displayOrder, hotel: { hotelId: r.hotel.id, hotelName: r.hotel.name, city: r.hotel.city, rooms: [] } };
      hotels.set(r.hotel.id, entry);
      const people = travellersIn(b.travellers, r.travellerSlots);
      entry.hotel.rooms.push({
        bookingReference: b.reference, bookingStatus: b.status, roomType: r.roomType, roomName: localText(r.roomName), occupancy: r.occupancy,
        checkIn: isoDay(b.checkIn), checkOut: isoDay(b.checkOut), guests: people,
      });
      rooms += 1;
      guests += people.length;
      detailsPending += people.filter(pending).length;
    }
  }
  const ordered = [...hotels.values()].sort((a, b) => a.displayOrder - b.displayOrder || a.hotel.hotelName.localeCompare(b.hotel.hotelName)).map((h) => h.hotel);
  return { trip: input.trip, hotels: ordered, totals: { rooms, guests, detailsPending } };
}

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');
const dash = (v: string | null): string => v ?? '';

export function roomingCsv(list: RoomingList): string {
  const header = ['hotel', 'city', 'booking_reference', 'booking_status', 'room_type', 'room_name', 'occupancy', 'check_in', 'check_out', 'guest_slot', 'given_name', 'family_name', 'lead_guest'];
  const rows: CsvValue[][] = [];
  for (const h of list.hotels) {
    for (const r of h.rooms) {
      const base: CsvValue[] = [h.hotelName, h.city, r.bookingReference, r.bookingStatus, r.roomType, r.roomName, r.occupancy, r.checkIn, r.checkOut];
      if (r.guests.length === 0) rows.push([...base, '', '', '', '']);
      for (const g of r.guests) rows.push([...base, g.slot, dash(g.givenName), dash(g.familyName), yesNo(g.isLead)]);
    }
  }
  return toCsv(header, rows);
}

// ---- Transfers list ----

export interface TransfersInput {
  trip: TripSummary;
  extras: ReadonlyArray<{
    id: string;
    name: unknown;
    pricingUnit: 'per_person' | 'per_booking';
    schedule: unknown;
    rows: ReadonlyArray<{ bookingReference: string; checkIn: Date; checkOut: Date; quantity: number; travellerSlot: number | null; travellers: ListedTraveller[] }>;
  }>;
}

const scheduleOf = (s: unknown): { departure: string | null; origin: string | null; destination: string | null } => {
  const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  const str = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  return { departure: str('departure'), origin: str('origin'), destination: str('destination') };
};

export function buildTransferList(input: TransfersInput): TransferList {
  const transfers: TransferGroup[] = [];
  let passengers = 0;
  let detailsPending = 0;
  for (const e of input.extras) {
    const byBooking = new Map<string, TransferGroup['bookings'][number]>();
    for (const r of [...e.rows].sort((a, b) => a.bookingReference.localeCompare(b.bookingReference) || (a.travellerSlot ?? 0) - (b.travellerSlot ?? 0))) {
      // A per-person transfer carries the traveller it was bought for; one for the whole booking carries everyone still in it.
      const people = e.pricingUnit === 'per_person' && r.travellerSlot !== null ? travellersIn(r.travellers, [r.travellerSlot]) : r.travellers;
      const entry = byBooking.get(r.bookingReference) ?? { bookingReference: r.bookingReference, quantity: 0, checkIn: isoDay(r.checkIn), checkOut: isoDay(r.checkOut), passengers: [] };
      entry.quantity += r.quantity;
      for (const p of people) if (!entry.passengers.some((x) => x.slot === p.slot)) entry.passengers.push(p);
      byBooking.set(r.bookingReference, entry);
    }
    const bookings = [...byBooking.values()].map((b) => ({ ...b, passengers: b.passengers.sort((x, y) => x.slot - y.slot) }));
    if (bookings.length === 0) continue;
    for (const b of bookings) {
      passengers += b.passengers.length;
      detailsPending += b.passengers.filter(pending).length;
    }
    transfers.push({ extraId: e.id, name: localText(e.name), ...scheduleOf(e.schedule), bookings, totalQuantity: bookings.reduce((n, b) => n + b.quantity, 0) });
  }
  transfers.sort((a, b) => (a.departure ?? '￿').localeCompare(b.departure ?? '￿') || a.name.localeCompare(b.name));
  return { trip: input.trip, transfers, totals: { passengers, detailsPending } };
}

export function transfersCsv(list: TransferList): string {
  const header = ['transfer', 'departure', 'origin', 'destination', 'booking_reference', 'check_in', 'check_out', 'quantity', 'passenger_slot', 'given_name', 'family_name'];
  const rows: CsvValue[][] = [];
  for (const t of list.transfers) {
    for (const b of t.bookings) {
      const base: CsvValue[] = [t.name, dash(t.departure), dash(t.origin), dash(t.destination), b.bookingReference, b.checkIn, b.checkOut, b.quantity];
      if (b.passengers.length === 0) rows.push([...base, '', '', '']);
      for (const p of b.passengers) rows.push([...base, p.slot, dash(p.givenName), dash(p.familyName)]);
    }
  }
  return toCsv(header, rows);
}

// ---- Itinerary ----

export interface ItineraryInput {
  trip: TripSummary;
  raceName: string;
  raceStart: Date | null;
  raceEnd: Date | null;
  raceDatesConfirmed: boolean;
  distances: string[];
  hotels: string[];
  extras: ReadonlyArray<{ kind: string; name: unknown; schedule: unknown }>;
}

const SCHEDULED_KINDS = new Set(['excursion', 'transfer', 'meal']);
const DATE_FIRST = /^(\d{4})-(\d{2})-(\d{2})(?:[\sT,;-]+(.*))?$/s;

function validDay(y: string, m: string, d: string): string | null {
  const iso = `${y}-${m}-${d}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDay(parsed) === iso ? iso : null;
}

/** "2027-06-19 06:30" gives the day and "06:30"; any other text has no day. */
export function scheduleDay(departure: string | null): { date: string; rest: string | null } | null {
  const m = departure ? DATE_FIRST.exec(departure.trim()) : null;
  if (!m) return null;
  const date = validDay(m[1]!, m[2]!, m[3]!);
  return date ? { date, rest: m[4]?.trim() || null } : null;
}

export function buildItinerary(input: ItineraryInput): Itinerary {
  const days = new Map<string, ItineraryItem[]>();
  const add = (date: string, item: ItineraryItem) => days.set(date, [...(days.get(date) ?? []), item]);
  const { checkInDate, checkOutDate } = input.trip;
  add(checkInDate, { kind: 'check_in', title: 'Check in', detail: input.hotels.length ? input.hotels.join('; ') : null });
  if (input.raceStart) {
    const start = isoDay(input.raceStart);
    const end = input.raceEnd ? isoDay(input.raceEnd) : start;
    const detail = input.distances.length ? input.distances.join('; ') : null;
    for (let n = 0, d = start; d <= end && n < 14; n += 1, d = isoDay(new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS))) add(d, { kind: 'race', title: input.raceName, detail });
  }
  const unscheduled: ItineraryItem[] = [];
  for (const e of input.extras.filter((x) => SCHEDULED_KINDS.has(x.kind))) {
    const s = scheduleOf(e.schedule);
    const when = scheduleDay(s.departure);
    const route = s.origin || s.destination ? `${s.origin ?? '?'} to ${s.destination ?? '?'}` : null;
    const detail = [when ? when.rest : s.departure, route].filter((x): x is string => !!x).join(' | ') || null;
    const item: ItineraryItem = { kind: 'extra', title: localText(e.name), detail };
    if (when) add(when.date, item);
    else unscheduled.push(item);
  }
  add(checkOutDate, { kind: 'check_out', title: 'Check out', detail: input.hotels.length ? input.hotels.join('; ') : null });
  const rank = { check_in: 0, race: 1, extra: 2, check_out: 3 } as const;
  const ordered: ItineraryDay[] = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => {
      const n = dayNumberOf(date, checkInDate) + 1;
      return { date, dayNumber: date >= checkInDate && date <= checkOutDate ? n : null, items: [...items].sort((a, b) => rank[a.kind] - rank[b.kind]) };
    });
  unscheduled.sort((a, b) => a.title.localeCompare(b.title));
  return { trip: input.trip, days: ordered, unscheduled, raceDatesProvisional: input.raceStart !== null && !input.raceDatesConfirmed };
}

export function itineraryCsv(list: Itinerary): string {
  const header = ['date', 'day', 'kind', 'title', 'detail'];
  const rows: CsvValue[][] = [];
  for (const d of list.days) for (const i of d.items) rows.push([d.date, d.dayNumber, i.kind, i.title, dash(i.detail)]);
  for (const i of list.unscheduled) rows.push(['', '', i.kind, i.title, dash(i.detail)]);
  return toCsv(header, rows);
}
