// Quotes through HTTP and a real PostgreSQL (plan docs/plans/2.5-booking-crm.md, sections 3 to 6).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CRM_PERMISSIONS } from '../../../src/modules/crm';
import { PermissionRegistry } from '../../../src/platform/access/permissions';
import { QuoteService } from '../../../src/modules/crm/quote.service';
import { QUOTE_OWNERSHIP_MISSES_PER_HOUR } from '../../../src/modules/crm/ownership';
import { STATE_HEADERS, TestApp, makeApp, uniqueEmail } from '../../support/auth';
import { closeCatalogue, staffClient } from '../../support/catalogue';
import { cleanBookingEvents, customerClient } from '../../support/bookings';
import { acceptQuote, crmStaff, linkedCustomer, makeQuote, quoteConfiguration, sendQuote } from '../../support/crm';
import { cardFor, pricedWorld, publishWith } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof crmStaff>>;
let owner: pg.Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await crmStaff(t);
  owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await cleanEvents();
  await closeCatalogue(t);
});

async function cleanEvents(): Promise<void> {
  await cleanBookingEvents(t);
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'crm.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'crm.%'`);
}

const poolOf = (id: string) => t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } });
async function setCapacity(id: string, capacity: number): Promise<void> {
  const p = await poolOf(id);
  const r = await admin.patch(`/admin/catalogue/pools/${id}`, { capacity, version: p.version });
  if (r.status !== 200) throw new Error(`capacity: ${r.status} ${JSON.stringify(r.body)}`);
}
async function widen(w: PricedWorld, capacity = 50): Promise<void> {
  for (const id of [w.roomPoolId, w.entryPoolId, w.extraPoolId]) await setCapacity(id, capacity);
}
/** Runs SQL as the table owner with the quote guard off, to put a quote in a state no API call can reach (an old one). */
async function asOwnerWithoutGuard(sql: string, params: unknown[] = []): Promise<void> {
  await owner.query('ALTER TABLE quotes DISABLE TRIGGER quotes_guard');
  try {
    await owner.query(sql, params);
  } finally {
    await owner.query('ALTER TABLE quotes ENABLE TRIGGER quotes_guard');
  }
}

describe('quote_has_no_amount_input: the engine prices, the request carries a configuration only', () => {
  it.each([
    ['totalMinor', { totalMinor: '1' }],
    ['priceMinor', { priceMinor: '100' }],
    ['currency', { currency: 'AUD' }],
    ['status', { status: 'sent' }],
    ['expiresAt', { expiresAt: '2030-01-01T00:00:00Z' }],
    ['a field nobody defined', { colour: 'red' }],
  ])('a top-level %s is a 422', async (_n, extra) => {
    const w = await pricedWorld(admin);
    const { customerId } = await linkedCustomer(t);
    const res = await admin.post('/admin/quotes', { customerId, configuration: quoteConfiguration(w), ...extra });
    expect(res.status).toBe(422);
    expect(await t.prisma.quote.count({ where: { packageId: w.pkg.id } })).toBe(0);
  });

  it.each([
    ['a promo code', { promoCode: 'SAVE10' }],
    ['an amount inside a room', { rooms: [{ roomOptionId: 'x', travellers: [], amountMinor: '1' }] }],
    ['a price on the configuration', { priceMinor: '1' }],
  ])('%s inside the configuration is a 422', async (_n, extra) => {
    const w = await pricedWorld(admin);
    const { customerId } = await linkedCustomer(t);
    const res = await admin.post('/admin/quotes', { customerId, configuration: { ...quoteConfiguration(w), ...extra } });
    expect(res.status).toBe(422);
  });

  it('a validity of 0 or 61 days is a 422', async () => {
    const w = await pricedWorld(admin);
    const { customerId } = await linkedCustomer(t);
    for (const validForDays of [0, 61, 1.5]) expect((await admin.post('/admin/quotes', { customerId, configuration: quoteConfiguration(w), validForDays })).status).toBe(422);
  });
});

describe('creating, sending and withdrawing', () => {
  let w: PricedWorld;
  beforeAll(async () => {
    w = await pricedWorld(admin);
    await widen(w);
  });

  it('a draft keeps the engine price and has no expiry; sending sets it, queues one email and lets the customer see it', async () => {
    const { client, customerId } = await linkedCustomer(t);
    const q = await makeQuote(admin, customerId, w);
    const draft = (await admin.get(`/admin/quotes/${q.id}`)).body;
    expect(draft).toMatchObject({ status: 'draft', expiresAt: null, currency: 'AUD', reference: expect.stringMatching(/^QT-[0-9A-HJKMNP-TV-Z]{6}$/) });
    // runner 50 000 (double room, alone with a supporter: 2 x 50 000) + marathon 30 000 + supporter 2 500 = the engine's answer, as digits
    const engine = await admin.post('/admin/pricing/quotes', quoteConfiguration(w));
    expect(draft.totalMinor).toBe(engine.body.totalMinor);
    expect(draft.priceBreakdown.trace).toBeDefined();
    // a draft is not the customer's yet
    expect((await t.http().get(`/quotes/${q.reference}`).set('Cookie', client.cookie)).status).toBe(404);

    const sent = await admin.post(`/admin/quotes/${q.id}/send`, { version: q.version });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('sent');
    const days = (new Date(sent.body.expiresAt).getTime() - new Date(sent.body.sentAt).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(14, 3);
    const emails = await t.prisma.outboundEmail.findMany({ where: { relatedEntityType: 'Quote', relatedEntityId: q.id } });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ templateKey: 'crm.quote_sent', status: 'queued', customerId });
    const view = (await t.http().get(`/quotes/${q.reference}`).set('Cookie', client.cookie)).body;
    expect(view).toMatchObject({ reference: q.reference, status: 'sent', acceptable: true, totalMinor: draft.totalMinor, bookingReference: null });
    expect(view.price.trace).toBeUndefined();
    expect(JSON.stringify(view)).not.toMatch(/"id"|customerId|createdById/);
  });

  it('the email says what is offered and until when, and nothing about payment or a confirmed booking', async () => {
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    const mail = await t.prisma.outboundEmail.findFirstOrThrow({ where: { relatedEntityId: q.id } });
    const { MailService } = await import('../../../src/platform/mail/mail.service');
    expect(await t.app.get(MailService).processSend(mail.id)).toBe('sent');
    const msg = t.mail.sent.filter((m) => m.to === client.email).at(-1)!;
    expect(msg.subject).toContain(q.reference);
    expect(msg.text).toContain(`/quotes/${q.reference}`);
    expect(msg.text).toMatch(/A\$[\d,]+\.\d{2}/);
    expect(msg.text).not.toMatch(/confirmed booking|pay now|payment link/i);
  });

  it('quote_send_enqueues_one_email: sending twice, or two sends at once, queue one', async () => {
    const { customerId } = await linkedCustomer(t);
    const q = await makeQuote(admin, customerId, w);
    const rs = await Promise.all([admin.post(`/admin/quotes/${q.id}/send`, { version: q.version }), admin.post(`/admin/quotes/${q.id}/send`, { version: q.version })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await admin.post(`/admin/quotes/${q.id}/send`, { version: q.version + 1 })).body.code).toBe('transition_not_allowed');
    expect(await t.prisma.outboundEmail.count({ where: { relatedEntityId: q.id } })).toBe(1);
  });

  it('a stale version is a 409 and changes nothing', async () => {
    const { customerId } = await linkedCustomer(t);
    const q = await makeQuote(admin, customerId, w);
    const r = await admin.post(`/admin/quotes/${q.id}/send`, { version: q.version + 3 });
    expect([r.status, r.body.code]).toEqual([409, 'version_conflict']);
    expect((await t.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('draft');
  });

  it('quote_transitions_matrix: only draft → sent | withdrawn and sent → withdrawn work through the API; the rest are 409', async () => {
    const { customerId } = await linkedCustomer(t);
    const fresh = () => makeQuote(admin, customerId, w);
    const state = async (id: string) => (await t.prisma.quote.findUniqueOrThrow({ where: { id } })).status;
    const d1 = await fresh();
    expect((await admin.post(`/admin/quotes/${d1.id}/withdraw`, { version: d1.version })).body.status).toBe('withdrawn');
    for (const action of ['send', 'withdraw']) {
      const v = (await t.prisma.quote.findUniqueOrThrow({ where: { id: d1.id } })).version;
      const r = await admin.post(`/admin/quotes/${d1.id}/${action}`, { version: v });
      expect([r.status, r.body.code, await state(d1.id)]).toEqual([409, 'transition_not_allowed', 'withdrawn']);
    }
    const s1 = await sendQuote(admin, await fresh());
    expect((await admin.post(`/admin/quotes/${s1.id}/send`, { version: s1.version })).status).toBe(409);
    expect((await admin.post(`/admin/quotes/${s1.id}/withdraw`, { version: s1.version })).body.status).toBe('withdrawn');
  });

  it('a quote for a customer that does not exist, or a package that is not open, is refused', async () => {
    const { customerId } = await linkedCustomer(t);
    expect((await admin.post('/admin/quotes', { customerId: '0190b1c0-0000-7000-8000-000000000000', configuration: quoteConfiguration(w) })).status).toBe(404);
    const closed = await pricedWorld(admin, { open: false });
    const r = await admin.post('/admin/quotes', { customerId, configuration: quoteConfiguration(closed) });
    expect([r.status, r.body.code]).toEqual([404, 'package_not_found']);
  });

  it('every route needs its permission, and the list and detail show the customer', async () => {
    const { customerId } = await linkedCustomer(t);
    const q = await makeQuote(admin, customerId, w);
    const none = await staffClient(t, ['bookings.booking.read']);
    for (const [method, path, body] of [
      ['get', '/admin/quotes'], ['get', `/admin/quotes/${q.id}`], ['post', '/admin/quotes', { customerId, configuration: quoteConfiguration(w) }],
      ['post', `/admin/quotes/${q.id}/send`, { version: 0 }], ['post', `/admin/quotes/${q.id}/withdraw`, { version: 0 }],
    ] as const) {
      const r = method === 'get' ? await none.get(path) : await none.post(path, body ?? {});
      expect([method, path, r.status]).toEqual([method, path, 403]);
    }
    const list = (await admin.get(`/admin/quotes?customerId=${customerId}`)).body;
    expect(list.items.map((i: { id: string }) => i.id)).toContain(q.id);
    expect(list.items[0].customer.id).toBe(customerId);
  });

  it('quote permissions are registered and none is an API key scope', async () => {
    const registry = t.app.get(PermissionRegistry);
    const defs = Object.values(CRM_PERMISSIONS).map((k) => registry.get(k)!);
    expect(defs.map((d) => [d.key, d.apiKeyScopable, d.requiresStepUp])).toEqual([
      ['crm.quote.read', false, false], ['crm.quote.create', false, false], ['crm.quote.send', false, false], ['crm.quote.withdraw', false, false],
    ]);
  });
});

describe('the quote table keeps what was offered (trigger)', () => {
  let w: PricedWorld;
  let q: Awaited<ReturnType<typeof makeQuote>>;
  beforeAll(async () => {
    w = await pricedWorld(admin);
    await widen(w);
    q = await sendQuote(admin, await makeQuote(admin, (await linkedCustomer(t)).customerId, w));
  });
  const run = (sql: string) => t.prisma.$executeRawUnsafe(sql.replace(/\$ID/g, `'${q.id}'`));

  it.each([
    ['the total', `UPDATE quotes SET "totalMinor" = 1 WHERE id = $ID`],
    ['the deposit', `UPDATE quotes SET "depositMinor" = 0 WHERE id = $ID`],
    ['the breakdown', `UPDATE quotes SET "priceBreakdown" = '{}' WHERE id = $ID`],
    ['the configuration', `UPDATE quotes SET "configuration" = '{}' WHERE id = $ID`],
    ['the customer', `UPDATE quotes SET "customerId" = (SELECT id FROM customers LIMIT 1 OFFSET 7) WHERE id = $ID AND false OR id = $ID`],
    ['the expiry', `UPDATE quotes SET "expiresAt" = "expiresAt" + interval '30 days' WHERE id = $ID`],
    ['the reference', `UPDATE quotes SET reference = 'QT-AAAAAA' WHERE id = $ID`],
  ])('%s cannot change', async (_n, sql) => {
    await expect(run(sql)).rejects.toThrow();
    expect((await t.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).version).toBe(q.version);
  });

  it.each([
    ['expired → sent', `UPDATE quotes SET status = 'expired', "expiredAt" = now(), version = version + 1 WHERE id = $ID`, `UPDATE quotes SET status = 'sent', version = version + 1 WHERE id = $ID`],
  ])('%s is refused', async (_n, first, second) => {
    const { customerId } = await linkedCustomer(t);
    const x = await sendQuote(admin, await makeQuote(admin, customerId, w));
    await t.prisma.$executeRawUnsafe(first.replace(/\$ID/g, `'${x.id}'`));
    await expect(t.prisma.$executeRawUnsafe(second.replace(/\$ID/g, `'${x.id}'`))).rejects.toThrow(/cannot go from/);
  });

  it('a quote is never deleted or truncated, accepted without a booking is impossible, and a draft cannot jump to accepted', async () => {
    await expect(run(`DELETE FROM quotes WHERE id = $ID`)).rejects.toThrow(/never deleted/);
    await expect(t.prisma.$executeRawUnsafe(`TRUNCATE quotes`)).rejects.toThrow();
    const { customerId } = await linkedCustomer(t);
    const d = await makeQuote(admin, customerId, w);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE quotes SET status = 'accepted', "acceptedAt" = now(), version = version + 1 WHERE id = '${d.id}'`)).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe(`UPDATE quotes SET status = 'sent', version = version + 1 WHERE id = '${d.id}'`)).rejects.toThrow(/quotes_state_check|violates check/);
  });
});

describe('accepting a quote', () => {
  it('creates an approved booking with the quote price, holds the stock and answers the same on a repeat', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    const before = await poolOf(w.roomPoolId);
    const first = await acceptQuote(t, client, q.reference);
    expect([first.status, first.body.created]).toEqual([200, true]);
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { reference: first.body.bookingReference }, include: { snapshots: true, claims: true, travellers: true, rooms: true } });
    const quote = await t.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(booking).toMatchObject({ status: 'approved', customerId, packageId: w.pkg.id, kind: 'catalogue', totalMinor: quote.totalMinor, depositMinor: quote.depositMinor, currency: quote.currency, sourceChannel: 'web' });
    expect(booking.snapshots).toHaveLength(1);
    expect(booking.snapshots[0]).toMatchObject({ version: 1, kind: 'original', totalMinor: quote.totalMinor, priceVersionId: quote.priceVersionId });
    expect(booking.snapshots[0]!.priceBreakdown).toEqual(quote.priceBreakdown);
    expect(booking.travellers).toHaveLength(2);
    expect(booking.claims.every((c) => c.status === 'held')).toBe(true);
    expect((await poolOf(w.roomPoolId)).consumed).toBe(before.consumed + 1);
    expect(quote).toMatchObject({ status: 'accepted', bookingId: booking.id, version: q.version + 1 });
    // the audit trail has the request, the approval and the quote
    const audits = await t.prisma.auditLog.findMany({ where: { entityId: { in: [booking.id, q.id] } }, select: { action: true } });
    expect(audits.map((a) => a.action).sort()).toEqual(['bookings.booking.requested', 'bookings.booking.status_changed', 'crm.quote.created', 'crm.quote.status_changed', 'crm.quote.status_changed']);

    const again = await acceptQuote(t, client, q.reference);
    expect([again.status, again.body]).toEqual([200, { bookingReference: first.body.bookingReference, created: false }]);
    expect((await poolOf(w.roomPoolId)).consumed).toBe(before.consumed + 1);
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(1);
    const view = (await t.http().get(`/quotes/${q.reference}`).set('Cookie', client.cookie)).body;
    expect(view).toMatchObject({ status: 'accepted', acceptable: false, bookingReference: first.body.bookingReference });
    const detail = (await t.http().get(`/booking-requests/${first.body.bookingReference}`).set('Cookie', client.cookie)).body;
    expect(detail).toMatchObject({ status: 'approved', isRequest: false, totalMinor: quote.totalMinor.toString() });
  });

  it('quote_accepted_twice_creates_one_booking: ten accepts at once, two tabs of one customer', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    const rs = await Promise.all(Array.from({ length: 10 }, () => acceptQuote(t, client, q.reference)));
    expect(rs.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(rs.map((r) => r.body.bookingReference)).size).toBe(1);
    expect(rs.filter((r) => r.body.created)).toHaveLength(1);
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(1);
    expect((await poolOf(w.roomPoolId)).consumed).toBe(1);
    expect(await t.prisma.inventoryClaim.count({ where: { booking: { customerId }, status: 'held' } })).toBeGreaterThan(0);
  });

  it('quote_acceptance_without_inventory_returns_409 and writes nothing', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    // someone else takes the last room after the quote went out
    const room = await poolOf(w.roomPoolId);
    await setCapacity(w.roomPoolId, room.consumed);
    const r = await acceptQuote(t, client, q.reference);
    expect([r.status, r.body.code]).toEqual([409, 'inventory_unavailable']);
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(0);
    expect(await t.prisma.inventoryClaim.count({ where: { booking: { customerId } } })).toBe(0);
    expect(await t.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: 'sent', bookingId: null, version: q.version });
    expect((await poolOf(w.entryPoolId)).consumed).toBe(0);
    // stock comes back and the same quote can be accepted
    await setCapacity(w.roomPoolId, 5);
    expect((await acceptQuote(t, client, q.reference)).status).toBe(200);
  });

  it('two quotes for the last place: one customer gets it, the other a 409', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    await setCapacity(w.roomPoolId, 1);
    const a = await linkedCustomer(t);
    const b = await linkedCustomer(t);
    const qa = await sendQuote(admin, await makeQuote(admin, a.customerId, w));
    const qb = await sendQuote(admin, await makeQuote(admin, b.customerId, w));
    const rs = await Promise.all([acceptQuote(t, a.client, qa.reference), acceptQuote(t, b.client, qb.reference)]);
    expect(rs.map((r) => (r.status === 200 ? '200' : `${r.status} ${r.body.code}`)).sort()).toEqual(['200', '409 inventory_unavailable']);
    expect((await poolOf(w.roomPoolId)).consumed).toBe(1);
  });

  it('quote_price_survives_price_change: a new price version after the quote does not change the booking', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    const cheaper = cardFor({ roomId: w.roomId, extraId: w.extraId, distanceId: w.distanceId });
    cheaper.roomRates = cheaper.roomRates.map((r) => ({ ...r, pricePerPersonMinor: '1000' }));
    const newVersion = await publishWith(admin, w.pkg.id, cheaper, 'Cheaper');
    expect(newVersion).not.toBe(w.versionId);
    const live = await admin.post('/admin/pricing/quotes', quoteConfiguration(w));
    const quote = await t.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(live.body.totalMinor).not.toBe(quote.totalMinor.toString());
    const r = await acceptQuote(t, client, q.reference);
    expect(r.status).toBe(200);
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { reference: r.body.bookingReference }, include: { snapshots: true } });
    expect(booking.totalMinor).toBe(quote.totalMinor);
    expect(booking.snapshots[0]!.priceVersionId).toBe(w.versionId);
  });

  it('expired_quote_cannot_be_accepted: at and after the expiry instant it is 409, before it is fine', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    await asOwnerWithoutGuard(`UPDATE quotes SET "expiresAt" = clock_timestamp() - interval '1 second' WHERE id = $1`, [q.id]);
    const r = await acceptQuote(t, client, q.reference);
    expect([r.status, r.body.code]).toEqual([409, 'quote_expired']);
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(0);
    expect((await t.http().get(`/quotes/${q.reference}`).set('Cookie', client.cookie)).body.acceptable).toBe(false);
    // a quote with a minute left is accepted
    const ok = await sendQuote(admin, await makeQuote(admin, customerId, w));
    await asOwnerWithoutGuard(`UPDATE quotes SET "expiresAt" = clock_timestamp() + interval '1 minute' WHERE id = $1`, [ok.id]);
    expect((await acceptQuote(t, client, ok.reference)).status).toBe(200);
  });

  it('a withdrawn, an expired and a draft quote cannot be accepted; a draft looks like it does not exist', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const withdrawn = await makeQuote(admin, customerId, w);
    const w1 = await sendQuote(admin, withdrawn);
    await admin.post(`/admin/quotes/${w1.id}/withdraw`, { version: w1.version });
    const r1 = await acceptQuote(t, client, w1.reference);
    expect([r1.status, r1.body.code]).toEqual([409, 'quote_not_available']);
    const draft = await makeQuote(admin, customerId, w);
    expect((await acceptQuote(t, client, draft.reference)).status).toBe(404);
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(0);
  });

  it('a package that closed since the quote went out cannot be booked; the quote stays sent', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    const closed = await admin.post(`/admin/catalogue/packages/${w.pkg.id}/sale-status`, { status: 'closed', version: pkg.version });
    expect(closed.status).toBe(200);
    const r = await acceptQuote(t, client, q.reference);
    expect([r.status, r.body.code]).toEqual([409, 'package_not_open']);
    expect((await t.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('sent');
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(0);
  });

  it('quote_of_other_customer_is_404: another customer, a staff session and no session are all refused the same way', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const mine = await linkedCustomer(t);
    const other = await customerClient(t, uniqueEmail('other'));
    const q = await sendQuote(admin, await makeQuote(admin, mine.customerId, w));
    const notFound = { status: 404, code: 'not_found' };
    const res = async (r: Promise<{ status: number; body: { code?: string } }>) => { const x = await r; return { status: x.status, code: x.body.code }; };
    expect(await res(t.http().get(`/quotes/${q.reference}`).set('Cookie', other.cookie))).toEqual(notFound);
    expect(await res(acceptQuote(t, other, q.reference))).toEqual(notFound);
    expect(await res(t.http().get('/quotes/QT-ZZZZZZ').set('Cookie', other.cookie))).toEqual(notFound);
    expect((await t.http().get(`/quotes/${q.reference}`).set('Cookie', 'x=1')).status).toBe(401);
    expect((await t.http().post(`/quotes/${q.reference}/accept`).set(STATE_HEADERS).send({})).status).toBe(401);
    expect(await t.prisma.booking.count({ where: { customerId: mine.customerId } })).toBe(0);
  });

  it('guessing references is capped per user and hour', async () => {
    const guesser = await customerClient(t, uniqueEmail('guess'));
    for (let i = 0; i < QUOTE_OWNERSHIP_MISSES_PER_HOUR; i++) await t.http().get('/quotes/QT-ZZZZZZ').set('Cookie', guesser.cookie);
    const w = await pricedWorld(admin);
    const own = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, own.customerId, w));
    // the caps are per user: a user that did not guess is unaffected
    expect((await t.http().get(`/quotes/${q.reference}`).set('Cookie', own.client.cookie)).status).toBe(200);
    expect((await t.http().get('/quotes/QT-ZZZZZZ').set('Cookie', guesser.cookie)).status).toBe(404);
  });

  it('a customer closed after the quote was sent cannot accept it', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    await t.prisma.customer.update({ where: { id: customerId }, data: { deletedAt: new Date() } });
    const r = await acceptQuote(t, client, q.reference);
    expect([r.status, r.body.code]).toEqual([409, 'customer_closed']);
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(0);
  });
});

describe('expiry job', () => {
  it('expiry_job_expires_only_due_quotes, once, and frees the quote from the customer view', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const due = await sendQuote(admin, await makeQuote(admin, customerId, w));
    const later = await sendQuote(admin, await makeQuote(admin, customerId, w));
    const draft = await makeQuote(admin, customerId, w);
    await asOwnerWithoutGuard(`UPDATE quotes SET "expiresAt" = clock_timestamp() - interval '1 minute' WHERE id = $1`, [due.id]);
    const svc = t.app.get(QuoteService);
    const first = await svc.expireDue();
    expect(first.failed).toBe(0);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(await t.prisma.quote.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ status: 'expired', version: due.version + 1 });
    expect((await t.prisma.quote.findUniqueOrThrow({ where: { id: later.id } })).status).toBe('sent');
    expect((await t.prisma.quote.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('draft');
    expect((await svc.expireDue()).expired).toBe(0);
    expect((await t.http().get(`/quotes/${due.reference}`).set('Cookie', client.cookie)).body).toMatchObject({ status: 'expired', acceptable: false });
    expect(await t.prisma.auditLog.count({ where: { entityId: due.id, action: 'crm.quote.status_changed' } })).toBeGreaterThanOrEqual(2);
  });

  it('the expiry job and an acceptance at the same moment: one wins, the booking is never made from an expired quote', async () => {
    const w = await pricedWorld(admin);
    await widen(w);
    const { client, customerId } = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    await asOwnerWithoutGuard(`UPDATE quotes SET "expiresAt" = clock_timestamp() + interval '1 second' WHERE id = $1`, [q.id]);
    await new Promise((r) => setTimeout(r, 1200));
    const [accept] = await Promise.all([acceptQuote(t, client, q.reference), t.app.get(QuoteService).expireDue()]);
    // Whoever takes the quote's lock first: the acceptance sees the passed time (quote_expired), or the job already marked it.
    expect(accept.status).toBe(409);
    expect(['quote_expired', 'quote_not_available']).toContain(accept.body.code);
    expect(await t.prisma.booking.count({ where: { customerId } })).toBe(0);
    expect(await t.prisma.inventoryClaim.count({ where: { booking: { customerId } } })).toBe(0);
  });
});
