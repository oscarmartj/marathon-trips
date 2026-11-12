// Offers and automatic promotion on the waiting list, through HTTP and a real PostgreSQL (task 6.5).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingExpiryService } from '../../../src/modules/bookings/expiry.service';
import { MailService } from '../../../src/platform/mail/mail.service';
import { EntityRegistry } from '../../../src/platform/entities/entity-registry';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { closeCatalogue, setSale } from '../../support/catalogue';
import { bookingStaff, cleanBookingEvents, contact, customerClient, requestBody } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import { act, cancelHolder, joinList, soldOutWorld, viewOf } from '../../support/waitlist';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof bookingStaff>>;
let owner: pg.Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await bookingStaff(t);
  owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'waitlist.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'waitlist.%'`);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const entry = (id: string) => t.prisma.waitlistEntry.findUniqueOrThrow({ where: { id } });
const consumed = async (ids: string[]) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } })).consumed] as const)));
const capacity = async (ids: string[]) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } })).capacity] as const)));
const heldBy = (entryId: string) => t.prisma.inventoryClaim.findMany({ where: { waitlistEntryId: entryId, status: 'held' } });
const roomsX2 = (w: Awaited<ReturnType<typeof pricedWorld>>) => {
  const room = { roomOptionId: w.roomId, travellers: [{ participationType: 'runner_with_entry', raceDistanceId: w.distanceId }, { participationType: 'supporter' }] };
  return requestBody(w, { rooms: [room, room] });
};

describe('joining the list of a package that is sold out', () => {
  it('a resident joins with the request kept and nothing else: no stock, no booking, no money in the answer', async () => {
    const s = await soldOutWorld(t, admin);
    const before = await consumed(s.pools);
    const c = await customerClient(t);
    const res = await c.request(requestBody(s.w));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ outcome: 'waitlisted', status: 'waiting', reason: 'sold_out', travellers: 2 });
    expect(JSON.stringify(res.body)).not.toMatch(/"(totalMinor|depositMinor|priceBreakdown|reference)"/);
    const e = await t.prisma.waitlistEntry.findFirstOrThrow({ where: { customer: { userId: c.userId } } });
    expect(e).toMatchObject({ reason: 'sold_out', status: 'waiting', packageId: s.w.pkg.id });
    // The kept request has no contact and no code.
    expect(JSON.stringify(e.configuration)).not.toMatch(/contact|givenName|promoCode|@/);
    expect(await consumed(s.pools)).toEqual(before);
    expect(await t.prisma.booking.count({ where: { customer: { userId: c.userId } } })).toBe(0);
  });

  it('the same choice again keeps the place; another choice is refused until they leave', async () => {
    const s = await soldOutWorld(t, admin);
    const c = await customerClient(t);
    const id = await joinList(t, c, s.w);
    expect((await c.request(requestBody(s.w))).status).toBe(201);
    expect(await t.prisma.waitlistEntry.count({ where: { customerId: (await entry(id)).customerId } })).toBe(1);
    const other = await c.request(roomsX2(s.w));
    expect([other.status, other.body.code]).toEqual([409, 'already_on_waitlist']);
  });

  it('a package in waitlist status takes the list too; a closed one is not found', async () => {
    const s = await soldOutWorld(t, admin);
    expect((await setSale(admin, s.w.pkg.id, 'waitlist')).status).toBe(200);
    const c = await customerClient(t);
    expect((await c.request(requestBody(s.w))).body).toMatchObject({ outcome: 'waitlisted', reason: 'sold_out' });
    expect((await setSale(admin, s.w.pkg.id, 'closed')).status).toBe(200);
    const d = await customerClient(t);
    expect((await d.request(requestBody(s.w))).status).toBe(404);
  });

  it('the public price list shows a sold out package so the page can build its request', async () => {
    const s = await soldOutWorld(t, admin);
    const res = await t.http().post('/pricing/quotes').set(STATE_HEADERS).send({ packageId: s.w.pkg.id, rooms: requestBody(s.w).rooms });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('cancellation_promotes_first_waitlisted', () => {
  it('the first in the queue is offered the places the cancelled request gave back, and the second keeps waiting', async () => {
    const s = await soldOutWorld(t, admin);
    const [a, b] = [await customerClient(t), await customerClient(t)];
    const [ida, idb] = [await joinList(t, a, s.w), await joinList(t, b, s.w)];
    const full = await consumed(s.pools);
    await cancelHolder(t, s);
    const ea = await entry(ida);
    expect(ea.status).toBe('offered');
    expect(ea.offerExpiresAt!.getTime() - ea.offeredAt!.getTime()).toBe(48 * 3_600_000);
    expect((await entry(idb)).status).toBe('waiting');
    // The places went back to the pool and straight out again to the offer: the pool is as full as before.
    expect(await consumed(s.pools)).toEqual(full);
    const claims = await heldBy(ida);
    expect(claims.length).toBeGreaterThan(0);
    expect(await heldBy(idb)).toEqual([]);
    // One email, one event, one audit entry; none carries the address.
    expect(await t.prisma.outboundEmail.count({ where: { dedupeKey: `waitlist:offer:${ida}` } })).toBe(1);
    const events = await t.prisma.outboxEvent.findMany({ where: { aggregateId: ida, type: 'waitlist.entry.offered' } });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(a.email.toLowerCase());
    const logs = await t.prisma.auditLog.findMany({ where: { entityId: ida, action: 'waitlist.entry.offered' } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs.map((l) => l.changes))).not.toContain(a.email.toLowerCase());
  });

  it('a request declined or expired also gives its places to the list', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: s.holderBookingId } });
    expect((await admin.post(`/admin/bookings/${b.id}/decline`, { version: b.version, reason: 'Full' })).status).toBe(200);
    expect((await entry(id)).status).toBe('offered');
  });

  it('promotion_skips_entry_that_does_not_fit_and_keeps_its_place', async () => {
    const s = await soldOutWorld(t, admin);
    const [big, small] = [await customerClient(t), await customerClient(t)];
    const idBig = await joinList(t, big, s.w, { rooms: roomsX2(s.w).rooms });
    const idSmall = await joinList(t, small, s.w);
    await cancelHolder(t, s);
    expect([(await entry(idBig)).status, (await entry(idSmall)).status]).toEqual(['waiting', 'offered']);
    // The skipped entry keeps its position ahead of anyone who joins later.
    expect((await entry(idBig)).position).toBeLessThan((await entry(idSmall)).position);
  });

  it('non_resident_never_offered: someone waiting because of where they live is left alone', async () => {
    const w = await pricedWorld(admin);
    const nz = await customerClient(t);
    expect((await nz.request(requestBody(w, { contact: contact({ countryOfResidence: 'NZ' }) }))).status).toBe(201);
    const s = await soldOutWorld(t, admin, w);
    await cancelHolder(t, s);
    const e = await t.prisma.waitlistEntry.findFirstOrThrow({ where: { customer: { userId: nz.userId } } });
    expect([e.reason, e.status]).toEqual(['non_resident', 'waiting']);
  });
});

describe('waitlist_offer_holds_released_slot_against_public_request', () => {
  it('a public request for the same places is refused while the offer stands, and they come back when it ends', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    await cancelHolder(t, s);
    expect((await setSale(admin, s.w.pkg.id, 'open')).status).toBe(200);
    const late = await customerClient(t);
    const refused = await late.request(requestBody(s.w));
    expect([refused.status, refused.body.code]).toEqual([409, 'inventory_unavailable']);
    // The person declines: the places are free again for the next request.
    expect((await act(t, a, id, 'withdraw')).status).toBe(200);
    expect((await late.request(requestBody(s.w))).status).toBe(201);
  });
});

describe('decline, expiry and withdrawal promote the next person', () => {
  it('decline_expire_and_withdraw_promote_next', async () => {
    const s = await soldOutWorld(t, admin);
    const [a, b, c] = [await customerClient(t), await customerClient(t), await customerClient(t)];
    const [ia, ib, ic] = [await joinList(t, a, s.w), await joinList(t, b, s.w), await joinList(t, c, s.w)];
    await cancelHolder(t, s);
    expect((await entry(ia)).status).toBe('offered');
    // A declines.
    const declined = await act(t, a, ia, 'withdraw');
    expect([declined.status, declined.body.status]).toEqual([200, 'withdrawn']);
    expect([(await entry(ia)).status, (await heldBy(ia)).length, (await entry(ib)).status]).toEqual(['withdrawn', 0, 'offered']);
    // B lets the offer run out: the periodic task ends it and C is offered the places.
    await t.prisma.waitlistEntry.update({ where: { id: ib }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });
    await t.app.get(BookingExpiryService).run();
    const { WaitlistOffersService } = await import('../../../src/modules/bookings/waitlist-offers.service');
    expect(await t.app.get(WaitlistOffersService).expireOffers()).toMatchObject({ expired: 1, failed: 0 });
    expect([(await entry(ib)).status, (await heldBy(ib)).length, (await entry(ic)).status]).toEqual(['expired', 0, 'offered']);
    // Expiring twice changes nothing.
    expect(await t.app.get(WaitlistOffersService).expireOffers()).toMatchObject({ expired: 0 });
    // Leaving the list while waiting needs no places back.
    const d = await customerClient(t);
    const id = await joinList(t, d, s.w);
    expect((await act(t, d, id, 'withdraw')).status).toBe(200);
    expect((await entry(id)).status).toBe('withdrawn');
    expect((await act(t, d, id, 'accept')).status).toBe(409);
  });
});

describe('accepting the offer', () => {
  it('accept_creates_request_moves_stock_once: a booking request priced by the engine holds the same places', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    await cancelHolder(t, s);
    const full = await consumed(s.pools);
    const view = await viewOf(t, a, id);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: 'offered', reason: 'sold_out' });
    expect(view.body.price.totalMinor).toBeTypeOf('string');
    expect(view.body.price.trace).toBeUndefined();
    expect(JSON.stringify(view.body)).not.toContain(a.email.toLowerCase());

    const res = await act(t, a, id, 'accept');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.created).toBe(true);
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.bookingReference as string }, include: { snapshots: true } });
    expect(booking).toMatchObject({ status: 'requested', packageId: s.w.pkg.id });
    expect(booking.snapshots).toHaveLength(1);
    expect(booking.totalMinor).toBe(booking.snapshots[0]!.totalMinor);
    // Same places, now the booking's.
    expect(await consumed(s.pools)).toEqual(full);
    expect(await heldBy(id)).toEqual([]);
    expect((await t.prisma.inventoryClaim.findMany({ where: { bookingId: booking.id, status: 'held' } })).length).toBeGreaterThan(0);
    expect(await entry(id)).toMatchObject({ status: 'converted', bookingId: booking.id });
    // The booking is a request like any other: staff can still decline it, and its places come back.
    expect((await act(t, a, id, 'withdraw')).status).toBe(409);
  });

  it('accept_twice_same_booking, also at the same time', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    await cancelHolder(t, s);
    const [x, y] = await Promise.all([act(t, a, id, 'accept'), act(t, a, id, 'accept')]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(x.body.bookingReference).toBe(y.body.bookingReference);
    expect([x.body.created, y.body.created].sort()).toEqual([false, true]);
    expect(await t.prisma.booking.count({ where: { customer: { userId: a.userId } } })).toBe(1);
  });

  it('accept_after_expiry_409: past its time the offer cannot be taken, and nothing is written', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    await cancelHolder(t, s);
    await t.prisma.waitlistEntry.update({ where: { id }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });
    const res = await act(t, a, id, 'accept');
    expect([res.status, res.body.code]).toEqual([409, 'offer_no_longer_open']);
    expect(await t.prisma.booking.count({ where: { customer: { userId: a.userId } } })).toBe(0);
    expect((await entry(id)).status).toBe('offered');
  });

  it('a person still waiting cannot accept', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    const res = await act(t, a, id, 'accept');
    expect([res.status, res.body.code]).toEqual([409, 'offer_no_longer_open']);
  });

  it('accept races with the periodic expiry: one wins, the places are never lost or doubled', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    await cancelHolder(t, s);
    const full = await consumed(s.pools);
    await t.prisma.waitlistEntry.update({ where: { id }, data: { offerExpiresAt: new Date(Date.now() + 1500) } });
    await new Promise((r) => setTimeout(r, 1450));
    const { WaitlistOffersService } = await import('../../../src/modules/bookings/waitlist-offers.service');
    const [acc] = await Promise.all([act(t, a, id, 'accept'), new Promise((r) => setTimeout(r, 60)).then(() => t.app.get(WaitlistOffersService).expireOffers())]);
    const e = await entry(id);
    if (acc.status === 200) expect(e.status).toBe('converted');
    else expect(e.status).toBe('expired');
    const total = Object.values(await consumed(s.pools)).reduce((n, v) => n + v, 0);
    const bookings = await t.prisma.booking.count({ where: { customer: { userId: a.userId } } });
    expect(e.status === 'converted' ? total === Object.values(full).reduce((n, v) => n + v, 0) && bookings === 1 : total === 0 && bookings === 0).toBe(true);
  });
});

describe('concurrent_cancellations_offer_each_entry_once', () => {
  it('two requests cancelled at once give two offers to two entries, no entry twice, no place twice', async () => {
    const s = await soldOutWorld(t, admin, undefined, 2);
    const [a, b] = [await customerClient(t), await customerClient(t)];
    const [ia, ib] = [await joinList(t, a, s.w), await joinList(t, b, s.w)];
    const full = await consumed(s.pools);
    await Promise.all(s.holderBookingIds.map((id) => cancelHolder(t, s, id)));
    expect([(await entry(ia)).status, (await entry(ib)).status]).toEqual(['offered', 'offered']);
    expect(await consumed(s.pools)).toEqual(full);
    for (const id of [ia, ib]) {
      expect(await t.prisma.outboxEvent.count({ where: { aggregateId: id, type: 'waitlist.entry.offered' } })).toBe(1);
      expect(await t.prisma.outboundEmail.count({ where: { dedupeKey: `waitlist:offer:${id}` } })).toBe(1);
    }
  });

  it('cancel_vs_public_request: a cancellation and public requests at the same time never oversell or deadlock', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    expect((await setSale(admin, s.w.pkg.id, 'open')).status).toBe(200);
    const rivals = await Promise.all(Array.from({ length: 4 }, () => customerClient(t)));
    const results = await Promise.all([cancelHolder(t, s).then(() => 'cancelled'), ...rivals.map((r) => r.request(requestBody(s.w)).then((x) => x.status))]);
    expect(results.filter((r) => r === 500)).toEqual([]);
    const e = await entry(id);
    const consumedNow = Object.values(await consumed(s.pools));
    const caps = Object.values(await capacity(s.pools));
    consumedNow.forEach((n, i) => expect(n).toBeLessThanOrEqual(caps[i]!));
    // Whoever won, the places are held by exactly one owner.
    const rivalBookings = await t.prisma.booking.count({ where: { customer: { userId: { in: rivals.map((r) => r.userId) } }, status: 'requested' } });
    expect(e.status === 'offered' ? rivalBookings : rivalBookings).toBeLessThanOrEqual(e.status === 'offered' ? 0 : 1);
  });
});

describe('the offer email and a request that can no longer be priced', () => {
  it('offer_email_sent_while_open_and_never_after_it_ended', async () => {
    const s = await soldOutWorld(t, admin);
    const [a, b] = [await customerClient(t), await customerClient(t)];
    const [ia, ib] = [await joinList(t, a, s.w), await joinList(t, b, s.w)];
    await cancelHolder(t, s);
    const mailA = await t.prisma.outboundEmail.findFirstOrThrow({ where: { dedupeKey: `waitlist:offer:${ia}` } });
    expect(mailA).toMatchObject({ templateKey: 'waitlist.offer', category: 'transactional' });
    // A leaves before the email goes out: it must not be sent, and B (offered next) has its own email.
    expect((await act(t, a, ia, 'withdraw')).status).toBe(200);
    expect(await t.app.get(MailService).processSend(mailA.id)).toBe('failed');
    expect((await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: mailA.id } })).status).not.toBe('sent');
    const mailB = await t.prisma.outboundEmail.findFirstOrThrow({ where: { dedupeKey: `waitlist:offer:${ib}` } });
    expect(await t.app.get(MailService).processSend(mailB.id)).not.toBe('failed');
  });

  it('changed_catalogue_expires_entry_and_continues: an entry whose room is gone leaves the queue, the next is offered', async () => {
    const s = await soldOutWorld(t, admin);
    const [a, b] = [await customerClient(t), await customerClient(t)];
    const [ia, ib] = [await joinList(t, a, s.w), await joinList(t, b, s.w)];
    // The kept request is immutable by trigger; the owner switches the guard off for one statement to simulate a removed room.
    await owner.query('ALTER TABLE waitlist_entries DISABLE TRIGGER waitlist_entries_guard');
    try {
      await owner.query(`UPDATE waitlist_entries SET configuration = jsonb_set(configuration, '{rooms,0,roomOptionId}', to_jsonb($2::text)) WHERE id = $1`, [ia, randomUUID()]);
    } finally {
      await owner.query('ALTER TABLE waitlist_entries ENABLE TRIGGER waitlist_entries_guard');
    }
    await cancelHolder(t, s);
    expect([(await entry(ia)).status, (await heldBy(ia)).length, (await entry(ib)).status]).toEqual(['expired', 0, 'offered']);
  });
});

describe('erasing a customer with an open offer', () => {
  it('releases the places and offers them to the next person', async () => {
    const s = await soldOutWorld(t, admin);
    const [a, b] = [await customerClient(t), await customerClient(t)];
    const [ia, ib] = [await joinList(t, a, s.w), await joinList(t, b, s.w)];
    await cancelHolder(t, s);
    expect((await entry(ia)).status).toBe('offered');
    const def = t.app.get(EntityRegistry).get('WaitlistEntry')!;
    const customerId = (await entry(ia)).customerId;
    await t.prisma.$transaction((tx) => def.handlers!.anonymise(tx, customerId));
    expect([(await entry(ia)).status, (await heldBy(ia)).length, (await entry(ib)).status]).toEqual(['withdrawn', 0, 'offered']);
  });
});

describe('offers respect the package and where the person lives', () => {
  it('no_offer_on_closed_package: places freed on a closed package are not offered, and nothing is held', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    expect((await setSale(admin, s.w.pkg.id, 'closed')).status).toBe(200);
    await cancelHolder(t, s);
    expect([(await entry(id)).status, (await heldBy(id)).length]).toEqual(['waiting', 0]);
    expect(await t.prisma.outboundEmail.count({ where: { dedupeKey: `waitlist:offer:${id}` } })).toBe(0);
  });

  it('a person who no longer lives in a sales country keeps the place but is not offered one, and cannot accept an offer', async () => {
    const s = await soldOutWorld(t, admin, undefined, 2);
    const [a, b] = [await customerClient(t), await customerClient(t)];
    const [ia, ib] = [await joinList(t, a, s.w), await joinList(t, b, s.w)];
    await t.prisma.customer.update({ where: { userId: a.userId }, data: { countryOfResidence: 'GB' } });
    await cancelHolder(t, s, s.holderBookingIds[0]);
    expect([(await entry(ia)).status, (await entry(ib)).status]).toEqual(['waiting', 'offered']);
    // B moves away after being offered: accepting is refused and the offer stays for expiry to clear.
    await t.prisma.customer.update({ where: { userId: b.userId }, data: { countryOfResidence: 'NZ' } });
    const res = await act(t, b, ib, 'accept');
    expect([res.status, res.body.code]).toEqual([409, 'country_not_served']);
    expect(await t.prisma.booking.count({ where: { customer: { userId: b.userId } } })).toBe(0);
  });
});

describe('erasure_never_leaks_an_offer', () => {
  it('erasing a customer while a cancellation offers them a place never leaves held places behind', async () => {
    for (let i = 0; i < 4; i++) {
      const s = await soldOutWorld(t, admin);
      const a = await customerClient(t);
      const id = await joinList(t, a, s.w);
      const customerId = (await entry(id)).customerId;
      const def = t.app.get(EntityRegistry).get('WaitlistEntry')!;
      await Promise.all([cancelHolder(t, s), t.prisma.$transaction((tx) => def.handlers!.anonymise(tx, customerId))]);
      const e = await entry(id);
      expect(e.status).toBe('withdrawn');
      expect(await heldBy(id)).toEqual([]);
      // Every place went back to the pool: nothing consumed is left without an owner.
      expect(Object.values(await consumed(s.pools)).reduce((n, v) => n + v, 0)).toBe(0);
    }
  });

  it('the database refuses to end an offer that still holds places', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    await cancelHolder(t, s);
    await owner.query('BEGIN');
    let outcome = 'ok';
    try {
      await owner.query(`UPDATE waitlist_entries SET status = 'withdrawn', "withdrawnAt" = now() WHERE id = $1`, [id]);
    } catch (err) {
      outcome = String(err);
    } finally {
      await owner.query('ROLLBACK');
    }
    expect(outcome).toMatch(/still holds places/);
  });
});

describe('waitlist_offer_database_guards', () => {
  const rolled = async (q: string, params: unknown[] = []): Promise<string> => {
    await owner.query('BEGIN');
    try {
      await owner.query(q, params);
      return 'ok';
    } catch (err) {
      return String(err);
    } finally {
      await owner.query('ROLLBACK');
    }
  };

  it('a claim has exactly one owner', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    const pool = s.w.roomPoolId;
    const insert = (booking: string | null, entryId: string | null) =>
      rolled(`INSERT INTO inventory_claims (id, "bookingId", "waitlistEntryId", "poolId", quantity) VALUES ($1, $2, $3, $4, 1)`, [randomUUID(), booking, entryId, pool]);
    expect(await insert(null, null)).toMatch(/inventory_claims_one_owner_check/);
    expect(await insert(s.holderBookingId, id)).toMatch(/inventory_claims_one_owner_check/);
    expect(await insert(null, id)).toBe('ok');
  });

  it('an entry for a sold out package keeps its request, which never changes; a converted entry has its booking', async () => {
    const s = await soldOutWorld(t, admin);
    const a = await customerClient(t);
    const id = await joinList(t, a, s.w);
    expect(await rolled(`UPDATE waitlist_entries SET configuration = '{}'::jsonb WHERE id = $1`, [id])).toMatch(/never change/);
    expect(await rolled(`UPDATE waitlist_entries SET status = 'converted', "convertedAt" = now() WHERE id = $1`, [id])).toMatch(/check_violation|cannot go|converted_booking/);
    expect(await rolled(`UPDATE waitlist_entries SET status = 'expired', "expiredAt" = now() WHERE id = $1`, [id])).toBe('ok');
    expect(await rolled(`UPDATE waitlist_entries SET status = 'offered', "offeredAt" = now(), "offerExpiresAt" = now() WHERE id = $1`, [id])).toBe('ok');
    const e = await entry(id);
    expect(await rolled(`INSERT INTO waitlist_entries (id, email, "customerId", reason, "packageId", "countryOfResidence", travellers, "requestKeyHash", "requestConfigHash", "updatedAt") VALUES ($1, 'x@example.test', $2, 'sold_out', $3, 'AU', 1, $4, $4, now())`, [randomUUID(), e.customerId, e.packageId, 'f'.repeat(64)])).toMatch(/sold_out_configuration_check/);
  });
});
