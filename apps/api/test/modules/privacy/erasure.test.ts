// Erasing a customer (task 5.5, plan docs/plans/5.5-privacy-export-erase.md, sections 2, 3, 5 and 10): who may, when it
// is refused, that nothing changes on a refusal or a failure, idempotency, concurrency forced with barriers, and the
// database's own guards. Failure paths first.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOOKING_STATUSES } from '@mt/shared';
import type { BookingStatus } from '@mt/shared';
import { erasureHooks } from '../../../src/modules/privacy/erasure.service';
import { ConsentService, ErasureService } from '../../../src/modules/privacy';
import { AuditService, SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { EntityRegistry } from '../../../src/platform/entities/entity-registry';
import { MailService } from '../../../src/platform/mail/mail.service';
import { PermissionRegistry } from '../../../src/platform/access/permissions';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { cleanBookingEvents, customerClient, requestBody } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import { cleanPayments, onlyAccount, paymentsStaff, simulatorAccount } from '../../support/payments';
import { PRIVACY_ALL, bookingWithDates, brisbaneDay, privacyCustomer, privacyStaff, stepUpOld } from '../../support/privacy';
import type { StaffHttp } from '../../support/privacy';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let owner: StaffHttp;
let w: PricedWorld;
let db: pg.Client;
beforeAll(async () => {
  t = await makeApp();
  owner = await privacyStaff(t, { owner: true });
  const admin = await paymentsStaff(t);
  const acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
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

// supertest sends only when awaited: `.then` starts the request now, so concurrent calls really run at once.
const erase = (who: StaffHttp, id: string) => who.post(`/admin/privacy/customers/${id}/erasure`).then((r) => r);
const isErased = async (id: string) => (await t.prisma.customer.findUniqueOrThrow({ where: { id }, select: { anonymisedAt: true } })).anonymisedAt !== null;

/** Personal values the audit log holds for a customer, written through the audit service (subject = the customer). */
async function auditValuesFor(customerId: string): Promise<void> {
  await t.prisma.$transaction((tx) => t.app.get(AuditService).record(tx, {
    actor: SYSTEM_ACTOR, action: 'bookings.customer.updated', entityType: 'Customer', entityId: customerId, model: 'Customer',
    before: { givenName: 'Before' }, after: { givenName: 'After' },
  }));
}

describe('access', () => {
  it('the permissions are declared with step-up for export and erasure, and none is an API key scope', () => {
    const reg = t.app.get(PermissionRegistry);
    expect(reg.get('privacy.customer.read')).toMatchObject({ requiresStepUp: false, apiKeyScopable: false });
    expect(reg.get('privacy.customer.export')).toMatchObject({ requiresStepUp: true, apiKeyScopable: false });
    expect(reg.get('privacy.customer.erase')).toMatchObject({ requiresStepUp: true, apiKeyScopable: false });
  });

  it('anonymous 401, a customer 401, staff without the permission 403, a non-owner holding it 403 owner_only, an owner without step-up 403', async () => {
    const c = await privacyCustomer(t);
    expect((await t.http().post(`/admin/privacy/customers/${c.id}/erasure`).set(STATE_HEADERS).send({})).status).toBe(401);
    const shopper = await customerClient(t);
    expect((await t.http().post(`/admin/privacy/customers/${c.id}/erasure`).set(STATE_HEADERS).set('Cookie', shopper.cookie).send({})).status).toBe(401);
    const none = await privacyStaff(t, { permissions: ['bookings.customer.read'] });
    expect((await erase(none, c.id)).status).toBe(403);
    const holder = await privacyStaff(t, { permissions: PRIVACY_ALL });
    const r = await erase(holder, c.id);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('owner_only');
    const ex = await holder.get(`/admin/privacy/customers/${c.id}/export`);
    expect(ex.status).toBe(403);
    expect(ex.body.code).toBe('owner_only');
    const o = await privacyStaff(t, { owner: true });
    await stepUpOld(t, o.staff.id);
    const s = await erase(o, c.id);
    expect(s.status).toBe(403);
    expect(s.body.code).toBe('step_up_required');
    expect(await isErased(c.id)).toBe(false);
  });

  it('an unknown customer is 404, a malformed id 400', async () => {
    expect((await erase(owner, '018f0000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await erase(owner, 'not-an-id')).status).toBe(400);
  });
});

describe('erasure_rejected_with_active_trip', () => {
  // Expected answer of the shared rule for one booking in each status, with its return date yesterday, today or tomorrow.
  const expected = (s: BookingStatus, ret: number): string | null => {
    if (['requested', 'approved', 'deposit_paid', 'confirmed'].includes(s)) return 'open_booking';
    if (s === 'balance_paid') return ret >= 0 ? 'trip_not_finished' : null;
    return null;
  };

  it('table: every booking status x return yesterday/today/tomorrow (Brisbane); a refusal changes nothing', async () => {
    for (const status of BOOKING_STATUSES) {
      for (const ret of [-1, 0, 1]) {
        const c = await privacyCustomer(t, 'Trip');
        await bookingWithDates(t, w, c.id, status, { departure: brisbaneDay(ret - 3), return: brisbaneDay(ret) });
        const reason = await t.app.get(ErasureService).blockedBy(t.prisma, c.id);
        expect(reason, `${status} return ${ret}`).toBe(expected(status, ret));
        if (reason) {
          await auditValuesFor(c.id);
          await t.prisma.privacyRequest.create({ data: { customerId: c.id, kind: 'erasure', requestedBy: 'customer' } });
          const r = await erase(owner, c.id);
          expect(r.status, `${status} ${ret}`).toBe(409);
          expect(r.body.code).toBe('erasure_rejected_with_active_trip');
          const row = await t.prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
          expect(row).toMatchObject({ anonymisedAt: null, givenName: 'TripGiven', phone: '+61 400 111 222' });
          expect(await t.prisma.auditPiiValue.count({ where: { subjectCustomerId: c.id } })).toBe(1);
          // The customer's request stays open (review point 16).
          expect((await t.prisma.privacyRequest.findFirstOrThrow({ where: { customerId: c.id } })).status).toBe('received');
          const rejected = await t.prisma.auditLog.findFirst({ where: { action: 'privacy.erasure.rejected', entityId: c.id } });
          expect(rejected?.changes).toMatchObject({ _context: { reason } });
        }
      }
    }
  });

  it('privacy_erase_customer repeats the rule: the API role cannot use it on a live customer or on one with a trip', async () => {
    const live = await privacyCustomer(t);
    await auditValuesFor(live.id);
    await expect(t.prisma.$queryRawUnsafe(`SELECT public.privacy_erase_customer($1::uuid)`, live.id)).rejects.toThrow(/not_anonymised/);
    const trip = await privacyCustomer(t);
    await bookingWithDates(t, w, trip.id, 'confirmed', { departure: brisbaneDay(10), return: brisbaneDay(14) });
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: trip.id }, data: { anonymisedAt: new Date() } });
      await tx.$queryRawUnsafe(`SELECT public.privacy_erase_customer($1::uuid)`, trip.id);
    })).rejects.toThrow(/active_trip/);
    expect(await t.prisma.auditPiiValue.count({ where: { subjectCustomerId: live.id } })).toBe(1);
  });
});

describe('rollback, idempotency and the database guards', () => {
  it('a handler failing midway leaves everything as it was; the retry then erases', async () => {
    const c = await privacyCustomer(t, 'Roll');
    await auditValuesFor(c.id);
    const def = t.app.get(EntityRegistry).get('Complaint')!;
    const spy = vi.spyOn(def.handlers!, 'anonymise').mockRejectedValueOnce(new Error('boom'));
    try {
      expect((await erase(owner, c.id)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await t.prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ givenName: 'RollGiven', anonymisedAt: null });
    expect(await t.prisma.auditPiiValue.count({ where: { subjectCustomerId: c.id } })).toBe(1);
    const ok = await erase(owner, c.id);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'completed', alreadyErased: false });
    expect(await t.prisma.auditPiiValue.count({ where: { subjectCustomerId: c.id } })).toBe(0);
  });

  it('erasing again is 200 and writes nothing; two at once give one audit row and one event; erasing_two_customers_succeeds', async () => {
    const a = await privacyCustomer(t);
    const b = await privacyCustomer(t);
    expect((await erase(owner, a.id)).status).toBe(200);
    expect((await erase(owner, b.id)).status).toBe(200);
    const again = await erase(owner, a.id);
    expect(again.body).toMatchObject({ alreadyErased: true });
    for (const id of [a.id, b.id]) {
      expect(await t.prisma.auditLog.count({ where: { action: 'privacy.customer.erased', entityId: id } })).toBe(1);
      expect(await t.prisma.outboxEvent.count({ where: { type: 'privacy.customer.erased', aggregateId: id } })).toBe(1);
      expect((await t.prisma.customer.findUniqueOrThrow({ where: { id } })).email).toBe(`erased+${id}@invalid`);
    }

    const c = await privacyCustomer(t);
    let inside!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (inside = r));
    const gate = new Promise<void>((r) => (release = r));
    const original = erasureHooks.afterLocks;
    let calls = 0;
    erasureHooks.afterLocks = async () => {
      if (++calls === 1) {
        inside();
        await gate;
      }
    };
    try {
      const first = erase(owner, c.id);
      await entered;
      const second = erase(owner, c.id);
      await new Promise((r) => setTimeout(r, 300)); // the second is waiting for the customer row
      release();
      const [r1, r2] = await Promise.all([first, second]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect([r1.body.alreadyErased, r2.body.alreadyErased].sort()).toEqual([false, true]);
    } finally {
      erasureHooks.afterLocks = original;
    }
    expect(await t.prisma.auditLog.count({ where: { action: 'privacy.customer.erased', entityId: c.id } })).toBe(1);
  });

  it('the API role cannot delete audit values, change consent records or delete privacy requests; only mt_privacy clears a consent link', async () => {
    const c = await privacyCustomer(t);
    await auditValuesFor(c.id);
    const hash = t.app.get(ConsentService).hashOf(c.email);
    await t.prisma.consentRecord.create({ data: { customerId: c.id, emailHash: hash, purpose: 'marketing_email', granted: true, source: 'account', wordingKey: 'marketing_email.v1' } });
    await t.prisma.privacyRequest.create({ data: { customerId: c.id, kind: 'export', status: 'completed', requestedBy: 'customer', completedAt: new Date() } });
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM audit_pii_values WHERE "subjectCustomerId" = $1::uuid`, c.id)).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe(`UPDATE consent_records SET granted = false WHERE "customerId" = $1::uuid`, c.id)).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe(`UPDATE consent_records SET "customerId" = NULL WHERE "customerId" = $1::uuid`, c.id)).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM privacy_requests WHERE "customerId" = $1::uuid`, c.id)).rejects.toThrow();
    // Even the owner of the tables: the triggers have no exception for it.
    await expect(db.query(`UPDATE consent_records SET granted = false WHERE "customerId" = $1::uuid`, [c.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE privacy_requests SET kind = 'erasure' WHERE "customerId" = $1::uuid`, [c.id])).rejects.toThrow(/received to completed/);
    expect((await erase(owner, c.id)).status).toBe(200);
    // The customer link is gone (mt_privacy), the evidence stays, and a last withdrawal keeps the address opted out.
    const rows = await t.prisma.consentRecord.findMany({ where: { emailHash: hash }, orderBy: { recordedAt: 'asc' } });
    expect(rows.map((r) => [r.customerId, r.granted, r.source])).toEqual([[null, true, 'account'], [null, false, 'erasure']]);
  });

  it('functions: owners, fixed search_path, no EXECUTE for PUBLIC, EXECUTE for the API role only', async () => {
    const { rows } = await db.query(`
      SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS config,
             has_function_privilege('mt_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('mt_owner', p.oid, 'EXECUTE') AS owner_exec,
             coalesce(p.proacl::text, '') AS acl
        FROM pg_proc p WHERE p.proname IN ('privacy_erase_customer', 'privacy_erase_account', 'privacy_active_trip_reason') ORDER BY p.proname`);
    expect(rows.map((r) => r.proname)).toEqual(['privacy_active_trip_reason', 'privacy_erase_account', 'privacy_erase_customer']);
    for (const r of rows) {
      expect(r.config).toContain('search_path=pg_catalog, public, pg_temp');
      expect(r.app).toBe(true);
      expect(r.acl).not.toMatch(/(^|[{,])=X/); // no grant to PUBLIC
    }
    const erasers = rows.filter((r) => r.proname !== 'privacy_active_trip_reason');
    for (const r of erasers) expect(r).toMatchObject({ owner: 'mt_privacy', prosecdef: true, owner_exec: false });
  });

  it('the insert guard refuses new rows for an erased customer (409 customer_closed through the API)', async () => {
    const c = await privacyCustomer(t);
    expect((await erase(owner, c.id)).status).toBe(200);
    await expect(bookingWithDates(t, w, c.id, 'requested', { departure: '2027-01-01', return: '2027-01-05' })).rejects.toThrow(/customer_erased|MT409/);
    await expect(t.prisma.outboundEmail.create({ data: { to: 'x@example.test', templateKey: 'k', templateVersion: 1, locale: 'en-AU', dedupeKey: `t:${c.id}`, customerId: c.id } })).rejects.toThrow(/customer_erased|MT409/);
  });
});

describe('concurrency, forced with barriers', () => {
  it('(a) a booking request waiting on the customer during an erasure gets 409 customer_closed and creates nothing', async () => {
    const me = await customerClient(t);
    expect((await me.request(requestBody(w))).status).toBe(201);
    const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: me.userId } });
    await walkTo(customer.id);
    const before = await t.prisma.booking.count({ where: { customerId: customer.id } });
    let inside!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (inside = r));
    const gate = new Promise<void>((r) => (release = r));
    const original = erasureHooks.afterLocks;
    erasureHooks.afterLocks = async () => {
      inside();
      await gate;
    };
    try {
      const erasing = erase(owner, customer.id);
      await entered;
      const requesting = me.request(requestBody(w)).then((r) => r);
      await new Promise((r) => setTimeout(r, 400)); // the request is waiting for the customer row
      release();
      const [e, r] = await Promise.all([erasing, requesting]);
      expect(e.status).toBe(200);
      expect([401, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.code).toBe('customer_closed');
    } finally {
      erasureHooks.afterLocks = original;
    }
    expect(await t.prisma.booking.count({ where: { customerId: customer.id } })).toBe(before);
  });

  it('(e) a complaint that read the customer before the erasure and writes after it is refused, nothing personal written', async () => {
    const c = await privacyCustomer(t, 'Late');
    const complaints = await privacyStaff(t, { permissions: ['complaints.complaint.read', 'complaints.complaint.manage'] });
    // The barrier sits between the complaint's unlocked read of the customer and its insert.
    const original = t.prisma.complaint.create.bind(t.prisma.complaint);
    let inside!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (inside = r));
    const gate = new Promise<void>((r) => (release = r));
    const { ComplaintService } = await import('../../../src/modules/complaints');
    const svc = t.app.get(ComplaintService) as unknown as { resolveLinks: (...a: unknown[]) => Promise<unknown> };
    const resolve = svc.resolveLinks.bind(svc);
    const spy = vi.spyOn(svc, 'resolveLinks').mockImplementation(async (...a: unknown[]) => {
      const r = await resolve(...a);
      inside();
      await gate;
      return r;
    });
    try {
      const logging = complaints.post('/admin/complaints', { customerId: c.id, channel: 'email', category: 'service', summary: 'Late summary', description: 'Late words' }).then((r) => r);
      await entered;
      expect((await erase(owner, c.id)).status).toBe(200);
      release();
      const r = await logging;
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('customer_closed');
    } finally {
      spy.mockRestore();
    }
    void original;
    expect(await t.prisma.complaint.count({ where: { customerId: c.id } })).toBe(0);
    expect(JSON.stringify(await t.prisma.complaint.findMany({ where: { complainantName: { contains: 'LateGiven' } } }))).toBe('[]');
  });

  it('(f) an email queued for a customer before the erasure is never sent after it', async () => {
    const c = await privacyCustomer(t);
    const mail = t.app.get(MailService);
    const { id } = await t.prisma.$transaction((tx) => mail.enqueue({ to: c.email, templateKey: 'auth.magic_link', templateVersion: 1, locale: 'en-AU', dedupeKey: `privacy-test:${c.id}`, customerId: c.id }, tx));
    expect((await erase(owner, c.id)).status).toBe(200);
    expect(await mail.processSend(id)).toBe('noop');
    const row = await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'suppressed', error: 'recipient_erased', to: `erased+${id}@invalid` });
  });
});

/** Ends every open booking of the customer, so it can be erased (its first request is left as it was in these tests). */
async function walkTo(customerId: string): Promise<void> {
  for (const b of await t.prisma.booking.findMany({ where: { customerId, status: 'requested' }, select: { id: true } })) {
    const { walkTo: walk } = await import('../../support/customer-portal');
    await walk(t, b.id, 'declined');
  }
}
