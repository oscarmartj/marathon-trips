// The erasure sweep (task 5.5, plan docs/plans/5.5-privacy-export-erase.md, section 10.7; plan 0.1, the 5.5 test list).
// The columns written are generated from the entity registry, the executor's own tables and FIELD_CLASSES, not listed by
// hand: every personal text, list, JSON and bytes column of every customer row gets a marker, every personal date,
// integer and two-letter column a sentinel. After the erasure, the marker is nowhere in the database (public and pgboss)
// and the sentinels are gone, while another customer keeps theirs and the financial rows are all still there.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TasksService } from '../../../src/platform/common/tasks/tasks.service';
import { AuditService, SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { FIELD_CLASSES } from '../../../src/platform/audit/field-classes.generated';
import { EntityRegistry } from '../../../src/platform/entities/entity-registry';
import { EXECUTOR_TABLES, POLYMORPHIC_TABLES, customerRecordIds } from '../../../src/platform/privacy/records';
import { STATE_HEADERS, TestApp, makeApp, signInCustomer } from '../../support/auth';
import { cleanBookingEvents, contact, customerClient, requestBody } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { walkTo } from '../../support/customer-portal';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import { SimAccount, acceptCurrentTerms, cleanPayments, deliver, ensureTerms, eventFor, onlyAccount, paymentsStaff, sim, simulatorAccount } from '../../support/payments';
import { createCode, freshCode } from '../../support/adjustments';
import { crmStaff, makeQuote } from '../../support/crm';
import { joinList, soldOutWorld } from '../../support/waitlist';
import { bookingStaff } from '../../support/bookings';
import { privacyStaff } from '../../support/privacy';
import type { StaffHttp } from '../../support/privacy';
import { parseSchema } from '../../conventions/schema-conventions';
import type { Model } from '../../conventions/schema-conventions';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const SCHEMA_DIR = join(__dirname, '../../../prisma/schema');
const models: Model[] = parseSchema(readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma')).map((f) => ({ name: f, text: readFileSync(join(SCHEMA_DIR, f), 'utf8') })));
const byName = new Map(models.map((m) => [m.name, m]));

let t: TestApp;
let owner: StaffHttp;
let w: PricedWorld;
let db: pg.Client;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let acc: SimAccount;
beforeAll(async () => {
  t = await makeApp();
  owner = await privacyStaff(t, { owner: true });
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  await ensureTerms(t);
  w = await pricedWorld(admin);
  db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await db.connect();
});
afterAll(async () => {
  await db.end();
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const letters = (n: number) => Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
const TEXT_TYPES = new Set(['String', 'Json', 'Bytes']);
const SENTINEL_DATE = '1901-02-03';
const SENTINEL_INT = 98765;
const SENTINEL_CHAR = 'NR';
// Phone columns only take digits (CHECK): they get a sentinel number instead of the marker.
const SENTINEL_PHONE = '+61 498 765 432';

/**
 * Personal columns whose own constraints refuse arbitrary text or a sentinel (review M2: listed, so a new one cannot go
 * untested silently). Each is still erased by its handler; the marker test simply cannot write into it.
 */
const EXPECTED_REFUSED: string[] = [];
// The webhook's raw body is never edited, only cleared (trigger, 3.3): the G1 test checks it is cleared.
const EXPECTED_REFUSED_PAID: string[] = ['webhook_events.rawBody'];

type Planted = { table: string; column: string; ids: string[]; kind: 'marker' | 'date' | 'int' | 'char' | 'phone' };

/** A customer that has been through every flow that keeps personal data, with `marker` in all of it. */
async function richCustomer(marker: string) {
  const email = `${marker}-${letters(4)}@example.test`;
  // The user exists before the customer: its audit values have only subjectUserId (written here through the service).
  const who = await signInCustomer(t, email);
  await t.prisma.$transaction((tx) => t.app.get(AuditService).record(tx, {
    actor: SYSTEM_ACTOR, action: 'auth.user.updated', entityType: 'User', entityId: who.userId, model: 'User', before: { email: `${marker}-old@example.test` }, after: { email },
  }));
  const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', who.cookie).set('Idempotency-Key', randomUUID())
    .send(requestBody(w, { contact: contact({ givenName: `${marker}given`, familyName: `${marker}family` }) }));
  if (res.status !== 201) throw new Error(`request failed ${res.status} ${JSON.stringify(res.body)}`);
  const booking = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string }, select: { id: true, customerId: true } });
  await walkTo(t, booking.id, 'declined');
  const customerId = booking.customerId;

  // Task 5.2: the traveller details of the booking, personal data the customer typed.
  await t.prisma.traveller.create({
    data: { bookingId: booking.id, customerId, slot: 1, givenName: `${marker}trav`, familyName: `${marker}eller`, dateOfBirth: new Date('1980-05-06'),
      emergencyContactName: `${marker} contact`, emergencyContactPhone: '+61 400 222 333', estimatedFinishSeconds: 14400 },
  });

  // Staff notes and tasks on the customer and the booking; a system task records its title in the audit log.
  for (const [entityType, entityId] of [['Customer', customerId], ['Booking', booking.id]] as const) {
    await t.prisma.note.create({ data: { entityType, entityId, body: `${marker} note on ${entityType}`, authorId: owner.staff.id } });
    await t.prisma.$transaction((tx) => t.app.get(TasksService).createSystemIn(tx, { title: `${marker} task on ${entityType}`, description: `${marker} details`, entityType, entityId, sourceRef: `sweep:${randomUUID()}:${entityType}` }));
  }
  // An old task audit row written before tasks had a subject: subject-less, about a task on the customer.
  const oldTask = await t.prisma.task.create({ data: { title: `${marker} old task`, entityType: 'Customer', entityId: customerId, source: 'manual' } });
  const log = await t.prisma.auditLog.create({ data: { actorType: 'system', action: 'common.task.created', entityType: 'Task', entityId: oldTask.id, changes: { title: '[pii]' } } });
  await t.prisma.auditPiiValue.create({ data: { auditLogId: log.id, field: 'title', after: `${marker} old task` } });

  // A complaint logged with the customer's address but no link (upper-case), with its subject-less audit values.
  const complaint = await t.prisma.complaint.create({
    data: {
      reference: `CP-${letters(6).toUpperCase().replace(/[ILOU]/g, 'A')}`, complainantName: `${marker} complainant`, complainantEmail: email.toUpperCase(), channel: 'email', category: 'service',
      summary: `${marker} summary`, description: `${marker} words`, receivedDate: new Date(), acknowledgeDueDate: new Date(Date.now() + 86_400_000), resolveDueDate: new Date(Date.now() + 2 * 86_400_000), createdById: owner.staff.id,
    },
  });
  await t.prisma.$transaction((tx) => t.app.get(AuditService).record(tx, { actor: SYSTEM_ACTOR, action: 'complaints.complaint.logged', entityType: 'Complaint', entityId: complaint.id, model: 'Complaint', after: { complainantName: `${marker} complainant` } }));
  await t.prisma.note.create({ data: { entityType: 'Complaint', entityId: complaint.id, body: `${marker} complaint note`, authorId: owner.staff.id } });

  // An opening alert through the public form (the address is stored as typed, lower-cased), and one written in mixed case.
  await t.prisma.race.update({ where: { id: w.race.id }, data: { status: 'published' } });
  expect((await t.http().post('/alerts/subscriptions').set(STATE_HEADERS).send({ email: email.toUpperCase(), raceSlug: w.race.slug })).status).toBe(202);
  await t.prisma.$executeRawUnsafe(`INSERT INTO alert_subscriptions (id, email, "raceId", "editionId", scope, "updatedAt") VALUES (gen_random_uuid(), $1, $2::uuid, $3::uuid, $4, now())`, email.replace(/^./, (c) => c.toUpperCase()), w.race.id, w.edition.id, `edition:${w.edition.id}`);

  // Mail to the address, with a subject; a sign-in link; the session's browser.
  await t.prisma.outboundEmail.create({ data: { to: email, subject: `${marker} subject`, templateKey: 'k', templateVersion: 1, locale: 'en-AU', dedupeKey: `sweep:${randomUUID()}`, status: 'sent', customerId } });
  await t.prisma.outboundEmail.create({ data: { to: email.toUpperCase(), subject: `${marker} unlinked`, templateKey: 'k', templateVersion: 1, locale: 'en-AU', dedupeKey: `sweep:${randomUUID()}:2`, status: 'sent' } });
  await t.prisma.loginToken.create({ data: { purpose: 'magic_link', email, userId: who.userId, expiresAt: new Date(Date.now() + 60_000) } });
  await t.prisma.session.updateMany({ where: { userId: who.userId }, data: { userAgent: `${marker}-browser` } });
  return { customerId, userId: who.userId, bookingId: booking.id, email, complaintId: complaint.id };
}

/**
 * Writes the marker (or a sentinel) into every personal column of the customer's rows, as the API role, one savepoint
 * per column: a column whose constraints refuse the value is reported and skipped (it cannot hold arbitrary text).
 */
async function plantEverywhere(marker: string, who: { customerId: string; userId: string }): Promise<{ planted: Planted[]; refused: string[] }> {
  const records = await t.prisma.$transaction((tx) => customerRecordIds(tx, t.app.get(EntityRegistry), who.customerId));
  const own = new Map<string, string[]>(records);
  const ids = async (sql: string) => (await db.query(sql, [who.userId, who.customerId])).rows.map((r) => r.id as string);
  own.set('User', [who.userId]);
  own.set('Session', await ids(`SELECT id FROM sessions WHERE "userId" = $1 AND $2::uuid IS NOT NULL`));
  own.set('LoginToken', await ids(`SELECT id FROM login_tokens WHERE "userId" = $1 AND $2::uuid IS NOT NULL`));
  own.set('OutboundEmail', await ids(`SELECT id FROM outbound_emails WHERE "customerId" = $2 AND $1::uuid IS NOT NULL`));
  const planted: Planted[] = [];
  const refused: string[] = [];
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const [modelName, rowIds] of own) {
      const m = byName.get(modelName);
      if (!m || rowIds.length === 0) continue;
      const classes = FIELD_CLASSES[modelName] ?? {};
      for (const f of m.fields) {
        // Address columns already hold the marker (the customer's own address): rewriting them would break the link by
        // address that erasure follows for rows like alerts and unlinked complaints.
        if (f.relation || (classes[f.name] ?? 'pii') !== 'pii' || /@id\b/.test(f.attrs) || /@db\.Uuid/.test(f.attrs) || /email/i.test(f.name)) continue;
        const isChar = /@db\.Char\(2\)/.test(f.attrs);
        const kind: Planted['kind'] | null = isChar ? 'char' : /phone/i.test(f.name) && f.type === 'String' ? 'phone' : TEXT_TYPES.has(f.type) ? 'marker' : f.type === 'DateTime' ? 'date' : f.type === 'Int' ? 'int' : null;
        if (!kind) continue;
        const value = kind === 'phone' ? `'${SENTINEL_PHONE}'` : kind === 'char' ? `'${SENTINEL_CHAR}'` : kind === 'date' ? `'${SENTINEL_DATE}'` : kind === 'int' ? String(SENTINEL_INT)
          : f.type === 'Json' ? `jsonb_build_object('m', '${marker} ${m.table}.${f.name}')`
          : f.type === 'Bytes' ? `convert_to('${marker} ${m.table}.${f.name}', 'UTF8')`
          : f.list ? `ARRAY['${marker} ${m.table}.${f.name}']` : `'${marker}-' || id::text || '-${f.name}@example.test'`;
        await client.query('SAVEPOINT p');
        try {
          await client.query(`UPDATE "${m.table}" SET "${f.name}" = ${value} WHERE id = ANY($1::uuid[])`, [rowIds]);
          await client.query('RELEASE SAVEPOINT p');
          planted.push({ table: m.table, column: f.name, ids: rowIds, kind });
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT p');
          refused.push(`${m.table}.${f.name}`);
        }
      }
    }
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
  return { planted, refused };
}

/** Planted date, number, phone and country columns that still hold their sentinel. */
async function sentinelsLeft(planted: Planted[]): Promise<string[]> {
  const kept: string[] = [];
  for (const p of planted.filter((x) => x.kind !== 'marker')) {
    const sentinel = p.kind === 'date' ? SENTINEL_DATE : p.kind === 'int' ? SENTINEL_INT : p.kind === 'phone' ? SENTINEL_PHONE : SENTINEL_CHAR;
    const q = await db.query(`SELECT count(*)::int AS n FROM "${p.table}" WHERE id = ANY($1::uuid[]) AND "${p.column}"::text LIKE $2`, [p.ids, `${sentinel}%`]);
    if (q.rows[0].n > 0) kept.push(`${p.table}.${p.column}`);
  }
  return kept;
}

/** Tables of public and pgboss in which `marker` appears anywhere in a row. */
async function tablesWith(marker: string): Promise<string[]> {
  const { rows } = await db.query(`SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'pgboss')`);
  const hits: string[] = [];
  for (const r of rows) {
    const q = await db.query(`SELECT count(*)::int AS n FROM "${r.schemaname}"."${r.tablename}" x WHERE x::text ILIKE $1`, [`%${marker}%`]);
    if (q.rows[0].n > 0) {
      hits.push(`${r.schemaname}.${r.tablename}`);
      if (process.env.SWEEP_DEBUG) console.log('HIT', r.tablename, JSON.stringify((await db.query(`SELECT x::text AS t FROM "${r.schemaname}"."${r.tablename}" x WHERE x::text ILIKE $1 LIMIT 2`, [`%${marker}%`])).rows));
    }
  }
  return hits;
}

describe('erasure_sweep_leaves_no_marker', () => {
  it('every personal column of every customer row is erased; another customer keeps theirs; the money rows stay', async () => {
    const marker = `zq${letters(8)}`;
    const otherMarker = `zq${letters(8)}`;
    const a = await richCustomer(marker);
    const b = await richCustomer(otherMarker);
    const { planted, refused } = await plantEverywhere(marker, a);
    expect(refused.sort()).toEqual(EXPECTED_REFUSED);
    // Something must have been planted in every registered table that has a personal text column and rows of A's.
    expect(planted.length).toBeGreaterThan(10);
    // 5.2's travellers come in through the registry contract: their dates and numbers get sentinels too.
    expect(planted.map((p) => `${p.table}.${p.column}`)).toEqual(expect.arrayContaining(['travellers.givenName', 'travellers.dateOfBirth', 'travellers.estimatedFinishSeconds', 'customers.countryOfResidence']));
    expect((await tablesWith(marker)).length).toBeGreaterThan(5);
    const money = async () => ({
      snapshots: await t.prisma.bookingSnapshot.count({ where: { booking: { customerId: a.customerId } } }),
      bookings: await t.prisma.booking.count({ where: { customerId: a.customerId } }),
      payments: await t.prisma.payment.count({ where: { booking: { customerId: a.customerId } } }),
      movements: await t.prisma.inventoryMovement.count({ where: { booking: { customerId: a.customerId } } }),
      terms: await t.prisma.termsAcceptance.count({ where: { customerId: a.customerId } }),
      audit: await t.prisma.auditLog.count({ where: { entityId: a.customerId } }),
    });
    const before = await money();

    const r = await owner.post(`/admin/privacy/customers/${a.customerId}/erasure`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    expect(await tablesWith(marker), `refused to hold a marker: ${refused.join(', ')}`).toEqual([]);
    expect(await sentinelsLeft(planted), 'personal date, number, phone or country columns still holding their sentinel').toEqual([]);
    const after = await money();
    expect(after).toEqual({ ...before, audit: after.audit });
    expect(after.audit).toBeGreaterThan(before.audit);
    // The other customer is untouched.
    expect((await tablesWith(otherMarker)).length).toBeGreaterThan(5);
    expect((await t.prisma.customer.findUniqueOrThrow({ where: { id: b.customerId } })).givenName).toBe(`${otherMarker}given`);
  });

  it('erasure_redacts_polymorphic_notes_and_tasks and erasure_removes_user_audit_pii_written_before_customer_existed', async () => {
    const marker = `zq${letters(8)}`;
    const a = await richCustomer(marker);
    expect(await t.prisma.auditPiiValue.count({ where: { subjectUserId: a.userId } })).toBeGreaterThan(0);
    // The new Task subject resolver: the system task's title values carry the customer as subject.
    expect(await t.prisma.auditPiiValue.count({ where: { subjectCustomerId: a.customerId, auditLog: { entityType: 'Task' } } })).toBeGreaterThan(0);
    expect((await owner.post(`/admin/privacy/customers/${a.customerId}/erasure`)).status).toBe(200);
    expect(await t.prisma.auditPiiValue.count({ where: { subjectUserId: a.userId } })).toBe(0);
    const notes = await t.prisma.note.findMany({ where: { entityId: { in: [a.customerId, a.bookingId, a.complaintId] } } });
    expect(notes.length).toBe(3);
    expect(notes.every((n) => n.body === '[redacted]')).toBe(true);
    const tasks = await t.prisma.task.findMany({ where: { entityId: { in: [a.customerId, a.bookingId] } } });
    expect(tasks.length).toBe(3);
    expect(tasks.every((k) => k.title === '[redacted]' && (k.description === null || k.description === '[redacted]'))).toBe(true);
    expect(await t.prisma.complaint.findUniqueOrThrow({ where: { id: a.complaintId } })).toMatchObject({ customerId: a.customerId, complainantEmail: null, complainantName: '[redacted]' });
    expect(await tablesWith(marker)).toEqual([]);
  });
});

/**
 * Review G1/M2: a customer whose trip is paid and finished, with every kind of money and booking row the erasure must
 * keep: a succeeded payment, the plan, the accepted terms, a webhook with its raw body, a used payment link, a promo
 * redemption, inventory claims and movements; plus a quote and a waiting list entry.
 */
async function paidCustomer(marker: string) {
  // The address carries the marker too, so rows linked by address (the waiting list entry's) are swept.
  const base = await customerClient(t, `${marker}-${letters(4)}@example.test`);
  const c = { ...base, pay: (ref: string, body: object) => t.http().post(`/booking-requests/${ref}/payments`).set(STATE_HEADERS).set('Cookie', base.cookie).set('Idempotency-Key', randomUUID()).send(body) };
  const code = (await createCode(admin, freshCode('PRIV'))).code;
  const res = await c.request(requestBody(w, { promoCode: code, contact: contact({ givenName: `${marker}given`, familyName: `${marker}family` }) }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string } });
  expect((await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version })).status).toBe(200);
  await acceptCurrentTerms(t, c, b.reference);
  expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId: b.id } })).at(-1)!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await t.http().post(`/booking-requests/${b.reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({})).status).toBe(200);
  expect((await deliver(t, acc, await eventFor(t, acc, p.id, { status: 'succeeded' }))).status).toBe(200);
  // A link that was sent and used (its token hash is kept until erasure).
  const item = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: b.id, state: 'active' }, orderBy: { sequence: 'asc' } });
  const link = await t.prisma.paymentLink.create({ data: { bookingId: b.id, targetScheduleItemId: item.id, expiresAt: new Date(Date.now() + 86_400_000), createdById: owner.staff.id } });
  await t.prisma.paymentLink.update({ where: { id: link.id }, data: { tokenHash: randomBytes(32).toString('hex') } });
  await t.prisma.paymentLink.update({ where: { id: link.id }, data: { status: 'used', usedAt: new Date() } });
  // The trip has finished.
  const now = await t.prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
  await walkTo(t, b.id, 'completed', now.status as 'deposit_paid' | 'confirmed');
  const customerId = b.customerId;
  // A quote and a waiting list entry of the same customer.
  await makeQuote(await crmStaff(t), customerId, w);
  const s = await soldOutWorld(t, await bookingStaff(t));
  await joinList(t, c, s.w);
  return { customerId, userId: c.userId, bookingId: b.id, linkId: link.id };
}

describe('erasure keeps the money (phase criterion; review G1)', () => {
  it('a customer with a paid, finished trip is erased: every financial row stays, with the same amounts, and no personal data', async () => {
    const marker = `zq${letters(8)}`;
    const a = await paidCustomer(marker);
    expect(await t.prisma.webhookEvent.count({ where: { bookingId: a.bookingId, rawBody: { not: null } } })).toBeGreaterThan(0);
    const { planted, refused } = await plantEverywhere(marker, a);
    expect(refused.sort()).toEqual(EXPECTED_REFUSED_PAID);
    if (process.env.SWEEP_DEBUG) console.log('PLANTED', planted.map((p) => `${p.table}.${p.column}`).join(' '));
    // Quotes, payments, plans, claims and links have no personal column to plant (their export and erasure tests are in
    // their modules); the waiting list entry and the customer do.
    expect(planted.map((p) => `${p.table}.${p.column}`)).toEqual(expect.arrayContaining(['waitlist_entries.countryOfResidence', 'customers.phone', 'bookings.residenceCountry']));
    const ledger = async () => ({
      payments: await t.prisma.payment.findMany({ where: { booking: { customerId: a.customerId } }, select: { id: true, amountMinor: true, currency: true, status: true }, orderBy: { id: 'asc' } }),
      items: await t.prisma.paymentScheduleItem.findMany({ where: { schedule: { booking: { customerId: a.customerId } } }, select: { id: true, amountMinor: true, currency: true, state: true }, orderBy: { id: 'asc' } }),
      snapshots: await t.prisma.bookingSnapshot.findMany({ where: { booking: { customerId: a.customerId } }, select: { id: true, totalMinor: true, currency: true }, orderBy: { id: 'asc' } }),
      bookings: await t.prisma.booking.findMany({ where: { customerId: a.customerId }, select: { id: true, totalMinor: true, currency: true, status: true }, orderBy: { id: 'asc' } }),
      terms: await t.prisma.termsAcceptance.count({ where: { customerId: a.customerId } }),
      claims: await t.prisma.inventoryClaim.count({ where: { booking: { customerId: a.customerId } } }),
      movements: await t.prisma.inventoryMovement.count({ where: { booking: { customerId: a.customerId } } }),
      redemptions: await t.prisma.promoRedemption.count({ where: { customerId: a.customerId } }),
      webhooks: await t.prisma.webhookEvent.count({ where: { booking: { customerId: a.customerId } } }),
      links: await t.prisma.paymentLink.count({ where: { booking: { customerId: a.customerId } } }),
    });
    const before = await ledger();
    expect(before.payments.some((p) => p.status === 'succeeded')).toBe(true);
    for (const k of ['terms', 'claims', 'movements', 'redemptions', 'webhooks', 'links'] as const) expect(before[k], k).toBeGreaterThan(0);

    const r = await owner.post(`/admin/privacy/customers/${a.customerId}/erasure`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await ledger()).toEqual(before);
    expect(await t.prisma.webhookEvent.count({ where: { booking: { customerId: a.customerId }, rawBody: { not: null } } })).toBe(0);
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: a.linkId } })).tokenHash).toBeNull();
    expect(await tablesWith(marker)).toEqual([]);
    expect(await sentinelsLeft(planted)).toEqual([]);
  });
});

describe('registry_covers_every_customer_table', () => {
  it('every model that reaches a customer, or has a customerId, is registered with handlers or handled by the executor; every polymorphic table is declared', () => {
    const registry = t.app.get(EntityRegistry);
    const roots = new Set(['Customer', 'Traveller', 'Booking', 'Quote', 'Complaint']);
    const linked = new Set<string>([...roots].filter((r) => byName.has(r)));
    for (let changed = true; changed;) {
      changed = false;
      for (const m of models) {
        if (linked.has(m.name)) continue;
        if (m.fields.some((f) => f.relation && f.relation.fields.length > 0 && linked.has(f.type))) {
          linked.add(m.name);
          changed = true;
        }
      }
    }
    for (const m of models) if (m.fields.some((f) => f.name === 'customerId' || f.name === 'payerCustomerId')) linked.add(m.name);
    const missing = [...linked].filter((name) => {
      if (name in EXECUTOR_TABLES) return false;
      const def = registry.all().find((d) => d.model === name);
      return !def?.customerLink || !def.handlers;
    });
    expect(missing).toEqual([]);
    const polymorphic = models.filter((m) => m.fields.some((f) => f.name === 'entityType') && m.fields.some((f) => f.name === 'entityId')).map((m) => m.name).sort();
    expect(polymorphic).toEqual(Object.keys(POLYMORPHIC_TABLES).sort());
    expect(() => registry.validate()).not.toThrow();
  });
});
