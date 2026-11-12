// The waiting list through HTTP and a real PostgreSQL (task 2.6). Someone who does not live in a country we sell to
// joins the list for a package instead of sending a booking request: no price kept, no stock held, nothing charged.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ISO_COUNTRY_CODES } from '@mt/shared';
import { BOOKING_SETTINGS } from '../../../src/modules/bookings/settings';
import { WAITLIST_PERMISSIONS } from '../../../src/modules/waitlist';
import { PermissionRegistry } from '../../../src/platform/access/permissions';
import { EntityRegistry } from '../../../src/platform/entities/entity-registry';
import { SettingsService } from '../../../src/platform/flags/flags.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { closeCatalogue, setSale, staffClient } from '../../support/catalogue';
import { bookingStaff, cleanBookingEvents, contact, customerClient, requestBody } from '../../support/bookings';
import { createCode, freshCode } from '../../support/adjustments';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof bookingStaff>>;
let w: PricedWorld;
let owner: pg.Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await bookingStaff(t);
  w = await pricedWorld(admin);
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

const nonResident = (over: Record<string, unknown> = {}) => contact({ countryOfResidence: 'NZ', ...over });
const consumed = async (ids: string[]) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } })).consumed] as const)));
const entriesOf = (userId: string) => t.prisma.waitlistEntry.findMany({ where: { customer: { userId } }, orderBy: { position: 'asc' } });
const MONEY_KEYS = /minor|total|deposit|price|currency|amount|breakdown|trace|reference/i;

/** As the owner of the tables, rolled back whatever happens: only the triggers and constraints stand in the way. */
async function asOwner(q: string, params: unknown[] = []): Promise<string> {
  await owner.query('BEGIN');
  try {
    await owner.query(q, params);
    return 'ok';
  } catch (err) {
    return String(err);
  } finally {
    await owner.query('ROLLBACK');
  }
}

describe('non_resident_joins_waitlist: a request from outside the sales countries becomes a waiting list entry', () => {
  it('writes an entry and nothing else: no booking, no snapshot, no stock, no code, no price in the answer', async () => {
    const c = await customerClient(t);
    const pools = [w.roomPoolId, w.entryPoolId, w.extraPoolId];
    const before = await consumed(pools);
    const res = await c.request(requestBody(w, { contact: nonResident() }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ outcome: 'waitlisted', status: 'waiting', travellers: 2, package: { id: w.pkg.id } });
    // The answer carries no money and no booking reference: the page must not be able to call this a request.
    expect(Object.keys(res.body).filter((k) => MONEY_KEYS.test(k))).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/"(totalMinor|depositMinor|priceBreakdown|reference|requestExpiresAt)"/);

    const [entry, ...rest] = await entriesOf(c.userId);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ reason: 'non_resident', status: 'waiting', countryOfResidence: 'NZ', travellers: 2, packageId: w.pkg.id, email: c.email.toLowerCase() });
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { userId: c.userId } });
    expect([entry!.customerId, customer.countryOfResidence]).toEqual([customer.id, 'NZ']);
    expect(await t.prisma.booking.count({ where: { customerId: customer.id } })).toBe(0);
    expect(await t.prisma.inventoryClaim.count({ where: { booking: { customerId: customer.id } } })).toBe(0);
    expect(await t.prisma.promoRedemption.count({ where: { customerId: customer.id } })).toBe(0);
    expect(await consumed(pools)).toEqual(before);
  });

  it('audit and event carry ids only: no address, no country, no name', async () => {
    const c = await customerClient(t);
    expect((await c.request(requestBody(w, { contact: nonResident({ givenName: 'Zqmarker', familyName: 'Zqmarker' }) }))).status).toBe(201);
    const [entry] = await entriesOf(c.userId);
    const events = await t.prisma.outboxEvent.findMany({ where: { aggregateId: entry!.id } });
    expect(events.map((e) => e.type)).toEqual(['waitlist.entry.joined']);
    const logs = await t.prisma.auditLog.findMany({ where: { entityId: entry!.id } });
    expect(logs.map((l) => l.action)).toEqual(['waitlist.entry.joined']);
    for (const text of [JSON.stringify(events), JSON.stringify(logs.map((l) => l.changes))]) {
      expect(text).not.toContain(c.email.toLowerCase());
      expect(text).not.toContain('Zqmarker');
      expect(text).not.toContain('"NZ"');
    }
  });

  const countries: Array<[string, string, 'waitlisted' | 'requested']> = [
    ['Australia sends a request', 'AU', 'requested'],
    ['New Zealand joins the list', 'NZ', 'waitlisted'],
    ['the United Kingdom joins the list', 'GB', 'waitlisted'],
    ['Spain joins the list', 'ES', 'waitlisted'],
    ['a lower case code is the same as upper case', 'nz', 'waitlisted'],
  ];
  it.each(countries)('country_decides_outcome: %s', async (_name, country, outcome) => {
    const c = await customerClient(t);
    const res = await c.request(requestBody(w, { contact: contact({ countryOfResidence: country }) }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    if (outcome === 'requested') expect(res.body).toMatchObject({ status: 'requested', isRequest: true });
    else expect(res.body).toMatchObject({ outcome: 'waitlisted' });
    expect(await t.prisma.waitlistEntry.count({ where: { customer: { userId: c.userId } } })).toBe(outcome === 'waitlisted' ? 1 : 0);
  });

  it('opening a country is a setting: with NZ in salesCountries a New Zealander sends a request, and closing it again puts them on the list', async () => {
    const settings = t.app.get(SettingsService);
    await settings.set(BOOKING_SETTINGS.salesCountries.key, ['AU', 'NZ']);
    try {
      const c = await customerClient(t);
      const open = await c.request(requestBody(w, { contact: nonResident() }));
      expect(open.body).toMatchObject({ status: 'requested' });
    } finally {
      await t.prisma.setting.deleteMany({ where: { key: BOOKING_SETTINGS.salesCountries.key } });
    }
    const c2 = await customerClient(t);
    expect((await c2.request(requestBody(w, { contact: nonResident() }))).body).toMatchObject({ outcome: 'waitlisted' });
  });

  it('a code sent with the request is ignored: it is not redeemed and does not fail the entry', async () => {
    const code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, valueBps: 1000, appliesTo: 'subtotal' });
    const c = await customerClient(t);
    const res = await c.request(requestBody(w, { promoCode: code.code, contact: nonResident() }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.outcome).toBe('waitlisted');
    expect(JSON.stringify(res.body)).not.toContain(code.code);
    expect(await t.prisma.promoRedemption.count({ where: { promoCodeId: code.id } })).toBe(0);
  });

  it('a resident who was on the list as a non-resident can still send a request; the entry stays', async () => {
    const c = await customerClient(t);
    expect((await c.request(requestBody(w, { contact: nonResident() }))).body.outcome).toBe('waitlisted');
    const res = await c.request(requestBody(w, { contact: contact() }));
    expect(res.body).toMatchObject({ status: 'requested' });
    expect((await entriesOf(c.userId)).map((e) => e.status)).toEqual(['waiting']);
  });
});

describe('country_must_be_an_assigned_iso_code: a made-up code is a 422, never an entry', () => {
  it.each([['ZZ'], ['XX'], ['AA'], ['AUS'], [''], ['A'], ['1A']])('%j', async (country) => {
    const c = await customerClient(t);
    const res = await c.request(requestBody(w, { contact: contact({ countryOfResidence: country }) }));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await t.prisma.customer.count({ where: { userId: c.userId } })).toBe(0);
    expect(await t.prisma.waitlistEntry.count({ where: { customer: { userId: c.userId } } })).toBe(0);
  });

  it('the list holds the 249 assigned codes, includes AU and NZ, and never the erased marker', () => {
    expect(ISO_COUNTRY_CODES.size).toBe(249);
    expect(['AU', 'NZ', 'GB', 'ES'].every((x) => ISO_COUNTRY_CODES.has(x))).toBe(true);
    expect(['ZZ', 'XX', 'AA'].some((x) => ISO_COUNTRY_CODES.has(x))).toBe(false);
  });
});

describe('waitlist_checks_the_package: the engine still validates what it is asked for', () => {
  it('a closed, unknown or departed package, and a bad configuration, are refused as for a request, and nothing is written', async () => {
    const closed = await pricedWorld(admin);
    expect((await setSale(admin, closed.pkg.id, 'closed')).status).toBe(200);
    const c = await customerClient(t);
    const a = await c.request(requestBody(closed, { contact: nonResident() }));
    expect([a.status, a.body.code]).toEqual([404, 'package_not_found']);
    const b = await c.request(requestBody(w, { packageId: randomUUID(), contact: nonResident() }));
    expect([b.status, b.body.code]).toEqual([404, 'package_not_found']);
    const other = await pricedWorld(admin);
    const d = await c.request(requestBody(w, { rooms: [{ roomOptionId: other.roomId, travellers: [{ participationType: 'supporter' }] }], contact: nonResident() }));
    expect(d.status).toBe(422);
    const late = await pricedWorld(admin);
    await t.prisma.$executeRawUnsafe(`UPDATE packages SET "checkInDate" = (now() AT TIME ZONE 'Australia/Brisbane')::date, "checkOutDate" = (now() AT TIME ZONE 'Australia/Brisbane')::date + 3, "balanceDueDate" = (now() AT TIME ZONE 'Australia/Brisbane')::date - 10 WHERE id = $1::uuid`, late.pkg.id);
    const e = await c.request(requestBody(late, { contact: nonResident() }));
    expect([e.status, e.body.code]).toEqual([409, 'package_departed']);
    expect(await t.prisma.waitlistEntry.count({ where: { customer: { userId: c.userId } } })).toBe(0);
    expect(await t.prisma.customer.count({ where: { userId: c.userId } })).toBe(0);
  });

  it('client_amount_field_rejected: the waiting list path takes no amount either', async () => {
    const c = await customerClient(t);
    for (const k of ['totalMinor', 'depositMinor', 'currency', 'status', 'position']) {
      const res = await c.request(requestBody(w, { contact: nonResident(), [k]: '1' }));
      expect(res.status, k).toBe(422);
    }
    const nested = await c.request(requestBody(w, { contact: { ...nonResident(), position: 1 } }));
    expect(nested.status).toBe(422);
    expect(await t.prisma.customer.count({ where: { userId: c.userId } })).toBe(0);
  });

  it('a request without a session is a 401, and one without an Idempotency-Key is a 422', async () => {
    const anon = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Idempotency-Key', randomUUID()).send(requestBody(w, { contact: nonResident() }));
    expect(anon.status).toBe(401);
    const c = await customerClient(t);
    const noKey = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', c.cookie).send(requestBody(w, { contact: nonResident() }));
    expect([noKey.status, noKey.body.code]).toEqual([422, 'idempotency_key_required']);
    expect(await t.prisma.waitlistEntry.count({ where: { customer: { userId: c.userId } } })).toBe(0);
  });
});

describe('waitlist_is_idempotent: a retry, a double click and a second ask are one place in the queue', () => {
  it('the same Idempotency-Key and body twice: one entry; the same key with another body is 422', async () => {
    const c = await customerClient(t);
    const key = randomUUID();
    const body = requestBody(w, { contact: nonResident() });
    const first = await c.request(body, key);
    const second = await c.request(body, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body).toEqual(first.body);
    expect(await entriesOf(c.userId)).toHaveLength(1);
    const other = await c.request(requestBody(w, { rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'supporter' }] }], contact: nonResident() }), key);
    expect([other.status, other.body.code]).toEqual([422, 'idempotency_key_reused']);
    expect(await entriesOf(c.userId)).toHaveLength(1);
  });

  it('asking again with a new key keeps the entry and its place, and refreshes the head count', async () => {
    const c = await customerClient(t);
    expect((await c.request(requestBody(w, { contact: nonResident() }))).body.travellers).toBe(2);
    const [first] = await entriesOf(c.userId);
    const again = await c.request(requestBody(w, { rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'supporter' }] }], contact: nonResident() }));
    expect(again.body).toMatchObject({ outcome: 'waitlisted', travellers: 1 });
    const entries = await entriesOf(c.userId);
    expect(entries).toHaveLength(1);
    expect([entries[0]!.id, entries[0]!.position, entries[0]!.travellers, entries[0]!.version]).toEqual([first!.id, first!.position, 1, first!.version + 1]);
    const logs = await t.prisma.auditLog.findMany({ where: { entityId: first!.id }, orderBy: { occurredAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['waitlist.entry.joined', 'waitlist.entry.updated']);
  });

  it('concurrent_asks_one_entry: several asks at once from one customer, each with its own key, make one live entry', async () => {
    const c = await customerClient(t);
    const results = await Promise.all(Array.from({ length: 6 }, () => c.request(requestBody(w, { contact: nonResident() }))));
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body))).toEqual(Array(6).fill(201));
    expect(await entriesOf(c.userId)).toHaveLength(1);
    expect(await t.prisma.customer.count({ where: { userId: c.userId } })).toBe(1);
  });

  it('queue_order: entries for one package are numbered in the order people joined', async () => {
    const p = await pricedWorld(admin);
    const clients = [await customerClient(t), await customerClient(t), await customerClient(t)];
    for (const c of clients) expect((await c.request(requestBody(p, { contact: nonResident() }))).status).toBe(201);
    const rows = await t.prisma.waitlistEntry.findMany({ where: { packageId: p.pkg.id }, orderBy: { position: 'asc' }, include: { customer: { select: { userId: true } } } });
    expect(rows.map((r) => r.customer.userId)).toEqual(clients.map((c) => c.userId));
    expect(rows[0]!.position).toBeLessThan(rows[1]!.position);
    expect(rows[1]!.position).toBeLessThan(rows[2]!.position);
    // Another package is another list.
    const c = clients[0]!;
    expect((await c.request(requestBody(w, { contact: nonResident() }))).status).toBe(201);
    expect((await entriesOf(c.userId)).map((e) => e.packageId).sort()).toEqual([p.pkg.id, w.pkg.id].sort());
  });
});

describe('one Idempotency-Key, one meaning, even after the platform\'s record of it is gone', () => {
  const forget = (key: string) => t.prisma.idempotencyRecord.deleteMany({ where: { key } });

  it('a waiting list key replayed with a resident body is a 422 and makes no booking; the same body gets the same entry', async () => {
    const c = await customerClient(t);
    const key = randomUUID();
    const first = await c.request(requestBody(w, { contact: nonResident() }), key);
    expect(first.status).toBe(201);
    await forget(key);
    const resident = await c.request(requestBody(w, { contact: contact() }), key);
    expect([resident.status, resident.body.code]).toEqual([422, 'idempotency_key_reused']);
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { userId: c.userId } });
    expect(await t.prisma.booking.count({ where: { customerId: customer.id } })).toBe(0);
    const same = await c.request(requestBody(w, { contact: nonResident() }), key);
    expect(same.body).toEqual(first.body);
    expect(await entriesOf(c.userId)).toHaveLength(1);
  });

  it('the same key and configuration with another contact (another country) is a 422', async () => {
    const c = await customerClient(t);
    const key = randomUUID();
    expect((await c.request(requestBody(w, { contact: nonResident() }), key)).status).toBe(201);
    await forget(key);
    const other = await c.request(requestBody(w, { contact: nonResident({ countryOfResidence: 'GB' }) }), key);
    expect([other.status, other.body.code]).toEqual([422, 'idempotency_key_reused']);
    expect((await entriesOf(c.userId))[0]!.countryOfResidence).toBe('NZ');
  });

  it('a booking key replayed with a non-resident body is a 422 and makes no entry', async () => {
    const c = await customerClient(t);
    const key = randomUUID();
    expect((await c.request(requestBody(w, { contact: contact() }), key)).status).toBe(201);
    await forget(key);
    const res = await c.request(requestBody(w, { contact: nonResident() }), key);
    expect([res.status, res.body.code]).toEqual([422, 'idempotency_key_reused']);
    expect(await entriesOf(c.userId)).toHaveLength(0);
  });

  it('asking again from another country updates and audits the country as personal data, even with the same head count', async () => {
    const c = await customerClient(t);
    expect((await c.request(requestBody(w, { contact: nonResident() }))).status).toBe(201);
    const [first] = await entriesOf(c.userId);
    expect((await c.request(requestBody(w, { contact: nonResident({ countryOfResidence: 'GB' }) }))).status).toBe(201);
    const [after] = await entriesOf(c.userId);
    expect([after!.id, after!.countryOfResidence, after!.version]).toEqual([first!.id, 'GB', first!.version + 1]);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: first!.id, action: 'waitlist.entry.updated' } });
    expect(JSON.stringify(log.changes)).not.toMatch(/"(NZ|GB)"/);
    const pii = await t.prisma.auditPiiValue.findMany({ where: { auditLogId: log.id } });
    expect(JSON.stringify(pii)).toMatch(/NZ/);
    expect(JSON.stringify(pii)).toMatch(/GB/);
  });
});

describe('waitlist_database_guards: the tables say no on their own', () => {
  const entry = async () => {
    const c = await customerClient(t);
    expect((await c.request(requestBody(w, { contact: nonResident() }))).status).toBe(201);
    return (await entriesOf(c.userId))[0]!;
  };

  it('an entry never changes owner, package, reason or place; it is never deleted or truncated', async () => {
    const e = await entry();
    const other = await pricedWorld(admin);
    for (const [col, value] of [['packageId', other.pkg.id], ['position', 999999], ['reason', 'sold_out'], ['requestKeyHash', 'a'.repeat(64)], ['customerId', randomUUID()]] as const) {
      const cast = col === 'packageId' || col === 'customerId' ? '::uuid' : col === 'reason' ? '::"WaitlistReason"' : '';
      expect(await asOwner(`UPDATE waitlist_entries SET "${col}" = $1${cast} WHERE id = $2::uuid`, [value, e.id]), col).toMatch(/error/i);
    }
    expect(await asOwner(`DELETE FROM waitlist_entries WHERE id = $1::uuid`, [e.id])).toMatch(/never deleted/);
    expect(await asOwner(`TRUNCATE waitlist_entries`)).toMatch(/error/i);
    await expect(t.prisma.waitlistEntry.delete({ where: { id: e.id } })).rejects.toThrow();
  });

  it('the status only moves along the allowed pairs', async () => {
    const e = await entry();
    const set = (to: string, extra = '') => asOwner(`UPDATE waitlist_entries SET status = $1::"WaitlistStatus"${extra} WHERE id = $2::uuid`, [to, e.id]);
    expect(await set('converted')).toMatch(/cannot go from waiting to converted/);
    expect(await set('expired')).toMatch(/cannot go from waiting to expired/);
    expect(await set('offered')).toMatch(/error/i); // an offer needs its times
    expect(await set('offered', `, "offeredAt" = now(), "offerExpiresAt" = now() + interval '1 day'`)).toBe('ok');
    expect(await set('withdrawn')).toMatch(/error/i); // a withdrawal needs its time
    expect(await set('withdrawn', `, "withdrawnAt" = now()`)).toBe('ok');
    // From a final state there is no way back.
    await owner.query('BEGIN');
    try {
      await owner.query(`UPDATE waitlist_entries SET status = 'withdrawn', "withdrawnAt" = now() WHERE id = $1::uuid`, [e.id]);
      await expect(owner.query(`UPDATE waitlist_entries SET status = 'waiting' WHERE id = $1::uuid`, [e.id])).rejects.toThrow(/cannot go from withdrawn to waiting/);
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('one live entry per customer, package and reason, and the checks on country and head count', async () => {
    const e = await entry();
    const insert = (over: Record<string, unknown>) => {
      const row = { email: 'x@example.test', customerId: e.customerId, reason: 'non_resident', packageId: e.packageId, countryOfResidence: 'NZ', travellers: 1, requestKeyHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), requestConfigHash: 'b'.repeat(64), ...over };
      return asOwner(
        `INSERT INTO waitlist_entries (id, email, "customerId", reason, "packageId", "countryOfResidence", travellers, "requestKeyHash", "requestConfigHash", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2::uuid, $3::"WaitlistReason", $4::uuid, $5, $6, $7, $8, now())`,
        [row.email, row.customerId, row.reason, row.packageId, row.countryOfResidence, row.travellers, row.requestKeyHash, row.requestConfigHash],
      );
    };
    expect(await insert({})).toMatch(/one_live_per_customer_package/);
    expect(await insert({ packageId: (await pricedWorld(admin)).pkg.id })).toBe('ok');
    expect(await insert({ packageId: (await pricedWorld(admin)).pkg.id, countryOfResidence: 'nz' })).toMatch(/country_check/);
    expect(await insert({ packageId: (await pricedWorld(admin)).pkg.id, travellers: 0 })).toMatch(/travellers_check/);
  });
});

describe('waitlist_privacy: the entry follows the customer through export and erasure', () => {
  it('export lists the customer\'s entries; anonymise withdraws them and erases the address and the country', async () => {
    const c = await customerClient(t);
    expect((await c.request(requestBody(w, { contact: nonResident() }))).status).toBe(201);
    const [e] = await entriesOf(c.userId);
    const def = t.app.get(EntityRegistry).get('WaitlistEntry')!;
    expect(def.customerLink).toEqual({ kind: 'column', column: 'customerId' });
    const exported = await t.prisma.$transaction((tx) => def.handlers!.export(tx, e!.customerId));
    expect(exported).toMatchObject([{ email: c.email.toLowerCase(), countryOfResidence: 'NZ', status: 'waiting' }]);
    await t.prisma.$transaction((tx) => def.handlers!.anonymise(tx, e!.customerId));
    const after = await t.prisma.waitlistEntry.findUniqueOrThrow({ where: { id: e!.id } });
    expect(after.requestContactHmac).toBeNull();
    expect([after.status, after.countryOfResidence, after.email, after.withdrawnAt === null]).toEqual(['withdrawn', 'ZZ', `erased+${e!.customerId}@invalid`, false]);
  });
});

describe('waitlist_panel: only staff with the permission read the list', () => {
  it('lists in queue order with the contact, filters by package and status, and refuses a user without the permission', async () => {
    const p = await pricedWorld(admin);
    const reader = await staffClient(t, [WAITLIST_PERMISSIONS.read]);
    const nobody = await staffClient(t, []);
    const a = await customerClient(t);
    const b = await customerClient(t);
    expect((await a.request(requestBody(p, { contact: nonResident({ givenName: 'First' }) }))).status).toBe(201);
    expect((await b.request(requestBody(p, { contact: nonResident({ givenName: 'Second' }) }))).status).toBe(201);
    const list = await reader.get(`/admin/waitlist?packageId=${p.pkg.id}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((i: { customer: { givenName: string } }) => i.customer.givenName)).toEqual(['First', 'Second']);
    expect(list.body.items[0]).toMatchObject({ status: 'waiting', reason: 'non_resident', countryOfResidence: 'NZ', travellers: 2, email: a.email.toLowerCase() });
    expect(JSON.stringify(list.body)).not.toMatch(/requestKeyHash|requestConfigHash/);
    const page = await reader.get(`/admin/waitlist?packageId=${p.pkg.id}&limit=1`);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBe(`${p.pkg.id}:${list.body.items[0].position}`);
    expect((await reader.get(`/admin/waitlist?packageId=${p.pkg.id}&cursor=${page.body.nextCursor}`)).body.items.map((i: { id: string }) => i.id)).toEqual([list.body.items[1].id]);
    expect((await reader.get(`/admin/waitlist?packageId=${p.pkg.id}&status=offered`)).body.items).toEqual([]);
    expect((await reader.get(`/admin/waitlist?status=nonsense`)).status).toBe(422);
    expect((await nobody.get(`/admin/waitlist`)).status).toBe(403);
    expect((await t.http().get('/admin/waitlist')).status).toBe(401);
  });

  it('paging loses nothing: across two packages, with ids out of order with positions, every entry shows up once, in list order', async () => {
    const p1 = await pricedWorld(admin);
    const p2 = await pricedWorld(admin);
    const reader = await staffClient(t, [WAITLIST_PERMISSIONS.read]);
    const clients = await Promise.all([1, 2, 3, 4].map(() => customerClient(t)));
    // Joined interleaved across the packages, and two at once, so ids (made before the insert) and positions disagree.
    for (const [i, c] of clients.entries()) expect((await c.request(requestBody(i % 2 ? p1 : p2, { contact: nonResident() }))).status).toBe(201);
    await Promise.all(clients.map((c) => c.request(requestBody(p1, { contact: nonResident() }))));
    const ours = new Set([p1.pkg.id, p2.pkg.id]);
    const all = (await t.prisma.waitlistEntry.findMany({ where: { packageId: { in: [...ours] } }, orderBy: [{ packageId: 'asc' }, { position: 'asc' }] })).map((e) => e.id);
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: { body: { items: Array<{ id: string; packageId: string }>; nextCursor: string | null } } = await reader.get(`/admin/waitlist?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...res.body.items.filter((i) => ours.has(i.packageId)).map((i) => i.id));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen, `limit ${limit}`).toEqual(all);
    }
    expect((await reader.get('/admin/waitlist?cursor=not-a-cursor')).status).toBe(422);
  });

  it('the permission is not an API key scope: it exposes customers\' contact details', () => {
    const def = t.app.get(PermissionRegistry).get(WAITLIST_PERMISSIONS.read)!;
    expect([def.apiKeyScopable, def.requiresStepUp]).toEqual([false, false]);
  });
});
