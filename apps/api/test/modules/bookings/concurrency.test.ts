// Booking requests and transitions racing each other on a real PostgreSQL (plan docs/plans/2.4-booking-requests.md,
// sections 4 to 6 and 12). Every loser is a 409 with a code, never a 500, and stock is never oversold or released twice.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bookingRequestSchema } from '@mt/shared';
import { BookingExpiryService } from '../../../src/modules/bookings/expiry.service';
import { BookingRequestService } from '../../../src/modules/bookings/request.service';
import { TRANSACTION_RETRIES } from '../../../src/platform/database/transaction';
import { TestApp, makeApp, signInCustomer } from '../../support/auth';
import { announceEdition, buildWorld, closeCatalogue, pricePackageFully, setSale } from '../../support/catalogue';
import { createCode, freshCode } from '../../support/adjustments';
import { bookingStaff, cleanBookingEvents, contact, customerClient, makeCustomer, requestBody } from '../../support/bookings';
import type { CustomerClient } from '../../support/bookings';
import { must, pricedWorld, text } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

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

const poolOf = (id: string) => t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } });
async function setCapacity(id: string, capacity: number): Promise<void> {
  const p = await poolOf(id);
  const r = await admin.patch(`/admin/catalogue/pools/${id}`, { capacity, version: p.version });
  if (r.status !== 200) throw new Error(`capacity: ${r.status} ${JSON.stringify(r.body)}`);
}
const customers = (n: number) => Promise.all(Array.from({ length: n }, () => customerClient(t)));
const heldBy = async (packageId: string) => (await t.prisma.inventoryClaim.findMany({ where: { booking: { packageId }, status: 'held' } })).reduce((m, c) => ({ ...m, [c.poolId]: (m[c.poolId] ?? 0) + c.quantity }), {} as Record<string, number>);

/** Statuses and codes of settled HTTP answers. */
const outcomes = (rs: Array<{ status: number; body: { code?: string } }>) => rs.map((r) => (r.status === 201 || r.status === 200 ? String(r.status) : `${r.status} ${r.body.code}`));

describe('the last place', () => {
  it.each([['room'], ['entry'], ['extra']] as const)('two_requests_last_place_one_wins: the last %s place goes to one request; the other holds nothing', async (kind) => {
    const w = await pricedWorld(admin);
    const target = { room: w.roomPoolId, entry: w.entryPoolId, extra: w.extraPoolId }[kind];
    for (const id of [w.roomPoolId, w.entryPoolId, w.extraPoolId]) await setCapacity(id, id === target ? 1 : 50);
    const body = requestBody(w, { extras: [{ extraId: w.extraId, travellerSlots: [1] }] });
    const [a, b] = await customers(2);
    const rs = await Promise.all([a!.request(body), b!.request(body)]);
    expect(outcomes(rs).sort()).toEqual(['201', '409 inventory_unavailable']);
    expect(await t.prisma.booking.count({ where: { packageId: w.pkg.id } })).toBe(1);
    expect((await poolOf(target)).consumed).toBe(1);
    // the loser's room, entry and extra were rolled back with it
    expect(await heldBy(w.pkg.id)).toEqual({ [w.roomPoolId]: 1, [w.entryPoolId]: 1, [w.extraPoolId]: 1 });
    for (const id of [w.roomPoolId, w.entryPoolId, w.extraPoolId]) expect((await poolOf(id)).consumed).toBe(1);
  });

  it('concurrent_requests_never_oversell: 20 requests for 7 rooms', async () => {
    const w = await pricedWorld(admin);
    await setCapacity(w.roomPoolId, 7);
    await setCapacity(w.entryPoolId, 50);
    const cs = await customers(20);
    const rs = await Promise.all(cs.map((c) => c.request(requestBody(w))));
    const o = outcomes(rs);
    const won = o.filter((x) => x === '201').length;
    const busy = o.filter((x) => x === '409 busy_try_again').length;
    expect(o.filter((x) => x !== '201').every((x) => x === '409 inventory_unavailable' || x === '409 busy_try_again'), o.join()).toBe(true);
    // never more than the seven places, and every place left unsold is accounted for by a request that lost to load
    expect(won).toBeLessThanOrEqual(7);
    expect(7 - won, o.join()).toBeLessThanOrEqual(busy);
    expect((await poolOf(w.roomPoolId)).consumed).toBe(won);
    expect(await t.prisma.booking.count({ where: { packageId: w.pkg.id } })).toBe(won);
    expect((await heldBy(w.pkg.id))[w.roomPoolId]).toBe(won);
  });
});

describe('opposite_order_requests_do_not_deadlock', () => {
  it('requests that name two room pools in opposite orders all succeed: pools are locked by id', async () => {
    const w = await buildWorld(admin, { priced: false });
    const second = (await must(admin.post(`/admin/catalogue/editions/${w.edition.id}/pools`, { kind: 'room', label: 'quad pool', capacity: 100 }), 'pool', 201)).body.id as string;
    let pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    await must(admin.post(`/admin/catalogue/packages/${w.pkg.id}/hotels/${pkg.hotels[0].id}/rooms`, { roomType: 'quad', name: text('Quad room'), minOccupancy: 1, maxOccupancy: 4, roomPoolId: second }), 'quad', 201);
    await must(admin.put(`/admin/catalogue/packages/${w.pkg.id}/participation`, { types: ['runner_with_entry', 'supporter'] }), 'participation');
    await pricePackageFully(admin, w.pkg.id);
    await must(admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version }), 'publish race');
    await must(announceEdition(admin, w.edition.id), 'announce');
    await must(setSale(admin, w.pkg.id, 'open'), 'open');
    await setCapacity(w.roomPoolId, 100);
    pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    const rooms = pkg.hotels[0].rooms as Array<{ id: string; roomType: string }>;
    const double = rooms.find((r) => r.roomType === 'double')!.id;
    const quad = rooms.find((r) => r.roomType === 'quad')!.id;
    const S = { participationType: 'supporter' };
    const forward = { packageId: w.pkg.id, rooms: [{ roomOptionId: double, travellers: [S] }, { roomOptionId: quad, travellers: [S] }], contact: contact() };
    const backward = { ...forward, rooms: [...forward.rooms].reverse() };
    const cs = await customers(20);
    const deadlocksBefore = TRANSACTION_RETRIES.deadlock;
    const rs = await Promise.all(cs.map((c, i) => c.request(i % 2 === 0 ? forward : backward)));
    const o = outcomes(rs);
    // a deadlock would be retried (and could end as 201 or busy_try_again): runTransaction counts every 40P01 retry
    expect(TRANSACTION_RETRIES.deadlock - deadlocksBefore, o.join()).toBe(0);
    expect(o.filter((x) => x !== '201' && x !== '409 busy_try_again'), o.join()).toEqual([]);
    const won = o.filter((x) => x === '201').length;
    expect([(await poolOf(w.roomPoolId)).consumed, (await poolOf(second)).consumed]).toEqual([won, won]);
    expect(won).toBeGreaterThanOrEqual(18);
  });
});

describe('one customer at a time', () => {
  let w: PricedWorld;
  beforeAll(async () => {
    w = await pricedWorld(admin);
    await setCapacity(w.roomPoolId, 200);
    await setCapacity(w.entryPoolId, 200);
  });

  it('max_open_requests_per_customer_concurrent: six at once, three win', async () => {
    const c = await customerClient(t);
    const rs = await Promise.all(Array.from({ length: 6 }, () => c.request(requestBody(w))));
    expect(outcomes(rs).sort()).toEqual(['201', '201', '201', '409 too_many_open_requests', '409 too_many_open_requests', '409 too_many_open_requests']);
    expect(await t.prisma.booking.count({ where: { customer: { userId: c.userId }, status: 'requested' } })).toBe(3);
  });

  it('first_requests_create_one_customer: three first requests at once give one customer', async () => {
    const c = await customerClient(t);
    const rs = await Promise.all(Array.from({ length: 3 }, () => c.request(requestBody(w))));
    expect(outcomes(rs)).toEqual(['201', '201', '201']);
    expect(await t.prisma.customer.count({ where: { userId: c.userId } })).toBe(1);
  });

  it('first_requests_create_one_customer: a customer without a user and with the verified address is linked once', async () => {
    const c = await customerClient(t);
    const existing = await makeCustomer(t, { email: c.email });
    const rs = await Promise.all(Array.from({ length: 3 }, () => c.request(requestBody(w))));
    expect(outcomes(rs)).toEqual(['201', '201', '201']);
    const rows = await t.prisma.customer.findMany({ where: { email: c.email } });
    expect(rows.map((r) => [r.id, r.userId])).toEqual([[existing, c.userId]]);
    expect(await t.prisma.auditLog.count({ where: { entityId: existing, action: 'bookings.customer.linked' } })).toBe(1);
  });

  it('concurrent_same_key_after_lock_takeover_returns_same_booking: the same key twice at once makes one booking', async () => {
    const s = await signInCustomer(t);
    const svc = t.app.get(BookingRequestService);
    const body = bookingRequestSchema.parse(requestBody(w));
    const key = randomUUID();
    const actor = { type: 'customer' as const, id: s.userId };
    // Straight to the service: as if the idempotency record's lock had run out and a second call took it over.
    const rs = await Promise.allSettled([1, 2].map(() => svc.create({ id: s.userId, email: s.email }, body, key, actor)));
    expect(rs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const [x, y] = rs.map((r) => (r as PromiseFulfilledResult<{ bookingId: string; created: boolean }>).value);
    expect(x!.bookingId).toBe(y!.bookingId);
    expect([x!.created, y!.created].sort()).toEqual([false, true]);
    expect(await t.prisma.inventoryClaim.count({ where: { bookingId: x!.bookingId } })).toBe(2);
  });
});

describe('codes and stock under contention', () => {
  it('request_promo_last_redemption_one_wins: one use left, two requests: one booking with the discount, the other writes nothing', async () => {
    const w = await pricedWorld(admin);
    const code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, maxRedemptions: 1 });
    const [a, b] = await customers(2);
    const rs = await Promise.all([a!, b!].map((c) => c.request(requestBody(w, { promoCode: code.code }))));
    expect(outcomes(rs).sort()).toEqual(['201', '409 promo_code_unavailable']);
    expect(rs.find((r) => r.status === 201)!.body.price.promo.status).toBe('applied');
    expect(await t.prisma.booking.count({ where: { packageId: w.pkg.id } })).toBe(1);
    expect((await poolOf(w.roomPoolId)).consumed).toBe(1);
    expect((await t.prisma.promoCode.findUniqueOrThrow({ where: { id: code.id } })).redeemedCount).toBe(1);
  });
});

describe('transitions racing each other', () => {
  let w: PricedWorld;
  beforeAll(async () => {
    w = await pricedWorld(admin);
    await setCapacity(w.roomPoolId, 200);
    await setCapacity(w.entryPoolId, 200);
  });
  const fresh = async (c: CustomerClient, promo?: string) => {
    const res = await c.request(requestBody(w, promo ? { promoCode: promo } : {}));
    if (res.status !== 201) throw new Error(`request: ${res.status} ${JSON.stringify(res.body)}`);
    return t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference } });
  };
  const expire = (id: string) => t.prisma.$executeRawUnsafe(`UPDATE bookings SET "requestExpiresAt" = "requestedAt" + interval '1 millisecond' WHERE id = $1::uuid`, id);

  it('expire_and_cancel_release_once: the task and a cancellation at once; one wins, stock and code come back once', async () => {
    for (let i = 0; i < 3; i++) {
      const code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id });
      const before = [(await poolOf(w.roomPoolId)).consumed, (await poolOf(w.entryPoolId)).consumed];
      const b = await fresh(await customerClient(t), code.code);
      await expire(b.id);
      const [run, cancel] = await Promise.all([t.app.get(BookingExpiryService).run(), admin.post(`/admin/bookings/${b.id}/cancel`, { version: b.version, reason: 'Race' })]);
      const final = (await t.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status;
      expect(['expired', 'cancelled']).toContain(final);
      if (final === 'cancelled') expect(cancel.status).toBe(200);
      else expect([cancel.status, cancel.body.code]).toEqual([409, 'transition_not_allowed']);
      expect(run.failed).toBe(0);
      expect([(await poolOf(w.roomPoolId)).consumed, (await poolOf(w.entryPoolId)).consumed]).toEqual(before);
      expect((await t.prisma.promoCode.findUniqueOrThrow({ where: { id: code.id } })).redeemedCount).toBe(0);
      expect(await t.prisma.inventoryMovement.count({ where: { bookingId: b.id, reason: 'release' } })).toBe(2);
    }
  });

  it('decline_and_cancel_one_wins: two closings at once; the second is a 409; stock comes back once', async () => {
    const before = (await poolOf(w.roomPoolId)).consumed;
    const b = await fresh(await customerClient(t));
    const rs = await Promise.all([
      admin.post(`/admin/bookings/${b.id}/decline`, { version: b.version, reason: 'Full' }),
      admin.post(`/admin/bookings/${b.id}/cancel`, { version: b.version, reason: 'Duplicate' }),
    ]);
    const o = outcomes(rs);
    expect(o.filter((x) => x === '200')).toHaveLength(1);
    expect(o.filter((x) => x !== '200').every((x) => x === '409 transition_not_allowed' || x === '409 version_conflict')).toBe(true);
    expect((await poolOf(w.roomPoolId)).consumed).toBe(before);
  });

  it('approve_and_expire_one_wins: a due request is expired, never approved, whoever comes first', async () => {
    for (let i = 0; i < 3; i++) {
      const before = (await poolOf(w.roomPoolId)).consumed;
      const b = await fresh(await customerClient(t));
      await expire(b.id);
      const [approve] = await Promise.all([admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version }), t.app.get(BookingExpiryService).run()]);
      expect([409]).toContain(approve.status);
      expect(['request_expired', 'transition_not_allowed']).toContain(approve.body.code);
      expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('expired');
      expect((await poolOf(w.roomPoolId)).consumed).toBe(before);
    }
  });

  it('close_package_while_request_in_flight: requests and closing at once; every booking was made while the package was open', async () => {
    const cw = await pricedWorld(admin);
    await setCapacity(cw.roomPoolId, 100);
    await setCapacity(cw.entryPoolId, 100);
    const cs = await customers(8);
    const version = (await admin.get(`/admin/catalogue/packages/${cw.pkg.id}`)).body.version;
    const [closed, ...rs] = await Promise.all([setSale(admin, cw.pkg.id, 'closed', version), ...cs.map((c) => c.request(requestBody(cw)))]);
    expect(closed.status).toBe(200);
    const o = outcomes(rs);
    expect(o.every((x) => x === '201' || x === '404 package_not_found'), o.join()).toBe(true);
    const pkg = await t.prisma.package.findUniqueOrThrow({ where: { id: cw.pkg.id } });
    const bookings = await t.prisma.booking.findMany({ where: { packageId: cw.pkg.id } });
    expect(bookings).toHaveLength(o.filter((x) => x === '201').length);
    // closing waits for the requests that hold the package (FOR SHARE); none is made after it
    for (const b of bookings) expect(b.requestedAt.getTime()).toBeLessThanOrEqual(pkg.updatedAt.getTime());
    const late = await cs[0]!.request(requestBody(cw));
    expect([late.status, late.body.code]).toEqual([404, 'package_not_found']);
  });
});
