// The booking state machine and its safety net in SQL (plan docs/plans/2.4-booking-requests.md, sections 3, 5 and 12).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOOKINGS_PERMISSIONS, BOOKING_STATUS_PAIRS, BookingStateMachine } from '../../../src/modules/bookings';
import { BookingExpiryService } from '../../../src/modules/bookings/expiry.service';
import { PermissionRegistry } from '../../../src/platform/access/permissions';
import { SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { runTransaction } from '../../../src/platform/database/transaction';
import { TestApp, makeApp } from '../../support/auth';
import { CATALOGUE_AND_PRICING, closeCatalogue, staffClient } from '../../support/catalogue';
import { createCode, freshCode } from '../../support/adjustments';
import { bookingStaff, cleanBookingEvents, customerClient, makeBookingFor, requestBody } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import { allRoutes } from '../../support/routes';
import { insertValidSchedule } from '../../support/payments';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const STATES = ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed', 'declined', 'expired', 'cancelled', 'refunded'] as const;
type State = (typeof STATES)[number];

/** Plan 0.1, 6.2, written out by hand: every pair the trigger must let through, and no other. */
const ALLOWED: ReadonlyArray<[State, State]> = [
  ['requested', 'approved'], ['requested', 'declined'], ['requested', 'cancelled'], ['requested', 'expired'],
  ['approved', 'deposit_paid'], ['approved', 'cancelled'], ['approved', 'expired'],
  // Task 3.4: a voided bank transfer takes the deposit away from a booking that is not yet confirmed.
  ['deposit_paid', 'approved'],
  ['deposit_paid', 'confirmed'], ['deposit_paid', 'cancelled'], ['deposit_paid', 'completed'],
  ['confirmed', 'balance_paid'], ['confirmed', 'cancelled'], ['confirmed', 'completed'],
  ['balance_paid', 'confirmed'], ['balance_paid', 'completed'], ['balance_paid', 'cancelled'],
  ['cancelled', 'refunded'], ['refunded', 'cancelled'],
];

/** A way into each state along allowed pairs. */
const PATH: Record<State, State[]> = {
  requested: [], approved: ['approved'], deposit_paid: ['approved', 'deposit_paid'], confirmed: ['approved', 'deposit_paid', 'confirmed'],
  balance_paid: ['approved', 'deposit_paid', 'confirmed', 'balance_paid'], completed: ['approved', 'deposit_paid', 'confirmed', 'completed'],
  declined: ['declined'], expired: ['expired'], cancelled: ['cancelled'], refunded: ['cancelled', 'refunded'],
};

/** One status change in SQL, with the time column its state needs; as the API's role, so only the trigger decides. */
const STEP_SQL = `
  UPDATE bookings SET status = $2::"BookingStatus", version = version + 1,
    "approvedAt" = CASE WHEN $2 = 'approved' THEN clock_timestamp() ELSE "approvedAt" END,
    "approvalExpiresAt" = CASE WHEN $2 = 'approved' THEN clock_timestamp() + interval '3 days' ELSE "approvalExpiresAt" END,
    "declinedAt" = CASE WHEN $2 = 'declined' THEN clock_timestamp() ELSE "declinedAt" END,
    "expiredAt" = CASE WHEN $2 = 'expired' THEN clock_timestamp() ELSE "expiredAt" END,
    "cancelledAt" = CASE WHEN $2 = 'cancelled' THEN clock_timestamp() ELSE "cancelledAt" END
  WHERE id = $1::uuid`;

let t: TestApp;
let admin: Awaited<ReturnType<typeof bookingStaff>>;
let w: PricedWorld;
let app: pg.Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await bookingStaff(t);
  w = await pricedWorld(admin);
  app = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await app.connect();
});
afterAll(async () => {
  await app.end();
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

// Task 3.1: an approved booking has a payment plan at commit, so the step to `approved` writes a valid plan in the same
// transaction (plan 3.1, section 14, point 1). Every other step, and every assertion, is unchanged.
const walk = async (id: string, to: State) => {
  for (const s of PATH[to]) {
    if (s === 'approved') {
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(STEP_SQL, id, s);
        await insertValidSchedule(tx, id);
      });
    } else await t.prisma.$executeRawUnsafe(STEP_SQL, id, s);
  }
};
const statusOf = async (id: string) => (await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const versionOf = async (id: string) => (await t.prisma.booking.findUniqueOrThrow({ where: { id } })).version;
const makeExpired = (id: string) => t.prisma.$executeRawUnsafe(`UPDATE bookings SET "requestExpiresAt" = "requestedAt" + interval '1 millisecond' WHERE id = $1::uuid`, id);

describe('booking_status_trigger_matrix: the database lets through exactly the pairs of plan 0.1, 6.2', () => {
  it('the code and the trigger use the same list as the plan', () => {
    expect([...BOOKING_STATUS_PAIRS].map((p) => p.join('>')).sort()).toEqual(ALLOWED.map((p) => p.join('>')).sort());
  });

  it('every (from, to) pair by SQL as the API role', async () => {
    const allowed = new Set(ALLOWED.map((p) => p.join('>')));
    const wrong: string[] = [];
    for (const from of STATES) {
      const { bookingId } = await makeBookingFor(t, w);
      await walk(bookingId, from);
      for (const to of STATES) {
        if (to === from) continue;
        await app.query('BEGIN');
        let ok = true;
        try {
          await app.query(STEP_SQL, [bookingId, to]);
        } catch (err) {
          ok = false;
          expect(String(err)).toMatch(/booking status cannot go from/);
        }
        await app.query('ROLLBACK');
        if (ok !== allowed.has(`${from}>${to}`)) wrong.push(`${from}>${to}: ${ok ? 'passed' : 'refused'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('a booking starts as a request at snapshot 1; a change of status bumps the version; the snapshot version moves by one', async () => {
    const { bookingId } = await makeBookingFor(t, w);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'declined', "declinedAt" = now() WHERE id = $1::uuid`, bookingId)).rejects.toThrow(/bumps its version/);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE bookings SET "currentSnapshotVersion" = 3 WHERE id = $1::uuid`, bookingId)).rejects.toThrow(/only goes up by one/);
    const row = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.booking.create({ data: { ...row, customFields: {}, id: crypto.randomUUID(), reference: 'MT-ZZZZZZ', requestKeyHash: 'a'.repeat(64), status: 'approved', approvedAt: new Date(), approvalExpiresAt: new Date(Date.now() + 1e6) } });
    })).rejects.toThrow(/starts as a request/);
  });
});

describe('walk_reaches_every_state_with_a_valid_plan (task 3.1): the matrices still start from every state', () => {
  it.each(STATES)('walk to %s', async (state) => {
    const { bookingId } = await makeBookingFor(t, w);
    await walk(bookingId, state);
    expect(await statusOf(bookingId)).toBe(state);
    const plan = await t.prisma.paymentSchedule.findUnique({ where: { bookingId }, include: { items: { where: { state: 'active' } } } });
    expect(plan !== null).toBe(PATH[state].includes('approved'));
    if (plan) {
      const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      expect(plan.items.reduce((s, i) => s + i.amountMinor, 0n)).toBe(b.totalMinor);
    }
  });
});

describe('booking_state_event_matrix: the cells that move no money, through the API and the expiry task', () => {
  type Expect = { to: State } | { code: string } | 'no_change';
  const EXPECTED: Record<'approve' | 'decline' | 'cancel' | 'expire', Record<State, Expect>> = {
    approve: { requested: { to: 'approved' }, approved: { code: 'transition_not_allowed' }, deposit_paid: { code: 'transition_not_allowed' }, confirmed: { code: 'transition_not_allowed' }, balance_paid: { code: 'transition_not_allowed' }, completed: { code: 'transition_not_allowed' }, declined: { code: 'transition_not_allowed' }, expired: { code: 'transition_not_allowed' }, cancelled: { code: 'transition_not_allowed' }, refunded: { code: 'transition_not_allowed' } },
    decline: { requested: { to: 'declined' }, approved: { code: 'transition_not_allowed' }, deposit_paid: { code: 'transition_not_allowed' }, confirmed: { code: 'transition_not_allowed' }, balance_paid: { code: 'transition_not_allowed' }, completed: { code: 'transition_not_allowed' }, declined: { code: 'transition_not_allowed' }, expired: { code: 'transition_not_allowed' }, cancelled: { code: 'transition_not_allowed' }, refunded: { code: 'transition_not_allowed' } },
    cancel: { requested: { to: 'cancelled' }, approved: { to: 'cancelled' }, deposit_paid: { code: 'cancellation_needs_payments' }, confirmed: { code: 'cancellation_needs_payments' }, balance_paid: { code: 'cancellation_needs_payments' }, completed: { code: 'transition_not_allowed' }, declined: { code: 'transition_not_allowed' }, expired: { code: 'transition_not_allowed' }, cancelled: { code: 'transition_not_allowed' }, refunded: { code: 'transition_not_allowed' } },
    expire: { requested: { to: 'expired' }, approved: 'no_change', deposit_paid: 'no_change', confirmed: 'no_change', balance_paid: 'no_change', completed: 'no_change', declined: 'no_change', expired: 'no_change', cancelled: 'no_change', refunded: 'no_change' },
  };
  const cells = (Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>).flatMap((event) => STATES.map((s) => [event, s] as const));

  it.each(cells)('%s on %s', async (event, state) => {
    const { bookingId } = await makeBookingFor(t, w);
    await walk(bookingId, state);
    const expected = EXPECTED[event][state];
    const before = await versionOf(bookingId);
    if (event === 'expire') {
      await makeExpired(bookingId);
      const r = await runTransaction(t.prisma, (tx) => t.app.get(BookingStateMachine).transition(tx, bookingId, 'expire_request', { actor: SYSTEM_ACTOR }));
      if (expected === 'no_change') expect(r).toEqual({ changed: false, status: state });
      else expect(r).toMatchObject({ changed: true, from: state, to: (expected as { to: State }).to });
    } else {
      const res = await admin.post(`/admin/bookings/${bookingId}/${event}`, { version: before, reason: 'Matrix' });
      if (typeof expected === 'object' && 'to' in expected) expect([res.status, res.body.status]).toEqual([200, expected.to]);
      else expect([res.status, res.body.code]).toEqual([409, (expected as { code: string }).code]);
    }
    const now = await statusOf(bookingId);
    expect(now).toBe(typeof expected === 'object' && 'to' in expected ? expected.to : state);
  });
});

describe('transitions through the API', () => {
  it('a stale version is a 409 version_conflict and changes nothing', async () => {
    const { bookingId } = await makeBookingFor(t, w);
    const v = await versionOf(bookingId);
    const res = await admin.post(`/admin/bookings/${bookingId}/approve`, { version: v + 1 });
    expect([res.status, res.body.code]).toEqual([409, 'version_conflict']);
    expect(await statusOf(bookingId)).toBe('requested');
  });

  it('approve_after_request_expiry_409: an approval after the request ran out is refused with the database clock', async () => {
    const { bookingId } = await makeBookingFor(t, w);
    await makeExpired(bookingId);
    const res = await admin.post(`/admin/bookings/${bookingId}/approve`, { version: await versionOf(bookingId) });
    expect([res.status, res.body.code]).toEqual([409, 'request_expired']);
    expect(await statusOf(bookingId)).toBe('requested');
  });

  it('approving sets approvedAt and approvalExpiresAt 72 hours later, audits and publishes', async () => {
    const { bookingId } = await makeBookingFor(t, w);
    const res = await admin.post(`/admin/bookings/${bookingId}/approve`, { version: 0 });
    expect(res.status).toBe(200);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(b.approvalExpiresAt!.getTime() - b.approvedAt!.getTime()).toBe(72 * 3_600_000);
    const events = await t.prisma.outboxEvent.findMany({ where: { aggregateId: bookingId } });
    expect(events.map((e) => [e.type, (e.payload as { from: string; to: string }).to])).toEqual([['bookings.booking.approved', 'approved']]);
  });

  it('declining a real request gives back its stock and code, stores the reason as personal data, audits and publishes', async () => {
    const code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id });
    const c = await customerClient(t);
    const pools = [w.roomPoolId, w.entryPoolId];
    const consumed = async () => Promise.all(pools.map(async (id) => (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } })).consumed));
    const before = await consumed();
    const res = await c.request(requestBody(w, { promoCode: code.code }));
    expect(res.status).toBe(201);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference } });
    expect((await t.prisma.promoCode.findUniqueOrThrow({ where: { id: code.id } })).redeemedCount).toBe(1);
    const reason = `Hotel full ${crypto.randomUUID().slice(0, 6)}`;
    const declined = await admin.post(`/admin/bookings/${b.id}/decline`, { version: b.version, reason });
    expect([declined.status, declined.body.status, declined.body.statusReason]).toEqual([200, 'declined', reason]);
    expect(await consumed()).toEqual(before);
    expect((await t.prisma.promoCode.findUniqueOrThrow({ where: { id: code.id } })).redeemedCount).toBe(0);
    expect((await t.prisma.inventoryClaim.findMany({ where: { bookingId: b.id } })).every((x) => x.status === 'released' && x.releasedAt)).toBe(true);
    const moves = await t.prisma.inventoryMovement.findMany({ where: { bookingId: b.id }, orderBy: { createdAt: 'asc' } });
    expect(moves.map((m) => m.reason).sort()).toEqual(['hold', 'hold', 'release', 'release']);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: b.id, action: 'bookings.booking.status_changed' } });
    expect(JSON.stringify(log.changes)).not.toContain(reason);
    expect(log.changes).toMatchObject({ status: { before: 'requested', after: 'declined' }, _reason: '[pii]', _context: { event: 'decline', releasedPlaces: 2, promoReleased: true } });
    const pii = await t.prisma.auditPiiValue.findMany({ where: { auditLogId: log.id } });
    expect(pii.find((p) => p.field === '_reason')).toMatchObject({ after: reason, subjectCustomerId: b.customerId });
    // a declined booking never comes back
    const again = await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version + 1 });
    expect([again.status, again.body.code]).toEqual([409, 'transition_not_allowed']);
  });

  it('decline_or_expiry_releases_archived_code: an archived code still gets its redemption back', async () => {
    for (const how of ['decline', 'expire'] as const) {
      const code = await createCode(admin, freshCode(), { scopeType: 'package', packageId: w.pkg.id, maxRedemptions: 1 });
      const c = await customerClient(t);
      const res = await c.request(requestBody(w, { promoCode: code.code }));
      expect(res.status).toBe(201);
      const archived = await admin.post(`/admin/pricing/promo-codes/${code.id}/archive`, { version: code.version });
      expect(archived.status).toBe(200);
      const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference } });
      if (how === 'decline') expect((await admin.post(`/admin/bookings/${b.id}/decline`, { version: b.version, reason: 'Archived code' })).status).toBe(200);
      else {
        await makeExpired(b.id);
        expect((await t.app.get(BookingExpiryService).run()).expired).toBeGreaterThanOrEqual(1);
      }
      const row = await t.prisma.promoCode.findUniqueOrThrow({ where: { id: code.id } });
      expect([how, row.redeemedCount, row.archivedAt !== null]).toEqual([how, 0, true]);
      expect((await t.prisma.promoRedemption.findFirstOrThrow({ where: { bookingId: b.id } })).releasedAt).not.toBeNull();
    }
  });

  it('request_expiry_job_expires_and_releases: due requests expire with their stock; others are left alone; a second run does nothing', async () => {
    const c = await customerClient(t);
    const due = await c.request(requestBody(w));
    const fresh = await c.request(requestBody(w));
    const dueId = (await t.prisma.booking.findUniqueOrThrow({ where: { reference: due.body.reference } })).id;
    const freshId = (await t.prisma.booking.findUniqueOrThrow({ where: { reference: fresh.body.reference } })).id;
    const before = (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.roomPoolId } })).consumed;
    await makeExpired(dueId);
    const first = await t.app.get(BookingExpiryService).run();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(first.failed).toBe(0);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: dueId } });
    expect([b.status, b.expiredAt !== null]).toEqual(['expired', true]);
    expect(await statusOf(freshId)).toBe('requested');
    expect((await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.roomPoolId } })).consumed).toBe(before - 1);
    expect((await t.prisma.outboxEvent.findMany({ where: { aggregateId: dueId, type: 'bookings.booking.expired' } }))).toHaveLength(1);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: dueId, action: 'bookings.booking.status_changed' } });
    expect(audit.actorType).toBe('system');
    const second = await t.app.get(BookingExpiryService).run();
    expect(await t.prisma.booking.findUniqueOrThrow({ where: { id: dueId } })).toMatchObject({ status: 'expired', version: b.version });
    expect(second.failed).toBe(0);
  });

  it('instant_booking_without_routable_method_stays_requested: no payment method exists before 3.1', async () => {
    const iw = await pricedWorld(admin);
    await t.prisma.$executeRawUnsafe(`UPDATE packages SET "instantBooking" = true WHERE id = $1::uuid`, iw.pkg.id);
    const c = await customerClient(t);
    const res = await c.request(requestBody(iw));
    expect([res.status, res.body.status]).toEqual([201, 'requested']);
  });
});

describe('permissions and the panel', () => {
  it('booking_admin_routes_require_permission: every /admin/bookings route is a 403 without its permission', async () => {
    const nobody = await staffClient(t, CATALOGUE_AND_PRICING);
    const { bookingId } = await makeBookingFor(t, w);
    const routes = allRoutes(t.app).filter((r) => r.path.startsWith('/admin/bookings'));
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /admin/bookings', 'GET /admin/bookings/:id', 'GET /admin/bookings/summary', 'POST /admin/bookings/:id/amendments', 'POST /admin/bookings/:id/amendments/preview', 'POST /admin/bookings/:id/approve', 'POST /admin/bookings/:id/cancel', 'POST /admin/bookings/:id/confirm', 'POST /admin/bookings/:id/decline',
    ]);
    for (const r of routes) {
      const path = r.path.replace(':id', bookingId);
      const res = r.method === 'GET' ? await nobody.get(path) : await nobody.post(path, { version: 0, reason: 'x' });
      expect([`${r.method} ${r.path}`, res.status]).toEqual([`${r.method} ${r.path}`, 403]);
    }
    expect(await statusOf(bookingId)).toBe('requested');
  });

  it('cancel_requires_step_up: without a recent TOTP check, cancelling is a 403', async () => {
    const staff = await bookingStaff(t);
    const { bookingId } = await makeBookingFor(t, w);
    await t.prisma.session.updateMany({ where: { userId: staff.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const res = await staff.post(`/admin/bookings/${bookingId}/cancel`, { version: 0, reason: 'Late' });
    expect([res.status, res.body.code]).toEqual([403, 'step_up_required']);
    // declining needs no step-up
    expect((await staff.post(`/admin/bookings/${bookingId}/decline`, { version: 0, reason: 'Full' })).status).toBe(200);
  });

  it('booking_permissions_not_api_key_scopable; only cancelling, confirming (task 3.2) and amending (task 6.3) need step-up', () => {
    const registry = t.app.get(PermissionRegistry);
    const defs = Object.values(BOOKINGS_PERMISSIONS).map((k) => registry.get(k)!);
    expect(defs.map((d) => [d.key, d.apiKeyScopable, d.requiresStepUp])).toEqual([
      ['bookings.booking.read', false, false], ['bookings.booking.approve', false, false], ['bookings.booking.decline', false, false], ['bookings.booking.cancel', false, true],
      ['bookings.booking.confirm', false, true], ['bookings.booking.amend', false, true],
    ]);
  });

  it('declining and cancelling need a reason; the list filters by status; the detail never shows the request hashes', async () => {
    const { bookingId } = await makeBookingFor(t, w);
    expect((await admin.post(`/admin/bookings/${bookingId}/decline`, { version: 0 })).status).toBe(422);
    expect((await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: 0, reason: '' })).status).toBe(422);
    const list = await admin.get(`/admin/bookings?status=requested&packageId=${w.pkg.id}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((i: { id: string }) => i.id === bookingId)).toBe(true);
    expect(list.body.items.every((i: { status: string }) => i.status === 'requested')).toBe(true);
    const detail = await admin.get(`/admin/bookings/${bookingId}`);
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body)).not.toEqual(expect.arrayContaining(['requestKeyHash']));
    expect(JSON.stringify(detail.body)).not.toMatch(/requestKeyHash|requestConfigHash|requestContactHmac/);
    expect((await admin.get(`/admin/bookings/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe('only_state_machine_writes_booking_status', () => {
  it('no file but the state machine updates bookings.status; the only other booking update is erasure, which leaves status alone', () => {
    const src = resolve(__dirname, '../../../src');
    const files: string[] = [];
    const walkDir = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) {
          if (f !== 'generated') walkDir(p);
        } else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walkDir(src);
    const rel = (p: string) => p.slice(src.length + 1);
    const sqlWriters = files.filter((p) => /UPDATE\s+"?bookings"?\s+SET/i.test(readFileSync(p, 'utf8'))).map(rel);
    expect(sqlWriters).toEqual(['modules/bookings/state-machine.ts']);
    const prismaWriters = files.filter((p) => /\.booking\.(update|updateMany|upsert)\(/.test(readFileSync(p, 'utf8'))).map(rel);
    expect(prismaWriters).toEqual(['modules/bookings/entities.ts']);
    const erasure = readFileSync(join(src, 'modules/bookings/entities.ts'), 'utf8');
    expect(erasure).not.toMatch(/booking\.update[^;]*status\s*:/s);
  });
});
