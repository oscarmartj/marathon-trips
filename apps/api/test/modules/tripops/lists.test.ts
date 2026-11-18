import { describe, expect, it } from 'vitest';
import type { TripSummary } from '@mt/shared';
import { activeTravellers, buildItinerary, buildRoomingList, buildTransferList, itineraryCsv, roomingCsv, scheduleDay, transfersCsv } from '../../../src/modules/tripops/lists';

const trip: TripSummary = { packageId: 'p', raceName: 'Test Marathon', year: 2027, packageName: 'Race weekend', checkInDate: '2027-06-18', checkOutDate: '2027-06-21', bookings: 1 };
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const people = activeTravellers(
  [{ slot: 1, isLead: true, removedInVersion: null }, { slot: 2, isLead: false, removedInVersion: null }, { slot: 3, isLead: false, removedInVersion: 2 }],
  [{ slot: 1, givenName: '=HYPERLINK("x")', familyName: 'Runner' }, { slot: 3, givenName: 'Gone', familyName: 'Away' }],
);

describe('activeTravellers', () => {
  it('drops removed places, keeps slot order and leaves untyped names null', () => {
    expect(people).toEqual([
      { slot: 1, givenName: '=HYPERLINK("x")', familyName: 'Runner', isLead: true },
      { slot: 2, givenName: null, familyName: null, isLead: false },
    ]);
  });
});

describe('scheduleDay (table)', () => {
  it.each([
    ['2027-06-19 06:30', { date: '2027-06-19', rest: '06:30' }],
    ['2027-06-19T06:30', { date: '2027-06-19', rest: '06:30' }],
    ['2027-06-19', { date: '2027-06-19', rest: null }],
    ['2027-06-19, after lunch', { date: '2027-06-19', rest: 'after lunch' }],
    ['2027-02-30 06:30', null],
    ['2027-13-01', null],
    ['Saturday 6:30', null],
    ['', null],
    [null, null],
  ])('%s', (input, expected) => expect(scheduleDay(input)).toEqual(expected));
});

describe('rooming list builder', () => {
  const hotel = (id: string, name: string, displayOrder: number) => ({ id, name, city: 'Sydney', displayOrder });
  const room = (id: string, h: ReturnType<typeof hotel>, slots: number[]) => ({ id, occupancy: slots.length, travellerSlots: slots, roomType: 'double', roomName: { 'en-AU': 'Double' }, hotel: h });
  const list = buildRoomingList({
    trip,
    bookings: [
      { reference: 'MT-B', status: 'confirmed', checkIn: d('2027-06-18'), checkOut: d('2027-06-21'), travellers: people, rooms: [room('2', hotel('h2', 'Second', 2), [1, 2])] },
      { reference: 'MT-A', status: 'deposit_paid', checkIn: d('2027-06-17'), checkOut: d('2027-06-21'), travellers: people, rooms: [room('1', hotel('h1', 'First', 1), [1]), room('3', hotel('h2', 'Second', 2), [3])] },
    ],
  });
  it('orders hotels by their order, rooms by booking reference, and counts', () => {
    expect(list.hotels.map((h) => h.hotelName)).toEqual(['First', 'Second']);
    expect(list.hotels[1]!.rooms.map((r) => r.bookingReference)).toEqual(['MT-A', 'MT-B']);
    expect(list.totals).toEqual({ rooms: 3, guests: 3, detailsPending: 1 });
  });
  it('a room whose only place was removed stays on the list with no guests, and the CSV keeps its row', () => {
    expect(list.hotels[1]!.rooms[0]!.guests).toEqual([]);
    expect(roomingCsv(list).split('\r\n').filter(Boolean)).toHaveLength(1 + 1 + 1 + 2);
  });
  it('the CSV guards a cell that would run as a formula', () => {
    expect(roomingCsv(list)).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('transfer list builder', () => {
  const row = (over: Record<string, unknown> = {}) => ({ bookingReference: 'MT-A', checkIn: d('2027-06-18'), checkOut: d('2027-06-21'), quantity: 1, travellerSlot: 1 as number | null, travellers: people, ...over });
  it('a per-person row carries its traveller, a per-booking row everyone, and a transfer nobody booked is left out', () => {
    const l = buildTransferList({
      trip,
      extras: [
        { id: 'e1', name: { 'en-AU': 'Airport shuttle' }, pricingUnit: 'per_person', schedule: { departure: '2027-06-18 07:30', origin: 'Airport', destination: 'Hotel' }, rows: [row(), row({ travellerSlot: 2 }), row({ bookingReference: 'MT-B', travellerSlot: 1 })] },
        { id: 'e2', name: { 'en-AU': 'Coach' }, pricingUnit: 'per_booking', schedule: null, rows: [row({ travellerSlot: null })] },
        { id: 'e3', name: { 'en-AU': 'Nobody' }, pricingUnit: 'per_person', schedule: null, rows: [] },
      ],
    });
    expect(l.transfers.map((t) => t.name)).toEqual(['Airport shuttle', 'Coach']);
    expect(l.transfers[0]!.bookings.map((b) => [b.bookingReference, b.quantity, b.passengers.map((p) => p.slot)])).toEqual([['MT-A', 2, [1, 2]], ['MT-B', 1, [1]]]);
    expect(l.transfers[1]).toMatchObject({ departure: null, totalQuantity: 1 });
    expect(l.totals).toEqual({ passengers: 5, detailsPending: 2 });
    expect(transfersCsv(l).split('\r\n')[1]).toContain('Airport shuttle,2027-06-18 07:30,Airport,Hotel,MT-A');
  });
});

describe('itinerary builder', () => {
  const input = { trip, raceName: 'Test Marathon', raceStart: d('2027-06-19'), raceEnd: d('2027-06-19'), raceDatesConfirmed: true, distances: ['Marathon', 'Half marathon'], hotels: ['Harbour Hotel'], extras: [] as Array<{ kind: string; name: unknown; schedule: unknown }> };
  it('numbers the package days and puts check-out last', () => {
    const l = buildItinerary(input);
    expect(l.days.map((x) => [x.date, x.dayNumber, x.items.map((i) => i.kind)])).toEqual([['2027-06-18', 1, ['check_in']], ['2027-06-19', 2, ['race']], ['2027-06-21', 4, ['check_out']]]);
    expect(l.days[1]!.items[0]!.detail).toBe('Marathon; Half marathon');
    expect(l.raceDatesProvisional).toBe(false);
  });
  it('a race outside the package nights gets a day with no number; no race date means no race day', () => {
    expect(buildItinerary({ ...input, raceStart: d('2027-06-25'), raceEnd: null }).days.find((x) => x.date === '2027-06-25')).toMatchObject({ dayNumber: null });
    expect(buildItinerary({ ...input, raceStart: null, raceEnd: null }).days.flatMap((x) => x.items).some((i) => i.kind === 'race')).toBe(false);
  });
  it('a multi-day race gets one item a day, and provisional dates are flagged', () => {
    const l = buildItinerary({ ...input, raceEnd: d('2027-06-20'), raceDatesConfirmed: false });
    expect(l.days.filter((x) => x.items.some((i) => i.kind === 'race')).map((x) => x.date)).toEqual(['2027-06-19', '2027-06-20']);
    expect(l.raceDatesProvisional).toBe(true);
  });
  it('only excursions, transfers and meals are scheduled; text without a day goes to unscheduled', () => {
    const l = buildItinerary({
      ...input,
      extras: [
        { kind: 'excursion', name: { 'en-AU': 'Tour' }, schedule: { departure: '2027-06-20 09:00' } },
        { kind: 'meal', name: { 'en-AU': 'Dinner' }, schedule: null },
        { kind: 'merchandise', name: { 'en-AU': 'Shirt' }, schedule: { departure: '2027-06-20' } },
        { kind: 'other', name: { 'en-AU': 'Other' }, schedule: null },
      ],
    });
    expect(l.days.find((x) => x.date === '2027-06-20')!.items).toEqual([{ kind: 'extra', title: 'Tour', detail: '09:00' }]);
    expect(l.unscheduled).toEqual([{ kind: 'extra', title: 'Dinner', detail: null }]);
    expect(itineraryCsv(l).split('\r\n').filter(Boolean)).toHaveLength(1 + 4 + 1);
  });
});
