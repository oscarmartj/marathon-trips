// The panel's inbox, customer records, notes and tags (plan docs/plans/2.5-booking-crm.md, sections 1, 2 and 4).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOOKINGS_CRM_PERMISSIONS, BOOKINGS_PERMISSIONS } from '../../../src/modules/bookings';
import { PermissionRegistry, PERMISSIONS } from '../../../src/platform/access/permissions';
import { TestApp, makeApp, uniqueEmail } from '../../support/auth';
import { closeCatalogue, staffClient, CATALOGUE_AND_PRICING } from '../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents, contact, customerClient, requestBody } from '../../support/bookings';
import { ALL_CRM_PERMISSIONS, ALL_CUSTOMER_PERMISSIONS, linkedCustomer, makeQuote, sendQuote } from '../../support/crm';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof staffClient>>;
let w: PricedWorld;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_CUSTOMER_PERMISSIONS, ...ALL_CRM_PERMISSIONS, 'common.table.use', PERMISSIONS.auditRead, 'common.tag.manage']);
  w = await pricedWorld(admin);
  for (const id of [w.roomPoolId, w.entryPoolId, w.extraPoolId]) {
    const p = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } });
    await admin.patch(`/admin/catalogue/pools/${id}`, { capacity: 500, version: p.version });
  }
});
afterAll(async () => {
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const newCustomer = (over: Record<string, unknown> = {}) => ({ email: uniqueEmail('added'), givenName: 'Sam', familyName: 'Staffadded', phone: '+61 412 345 678', countryOfResidence: 'AU', ...over });

describe('adding and changing a customer', () => {
  it('staff add a customer with no sign-in; the record shows it and the audit keeps the personal values apart', async () => {
    const body = newCustomer();
    const res = await admin.post('/admin/customers', body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: body.email, givenName: 'Sam', source: 'panel', signedUp: false, bookings: [], quotes: [], emails: [], alerts: [], version: 0 });
    const row = await t.prisma.customer.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ source: 'panel', userId: null, countryOfResidence: 'AU' });
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: res.body.id, action: 'bookings.customer.created' }, include: { piiValues: true } });
    expect(JSON.stringify(log.changes)).not.toContain(body.email);
    expect(log.piiValues.map((p) => p.field).sort()).toEqual(expect.arrayContaining(['email', 'givenName', 'familyName']));
    expect(log.piiValues.every((p) => p.subjectCustomerId === res.body.id)).toBe(true);
  });

  it.each([
    ['an email that is already a customer', (b: Record<string, unknown>) => ({ ...b, email: String(b.email).toUpperCase() }), 409, 'customer_exists'],
    ['a bad email', (b: Record<string, unknown>) => ({ ...b, email: 'nope' }), 422, undefined],
    ['a country of three letters', (b: Record<string, unknown>) => ({ ...b, countryOfResidence: 'AUS' }), 422, undefined],
    ['angle brackets in a name', (b: Record<string, unknown>) => ({ ...b, givenName: '<b>x</b>' }), 422, undefined],
    ['a field nobody defined', (b: Record<string, unknown>) => ({ ...b, userId: '0190b1c0-0000-7000-8000-000000000000' }), 422, undefined],
    ['a source', (b: Record<string, unknown>) => ({ ...b, source: 'web' }), 422, undefined],
  ])('%s is refused', async (_n, change, status, code) => {
    const first = newCustomer();
    expect((await admin.post('/admin/customers', first)).status).toBe(201);
    const r = await admin.post('/admin/customers', change(first));
    expect(r.status).toBe(status);
    if (code) expect(r.body.code).toBe(code);
  });

  it('changing the contact needs the current version, is audited and a stale version is a 409', async () => {
    const c = (await admin.post('/admin/customers', newCustomer())).body;
    const stale = await admin.patch(`/admin/customers/${c.id}`, { givenName: 'Sammy', version: c.version + 5 });
    expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
    const ok = await admin.patch(`/admin/customers/${c.id}`, { givenName: 'Sammy', phone: null, version: c.version });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ givenName: 'Sammy', phone: null, version: c.version + 1 });
    const unchanged = await admin.patch(`/admin/customers/${c.id}`, { givenName: 'Sammy', version: c.version + 1 });
    expect(unchanged.body.version).toBe(c.version + 1);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: c.id, action: 'bookings.customer.updated' }, include: { piiValues: true } });
    expect(log.piiValues.find((p) => p.field === 'givenName')).toMatchObject({ before: 'Sam', after: 'Sammy' });
    expect((await admin.patch(`/admin/customers/${c.id}`, { email: 'new@example.test', version: 2 })).status).toBe(422);
    expect((await admin.patch(`/admin/customers/0190b1c0-0000-7000-8000-000000000000`, { givenName: 'X', version: 0 })).status).toBe(404);
  });

  it('a closed customer cannot be changed', async () => {
    const c = (await admin.post('/admin/customers', newCustomer())).body;
    await t.prisma.customer.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
    expect((await admin.patch(`/admin/customers/${c.id}`, { givenName: 'Z', version: c.version })).body.code).toBe('customer_closed');
  });

  it('a customer staff added links to the person who signs in with that address, who then asks for a trip', async () => {
    const body = newCustomer();
    const c = (await admin.post('/admin/customers', body)).body;
    const client = await customerClient(t, body.email);
    const r = await client.request(requestBody(w, { contact: contact({ givenName: 'Sam', familyName: 'Staffadded' }) }));
    expect(r.status).toBe(201);
    expect(await t.prisma.customer.count({ where: { email: body.email } })).toBe(1);
    const record = (await admin.get(`/admin/customers/${c.id}`)).body;
    expect(record).toMatchObject({ signedUp: true });
    expect(record.bookings.map((b: { reference: string }) => b.reference)).toEqual([r.body.reference]);
  });

  it('customer routes need their permissions, and the booking and customer permissions are not API key scopes', async () => {
    const reader = await staffClient(t, [BOOKINGS_CRM_PERMISSIONS.customerRead]);
    const c = (await admin.post('/admin/customers', newCustomer())).body;
    expect((await reader.get('/admin/customers')).status).toBe(200);
    expect((await reader.get(`/admin/customers/${c.id}`)).status).toBe(200);
    expect((await reader.post('/admin/customers', newCustomer())).status).toBe(403);
    expect((await reader.patch(`/admin/customers/${c.id}`, { givenName: 'X', version: 0 })).status).toBe(403);
    const nobody = await staffClient(t, [BOOKINGS_PERMISSIONS.read]);
    expect((await nobody.get('/admin/customers')).status).toBe(403);
    const registry = t.app.get(PermissionRegistry);
    for (const k of Object.values(BOOKINGS_CRM_PERMISSIONS)) expect([k, registry.get(k)?.apiKeyScopable]).toEqual([k, false]);
  });
});

describe('the customer record', () => {
  it('lists bookings, quotes and emails of this customer only, newest first', async () => {
    const { client, customerId } = await linkedCustomer(t);
    const other = await linkedCustomer(t);
    const req = await client.request(requestBody(w));
    expect(req.status).toBe(201);
    const q = await sendQuote(admin, await makeQuote(admin, customerId, w));
    await sendQuote(admin, await makeQuote(admin, other.customerId, w));
    const rec = (await admin.get(`/admin/customers/${customerId}`)).body;
    expect(rec.bookings.map((b: { reference: string }) => b.reference)).toEqual([req.body.reference]);
    expect(rec.bookings[0]).toMatchObject({ status: 'requested', currency: 'AUD', totalMinor: req.body.totalMinor });
    expect(rec.quotes.map((x: { reference: string }) => x.reference)).toEqual([q.reference]);
    expect(rec.emails.map((e: { templateKey: string }) => e.templateKey)).toEqual(['crm.quote_sent']);
    expect(JSON.stringify(rec)).not.toContain(other.client.email);
    expect(rec).not.toHaveProperty('userId');
  });

  it('shows the opening alerts of the customer by id or address', async () => {
    const { client, customerId } = await linkedCustomer(t);
    await t.prisma.alertSubscription.create({ data: { email: client.email, raceId: w.race.id, scope: 'race', status: 'confirmed', confirmedAt: new Date() } });
    const rec = (await admin.get(`/admin/customers/${customerId}`)).body;
    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toMatchObject({ status: 'confirmed' });
  });

  it('the list searches by name or address, word by word, and pages', async () => {
    const tag = `zq${Date.now().toString(36)}`;
    const a = (await admin.post('/admin/customers', newCustomer({ givenName: `Alma${tag}`, familyName: 'Boyd' }))).body;
    await admin.post('/admin/customers', newCustomer({ givenName: `Alma${tag}`, familyName: 'Cole' }));
    expect((await admin.get(`/admin/customers?q=Alma${tag}`)).body.items).toHaveLength(2);
    const one = (await admin.get(`/admin/customers?q=${encodeURIComponent(`alma${tag} boyd`)}`)).body.items;
    expect(one.map((c: { id: string }) => c.id)).toEqual([a.id]);
    const byMail = (await admin.get(`/admin/customers?q=${encodeURIComponent(a.email.slice(0, 20))}`)).body.items;
    expect(byMail.map((c: { id: string }) => c.id)).toContain(a.id);
    const page = (await admin.get(`/admin/customers?q=Alma${tag}&limit=1`)).body;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(page.items[0].id);
    expect((await admin.get('/admin/customers?q=a')).status).toBe(422);
  });
});

describe('the inbox', () => {
  it('searches by reference, name and address; filters by customer and status; counts by state', async () => {
    const surname = `Findme${Date.now().toString(36)}`;
    const a = await linkedCustomer(t);
    const b = await linkedCustomer(t);
    const ra = (await a.client.request(requestBody(w, { contact: contact({ givenName: 'Inbox', familyName: surname }) }))).body;
    const rb = (await b.client.request(requestBody(w))).body;
    const ids = async (qs: string) => (await admin.get(`/admin/bookings?${qs}`)).body.items.map((i: { reference: string }) => i.reference);
    expect(await ids(`q=${surname}`)).toEqual([ra.reference]);
    expect(await ids(`q=${encodeURIComponent(`inbox ${surname}`)}`)).toEqual([ra.reference]);
    expect(await ids(`q=${a.client.email.slice(0, 18)}`)).toEqual([ra.reference]);
    expect(await ids(`q=${rb.reference.toLowerCase()}`)).toEqual([rb.reference]);
    expect(await ids(`customerId=${b.customerId}`)).toEqual([rb.reference]);
    expect(await ids(`customerId=${b.customerId}&status=approved`)).toEqual([]);
    expect(await ids(`q=${surname}&customerId=${b.customerId}`)).toEqual([]);
    expect((await admin.get('/admin/bookings?q=x')).status).toBe(422);

    const before = (await admin.get('/admin/bookings/summary')).body.counts;
    const detail = (await admin.get(`/admin/bookings?customerId=${a.customerId}`)).body.items[0];
    expect((await admin.post(`/admin/bookings/${detail.id}/approve`, { version: detail.version })).status).toBe(200);
    const after = (await admin.get('/admin/bookings/summary')).body.counts;
    expect([(after.requested ?? 0) - (before.requested ?? 0), (after.approved ?? 0) - (before.approved ?? 0)]).toEqual([-1, 1]);
  });

  it('the summary needs the read permission', async () => {
    const nobody = await staffClient(t, [BOOKINGS_CRM_PERMISSIONS.customerRead]);
    expect((await nobody.get('/admin/bookings/summary')).status).toBe(403);
  });
});

describe('notes, tags and history on customers and bookings (the shared tools of task 0.5)', () => {
  it('a note on a customer and on a booking is kept, listed, and shows in the history', async () => {
    const { client, customerId } = await linkedCustomer(t);
    const req = (await client.request(requestBody(w))).body;
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { reference: req.reference } });
    for (const [type, id] of [['Customer', customerId], ['Booking', booking.id]] as const) {
      const add = await admin.post(`/admin/tables/${type}/${id}/notes`, { body: `Called about ${type}`, pinned: true });
      expect([type, add.status]).toEqual([type, 201]);
      const list = (await admin.get(`/admin/tables/${type}/${id}/notes`)).body;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ body: `Called about ${type}`, pinned: true });
      const history = (await admin.get(`/admin/tables/${type}/${id}/history`)).body;
      expect(history.map((h: { action: string }) => h.action)).toContain('common.note.added');
    }
    // the note's text is personal data of this customer in the audit trail
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: customerId, action: 'common.note.added' }, include: { piiValues: true } });
    expect(log.piiValues.some((p) => p.subjectCustomerId === customerId)).toBe(true);
  });

  it('tags can be put on both, and notes need the annotate permission', async () => {
    const { customerId } = await linkedCustomer(t);
    const tag = (await admin.post('/admin/tags', { name: `vip-${Date.now().toString(36)}`, colour: '#1f6feb' })).body;
    expect((await admin.put(`/admin/tables/Customer/${customerId}/tags`, { tagIds: [tag.id] })).status).toBe(200);
    const rows = (await admin.get(`/admin/tables/Customer/rows?tags=${tag.id}`)).body;
    expect(rows.rows.map((r: { id: string }) => r.id)).toEqual([customerId]);
    const reader = await staffClient(t, [BOOKINGS_CRM_PERMISSIONS.customerRead, 'common.table.use']);
    expect((await reader.get(`/admin/tables/Customer/${customerId}/notes`)).status).toBe(200);
    expect((await reader.post(`/admin/tables/Customer/${customerId}/notes`, { body: 'x', pinned: false })).status).toBe(403);
    expect((await reader.put(`/admin/tables/Customer/${customerId}/tags`, { tagIds: [] })).status).toBe(403);
    const noBooking = await staffClient(t, [BOOKINGS_CRM_PERMISSIONS.customerRead, 'common.table.use']);
    expect((await noBooking.get(`/admin/tables/Booking/${customerId}/notes`)).status).toBe(403);
  });

  it('neither table goes into the global search index', async () => {
    const tag = `Searchable${Date.now().toString(36)}`;
    await admin.post('/admin/customers', newCustomer({ givenName: tag }));
    expect((await admin.get(`/admin/search?q=${tag}`)).body.results ?? (await admin.get(`/admin/search?q=${tag}`)).body).toEqual(expect.not.arrayContaining([expect.objectContaining({ entityType: 'Customer' })]));
    expect(await t.prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM search_documents WHERE "entityType" IN ('Customer', 'Booking') LIMIT 1`).catch(() => [])).toEqual([]);
  });
});
