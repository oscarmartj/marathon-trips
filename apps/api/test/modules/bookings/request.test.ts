// Booking requests through HTTP and a real PostgreSQL (plan docs/plans/2.4-booking-requests.md, sections 4, 7, 8 and 12).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { quoteRequestSchema } from '@mt/shared';
import { QuoteService } from '../../../src/modules/pricing';
import { BOOKING_SETTINGS } from '../../../src/modules/bookings/settings';
import { jsonOf } from '../../../src/modules/bookings/support';
import { SettingsService } from '../../../src/platform/flags/flags.service';
import { STATE_HEADERS, TestApp, makeApp, signInStaff } from '../../support/auth';
import { closeCatalogue, setSale } from '../../support/catalogue';
import { createCode, createRule, freshCode, richWorld } from '../../support/adjustments';
import { OWNERSHIP_MISSES_PER_HOUR } from '../../../src/modules/bookings/ownership';
import type { RichWorld } from '../../support/adjustments';
import { bookingStaff, cleanBookingEvents, contact, customerClient, requestBody } from '../../support/bookings';
import { cardFor, pricedWorld, publishWith } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof bookingStaff>>;
beforeAll(async () => {
  t = await makeApp();
  admin = await bookingStaff(t);
});
afterAll(async () => {
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

/** Pools of a world with room for every row of a table. */
async function widen(w: { entryPoolId: string; roomPoolId: string; extraPoolId: string }, capacity = 1000): Promise<void> {
  for (const id of [w.entryPoolId, w.roomPoolId, w.extraPoolId]) {
    const v = (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } })).version;
    const r = await admin.patch(`/admin/catalogue/pools/${id}`, { capacity, version: v });
    if (r.status !== 200) throw new Error(`widen failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
}
const consumed = async (ids: string[]) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } })).consumed] as const)));
const bookingByRef = (reference: string) => t.prisma.booking.findUniqueOrThrow({ where: { reference }, include: { snapshots: true, claims: true, travellers: true, rooms: true, extras: true, promoRedemptions: true } });

describe('request_snapshot_matches_engine: the request stores exactly what the engine prices, and holds what it needs', () => {
  let w: RichWorld;
  let code: { id: string; code: string };
  beforeAll(async () => {
    w = await richWorld(admin);
    await widen(w);
    code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, valueBps: 1000, appliesTo: 'subtotal' });
  });
  const R = () => ({ participationType: 'runner_with_entry', raceDistanceId: w.distanceId });
  const S = () => ({ participationType: 'supporter' });

  type Row = [string, () => Record<string, unknown>, { rooms: number; entries: number; extras: number }];
  const rows: Row[] = [
    ['occupancy 1: one runner in the double', () => ({ rooms: [{ roomOptionId: w.doubleId, travellers: [R()] }] }), { rooms: 1, entries: 1, extras: 0 }],
    ['occupancy 2: runner and supporter in the double', () => ({ rooms: [{ roomOptionId: w.doubleId, travellers: [R(), S()] }] }), { rooms: 1, entries: 1, extras: 0 }],
    ['occupancy 3: two runners and a supporter in the quad', () => ({ rooms: [{ roomOptionId: w.quadId, travellers: [R(), R(), S()] }] }), { rooms: 1, entries: 2, extras: 0 }],
    ['occupancy 4: four runners in the quad', () => ({ rooms: [{ roomOptionId: w.quadId, travellers: [R(), R(), R(), R()] }] }), { rooms: 1, entries: 4, extras: 0 }],
    ['extra nights: two after, double for two', () => ({ rooms: [{ roomOptionId: w.doubleId, travellers: [R(), S()] }], extraNightsAfter: 2 }), { rooms: 1, entries: 1, extras: 0 }],
    ['supporters only take no entry', () => ({ rooms: [{ roomOptionId: w.doubleId, travellers: [S(), S()] }] }), { rooms: 1, entries: 0, extras: 0 }],
    ['a per-person extra for two of three', () => ({ rooms: [{ roomOptionId: w.quadId, travellers: [R(), R(), S()] }], extras: [{ extraId: w.extraId, travellerSlots: [1, 3] }] }), { rooms: 1, entries: 2, extras: 2 }],
    ['two rooms of one pool are one hold of two', () => ({ rooms: [{ roomOptionId: w.doubleId, travellers: [R()] }, { roomOptionId: w.quadId, travellers: [S(), S()] }] }), { rooms: 2, entries: 1, extras: 0 }],
    ['a promo code, applied and redeemed', () => ({ rooms: [{ roomOptionId: w.doubleId, travellers: [R(), S()] }], promoCode: code.code.toLowerCase() }), { rooms: 1, entries: 1, extras: 0 }],
  ];

  it.each(rows)('%s', async (_name, config, demand) => {
    const c = await customerClient(t);
    const body = { packageId: w.pkg.id, ...config(), contact: contact() };
    const pools = [w.roomPoolId, w.entryPoolId, w.extraPoolId];
    const before = await consumed(pools);
    const res = await c.request(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'requested', isRequest: true, currency: 'AUD' });
    const b = await bookingByRef(res.body.reference);
    const snap = b.snapshots[0]!;
    // The engine, asked again with the same configuration at the request's instant, gives the stored snapshot.
    const { contact: _c, ...rest } = body;
    const configuration = rest as unknown as Record<string, unknown> & { rooms: Array<{ travellers: unknown[] }> };
    const again = await t.prisma.$transaction((tx) => t.app.get(QuoteService).priceWithPromoRef(tx, quoteRequestSchema.parse(configuration), { audience: 'public', now: b.requestedAt }));
    expect(snap.priceBreakdown).toEqual(jsonOf(again.breakdown));
    expect(snap.configuration).toEqual(jsonOf(again.breakdown.configuration));
    expect([b.totalMinor, b.depositMinor, snap.totalMinor, snap.depositMinor]).toEqual([again.breakdown.totalMinor, again.breakdown.depositMinor, again.breakdown.totalMinor, again.breakdown.depositMinor]);
    expect([snap.priceVersionId, snap.engineVersion, b.currentSnapshotVersion]).toEqual([w.versionId, again.breakdown.engineVersion, 1]);
    expect(res.body.totalMinor).toBe(again.breakdown.totalMinor.toString());
    // What it holds, pool by pool, and nothing else.
    const expected: Record<string, number> = {};
    if (demand.rooms) expected[w.roomPoolId] = demand.rooms;
    if (demand.entries) expected[w.entryPoolId] = demand.entries;
    if (demand.extras) expected[w.extraPoolId] = demand.extras;
    expect(Object.fromEntries(b.claims.map((x) => [x.poolId, x.quantity]))).toEqual(expected);
    const after = await consumed(pools);
    expect(Object.fromEntries(pools.map((p) => [p, after[p]! - before[p]!]))).toEqual({ [w.roomPoolId]: demand.rooms, [w.entryPoolId]: demand.entries, [w.extraPoolId]: demand.extras });
    // Places, rooms and extras as they stand.
    const travellers = (configuration.rooms as Array<{ travellers: unknown[] }>).reduce((n, r) => n + r.travellers.length, 0);
    expect(b.travellers.map((x) => x.slot)).toEqual(Array.from({ length: travellers }, (_, i) => i + 1));
    expect(b.travellers.filter((x) => x.isLead).map((x) => x.slot)).toEqual([1]);
    expect(b.rooms).toHaveLength((configuration.rooms as unknown[]).length);
    expect(b.extras.reduce((n, x) => n + x.quantity, 0)).toBe(demand.extras);
    expect(b.promoRedemptions.length).toBe('promoCode' in configuration ? 1 : 0);
    if ('promoCode' in configuration) expect(res.body.price.promo.status).toBe('applied');
  });

  it('price rules: the one in force applies, an expired and a future one do not, as the engine decides at the request instant', async () => {
    const rw = await richWorld(admin);
    const hour = 3_600_000;
    const now = Date.now();
    const active = await createRule(admin, { scopeType: 'package', packageId: rw.pkg.id, kind: 'early_bird', conditions: { minDaysBeforeCheckIn: 1 }, validFrom: new Date(now - hour).toISOString(), validTo: new Date(now + hour).toISOString(), stackable: true });
    const expired = await createRule(admin, { scopeType: 'package', packageId: rw.pkg.id, appliesTo: 'participation', validFrom: new Date(now - 2 * hour).toISOString(), validTo: new Date(now - hour).toISOString(), stackable: true });
    const future = await createRule(admin, { scopeType: 'package', packageId: rw.pkg.id, appliesTo: 'extras', validFrom: new Date(now + hour).toISOString(), stackable: true });
    const c = await customerClient(t);
    const body = { packageId: rw.pkg.id, rooms: [{ roomOptionId: rw.doubleId, travellers: [{ participationType: 'runner_with_entry', raceDistanceId: rw.distanceId }] }], contact: contact() };
    const res = await c.request(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const b = await bookingByRef(res.body.reference);
    const trace = (b.snapshots[0]!.priceBreakdown as { trace: Array<{ ruleId: string; outcome: string }> }).trace;
    expect(Object.fromEntries(trace.map((x) => [x.ruleId, x.outcome]))).toMatchObject({ [active.id]: 'applied', [expired.id]: 'out_of_validity', [future.id]: 'out_of_validity' });
    expect(res.body.price.trace).toBeUndefined();
  });
});

describe('what a request may carry', () => {
  let w: PricedWorld;
  beforeAll(async () => {
    w = await pricedWorld(admin);
  });

  it('client_amount_field_rejected: an amount, a currency, a date or a status anywhere is a 422 and writes nothing', async () => {
    const c = await customerClient(t);
    const base = requestBody(w);
    const room = base.rooms[0]!;
    const bodies: Array<[string, object]> = [
      ...['totalMinor', 'amountMinor', 'priceMinor', 'depositMinor', 'discountMinor', 'total', 'price', 'currency', 'status', 'requestedAt', 'reference', 'customerId'].map((k): [string, object] => [k, { ...base, [k]: '1' }]),
      ['rooms[].priceMinor', { ...base, rooms: [{ ...room, priceMinor: '1' }] }],
      ['rooms[].travellers[].amountMinor', { ...base, rooms: [{ ...room, travellers: [{ ...room.travellers[0], amountMinor: '1' }] }] }],
      ['extras[].amountMinor', { ...base, extras: [{ extraId: w.extraId, travellerSlots: [1], amountMinor: '1' }] }],
      ['contact.email', { ...base, contact: { ...base.contact, email: 'someone.else@example.test' } }],
      ['contact.totalMinor', { ...base, contact: { ...base.contact, totalMinor: '1' } }],
    ];
    for (const [name, body] of bodies) {
      const res = await c.request(body);
      expect([name, res.status, res.body.code]).toEqual([name, 422, 'validation_failed']);
    }
    expect(await t.prisma.customer.count({ where: { userId: c.userId } })).toBe(0);
  });

  it('a request needs an Idempotency-Key header', async () => {
    const c = await customerClient(t);
    const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', c.cookie).send(requestBody(w));
    expect([res.status, res.body.code]).toEqual([422, 'idempotency_key_required']);
  });

  it('request_requires_customer_session and staff_session_cannot_request', async () => {
    const anon = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Idempotency-Key', randomUUID()).send(requestBody(w));
    expect(anon.status).toBe(401);
    const staffCookie = await signInStaff(t, admin.staff);
    const staff = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', staffCookie).set('Idempotency-Key', randomUUID()).send(requestBody(w));
    expect(staff.status).toBe(401);
    expect(await t.prisma.booking.count({ where: { packageId: w.pkg.id } })).toBe(0);
  });

  it('the email is the verified one; the contact is stored on the customer and later requests update it, audited as personal data', async () => {
    const c = await customerClient(t);
    expect((await c.request(requestBody(w))).status).toBe(201);
    const first = await t.prisma.customer.findUniqueOrThrow({ where: { userId: c.userId } });
    expect([first.email, first.givenName, first.countryOfResidence]).toEqual([c.email, 'Ada', 'AU']);
    expect((await c.request(requestBody(w, { contact: contact({ givenName: 'Adaline' }) }))).status).toBe(201);
    const second = await t.prisma.customer.findUniqueOrThrow({ where: { userId: c.userId } });
    expect(second.givenName).toBe('Adaline');
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: first.id, action: 'bookings.customer.updated' } });
    expect(log.changes).toMatchObject({ givenName: '[pii]' });
    expect(JSON.stringify(log.changes)).not.toContain('Adaline');
    const pii = await t.prisma.auditPiiValue.findMany({ where: { auditLogId: log.id } });
    expect(pii.every((p) => p.subjectCustomerId === first.id)).toBe(true);
  });

  it('customer_contact_change_audited_as_pii and snapshot_and_events_carry_no_personal_data', async () => {
    const c = await customerClient(t);
    const marker = `Zq${randomUUID().slice(0, 8)}`;
    const res = await c.request(requestBody(w, { contact: contact({ givenName: marker, familyName: marker }) }));
    expect(res.status).toBe(201);
    const b = await bookingByRef(res.body.reference);
    expect(JSON.stringify(jsonOf(b.snapshots))).not.toContain(marker);
    const events = await t.prisma.outboxEvent.findMany({ where: { aggregateId: b.id } });
    expect(events.map((e) => e.type)).toEqual(['bookings.booking.requested']);
    expect(JSON.stringify(events)).not.toContain(marker);
    const logs = await t.prisma.auditLog.findMany({ where: { OR: [{ entityId: b.id }, { entityId: b.customerId }] } });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logs.map((l) => l.changes))).not.toContain(marker);
  });

  it('country_not_served_waitlists (task 2.6, was country_not_served_409): outside the sales countries the request becomes a waiting list entry; no booking, nothing held', async () => {
    const c = await customerClient(t);
    const pools = await consumed([w.roomPoolId, w.entryPoolId]);
    const res = await c.request(requestBody(w, { contact: contact({ countryOfResidence: 'NZ' }) }));
    expect([res.status, res.body.outcome]).toEqual([201, 'waitlisted']);
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { userId: c.userId } });
    expect(await t.prisma.booking.count({ where: { customerId: customer.id } })).toBe(0);
    expect(await t.prisma.waitlistEntry.count({ where: { customerId: customer.id } })).toBe(1);
    expect(await consumed([w.roomPoolId, w.entryPoolId])).toEqual(pools);
  });

  it('foreign_option_ids_rejected: a room or a distance of another package is a 422 and holds nothing', async () => {
    const other = await pricedWorld(admin);
    const c = await customerClient(t);
    const pools = await consumed([w.roomPoolId, w.entryPoolId, other.roomPoolId]);
    const room = await c.request(requestBody(w, { rooms: [{ roomOptionId: other.roomId, travellers: [{ participationType: 'supporter' }] }] }));
    expect(room.status).toBe(422);
    const distance = await c.request(requestBody(w, { rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'runner_with_entry', raceDistanceId: other.distanceId }] }] }));
    expect(distance.status).toBe(422);
    expect(await consumed([w.roomPoolId, w.entryPoolId, other.roomPoolId])).toEqual(pools);
  });

  it('package_not_open_or_demo_404: a closed package takes no request', async () => {
    const closed = await pricedWorld(admin);
    expect((await setSale(admin, closed.pkg.id, 'closed')).status).toBe(200);
    const c = await customerClient(t);
    const res = await c.request(requestBody(closed));
    expect([res.status, res.body.code]).toEqual([404, 'package_not_found']);
    const unknown = await c.request(requestBody(w, { packageId: randomUUID() }));
    expect([unknown.status, unknown.body.code]).toEqual([404, 'package_not_found']);
  });

  it('promo_not_applied_rejects_request: a code that does not apply is a 409 with the single public answer and writes nothing', async () => {
    const c = await customerClient(t);
    const archived = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id });
    await admin.post(`/admin/pricing/promo-codes/${archived.id}/archive`, { version: archived.version });
    const otherPackage = await createCode(admin, freshCode(), { scopeType: 'package', packageId: (await pricedWorld(admin)).pkg.id });
    const answers = [];
    for (const promoCode of [freshCode(), archived.code, otherPackage.code]) {
      const res = await c.request(requestBody(w, { promoCode }));
      answers.push([res.status, res.body.code, res.body.message]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual([409, 'promo_code_unavailable', 'That code can no longer be used. Remove it to continue.']);
    expect(await t.prisma.booking.count({ where: { packageId: w.pkg.id, customer: { userId: c.userId } } })).toBe(0);
  });

  it('GET by reference: the owner sees the request and the snapshot price; another customer and an unknown reference get the same 404', async () => {
    const a = await customerClient(t);
    const b = await customerClient(t);
    const res = await a.request(requestBody(w));
    const mine = await a.get(res.body.reference);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ reference: res.body.reference, status: 'requested', isRequest: true, totalMinor: res.body.totalMinor });
    expect(mine.body.id).toBeUndefined();
    const theirs = await b.get(res.body.reference);
    const unknown = await b.get('MT-000000');
    expect([theirs.status, theirs.body]).toEqual([unknown.status, unknown.body]);
    expect(theirs.status).toBe(404);
  });
});

describe('idempotency', () => {
  let w: PricedWorld;
  beforeAll(async () => {
    w = await pricedWorld(admin);
  });

  it('request_idempotent_replay: the same key and body give the same booking and hold once', async () => {
    const c = await customerClient(t);
    const key = randomUUID();
    const first = await c.request(requestBody(w), key);
    const again = await c.request(requestBody(w), key);
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.body.reference).toBe(first.body.reference);
    expect(await t.prisma.booking.count({ where: { customer: { userId: c.userId } } })).toBe(1);
    expect((await t.prisma.inventoryClaim.findMany({ where: { booking: { reference: first.body.reference } } })).length).toBe(2);
  });

  it('request_key_reused_other_body_422: another configuration or another contact with the same key', async () => {
    const c = await customerClient(t);
    const key = randomUUID();
    expect((await c.request(requestBody(w), key)).status).toBe(201);
    const config = await c.request(requestBody(w, { extraNightsBefore: 0, rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'supporter' }] }] }), key);
    expect([config.status, config.body.code]).toEqual([422, 'idempotency_key_reused']);
    const person = await c.request(requestBody(w, { contact: contact({ phone: '+61 411 111 111' }) }), key);
    expect([person.status, person.body.code]).toEqual([422, 'idempotency_key_reused']);
  });

  it('request_retry_after_commit_returns_same_booking: without the idempotency record, the key on the booking still answers', async () => {
    const c = await customerClient(t);
    const key = randomUUID();
    const first = await c.request(requestBody(w), key);
    await t.prisma.idempotencyRecord.deleteMany({ where: { key, actorId: c.userId } });
    const again = await c.request(requestBody(w), key);
    expect([again.status, again.body.reference]).toEqual([201, first.body.reference]);
    expect(await t.prisma.booking.count({ where: { customer: { userId: c.userId } } })).toBe(1);
    // the contact is checked too, through its HMAC: another phone with the same key is refused
    await t.prisma.idempotencyRecord.deleteMany({ where: { key, actorId: c.userId } });
    const other = await c.request(requestBody(w, { contact: contact({ phone: '+61 422 222 222' }) }), key);
    expect([other.status, other.body.code]).toEqual([422, 'idempotency_key_reused']);
  });
});

describe('limits per customer', () => {
  it('max_open_requests_per_customer: the fourth open request is refused', async () => {
    const w = await pricedWorld(admin);
    const c = await customerClient(t);
    for (let i = 0; i < 3; i++) expect((await c.request(requestBody(w))).status).toBe(201);
    const fourth = await c.request(requestBody(w));
    expect([fourth.status, fourth.body.code]).toEqual([409, 'too_many_open_requests']);
  });

  it('max_held_places_per_customer: places held by open requests count against the limit', async () => {
    const settings = t.app.get(SettingsService);
    await settings.set(BOOKING_SETTINGS.maxHeldPlaces.key, 3);
    try {
      const w = await pricedWorld(admin);
      const c = await customerClient(t);
      // runner + supporter in the double: 1 room + 1 entry = 2 places
      expect((await c.request(requestBody(w))).status).toBe(201);
      const second = await c.request(requestBody(w));
      expect([second.status, second.body.code]).toEqual([409, 'too_many_places_held']);
      // a single supporter holds 1 room place: 2 + 1 = 3, allowed
      expect((await c.request(requestBody(w, { rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'supporter' }] }] }))).status).toBe(201);
    } finally {
      await t.prisma.setting.deleteMany({ where: { key: BOOKING_SETTINGS.maxHeldPlaces.key } });
    }
  });
});

describe('dates', () => {
  const shift = (packageId: string, checkIn: string, checkOut: string, balance: string) =>
    t.prisma.$executeRawUnsafe(`UPDATE packages SET "checkInDate" = ${checkIn}, "checkOutDate" = ${checkOut}, "balanceDueDate" = ${balance} WHERE id = $1::uuid`, packageId);

  it('package_departed_409: a trip that starts today takes no request', async () => {
    const w = await pricedWorld(admin);
    await shift(w.pkg.id, `(now() AT TIME ZONE 'Australia/Brisbane')::date`, `(now() AT TIME ZONE 'Australia/Brisbane')::date + 3`, `(now() AT TIME ZONE 'Australia/Brisbane')::date - 10`);
    const c = await customerClient(t);
    const res = await c.request(requestBody(w));
    expect([res.status, res.body.code]).toEqual([409, 'package_departed']);
  });

  it('request_expires_at_departure_if_sooner: a trip in two days expires its request at the start of the departure day in Brisbane', async () => {
    const w = await pricedWorld(admin);
    await shift(w.pkg.id, `(now() AT TIME ZONE 'Australia/Brisbane')::date + 2`, `(now() AT TIME ZONE 'Australia/Brisbane')::date + 5`, `(now() AT TIME ZONE 'Australia/Brisbane')::date - 10`);
    const c = await customerClient(t);
    const res = await c.request(requestBody(w));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference } });
    const departure = b.departureDate.toISOString().slice(0, 10);
    expect(b.requestExpiresAt.toISOString()).toBe(new Date(`${departure}T00:00:00.000+10:00`).toISOString());
  });

  it('a request expires 168 hours after it was made by default', async () => {
    const w = await pricedWorld(admin);
    const c = await customerClient(t);
    const res = await c.request(requestBody(w));
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference } });
    expect(b.requestExpiresAt.getTime() - b.requestedAt.getTime()).toBe(168 * 3_600_000);
  });
});

describe('price_change_does_not_alter_snapshot (phase criterion: changing a price after a request does not alter it)', () => {
  it('a new price version, a new rule and an archived code later: the booking, its snapshot and what the customer sees stay the same', async () => {
    const w = await pricedWorld(admin);
    const code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, valueBps: 1000, appliesTo: 'subtotal' });
    const c = await customerClient(t);
    const res = await c.request(requestBody(w, { promoCode: code.code }));
    expect(res.status).toBe(201);
    const read = async () => {
      const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference }, include: { snapshots: true, claims: true, travellers: true, rooms: true, extras: true } });
      return jsonOf(b);
    };
    const before = await read();
    const seenBefore = (await c.get(res.body.reference)).body;
    const quoteBefore = (await t.http().post('/pricing/quotes').set(STATE_HEADERS).send(requestBody(w, { contact: undefined }))).body.totalMinor;

    // Prices change: a dearer version, a big package discount, and the code archived.
    const dearer = cardFor({ roomId: w.roomId, extraId: w.extraId, distanceId: w.distanceId });
    dearer.roomRates = dearer.roomRates.map((r) => ({ ...r, pricePerPersonMinor: String(BigInt(r.pricePerPersonMinor) * 2n) }));
    const newVersion = await publishWith(admin, w.pkg.id, dearer, 'Dearer');
    await createRule(admin, { scopeType: 'package', packageId: w.pkg.id, appliesTo: 'participation', valueBps: 5000, stackable: true });
    expect((await admin.post(`/admin/pricing/promo-codes/${code.id}/archive`, { version: code.version })).status).toBe(200);

    // The price really changed for a new quote...
    const quoteAfter = (await t.http().post('/pricing/quotes').set(STATE_HEADERS).send(requestBody(w, { contact: undefined }))).body;
    expect(quoteAfter.priceVersionId).toBe(newVersion);
    expect(quoteAfter.totalMinor).not.toBe(quoteBefore);
    // ...and nothing about the request did.
    expect(await read()).toEqual(before);
    expect((await c.get(res.body.reference)).body).toEqual(seenBefore);
    expect(seenBefore.totalMinor).toBe(res.body.totalMinor);
  });
});

describe('failures write nothing', () => {
  /** Rows a failed request could have left anywhere: bookings and their parts, codes, stock, events and audit. */
  async function footprint(userId: string, pools: string[], codeId: string) {
    const customer = await t.prisma.customer.findUnique({ where: { userId } });
    const cid = customer?.id ?? '00000000-0000-0000-0000-000000000000';
    return {
      customer: customer ? jsonOf(customer) : null,
      bookings: await t.prisma.booking.count({ where: { customerId: cid } }),
      snapshots: await t.prisma.bookingSnapshot.count({ where: { booking: { customerId: cid } } }),
      travellers: await t.prisma.bookingTraveller.count({ where: { customerId: cid } }),
      rooms: await t.prisma.bookingRoom.count({ where: { booking: { customerId: cid } } }),
      extras: await t.prisma.bookingExtra.count({ where: { booking: { customerId: cid } } }),
      claims: await t.prisma.inventoryClaim.count({ where: { booking: { customerId: cid } } }),
      redemptions: await t.prisma.promoRedemption.count({ where: { promoCodeId: codeId } }),
      redeemedCount: (await t.prisma.promoCode.findUniqueOrThrow({ where: { id: codeId } })).redeemedCount,
      consumed: await Promise.all(pools.map(async (id) => (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } })).consumed)),
      movements: await t.prisma.inventoryMovement.count({ where: { poolId: { in: pools } } }),
      requestedEvents: await t.prisma.outboxEvent.count({ where: { type: 'bookings.booking.requested' } }),
      requestedAudit: await t.prisma.auditLog.count({ where: { action: { startsWith: 'bookings.' } } }),
      redemptionAudit: await t.prisma.auditLog.count({ where: { entityId: codeId } }),
    };
  }

  it('failed_hold_rolls_back_everything: no place left in the last pool, and nothing of the request remains anywhere', async () => {
    const w = await pricedWorld(admin);
    const code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id });
    const pools = [w.roomPoolId, w.entryPoolId, w.extraPoolId];
    // the pool locked last (highest id) is the one that is full, so every earlier hold has already been written
    const last = [...pools].sort().at(-1)!;
    const v = (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: last } })).version;
    expect((await admin.patch(`/admin/catalogue/pools/${last}`, { capacity: 0, version: v })).status).toBe(200);
    const c = await customerClient(t);
    const before = await footprint(c.userId, pools, code.id);
    const res = await c.request(requestBody(w, { promoCode: code.code, extras: [{ extraId: w.extraId, travellerSlots: [1] }] }));
    expect([res.status, res.body.code]).toEqual([409, 'inventory_unavailable']);
    expect(await footprint(c.userId, pools, code.id)).toEqual(before);
    expect(before.customer).toBeNull();
  });

  it('failed_redemption_rolls_back_everything: the code fails at redemption (per-customer limit), after the booking was written; nothing remains', async () => {
    const w = await pricedWorld(admin);
    const code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, maxPerCustomer: 1 });
    const pools = [w.roomPoolId, w.entryPoolId, w.extraPoolId];
    const c = await customerClient(t);
    expect((await c.request(requestBody(w, { promoCode: code.code }))).status).toBe(201);
    const before = await footprint(c.userId, pools, code.id);
    const res = await c.request(requestBody(w, { promoCode: code.code }));
    expect([res.status, res.body.code, res.body.message]).toEqual([409, 'promo_code_unavailable', 'That code can no longer be used. Remove it to continue.']);
    expect(await footprint(c.userId, pools, code.id)).toEqual(before);
  });

  it('no_current_price_version_409: an open package whose version has ended takes no request and writes nothing', async () => {
    const w = await pricedWorld(admin);
    // A state the API never makes (a published version ends only when a successor starts): built as the table owner,
    // with the successor check off for this one statement only.
    const { default: pg } = await import('pg');
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    try {
      // Atomic: if anything fails, the rollback leaves the trigger as it was.
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE price_versions DISABLE TRIGGER price_versions_successor');
      await owner.query(`UPDATE price_versions SET "validTo" = clock_timestamp() WHERE id = $1::uuid`, [w.versionId]);
      await owner.query('SET CONSTRAINTS ALL IMMEDIATE'); // run the other deferred checks now, so the table can be altered again
      await owner.query('ALTER TABLE price_versions ENABLE TRIGGER price_versions_successor');
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK');
      throw err;
    } finally {
      const { rows } = await owner.query<{ tgenabled: string }>(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'price_versions_successor' AND tgrelid = 'price_versions'::regclass`);
      await owner.end();
      expect(rows).toEqual([{ tgenabled: 'O' }]);
    }
    const c = await customerClient(t);
    const res = await c.request(requestBody(w));
    expect([res.status, res.body.code]).toEqual([409, 'no_current_price_version']);
    expect(await t.prisma.customer.count({ where: { userId: c.userId } })).toBe(0);
    expect(await t.prisma.booking.count({ where: { packageId: w.pkg.id } })).toBe(0);
  });
});

describe('guessing references', () => {
  it(`after ${OWNERSHIP_MISSES_PER_HOUR} misses in an hour, even the customer's own reference reads as not found`, async () => {
    const w = await pricedWorld(admin);
    const c = await customerClient(t);
    const mine = (await c.request(requestBody(w))).body.reference as string;
    expect((await c.get(mine)).status).toBe(200);
    for (let i = 0; i < OWNERSHIP_MISSES_PER_HOUR; i++) expect((await c.get(`MT-${String(i).padStart(6, '0')}`)).status).toBe(404);
    const blocked = await c.get(mine);
    const unknown = await c.get('MT-ZZZZZZ');
    expect([blocked.status, blocked.body]).toEqual([unknown.status, unknown.body]);
    expect(blocked.status).toBe(404);
    // another customer is not affected
    const other = await customerClient(t);
    expect((await other.get('MT-ZZZZZZ')).status).toBe(404);
    const theirs = (await other.request(requestBody(w))).body.reference as string;
    expect((await other.get(theirs)).status).toBe(200);
  });
});
