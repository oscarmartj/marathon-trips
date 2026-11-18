// Changes to a booking after its deposit, through HTTP, the simulator and a real PostgreSQL (plan
// docs/plans/6.3-booking-amendments.md, sections 2, 5 to 8 and 10). Failure paths first.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOOKINGS_PERMISSIONS } from '../../../../src/modules/bookings';
import { PermissionRegistry } from '../../../../src/platform/access/permissions';
import { PaymentsMaintenanceService } from '../../../../src/modules/payments/core/maintenance.service';
import { EntityRegistry } from '../../../../src/platform/entities/entity-registry';
import { STATE_HEADERS, TestApp, makeApp } from '../../../support/auth';
import { CATALOGUE_AND_PRICING, closeCatalogue, staffClient } from '../../../support/catalogue';
import type { Client } from '../../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../../support/bookings';
import { walkTo } from '../../../support/customer-portal';
import {
  ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, acceptCurrentTerms, cleanPayments, deliver, ensureTerms, eventFor, onlyAccount, payingCustomer, sim, simulatorAccount,
} from '../../../support/payments';
import { AmendWorld, amendWorld, requestIn, runner, setCustomerAmendments, supporter } from '../../../support/amendments';
import { retireAmendWorlds } from '../../../support/amendments';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Client;
let acc: SimAccount;
let c: PayingCustomer;
let w: AmendWorld;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
  w = await amendWorld(admin);
  await setCustomerAmendments(t, false);
});
afterAll(async () => {
  await retireAmendWorlds(t);
  await setCustomerAmendments(t, false);
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const row = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
const paymentsOf = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
const activeItems = (bookingId: string) => t.prisma.paymentScheduleItem.findMany({ where: { bookingId, state: 'active' }, orderBy: { sequence: 'asc' } });
const openTask = (sourceRef: string) => t.prisma.task.findFirst({ where: { sourceRef, status: 'open' } });

/** Pays the next payable item through the simulator and a signed webhook. */
async function payNext(reference: string, bookingId: string): Promise<void> {
  const res = await c.pay(reference, { method: 'card' });
  if (res.status !== 201) throw new Error(`pay: ${res.status} ${JSON.stringify(res.body)}`);
  const p = (await paymentsOf(bookingId)).at(-1)!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  const d = await deliver(t, acc, await eventFor(t, acc, p.id));
  if (d.outcome !== 'processed') throw new Error(`webhook: ${JSON.stringify(d)}`);
}

/** A booking of customer c (default: a runner and a supporter in the double), approved, terms accepted, deposit paid (→ confirmed). */
async function paidBooking(world: AmendWorld = w, rooms = [{ roomOptionId: world.doubleId, travellers: [runner(world), supporter] }], extra: Record<string, unknown> = {}) {
  const b = await requestIn(t, c.cookie, world, { rooms, ...extra });
  const ok = await admin.post(`/admin/bookings/${b.bookingId}/approve`, { version: (await row(b.bookingId)).version });
  if (ok.status !== 200) throw new Error(`approve: ${ok.status} ${JSON.stringify(ok.body)}`);
  await acceptCurrentTerms(t, c, b.reference);
  await payNext(b.reference, b.bookingId);
  return b;
}

/** The staff body that keeps every place where it is, from the current snapshot, with changes on top. */
async function keepAll(bookingId: string, over: Record<string, unknown> = {}) {
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { snapshots: true } });
  const conf = b.snapshots.find((s) => s.version === b.currentSnapshotVersion)!.configuration as { rooms: Array<{ roomOptionId: string; travellers: Array<{ slot: number }> }>; extraNightsBefore: number; extraNightsAfter: number; extras: Array<{ extraId: string; travellerSlots: number[]; quantity: number }> };
  const pos = new Map<number, number>();
  let p = 0;
  for (const r of conf.rooms) for (const x of r.travellers) pos.set(x.slot, ++p);
  return {
    expectedSnapshotVersion: b.currentSnapshotVersion,
    rooms: conf.rooms.map((r) => ({ roomOptionId: r.roomOptionId, travellers: r.travellers.map((x) => ({ keepSlot: x.slot })) })),
    extraNightsBefore: conf.extraNightsBefore, extraNightsAfter: conf.extraNightsAfter,
    extras: conf.extras.map((e) => (e.travellerSlots.length ? { extraId: e.extraId, travellerSlots: e.travellerSlots.map((s) => pos.get(s)!) } : { extraId: e.extraId, quantity: e.quantity })),
    reasonCode: 'customer_request', ...over,
  };
}

const preview = (bookingId: string, body: object, who: Client = admin) => who.post(`/admin/bookings/${bookingId}/amendments/preview`, body);
const apply = (bookingId: string, body: object, key: string = randomUUID(), who: Client = admin) => who.post(`/admin/bookings/${bookingId}/amendments`, body).set('Idempotency-Key', key);
async function amend(bookingId: string, body: Record<string, unknown>) {
  const p = await preview(bookingId, body);
  if (p.status !== 200) throw new Error(`preview: ${p.status} ${JSON.stringify(p.body)}`);
  const r = await apply(bookingId, { ...body, previewDigest: p.body.previewDigest });
  if (r.status !== 201) throw new Error(`apply: ${r.status} ${JSON.stringify(r.body)}`);
  return { preview: p.body, result: r.body };
}
const customerPreview = (reference: string, body: object) => t.http().post(`/account/bookings/${reference}/amendments/preview`).set(STATE_HEADERS).set('Cookie', c.cookie).send(body);
const customerApply = (reference: string, body: object, key = randomUUID()) => t.http().post(`/account/bookings/${reference}/amendments`).set(STATE_HEADERS).set('Cookie', c.cookie).set('Idempotency-Key', key).send(body);

describe('failure paths: nothing is written', () => {
  it('client_amount_field_rejected: no amount, total or price field exists in either body', async () => {
    const b = await paidBooking();
    const body = await keepAll(b.bookingId, { extraNightsAfter: 1 });
    for (const extra of [{ totalMinor: '1' }, { priceDifferenceMinor: '0' }, { amountMinor: '100' }, { depositMinor: '0' }]) {
      expect((await preview(b.bookingId, { ...body, ...extra })).status, JSON.stringify(extra)).toBe(422);
      expect((await apply(b.bookingId, { ...body, ...extra, previewDigest: 'a'.repeat(64) })).status).toBe(422);
    }
    expect((await preview(b.bookingId, { ...body, extras: [{ extraId: w.extraId, travellerSlots: [1], amountMinor: '1' }] })).status).toBe(422);
    await setCustomerAmendments(t, true);
    try {
      expect((await customerPreview(b.reference, { expectedSnapshotVersion: 1, extraNightsBefore: 0, extraNightsAfter: 1, extras: [], totalMinor: '1' })).status).toBe(422);
      // A customer body never takes rooms: places cannot be touched.
      expect((await customerPreview(b.reference, { expectedSnapshotVersion: 1, extraNightsBefore: 0, extraNightsAfter: 1, extras: [], rooms: [] })).status).toBe(422);
    } finally {
      await setCustomerAmendments(t, false);
    }
    expect(await t.prisma.bookingAmendment.count({ where: { bookingId: b.bookingId } })).toBe(0);
  });

  it('amendment_state_matrix: only deposit_paid, confirmed and balance_paid can change', async () => {
    for (const status of ['requested', 'approved', 'completed', 'declined', 'expired', 'cancelled', 'refunded'] as const) {
      const b = await requestIn(t, c.cookie, w, { rooms: [{ roomOptionId: w.doubleId, travellers: [runner(w), supporter] }] });
      await walkTo(t, b.bookingId, status);
      const r = await preview(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1 }));
      expect([status, r.status, r.body.code]).toEqual([status, 409, 'amendment_not_allowed']);
    }
    for (const status of ['deposit_paid', 'confirmed', 'balance_paid'] as const) {
      const b = await requestIn(t, c.cookie, w, { rooms: [{ roomOptionId: w.doubleId, travellers: [runner(w), supporter] }] });
      await walkTo(t, b.bookingId, status);
      expect([status, (await preview(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1 }))).status]).toEqual([status, 200]);
    }
  });

  it('version_conflict, no change, stale preview and a missing or reused Idempotency-Key', async () => {
    const b = await paidBooking();
    const body = await keepAll(b.bookingId, { extraNightsAfter: 1 });
    expect((await preview(b.bookingId, { ...body, expectedSnapshotVersion: 2 })).body.code).toBe('version_conflict');
    expect((await preview(b.bookingId, await keepAll(b.bookingId))).body.code).toBe('amendment_has_no_change');
    expect((await apply(b.bookingId, { ...body, previewDigest: 'b'.repeat(64) })).body.code).toBe('amendment_price_changed');
    const p = await preview(b.bookingId, body);
    const noKey = await admin.post(`/admin/bookings/${b.bookingId}/amendments`, { ...body, previewDigest: p.body.previewDigest });
    expect([noKey.status, noKey.body.code]).toEqual([422, 'idempotency_key_required']);
    expect(await t.prisma.bookingAmendment.count({ where: { bookingId: b.bookingId } })).toBe(0);
    expect((await row(b.bookingId)).currentSnapshotVersion).toBe(1);
  });

  it('same_key_one_amendment and key_reused_with_other_body_422', async () => {
    const b = await paidBooking();
    const body = await keepAll(b.bookingId, { extraNightsAfter: 1 });
    const p = await preview(b.bookingId, body);
    const key = randomUUID();
    const first = await apply(b.bookingId, { ...body, previewDigest: p.body.previewDigest }, key);
    const again = await apply(b.bookingId, { ...body, previewDigest: p.body.previewDigest }, key);
    expect([first.status, first.body.created, again.status, again.body.created]).toEqual([201, true, 201, false]);
    expect(again.body.amendmentId).toBe(first.body.amendmentId);
    const other = await apply(b.bookingId, { ...body, extraNightsAfter: 2, previewDigest: p.body.previewDigest }, key);
    expect([other.status, other.body.code]).toEqual([422, 'idempotency_key_reused']);
    expect(await t.prisma.bookingAmendment.count({ where: { bookingId: b.bookingId } })).toBe(1);
    expect(await t.prisma.bookingSnapshot.count({ where: { bookingId: b.bookingId } })).toBe(2);
  });

  it('live_attempt_blocks_amendment: a payment in progress refuses the change', async () => {
    const b = await paidBooking();
    expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
    const r = await preview(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1 }));
    expect([r.status, r.body.code]).toEqual([409, 'amendment_blocked_by_payment']);
  });

  it('cutoff_boundaries: staff until the day before departure, customers until departure minus the cutoff', async () => {
    const b = await paidBooking();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
    const plus = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const setDeparture = (d: string) => t.prisma.$executeRawUnsafe(`UPDATE bookings SET "departureDate" = $2::date WHERE id = $1::uuid`, b.bookingId, d);
    const body = await keepAll(b.bookingId, { extraNightsAfter: 1 });
    await setDeparture(plus(1));
    expect((await preview(b.bookingId, body)).status).toBe(200);
    await setDeparture(plus(0));
    expect((await preview(b.bookingId, body)).body.code).toBe('amendment_too_late');
    await setCustomerAmendments(t, true);
    try {
      const cb = { expectedSnapshotVersion: 1, extraNightsBefore: 0, extraNightsAfter: 1, extras: [] };
      await setDeparture(plus(14));
      expect((await customerPreview(b.reference, cb)).status).toBe(200);
      await setDeparture(plus(13));
      expect((await customerPreview(b.reference, cb)).body.code).toBe('amendment_too_late');
    } finally {
      await setCustomerAmendments(t, false);
    }
  });

  it('customer_rules: off by default, terms in force, never a lower price, never places', async () => {
    const b = await paidBooking(w, [{ roomOptionId: w.doubleId, travellers: [runner(w), supporter] }], { extras: [{ extraId: w.extraId, travellerSlots: [1] }] });
    const cb = { expectedSnapshotVersion: 1, extraNightsBefore: 0, extraNightsAfter: 1, extras: [{ extraId: w.extraId, travellerSlots: [1] }] };
    expect((await customerPreview(b.reference, cb)).body.code).toBe('amendments_unavailable');
    await setCustomerAmendments(t, true);
    try {
      // Dropping the tour lowers the price: staff only.
      const lower = await customerPreview(b.reference, { ...cb, extraNightsAfter: 0, extras: [] });
      expect([lower.status, lower.body.code]).toEqual([409, 'amendment_needs_staff']);
      expect((await customerPreview(b.reference, { ...cb, extras: [{ extraId: w.extraId, travellerSlots: [9] }] })).body.code).toBe('place_unknown');
      const p = await customerPreview(b.reference, cb);
      expect(p.status).toBe(200);
      expect(p.body.price.trace).toBeUndefined();
      // Without accepting the new price, or with the terms edited since they were accepted: refused, nothing written.
      expect((await customerApply(b.reference, { ...cb, previewDigest: p.body.previewDigest })).status).toBe(422);
      await ensureTerms(t, { body: `Changed ${randomUUID()}` });
      const noTerms = await customerApply(b.reference, { ...cb, previewDigest: p.body.previewDigest, acceptNewPrice: true });
      expect([noTerms.status, noTerms.body.code]).toEqual([409, 'terms_not_accepted']);
      await acceptCurrentTerms(t, c, b.reference);
      const ok = await customerApply(b.reference, { ...cb, previewDigest: p.body.previewDigest, acceptNewPrice: true });
      expect(ok.status).toBe(201);
      const a = await t.prisma.bookingAmendment.findFirstOrThrow({ where: { bookingId: b.bookingId } });
      expect([a.initiatedBy, a.reasonCode, a.changes]).toEqual(['customer', 'customer_request', ['nights']]);
    } finally {
      await setCustomerAmendments(t, false);
    }
  });

  it('amend_needs_permission_step_up_not_api_key', async () => {
    const def = t.app.get(PermissionRegistry).get(BOOKINGS_PERMISSIONS.amend)!;
    expect([def.requiresStepUp, def.apiKeyScopable ?? false]).toEqual([true, false]);
    const b = await paidBooking();
    const body = await keepAll(b.bookingId, { extraNightsAfter: 1 });
    const reader = await staffClient(t, [BOOKINGS_PERMISSIONS.read]);
    const p = await preview(b.bookingId, body, reader);
    expect(p.status).toBe(200);
    const denied = await apply(b.bookingId, { ...body, previewDigest: p.body.previewDigest }, randomUUID(), reader);
    expect([denied.status, denied.body.code]).toEqual([403, 'forbidden']);
    const amender = await staffClient(t, [BOOKINGS_PERMISSIONS.read, BOOKINGS_PERMISSIONS.amend]);
    await t.prisma.session.updateMany({ where: { userId: amender.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const stale = await apply(b.bookingId, { ...body, previewDigest: p.body.previewDigest }, randomUUID(), amender);
    expect([stale.status, stale.body.code]).toEqual([403, 'step_up_required']);
    expect(await t.prisma.bookingAmendment.count({ where: { bookingId: b.bookingId } })).toBe(0);
  });
});

describe('what a change records and does', () => {
  it('amendment_records_difference_and_keeps_original_snapshot', async () => {
    const b = await paidBooking();
    const v1 = await t.prisma.bookingSnapshot.findUniqueOrThrow({ where: { bookingId_version: { bookingId: b.bookingId, version: 1 } } });
    const { preview: p } = await amend(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1 }));
    // One extra night for two in the double: 2 × 15 000.
    expect([p.previousTotalMinor, p.newTotalMinor, p.priceDifferenceMinor]).toEqual(['132500', '162500', '30000']);
    const again = await t.prisma.bookingSnapshot.findUniqueOrThrow({ where: { bookingId_version: { bookingId: b.bookingId, version: 1 } } });
    expect(again).toEqual(v1);
    const v2 = await t.prisma.bookingSnapshot.findUniqueOrThrow({ where: { bookingId_version: { bookingId: b.bookingId, version: 2 } } });
    expect([v2.kind, v2.totalMinor]).toEqual(['amendment', 162500n]);
    const a = await t.prisma.bookingAmendment.findFirstOrThrow({ where: { bookingId: b.bookingId } });
    expect([a.fromVersion, a.toVersion, a.previousTotalMinor, a.newTotalMinor, a.priceDifferenceMinor, a.collectedMinor, a.outstandingMinor, a.creditPendingMinor])
      .toEqual([1, 2, 132500n, 162500n, 30000n, 100000n, 62500n, 0n]);
    const bk = await row(b.bookingId);
    expect([bk.currentSnapshotVersion, bk.totalMinor, bk.returnDate.toISOString().slice(0, 10)]).toEqual([2, 162500n, '2027-06-22']);
    // The audit entry has no personal data.
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: b.bookingId, action: 'bookings.booking.amended' } });
    expect(JSON.stringify(audit)).not.toMatch(/Ada|Runner|example\.test/);
  });

  it('amendment_supersedes_items_reallocates and positive_difference_paid_through_attempt_flow', async () => {
    const b = await paidBooking();
    const before = await activeItems(b.bookingId);
    await amend(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1 }));
    const items = await activeItems(b.bookingId);
    expect(items.map((i) => [i.kind, i.amountMinor, i.planVersion])).toEqual([['deposit', 100000n, 2], ['adjustment', 30000n, 2], ['balance', 32500n, 2]]);
    expect(items.reduce((s, i) => s + i.amountMinor, 0n)).toBe(162500n);
    expect(await t.prisma.paymentScheduleItem.count({ where: { id: { in: before.map((i) => i.id) }, state: 'superseded' } })).toBe(before.length);
    const plan = await c.plan(b.reference);
    expect([plan.body.nextPayable.amountMinor, plan.body.outstandingMinor]).toEqual(['30000', '62500']);
    await payNext(b.reference, b.bookingId);
    expect((await row(b.bookingId)).status).toBe('confirmed');
    await payNext(b.reference, b.bookingId);
    expect((await row(b.bookingId)).status).toBe('balance_paid');
  });

  it('amendment_raising_total_reopens_balance_paid with balance_reopened_event_not_confirmed', async () => {
    const b = await paidBooking();
    await payNext(b.reference, b.bookingId);
    expect((await row(b.bookingId)).status).toBe('balance_paid');
    const confirmedBefore = await t.prisma.outboxEvent.count({ where: { aggregateId: b.bookingId, type: 'bookings.booking.confirmed' } });
    await amend(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1 }));
    expect((await row(b.bookingId)).status).toBe('confirmed');
    expect(await t.prisma.outboxEvent.count({ where: { aggregateId: b.bookingId, type: 'bookings.booking.confirmed' } })).toBe(confirmedBefore);
    expect(await t.prisma.outboxEvent.count({ where: { aggregateId: b.bookingId, type: 'bookings.booking.balance_reopened' } })).toBe(1);
    expect(await t.prisma.outboxEvent.count({ where: { aggregateId: b.bookingId, type: 'bookings.booking.amended' } })).toBe(1);
  });

  it('negative_difference_parked_no_refund, amendment_lowering_total_to_paid_moves_to_balance_paid and credit_task_closed_when_absorbed', async () => {
    const b = await paidBooking();
    // The supporter leaves: the runner alone in the double, 80 000 + 30 000 = 110 000; still owes 10 000.
    let r = await amend(b.bookingId, { ...(await keepAll(b.bookingId)), rooms: [{ roomOptionId: w.doubleId, travellers: [{ keepSlot: 1 }] }], reasonCode: 'correction' });
    expect([r.preview.priceDifferenceMinor, r.preview.outstandingAfterMinor, r.preview.creditPendingAfterMinor]).toEqual(['-22500', '10000', '0']);
    expect((await row(b.bookingId)).status).toBe('confirmed');
    // The runner becomes a supporter (the lead's place is replaced): 80 000 + 2 500 = 82 500 < 100 000 paid.
    r = await amend(b.bookingId, { ...(await keepAll(b.bookingId)), rooms: [{ roomOptionId: w.doubleId, travellers: [{ participationType: 'supporter', replacesSlot: 1 }] }], reasonCode: 'correction' });
    expect([r.preview.priceDifferenceMinor, r.preview.creditPendingAfterMinor]).toEqual(['-27500', '17500']);
    expect((await row(b.bookingId)).status).toBe('balance_paid');
    expect(await openTask(`payments:overpaid:amendment:${b.bookingId}`)).not.toBeNull();
    const plan = await c.plan(b.reference);
    expect(plan.body.overpaidMinor).toBe('17500');
    // A later change takes the credit up again (a supporter joins: double for two): the task closes, the screen shows 0.
    r = await amend(b.bookingId, { ...(await keepAll(b.bookingId)), rooms: [{ roomOptionId: w.doubleId, travellers: [{ keepSlot: 3 }, supporter] }], reasonCode: 'customer_request' });
    expect(r.preview.creditPendingAfterMinor).toBe('0');
    expect(await openTask(`payments:overpaid:amendment:${b.bookingId}`)).toBeNull();
    expect((await c.plan(b.reference)).body.overpaidMinor).toBe('0');
  });

  it('staff_positive_change_not_requested_opens_inform_task', async () => {
    const b = await paidBooking();
    await amend(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1, reasonCode: 'supplier_change' }));
    expect(await openTask(`bookings:amendment_inform:${b.bookingId}:v2`)).not.toBeNull();
    const b2 = await paidBooking();
    await amend(b2.bookingId, await keepAll(b2.bookingId, { extraNightsAfter: 1, reasonCode: 'customer_request' }));
    expect(await openTask(`bookings:amendment_inform:${b2.bookingId}:v2`)).toBeNull();
  });

  it('payment_link_revoked_by_amendment', async () => {
    const b = await paidBooking();
    const link = await admin.post(`/admin/payments/bookings/${b.bookingId}/payment-links`, {});
    expect(link.status).toBeLessThan(300);
    await amend(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1 }));
    expect(await t.prisma.paymentLink.count({ where: { bookingId: b.bookingId, status: 'active' } })).toBe(0);
  });

  it('account_shows_plan_deposit_after_amendment: the account shows the plan items and the change history', async () => {
    const b = await paidBooking();
    await amend(b.bookingId, { ...(await keepAll(b.bookingId)), rooms: [{ roomOptionId: w.quadId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }, supporter] }] });
    const d = await t.http().get(`/account/bookings/${b.reference}`).set('Cookie', c.cookie);
    expect(d.status).toBe(200);
    // The deposit asked at approval (2 × 50 000) is still the plan's deposit, though the new snapshot's deposit is 3 × 50 000.
    expect(d.body.plan.items[0]).toMatchObject({ kind: 'deposit', amountMinor: '100000', paidMinor: '100000' });
    expect((await row(b.bookingId)).depositMinor).toBe(150000n);
    expect(d.body.changes.items).toHaveLength(1);
    expect(d.body.changes.items[0]).toMatchObject({ by: 'staff', changes: ['room', 'travellers_added'], priceDifferenceMinor: '37500' });
    // Quad for three: 3 × 45 000 + marathon 30 000 + 2 supporters × 2 500 = 170 000.
    expect(d.body.booking.totalMinor).toBe('170000');
  });
});

describe('places and traveller details (plan section 7)', () => {
  it('details are carried to a replacing place, the retired place takes no details, lead rules hold', async () => {
    const b = await paidBooking();
    const save = (slot: number, body: object) => t.http().put(`/account/bookings/${b.reference}/travellers/${slot}`).set(STATE_HEADERS).set('Cookie', c.cookie).send(body);
    expect((await save(1, { givenName: 'Lena', familyName: 'Swift', dateOfBirth: '1990-01-02', estimatedFinishSeconds: 14400, emergencyContactName: 'Max Swift', emergencyContactPhone: '+61 400 111 222' })).status).toBe(200);
    // The lead can only be replaced, never removed.
    const drop = await preview(b.bookingId, { ...(await keepAll(b.bookingId)), rooms: [{ roomOptionId: w.doubleId, travellers: [{ keepSlot: 2 }] }] });
    expect([drop.status, drop.body.code]).toEqual([422, 'lead_place_required']);
    expect((await preview(b.bookingId, { ...(await keepAll(b.bookingId)), rooms: [{ roomOptionId: w.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 1 }] }] })).body.code).toBe('place_listed_twice');
    expect((await preview(b.bookingId, { ...(await keepAll(b.bookingId)), rooms: [{ roomOptionId: w.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 7 }] }] })).body.code).toBe('place_unknown');
    // The runner becomes a supporter: a new lead place 3 with the names and emergency contact, no birth date, no finish time.
    await amend(b.bookingId, { ...(await keepAll(b.bookingId)), rooms: [{ roomOptionId: w.doubleId, travellers: [{ participationType: 'supporter', replacesSlot: 1 }, { keepSlot: 2 }] }] });
    const places = await t.prisma.bookingTraveller.findMany({ where: { bookingId: b.bookingId }, orderBy: { slot: 'asc' } });
    expect(places.map((p) => [p.slot, p.participationType, p.isLead, p.addedInVersion, p.removedInVersion])).toEqual([
      [1, 'runner_with_entry', true, 1, 2], [2, 'supporter', false, 1, null], [3, 'supporter', true, 2, null],
    ]);
    const details = await t.prisma.traveller.findMany({ where: { bookingId: b.bookingId } });
    expect(details.map((d) => [d.slot, d.givenName, d.dateOfBirth, d.estimatedFinishSeconds, d.emergencyContactName])).toEqual([[3, 'Lena', null, null, 'Max Swift']]);
    expect((await save(1, { givenName: 'Old', familyName: 'Place' })).status).toBe(404);
    const view = await t.http().get(`/account/bookings/${b.reference}/travellers`).set('Cookie', c.cookie);
    expect(view.body.travellers.map((x: { slot: number }) => x.slot)).toEqual([2, 3]);
  });
});

describe('overdue adjustments and erasure (review M2, M4)', () => {
  it('adjustment_overdue_opens_task_once and adjustment_paid_no_task', async () => {
    const late = await paidBooking();
    await amend(late.bookingId, await keepAll(late.bookingId, { extraNightsAfter: 1 }));
    const paid = await paidBooking();
    await amend(paid.bookingId, await keepAll(paid.bookingId, { extraNightsAfter: 1 }));
    await payNext(paid.reference, paid.bookingId);
    const item = (await activeItems(late.bookingId)).find((i) => i.kind === 'adjustment')!;
    const due = item.dueDate.toISOString().slice(0, 10);
    // The day after the due date (and twice): one task for the unpaid change, none for the paid one.
    const after = new Date(item.dueDate.getTime() + 2 * 86_400_000);
    await t.app.get(PaymentsMaintenanceService).run(after);
    await t.app.get(PaymentsMaintenanceService).run(after);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:adjustment_overdue:${late.bookingId}:${due}` } })).toBe(1);
    expect(await t.prisma.task.count({ where: { sourceRef: { startsWith: `payments:adjustment_overdue:${paid.bookingId}` } } })).toBe(0);
    // Not before it is due.
    const early = await paidBooking();
    await amend(early.bookingId, await keepAll(early.bookingId, { extraNightsAfter: 1 }));
    await t.app.get(PaymentsMaintenanceService).run(new Date());
    expect(await t.prisma.task.count({ where: { sourceRef: { startsWith: `payments:adjustment_overdue:${early.bookingId}` } } })).toBe(0);
  });

  it('erasure registry: amendments are exported with the customer and hold nothing to erase', async () => {
    const b = await paidBooking();
    await amend(b.bookingId, await keepAll(b.bookingId, { extraNightsAfter: 1 }));
    const def = t.app.get(EntityRegistry).get('BookingAmendment')!;
    expect(def.customerLink).toEqual({ kind: 'via', entityType: 'Booking', column: 'bookingId' });
    const customerId = (await row(b.bookingId)).customerId;
    const exported = await t.prisma.$transaction((tx) => def.handlers!.export(tx, customerId));
    expect(exported.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(exported, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/Ada|Runner|@/);
  });
});
