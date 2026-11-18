// Changes under concurrency, with barriers that force the interleaving (plan docs/plans/6.3-booking-amendments.md,
// sections 5 and 10; lock order Customer → Booking → Package → PromoCode → pools; review M5, m6).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingAmendmentService } from '../../../../src/modules/bookings';
import { BookingAmendmentHooks } from '../../../../src/modules/bookings/amendment-hooks';
import { BookingExpiryService } from '../../../../src/modules/bookings/expiry.service';
import { WaitlistOffersService } from '../../../../src/modules/bookings/waitlist-offers.service';
import { PaymentCoverageService } from '../../../../src/modules/payments/core/coverage.service';
import { PaymentWebhooksService } from '../../../../src/modules/payments/core/webhooks.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../../support/auth';
import { CATALOGUE_AND_PRICING, closeCatalogue, setSale, staffClient } from '../../../support/catalogue';
import type { Client } from '../../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents, customerClient } from '../../../support/bookings';
import { walkTo } from '../../../support/customer-portal';
import { ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, acceptCurrentTerms, cleanPayments, eventFor, onlyAccount, payingCustomer, sendWebhook, sim, simulatorAccount } from '../../../support/payments';
import { AmendWorld, amendWorld, requestIn, runner, supporter } from '../../../support/amendments';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let t: TestApp;
let admin: Client & { staff: { id: string } };
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
// Steps-up last five minutes: every test starts with a fresh one.
beforeEach(async () => {
  await t.prisma.session.updateMany({ where: { userId: (admin as Client & { staff: { id: string } }).staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date() } });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const row = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
const consumed = async (poolId: string) => (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: poolId } })).consumed;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every pool of the world holds exactly what its held claims say, within 0 and its capacity. */
async function stockIsExact(world: AmendWorld): Promise<void> {
  for (const poolId of [world.roomPoolId, world.quadPoolId, world.entryPoolId, world.extraPoolId]) {
    const p = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: poolId } });
    const held = await t.prisma.inventoryClaim.aggregate({ where: { poolId, status: 'held' }, _sum: { quantity: true } });
    expect([poolId, p.consumed]).toEqual([poolId, held._sum.quantity ?? 0]);
    expect(p.consumed).toBeGreaterThanOrEqual(0);
    expect(p.consumed).toBeLessThanOrEqual(p.capacity);
  }
}

/** The plan's active items add up to the booking's total. */
async function planMatches(bookingId: string): Promise<void> {
  const b = await row(bookingId);
  const items = await t.prisma.paymentScheduleItem.aggregate({ where: { bookingId, state: 'active' }, _sum: { amountMinor: true } });
  expect(items._sum.amountMinor).toBe(b.totalMinor);
}

async function walked(world: AmendWorld, rooms: object[], who: { cookie: string } = c) {
  const b = await requestIn(t, who.cookie, world, { rooms });
  await walkTo(t, b.bookingId, 'deposit_paid');
  return b;
}
const double = (world: AmendWorld, n = 2) => [{ roomOptionId: world.doubleId, travellers: n === 2 ? [runner(world), supporter] : [runner(world)] }];
const toQuad = (world: AmendWorld, v = 1) => ({ expectedSnapshotVersion: v, rooms: [{ roomOptionId: world.quadId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [], reasonCode: 'customer_request' });
const toDouble = (world: AmendWorld, v = 1) => ({ ...toQuad(world, v), rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }] });
const nightBody = (world: AmendWorld, v = 1, nights = 1) => ({ ...toDouble(world, v), extraNightsAfter: nights });

async function digestOf(bookingId: string, body: object): Promise<string> {
  const p = await admin.post(`/admin/bookings/${bookingId}/amendments/preview`, body);
  if (p.status !== 200) throw new Error(`preview ${p.status} ${JSON.stringify(p.body)}`);
  return p.body.previewDigest as string;
}
const applyWith = (bookingId: string, body: object, digest: string) => admin.post(`/admin/bookings/${bookingId}/amendments`, { ...body, previewDigest: digest }).set('Idempotency-Key', randomUUID());

/** Waits until the gate is entered; if the gated call ends first, fails with what it answered. */
async function enteredOr(g: { entered: Promise<void> }, call: Promise<unknown>): Promise<void> {
  await Promise.race([g.entered, call.then((r) => { throw new Error(`ended before the gate: ${JSON.stringify((r as { status?: number; body?: unknown }).status ?? r)} ${JSON.stringify((r as { body?: unknown }).body ?? '')}`); })]);
}

/** A gate on a method: the first `times` calls stop inside it (after whatever locks their caller holds) until released. */
function gate<T extends object>(proto: T, method: string, times = 1) {
  const original = (proto as Record<string, (...a: unknown[]) => unknown>)[method]!;
  let inside!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (inside = r));
  const opened = new Promise<void>((r) => (release = r));
  let left = times;
  const spy = vi.spyOn(proto as Record<string, (...a: unknown[]) => unknown>, method as never).mockImplementation(async function (this: unknown, ...args: unknown[]) {
    if (left > 0) {
      left -= 1;
      inside();
      await opened;
    }
    return original.apply(this, args);
  } as never);
  return { entered, release, restore: () => spy.mockRestore() };
}

describe('two changes of one booking', () => {
  it('concurrent_amendments_one_wins: the second waits on the booking and sees the new version', async () => {
    const world = await amendWorld(admin);
    const b = await walked(world, double(world));
    const d1 = await digestOf(b.bookingId, nightBody(world, 1, 1));
    const d2 = await digestOf(b.bookingId, nightBody(world, 1, 2));
    // `moveStock` runs with the booking locked: the first change stops there.
    const g = gate(BookingAmendmentService.prototype, 'moveStock');
    try {
      const first = applyWith(b.bookingId, nightBody(world, 1, 1), d1);
      await enteredOr(g, first);
      const second = applyWith(b.bookingId, nightBody(world, 1, 2), d2);
      await sleep(400);
      g.release();
      const [r1, r2] = await Promise.all([first, second]);
      expect([r1.status, r2.status, r2.body.code]).toEqual([201, 409, 'version_conflict']);
    } finally {
      g.restore();
    }
    expect(await t.prisma.bookingAmendment.count({ where: { bookingId: b.bookingId } })).toBe(1);
    expect((await row(b.bookingId)).currentSnapshotVersion).toBe(2);
    await stockIsExact(world);
    await planMatches(b.bookingId);
  });
});

describe('allotments never go below zero or above capacity', () => {
  it('concurrent_amendments_last_place_never_oversell: two bookings, one quad place', async () => {
    const world = await amendWorld(admin, { quadCapacity: 1 });
    const x = await walked(world, double(world));
    const y = await walked(world, double(world));
    const dx = await digestOf(x.bookingId, toQuad(world));
    const dy = await digestOf(y.bookingId, toQuad(world));
    const g = gate(BookingAmendmentHooks.prototype, 'runPlaces');
    try {
      const first = applyWith(x.bookingId, toQuad(world), dx);
      await enteredOr(g, first);
      const second = applyWith(y.bookingId, toQuad(world), dy);
      await sleep(400);
      g.release();
      const res = await Promise.all([first, second]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(res.find((r) => r.status === 409)!.body.code).toBe('inventory_unavailable');
    } finally {
      g.restore();
    }
    expect(await consumed(world.quadPoolId)).toBe(1);
    await stockIsExact(world);
  });

  it('opposite_room_swaps_do_not_deadlock: two bookings swapping rooms in opposite directions at once', async () => {
    const world = await amendWorld(admin, { quadCapacity: 1, doubleCapacity: 2 });
    const x = await walked(world, double(world));
    const y = await walked(world, [{ roomOptionId: world.quadId, travellers: [runner(world), supporter] }]);
    const dx = await digestOf(x.bookingId, toQuad(world));
    const dy = await digestOf(y.bookingId, toDouble(world));
    const [rx, ry] = await Promise.all([applyWith(x.bookingId, toQuad(world), dx), applyWith(y.bookingId, toDouble(world), dy)]);
    // y always fits (a double place is free); x fits only if y gave the quad back first. Never a 500 or a deadlock.
    expect(ry.status).toBe(201);
    expect(rx.status === 201 || (rx.status === 409 && rx.body.code === 'inventory_unavailable')).toBe(true);
    await stockIsExact(world);
  });

  it('pool_swap_at_capacity_limit: a swap into the last place succeeds; into a full pool it is a 409 and nothing moves', async () => {
    const world = await amendWorld(admin, { quadCapacity: 1, doubleCapacity: 1 });
    const x = await walked(world, double(world));
    expect((await applyWith(x.bookingId, toQuad(world), await digestOf(x.bookingId, toQuad(world)))).status).toBe(201);
    expect([await consumed(world.quadPoolId), await consumed(world.roomPoolId)]).toEqual([1, 0]);
    const z = await walked(world, double(world));
    const claims = await t.prisma.inventoryClaim.findMany({ where: { bookingId: z.bookingId }, orderBy: { id: 'asc' } });
    const r = await applyWith(z.bookingId, toQuad(world), await digestOf(z.bookingId, toQuad(world)));
    expect([r.status, r.body.code]).toEqual([409, 'inventory_unavailable']);
    expect([await consumed(world.quadPoolId), await consumed(world.roomPoolId)]).toEqual([1, 1]);
    expect(await t.prisma.inventoryClaim.findMany({ where: { bookingId: z.bookingId }, orderBy: { id: 'asc' } })).toEqual(claims);
    expect((await row(z.bookingId)).currentSnapshotVersion).toBe(1);
    await stockIsExact(world);
  });
});

describe('waiting list (review M5, m6)', () => {
  async function soldOut(world: AmendWorld) {
    const pkg = await t.prisma.package.findUniqueOrThrow({ where: { id: world.pkgId } });
    const r = await setSale(admin, world.pkgId, 'sold_out', pkg.version);
    if (r.status !== 200) throw new Error(`sold_out ${r.status} ${JSON.stringify(r.body)}`);
  }
  async function join(world: AmendWorld, rooms: object[]) {
    const other = await customerClient(t);
    const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', other.cookie).set('Idempotency-Key', randomUUID())
      .send({ packageId: world.pkgId, rooms, contact: { givenName: 'Wai', familyName: 'Ting', phone: '+61 400 000 001', countryOfResidence: 'AU' } });
    if (res.status !== 201 || res.body.outcome !== 'waitlisted') throw new Error(`join ${res.status} ${JSON.stringify(res.body)}`);
    return { other, entry: await t.prisma.waitlistEntry.findFirstOrThrow({ where: { customer: { userId: other.userId }, packageId: world.pkgId } }) };
  }

  it('amendment_freeing_place_promotes_waitlist: the quad given back is offered in the same transaction', async () => {
    const world = await amendWorld(admin, { quadCapacity: 1 });
    const b = await walked(world, [{ roomOptionId: world.quadId, travellers: [runner(world), supporter] }]);
    await soldOut(world);
    const { entry } = await join(world, [{ roomOptionId: world.quadId, travellers: [runner(world)] }]);
    const d = await digestOf(b.bookingId, toDouble(world));
    expect((await applyWith(b.bookingId, toDouble(world), d)).status).toBe(201);
    expect((await t.prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('offered');
    await stockIsExact(world);
  });

  it('swap_with_waitlist_does_not_steal_target_place: the waiting list is offered only after the change holds its places', async () => {
    const world = await amendWorld(admin, { quadCapacity: 1, doubleCapacity: 1 });
    const b = await walked(world, double(world));
    await soldOut(world);
    // Someone waits for the free quad place (it is free, but the package takes no requests).
    const { entry } = await join(world, [{ roomOptionId: world.quadId, travellers: [runner(world)] }]);
    const d = await digestOf(b.bookingId, toQuad(world));
    const r = await applyWith(b.bookingId, toQuad(world), d);
    expect(r.status).toBe(201);
    expect([await consumed(world.quadPoolId), await consumed(world.roomPoolId)]).toEqual([1, 0]);
    // The double given back does not fit the entry (it asked for the quad): it keeps waiting.
    expect((await t.prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('waiting');
    await stockIsExact(world);
  });

  it('amendment_vs_waitlist_offer_same_pool: an offer accepted while a change moves the same pool keeps the stock exact', async () => {
    const world = await amendWorld(admin, { quadCapacity: 2 });
    const b = await walked(world, [{ roomOptionId: world.quadId, travellers: [runner(world), supporter] }]);
    const holder = await walked(world, [{ roomOptionId: world.quadId, travellers: [runner(world)] }]);
    await soldOut(world);
    const { other, entry } = await join(world, [{ roomOptionId: world.quadId, travellers: [runner(world)] }]);
    // Release the holder's quad by a staff change (quad → double), which offers it to the entry; then race the
    // acceptance against b's change (quad → double), which frees another quad place.
    const dh = await digestOf(holder.bookingId, { ...toDouble(world), rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }] }] });
    expect((await applyWith(holder.bookingId, { ...toDouble(world), rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }] }] }, dh)).status).toBe(201);
    expect((await t.prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('offered');
    const db = await digestOf(b.bookingId, toDouble(world));
    const g = gate(BookingAmendmentHooks.prototype, 'runPlaces');
    try {
      const change = applyWith(b.bookingId, toDouble(world), db);
      await enteredOr(g, change);
      const accept = t.http().post(`/waitlist/entries/${entry.id}/accept`).set(STATE_HEADERS).set('Cookie', other.cookie).send({});
      await sleep(400);
      g.release();
      const [rc, ra] = await Promise.all([change, accept]);
      expect([rc.status, ra.status]).toEqual([201, 200]);
    } finally {
      g.restore();
    }
    await stockIsExact(world);
  });
});

describe('a change against payments, cancellation and the sweeps', () => {
  it('amendment_vs_payment_success_serialised: a webhook holding the booking makes the change wait; plan and coverage agree after', async () => {
    const world = await amendWorld(admin);
    const b = await requestIn(t, c.cookie, world, { rooms: double(world) });
    const ok = await admin.post(`/admin/bookings/${b.bookingId}/approve`, { version: (await row(b.bookingId)).version });
    expect(ok.status).toBe(200);
    await acceptCurrentTerms(t, c, b.reference);
    const body = nightBody(world);
    // Preview while nothing is in progress (a live attempt refuses even the preview).
    await walkTo(t, b.bookingId, 'deposit_paid', 'approved');
    const digest = await digestOf(b.bookingId, body);
    expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
    const p = (await t.prisma.payment.findMany({ where: { bookingId: b.bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
    sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
    const ev = await eventFor(t, acc, p.id);
    expect((await sendWebhook(t, acc, ev)).status).toBe(200);
    const stored = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: ev.eventId } } });
    // Coverage runs inside the webhook's transaction with the booking locked: the webhook stops there.
    const g = gate(PaymentCoverageService.prototype, 'apply');
    try {
      const processing = t.app.get(PaymentWebhooksService).process(stored.id);
      await enteredOr(g, processing);
      const change = applyWith(b.bookingId, body, digest);
      await sleep(400);
      g.release();
      const [outcome, r] = await Promise.all([processing, change]);
      expect(outcome).toBe('processed');
      expect(r.status).toBe(201);
    } finally {
      g.restore();
    }
    await planMatches(b.bookingId);
    const a = await t.prisma.bookingAmendment.findFirstOrThrow({ where: { bookingId: b.bookingId } });
    expect(a.collectedMinor).toBe(p.amountMinor);
    expect((await c.plan(b.reference)).body.outstandingMinor).toBe((a.newTotalMinor - p.amountMinor).toString());
  });

  it('change holding the booking: a live attempt start waits, then the plan it pays is the new one', async () => {
    const world = await amendWorld(admin);
    const b = await requestIn(t, c.cookie, world, { rooms: double(world) });
    expect((await admin.post(`/admin/bookings/${b.bookingId}/approve`, { version: (await row(b.bookingId)).version })).status).toBe(200);
    await acceptCurrentTerms(t, c, b.reference);
    await walkTo(t, b.bookingId, 'confirmed', 'approved');
    const body = nightBody(world);
    const digest = await digestOf(b.bookingId, body);
    const g = gate(BookingAmendmentHooks.prototype, 'runPlaces');
    try {
      const change = applyWith(b.bookingId, body, digest);
      await enteredOr(g, change);
      const pay = c.pay(b.reference, { method: 'card' });
      await sleep(400);
      g.release();
      const [rc, rp] = await Promise.all([change, pay]);
      expect([rc.status, rp.status]).toEqual([201, 201]);
    } finally {
      g.restore();
    }
    const p = (await t.prisma.payment.findMany({ where: { bookingId: b.bookingId } }))[0]!;
    const plan = await c.plan(b.reference);
    // The attempt asked for the first item of the new plan (the deposit), computed after the change committed.
    expect(p.amountMinor.toString()).toBe(plan.body.items[0].amountMinor);
    await planMatches(b.bookingId);
  });

  it('amendment_vs_cancel_and_sweep_lock_ordered: a cancellation and the expiry sweep wait on the booking; no deadlock, stock exact', async () => {
    const world = await amendWorld(admin);
    const b = await walked(world, double(world));
    const digest = await digestOf(b.bookingId, toQuad(world));
    const g = gate(BookingAmendmentHooks.prototype, 'runPlaces');
    try {
      const change = applyWith(b.bookingId, toQuad(world), digest);
      await enteredOr(g, change);
      const cancel = admin.post(`/admin/bookings/${b.bookingId}/cancel`, { version: (await row(b.bookingId)).version, reason: 'Test' });
      const sweep = t.app.get(BookingExpiryService).run();
      const offers = t.app.get(WaitlistOffersService).expireOffers();
      await sleep(400);
      g.release();
      const [rc, rx] = await Promise.all([change, cancel, sweep, offers]);
      expect(rc.status).toBe(201);
      // The cancellation read the old version: 409 (version, or the money cell of a paid booking), never a 500.
      expect(rx.status).toBe(409);
    } finally {
      g.restore();
    }
    expect((await row(b.bookingId)).status).toBe('deposit_paid');
    await stockIsExact(world);
    await planMatches(b.bookingId);
  });
});
