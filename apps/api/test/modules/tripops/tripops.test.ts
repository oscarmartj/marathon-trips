// Trip lists (task 7.1): who can read them, which bookings are on them, and that nothing outside each list's whitelist
// leaves the API. The failure paths come first: access, unknown and foreign trips, status, personal data.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOOKING_STATUSES, TRIP_LIST_BOOKING_STATUSES, type BookingStatus } from '@mt/shared';
import { TRIPOPS_PERMISSIONS as P, tripopsManifest } from '../../../src/modules/tripops';
import { TestApp, makeApp } from '../../support/auth';
import { cleanBookingEvents } from '../../support/bookings';
import { Client, anonymous, closeCatalogue, staffClient } from '../../support/catalogue';
import { customerBookingIn } from '../../support/customer-portal';
import { cleanPayments } from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let reader: Client;
beforeAll(async () => {
  t = await makeApp();
  reader = await staffClient(t, [P.read]);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const DOB = '1988-03-14';
const EMERGENCY_NAME = 'Zelda Emergencycontact';
const EMERGENCY_PHONE = '+61 400 777 888';
const FINISH = 13_579;
const base = '/admin/trip-ops';
const BOM = String.fromCharCode(0xfeff);

interface Trip { packageId: string; reference: string; bookingId: string; customerId: string; extraId: string; hotelName: string }

/** A booking in `status` with both travellers' details typed, the way a customer would have saved them. */
async function trip(status: BookingStatus = 'confirmed', names = { a: ['Ana', 'Garcia'], b: ['Luis', 'Perez'] }): Promise<Trip> {
  const who = await (await import('../../support/bookings')).customerClient(t);
  const b = await customerBookingIn(t, who, status);
  const row = await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId }, select: { packageId: true, customerId: true, package: { select: { extras: { select: { id: true } }, hotels: { select: { hotel: { select: { name: true } } } } } } } });
  await t.prisma.traveller.createMany({
    data: [
      { bookingId: b.bookingId, customerId: row.customerId, slot: 1, givenName: names.a[0]!, familyName: names.a[1]!, dateOfBirth: new Date(DOB), emergencyContactName: EMERGENCY_NAME, emergencyContactPhone: EMERGENCY_PHONE, estimatedFinishSeconds: FINISH },
      { bookingId: b.bookingId, customerId: row.customerId, slot: 2, givenName: names.b[0]!, familyName: names.b[1]! },
    ],
  });
  return { packageId: row.packageId, reference: b.reference, bookingId: b.bookingId, customerId: row.customerId, extraId: row.package.extras[0]!.id, hotelName: row.package.hotels[0]!.hotel.name };
}

const rooming = (id: string, q = '') => reader.get(`${base}/trips/${id}/rooming-list${q}`);
const transfers = (id: string, q = '') => reader.get(`${base}/trips/${id}/transfers${q}`);
const itinerary = (id: string, q = '') => reader.get(`${base}/trips/${id}/itinerary${q}`);
const NIL = '00000000-0000-4000-8000-000000000000';
const text = (r: { body: unknown; text?: string }) => (typeof r.text === 'string' && r.text.length > 0 ? r.text : JSON.stringify(r.body));
const PII = [DOB, EMERGENCY_NAME, EMERGENCY_PHONE, String(FINISH), 'dateOfBirth', 'emergencyContact', 'estimatedFinish', 'email', 'phone'];

describe('access', () => {
  it('every route refuses anonymous callers (401) and staff without the permission (403)', async () => {
    const t1 = await trip();
    const none = await staffClient(t, []);
    const other = await staffClient(t, [...(await import('../../../src/modules/keydates')).keydatesManifest.permissions.map((p) => p.key)]);
    const paths = [`${base}/trips`, ...['rooming-list', 'transfers', 'itinerary'].flatMap((k) => [`${base}/trips/${t1.packageId}/${k}`, `${base}/trips/${t1.packageId}/${k}?format=csv`])];
    for (const p of paths) {
      expect([401, 403], `anonymous ${p}`).toContain((await anonymous(t).get(p)).status);
      expect((await none.get(p)).status, `no permission ${p}`).toBe(403);
      expect((await other.get(p)).status, `other module's permission ${p}`).toBe(403);
      expect((await reader.get(p)).status, `reader ${p}`).toBe(200);
    }
  });

  it('the permission is not an API key scope, and the module has exactly one', async () => {
    expect(tripopsManifest.permissions).toHaveLength(1);
    expect(tripopsManifest.permissions.every((p) => p.apiKeyScopable === false && p.requiresStepUp === false)).toBe(true);
    expect(await t.prisma.permission.count({ where: { key: P.read } })).toBe(1);
  });

  it('the routes only read: no POST, PUT, PATCH or DELETE exists', async () => {
    const t1 = await trip();
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await (reader as unknown as Record<string, (p: string, b?: object) => Promise<{ status: number }>>)[m]!(`${base}/trips/${t1.packageId}/rooming-list`, {});
      expect([404, 405], m).toContain(res.status);
    }
  });
});

describe('unknown trips and bad requests', () => {
  it('an unknown trip is a 404 on every list, and a malformed id a 400', async () => {
    for (const k of ['rooming-list', 'transfers', 'itinerary']) {
      expect((await reader.get(`${base}/trips/${NIL}/${k}`)).status, k).toBe(404);
      expect((await reader.get(`${base}/trips/not-a-uuid/${k}`)).status, k).toBe(400);
    }
  });

  it('a deleted package is a 404', async () => {
    const t1 = await trip();
    await t.prisma.package.update({ where: { id: t1.packageId }, data: { deletedAt: new Date() } });
    for (const k of ['rooming-list', 'transfers', 'itinerary']) expect((await reader.get(`${base}/trips/${t1.packageId}/${k}`)).status, k).toBe(404);
    expect((await reader.get(`${base}/trips`)).body.items.some((i: { packageId: string }) => i.packageId === t1.packageId)).toBe(false);
  });

  it('an unknown format or query key is a 422', async () => {
    const t1 = await trip();
    for (const q of ['?format=xml', '?format=', '?bookingId=x', '?format=csv&extra=1']) expect((await rooming(t1.packageId, q)).status, q).toBe(422);
  });
});

describe('which bookings are listed', () => {
  it('status_matrix: only a paid deposit onwards is on the rooming and transfers lists', async () => {
    for (const status of BOOKING_STATUSES) {
      const t1 = await trip(status);
      await t.prisma.extra.update({ where: { id: t1.extraId }, data: { kind: 'transfer' } });
      await t.prisma.bookingExtra.create({ data: { bookingId: t1.bookingId, extraId: t1.extraId, quantity: 1, travellerSlot: 1 } }).catch(() => undefined);
      const listed = (TRIP_LIST_BOOKING_STATUSES as readonly string[]).includes(status);
      const r = (await rooming(t1.packageId)).body;
      expect(r.hotels.flatMap((h: { rooms: unknown[] }) => h.rooms), `rooming ${status}`).toHaveLength(listed ? 1 : 0);
      expect(r.trip.bookings, `count ${status}`).toBe(listed ? 1 : 0);
      expect((await transfers(t1.packageId)).body.transfers.length, `transfers ${status}`).toBe(listed ? 1 : 0);
    }
  });

  it('cancelled and expired bookings never appear, even with names typed', async () => {
    for (const status of ['cancelled', 'expired'] as const) {
      const t1 = await trip(status);
      const res = await rooming(t1.packageId, '?format=csv');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('Ana');
      expect(res.text).not.toContain(t1.reference);
    }
  });
});

describe('no personal data outside the whitelist', () => {
  it('the rooming list has names, room and dates only', async () => {
    const t1 = await trip();
    const res = await rooming(t1.packageId);
    expect(res.status).toBe(200);
    const room = res.body.hotels[0].rooms[0];
    expect(Object.keys(room).sort()).toEqual(['bookingReference', 'bookingStatus', 'checkIn', 'checkOut', 'guests', 'occupancy', 'roomName', 'roomType']);
    expect(room.guests).toEqual([
      { slot: 1, givenName: 'Ana', familyName: 'Garcia', isLead: expect.any(Boolean) },
      { slot: 2, givenName: 'Luis', familyName: 'Perez', isLead: expect.any(Boolean) },
    ]);
    expect(Object.keys(res.body.hotels[0]).sort()).toEqual(['city', 'hotelId', 'hotelName', 'rooms']);
    for (const v of PII) expect(JSON.stringify(res.body), v).not.toContain(v);
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { id: t1.customerId }, select: { email: true } });
    expect(JSON.stringify(res.body)).not.toContain(customer.email);
  });

  it('the CSV has the same whitelist and nothing else', async () => {
    const t1 = await trip();
    const res = await rooming(t1.packageId, '?format=csv');
    const [header, ...rows] = res.text.replace(BOM, '').trim().split('\r\n');
    expect(header).toBe('hotel,city,booking_reference,booking_status,room_type,room_name,occupancy,check_in,check_out,guest_slot,given_name,family_name,lead_guest');
    expect(rows).toHaveLength(2);
    for (const v of PII) expect(res.text, v).not.toContain(v);
  });

  it('the transfers list names passengers only: no date of birth, contact or money', async () => {
    const t1 = await trip();
    await t.prisma.extra.update({ where: { id: t1.extraId }, data: { kind: 'transfer', schedule: { departure: '2027-06-18 07:30', origin: 'Airport', destination: 'Hotel' } } });
    await t.prisma.bookingExtra.create({ data: { bookingId: t1.bookingId, extraId: t1.extraId, quantity: 1, travellerSlot: 2 } });
    const res = await transfers(t1.packageId);
    expect(res.status).toBe(200);
    const g = res.body.transfers[0];
    expect(Object.keys(g).sort()).toEqual(['bookings', 'departure', 'destination', 'extraId', 'name', 'origin', 'totalQuantity']);
    expect(Object.keys(g.bookings[0]).sort()).toEqual(['bookingReference', 'checkIn', 'checkOut', 'passengers', 'quantity']);
    expect(g.bookings[0].passengers).toEqual([{ slot: 2, givenName: 'Luis', familyName: 'Perez', isLead: false }]);
    for (const v of [...PII, 'amount', 'price', 'deposit', 'Minor', 'currency']) expect(JSON.stringify(res.body), v).not.toContain(v);
    const csv = await transfers(t1.packageId, '?format=csv');
    expect(csv.text.replace(BOM, '').split('\r\n')[0]).toBe('transfer,departure,origin,destination,booking_reference,check_in,check_out,quantity,passenger_slot,given_name,family_name');
    for (const v of PII) expect(csv.text, v).not.toContain(v);
  });

  it('a per-booking transfer lists everyone still in the booking; a removed place is not listed', async () => {
    const t1 = await trip();
    await t.prisma.extra.update({ where: { id: t1.extraId }, data: { kind: 'transfer', pricingUnit: 'per_booking' } });
    await t.prisma.bookingExtra.create({ data: { bookingId: t1.bookingId, extraId: t1.extraId, quantity: 1, travellerSlot: null } });
    expect((await transfers(t1.packageId)).body.transfers[0].bookings[0].passengers.map((p: { slot: number }) => p.slot)).toEqual([1, 2]);
    await t.prisma.bookingTraveller.update({ where: { bookingId_slot: { bookingId: t1.bookingId, slot: 2 } }, data: { removedInVersion: 2 } });
    expect((await transfers(t1.packageId)).body.transfers[0].bookings[0].passengers.map((p: { slot: number }) => p.slot)).toEqual([1]);
    expect(JSON.stringify((await rooming(t1.packageId)).body)).not.toContain('Luis');
  });

  it('a place without details is listed with null names, and an erased customer shows as stored', async () => {
    const t1 = await trip();
    await t.prisma.traveller.delete({ where: { bookingId_slot: { bookingId: t1.bookingId, slot: 2 } } });
    await t.prisma.traveller.update({
      where: { bookingId_slot: { bookingId: t1.bookingId, slot: 1 } },
      data: { givenName: '[redacted]', familyName: '[redacted]', dateOfBirth: null, emergencyContactName: null, emergencyContactPhone: null, estimatedFinishSeconds: null, anonymisedAt: new Date() },
    });
    const res = await rooming(t1.packageId);
    expect(res.body.hotels[0].rooms[0].guests.map((g: { givenName: string | null; familyName: string | null }) => [g.givenName, g.familyName])).toEqual([['[redacted]', '[redacted]'], [null, null]]);
    expect(res.body.totals.detailsPending).toBe(1);
    expect(res.text ?? '').not.toContain('Ana');
  });
});

describe('one trip never shows another', () => {
  it('cross_trip_leakage: each list holds only its own trip\'s bookings, names and hotel', async () => {
    const a = await trip('confirmed', { a: ['Alpha', 'Aaronson'], b: ['Alina', 'Aaronson'] });
    const b = await trip('confirmed', { a: ['Bravo', 'Bishop'], b: ['Bella', 'Bishop'] });
    await t.prisma.extra.updateMany({ where: { id: { in: [a.extraId, b.extraId] } }, data: { kind: 'transfer' } });
    await t.prisma.bookingExtra.create({ data: { bookingId: a.bookingId, extraId: a.extraId, quantity: 1, travellerSlot: 1 } });
    await t.prisma.bookingExtra.create({ data: { bookingId: b.bookingId, extraId: b.extraId, quantity: 1, travellerSlot: 1 } });
    for (const [mine, theirs, mineName, theirName] of [[a, b, 'Alpha', 'Bravo'], [b, a, 'Bravo', 'Alpha']] as const) {
      for (const fn of [rooming, transfers]) {
        for (const q of ['', '?format=csv']) {
          const res = await fn(mine.packageId, q);
          const body = text(res);
          expect(body).toContain(mineName);
          expect(body).not.toContain(theirName);
          expect(body).not.toContain(theirs.reference);
          expect(body).not.toContain(theirs.hotelName === mine.hotelName ? '\u0000' : theirs.hotelName);
        }
      }
    }
  });

  it('the trip picker holds counts and names of trips, never travellers', async () => {
    const a = await trip();
    const res = await reader.get(`${base}/trips`);
    expect(res.status).toBe(200);
    const mine = res.body.items.find((i: { packageId: string }) => i.packageId === a.packageId);
    expect(mine.bookings).toBe(1);
    expect(Object.keys(mine).sort()).toEqual(['bookings', 'checkInDate', 'checkOutDate', 'packageId', 'packageName', 'raceName', 'year']);
    expect(JSON.stringify(res.body)).not.toContain('Ana');
  });
});

describe('exports', () => {
  it('a download is a CSV attachment with a safe name and no-store, and the JSON is no-store too', async () => {
    const t1 = await trip();
    for (const k of ['rooming-list', 'transfers', 'itinerary']) {
      const csv = await reader.get(`${base}/trips/${t1.packageId}/${k}?format=csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
      expect(csv.headers['cache-control']).toBe('no-store');
      expect(csv.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="${k}-[a-z0-9-]+\\.csv"$`));
      expect(csv.headers['x-content-type-options']).toBe('nosniff');
      const json = await reader.get(`${base}/trips/${t1.packageId}/${k}`);
      expect(json.headers['cache-control']).toBe('no-store');
      expect(json.headers['content-type']).toMatch(/json/);
    }
  });

  it('audit_has_no_personal_data: a view and an export are logged by ids and counts only', async () => {
    const t1 = await trip();
    await rooming(t1.packageId);
    await rooming(t1.packageId, '?format=csv');
    const rows = await t.prisma.auditLog.findMany({ where: { entityId: t1.packageId, action: { startsWith: 'tripops.' } }, orderBy: { occurredAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['tripops.list.viewed', 'tripops.list.exported']);
    const blob = JSON.stringify(rows);
    for (const v of ['Ana', 'Garcia', 'Luis', 'Perez', ...PII.slice(0, 4)]) expect(blob, v).not.toContain(v);
    expect(rows[0]!.changes).toEqual({ _context: { list: 'rooming-list', rows: 1 } });
    expect(await t.prisma.auditPiiValue.count({ where: { auditLogId: { in: rows.map((r) => r.id) } } })).toBe(0);
  });
});

describe('the itinerary', () => {
  it('lists check-in, race days, dated extras and check-out in order, with undated ones apart; no travellers', async () => {
    const t1 = await trip();
    const pkg = await t.prisma.package.findUniqueOrThrow({ where: { id: t1.packageId }, select: { checkInDate: true, checkOutDate: true, editionId: true, extras: { select: { id: true } } } });
    const day = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const checkIn = pkg.checkInDate.toISOString().slice(0, 10);
    await t.prisma.raceEdition.update({ where: { id: pkg.editionId }, data: { startDate: new Date(day(pkg.checkInDate, 1)), endDate: new Date(day(pkg.checkInDate, 1)), dateStatus: 'provisional' } });
    await t.prisma.extra.update({ where: { id: pkg.extras[0]!.id }, data: { kind: 'transfer', name: { 'en-AU': 'Race morning shuttle' }, schedule: { departure: `${day(pkg.checkInDate, 1)} 05:15`, origin: 'Hotel', destination: 'Start line' } } });
    const undated = await t.prisma.extra.create({ data: { packageId: t1.packageId, kind: 'excursion', name: { 'en-AU': 'Harbour cruise' }, description: {}, pricingUnit: 'per_person', schedule: { departure: 'Afternoon, day after the race' } } });
    const gone = await t.prisma.extra.create({ data: { packageId: t1.packageId, kind: 'excursion', name: { 'en-AU': 'Deleted outing' }, description: {}, pricingUnit: 'per_person', deletedAt: new Date() } });
    const merch = await t.prisma.extra.create({ data: { packageId: t1.packageId, kind: 'merchandise', name: { 'en-AU': 'Souvenir shirt' }, description: {}, pricingUnit: 'per_person' } });
    expect([undated.id, gone.id, merch.id]).toHaveLength(3);
    const res = await itinerary(t1.packageId);
    expect(res.status).toBe(200);
    const days = res.body.days as Array<{ date: string; dayNumber: number | null; items: Array<{ kind: string; title: string; detail: string | null }> }>;
    expect(days.map((d) => d.date)).toEqual([...days.map((d) => d.date)].sort());
    expect(days[0]).toMatchObject({ date: checkIn, dayNumber: 1 });
    expect(days[0]!.items[0]).toMatchObject({ kind: 'check_in', detail: t1.hotelName });
    const raceDay = days.find((d) => d.date === day(pkg.checkInDate, 1))!;
    expect(raceDay.items.map((i) => i.kind)).toEqual(['race', 'extra']);
    expect(raceDay.items[1]).toEqual({ kind: 'extra', title: 'Race morning shuttle', detail: '05:15 | Hotel to Start line' });
    expect(days.at(-1)!.items.at(-1)).toMatchObject({ kind: 'check_out' });
    expect(res.body.unscheduled).toEqual([{ kind: 'extra', title: 'Harbour cruise', detail: 'Afternoon, day after the race' }]);
    expect(res.body.raceDatesProvisional).toBe(true);
    const all = JSON.stringify(res.body);
    for (const v of ['Ana', 'Garcia', 'Luis', 'Perez', t1.reference, 'Deleted outing', 'Souvenir shirt']) expect(all, v).not.toContain(v);
  });
});
