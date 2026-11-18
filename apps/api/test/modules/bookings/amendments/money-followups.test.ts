// What a change means for the reminders of task 5.6 and the erasure rule of task 5.5 (plan
// docs/plans/6.3-booking-amendments.md, section 6; review M1 and M4).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingAmendmentHooks } from '../../../../src/modules/bookings/amendment-hooks';
import { ErasureService } from '../../../../src/modules/privacy';
import { PaymentRemindersService, legacyReminderDedupeKey } from '../../../../src/modules/payments/core/reminders.service';
import { TestApp, makeApp } from '../../../support/auth';
import { CATALOGUE_AND_PRICING, closeCatalogue, staffClient } from '../../../support/catalogue';
import type { Client } from '../../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../../support/bookings';
import { ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, acceptCurrentTerms, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, sim, simulatorAccount } from '../../../support/payments';
import { AmendWorld, amendWorld, requestIn, retireAmendWorlds, runner, supporter } from '../../../support/amendments';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

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
afterAll(async () => {
  vi.restoreAllMocks();
  await retireAmendWorlds(t);
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'mail.send'`);
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** 10:00 in Brisbane on a date (reminders go out in business hours only). */
const tenAm = (date: string) => new Date(`${date}T10:00:00+10:00`);
const row = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
const reminderKeys = (bookingId: string) => t.prisma.outboundEmail.findMany({ where: { dedupeKey: { startsWith: `balance-reminder:${bookingId}:` } }, orderBy: { createdAt: 'asc' } }).then((r) => r.map((e) => e.dedupeKey));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function lockWaiter(timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [r] = await t.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((r?.n ?? 0) >= 1) return;
    await sleep(25);
  }
  throw new Error('no transaction waited on a lock');
}

/** Approved, terms accepted, deposit paid through the simulator: confirmed (the package confirms on deposit). */
async function paidBooking(world: AmendWorld, rooms = [{ roomOptionId: world.doubleId, travellers: [runner(world), supporter] }]) {
  const b = await requestIn(t, c.cookie, world, { rooms });
  expect((await admin.post(`/admin/bookings/${b.bookingId}/approve`, { version: (await row(b.bookingId)).version })).status).toBe(200);
  await acceptCurrentTerms(t, c, b.reference);
  expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId: b.bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, acc, await eventFor(t, acc, p.id))).outcome).toBe('processed');
  return b;
}

async function amend(bookingId: string, body: Record<string, unknown>) {
  const p = await admin.post(`/admin/bookings/${bookingId}/amendments/preview`, body);
  if (p.status !== 200) throw new Error(`preview ${p.status} ${JSON.stringify(p.body)}`);
  const r = await admin.post(`/admin/bookings/${bookingId}/amendments`, { ...body, previewDigest: p.body.previewDigest }).set('Idempotency-Key', randomUUID());
  if (r.status !== 201) throw new Error(`apply ${r.status} ${JSON.stringify(r.body)}`);
}
const keep = (world: AmendWorld, over: Record<string, unknown> = {}) => ({ expectedSnapshotVersion: 1, rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [], reasonCode: 'customer_request', ...over });

describe('reminders after a change (review M1, task 5.6)', () => {
  it('adjustment_item_reminded: what a change adds is the next item owed and gets its own reminder', async () => {
    const world = await amendWorld(admin);
    const b = await paidBooking(world);
    await amend(b.bookingId, keep(world, { extraNightsAfter: 1 }));
    const adj = (await t.prisma.paymentScheduleItem.findMany({ where: { bookingId: b.bookingId, state: 'active', kind: 'adjustment' } }))[0]!;
    const due = adj.dueDate.toISOString().slice(0, 10);
    const run = await t.app.get(PaymentRemindersService).run(tenAm(plus(due, -3)), { bookingId: b.bookingId });
    expect([run.queued, run.errors]).toEqual([1, 0]);
    expect(await reminderKeys(b.bookingId)).toEqual([`balance-reminder:${b.bookingId}:adjustment:${due}:3`]);
  });

  it('amendment_does_not_resend_reminders: the restated balance (new id, same kind and due date) is not reminded again', async () => {
    const due = plus(today(), 10);
    const world = await amendWorld(admin, { balanceDueDate: due });
    const b = await paidBooking(world);
    const first = await t.app.get(PaymentRemindersService).run(tenAm(today()), { bookingId: b.bookingId });
    expect(first.queued).toBe(1);
    expect(await reminderKeys(b.bookingId)).toEqual([`balance-reminder:${b.bookingId}:balance:${due}:14`]);
    const before = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: b.bookingId, state: 'active', kind: 'balance' } });
    // The supporter leaves: the balance shrinks and is restated with a new id and the same due date.
    await amend(b.bookingId, keep(world, { rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }] }], reasonCode: 'correction' }));
    const after = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: b.bookingId, state: 'active', kind: 'balance' } });
    expect(after.id).not.toBe(before.id);
    expect(after.dueDate).toEqual(before.dueDate);
    const second = await t.app.get(PaymentRemindersService).run(tenAm(today()), { bookingId: b.bookingId });
    expect(second.queued).toBe(0);
    expect(await reminderKeys(b.bookingId)).toHaveLength(1);
  });

  it('legacy_key_honoured: a reminder 5.6 already queued under its old key (item id and offset) is not sent again', async () => {
    const due = plus(today(), 10);
    const world = await amendWorld(admin, { balanceDueDate: due });
    const b = await paidBooking(world);
    const item = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: b.bookingId, state: 'active', kind: 'balance' } });
    const legacy = legacyReminderDedupeKey(item.id, 14);
    expect(legacy).toBe(`balance-reminder:${item.id}:14`);
    await t.prisma.outboundEmail.create({ data: { to: 'legacy@example.test', templateKey: 'payment-reminder', templateVersion: 1, locale: 'en-AU', dedupeKey: legacy, status: 'sent' } });
    // The sweep leaves the line out in SQL...
    const run = await t.app.get(PaymentRemindersService).run(tenAm(today()), { bookingId: b.bookingId });
    expect([run.examined, run.queued, run.errors]).toEqual([0, 0, 0]);
    // ...and the line's own transaction refuses it too (a sweep that read the line before the old row was seen).
    expect(await t.app.get(PaymentRemindersService).remind(item.id, b.bookingId, [14, 7, 3], today())).toBe('already_queued');
    expect(await reminderKeys(b.bookingId)).toEqual([]);
    await t.prisma.outboundEmail.delete({ where: { dedupeKey: legacy } });
  });

  it('same_day_adjustments_merge: two rises falling due the same day make one adjustment, which keeps its reminders', async () => {
    const world = await amendWorld(admin);
    const b = await paidBooking(world);
    await amend(b.bookingId, keep(world, { extraNightsAfter: 1 }));
    const first = (await t.prisma.paymentScheduleItem.findMany({ where: { bookingId: b.bookingId, state: 'active', kind: 'adjustment' } }))[0]!;
    const due = first.dueDate.toISOString().slice(0, 10);
    expect((await t.app.get(PaymentRemindersService).run(tenAm(plus(due, -3)), { bookingId: b.bookingId })).queued).toBe(1);
    await amend(b.bookingId, keep(world, { expectedSnapshotVersion: 2, extraNightsAfter: 2 }));
    const adj = await t.prisma.paymentScheduleItem.findMany({ where: { bookingId: b.bookingId, state: 'active', kind: 'adjustment' } });
    expect(adj).toHaveLength(1);
    expect(adj[0]!.dueDate).toEqual(first.dueDate);
    expect(adj[0]!.amountMinor > first.amountMinor).toBe(true);
    // Same key as the one already sent: no second reminder for that offset, and nothing lost to a second item.
    expect((await t.app.get(PaymentRemindersService).run(tenAm(plus(due, -3)), { bookingId: b.bookingId })).queued).toBe(0);
    expect(await reminderKeys(b.bookingId)).toEqual([`balance-reminder:${b.bookingId}:adjustment:${due}:3`]);
  });

  it('a reminder sweep racing a change waits for it and never reminds a superseded item', async () => {
    const due = plus(today(), 10);
    const world = await amendWorld(admin, { balanceDueDate: due });
    const b = await paidBooking(world);
    const body = keep(world, { extraNightsAfter: 1 });
    const p = await admin.post(`/admin/bookings/${b.bookingId}/amendments/preview`, body);
    // The change stops with the booking locked; the sweep picked the old balance and must wait for the booking.
    const original = BookingAmendmentHooks.prototype.runPlaces;
    let inside!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (inside = r));
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi.spyOn(BookingAmendmentHooks.prototype, 'runPlaces').mockImplementationOnce(async function (this: BookingAmendmentHooks, ...args) {
      inside();
      await gate;
      return original.apply(this, args);
    });
    try {
      const change = Promise.resolve(admin.post(`/admin/bookings/${b.bookingId}/amendments`, { ...body, previewDigest: p.body.previewDigest }).set('Idempotency-Key', randomUUID()));
      await entered;
      const sweep = t.app.get(PaymentRemindersService).run(tenAm(today()), { bookingId: b.bookingId });
      await lockWaiter();
      release();
      const [rc, rs] = await Promise.all([change, sweep]);
      expect(rc.status).toBe(201);
      expect([rs.queued, rs.errors, rs.skipped.item_changed]).toEqual([0, 0, 1]);
    } finally {
      spy.mockRestore();
    }
    expect(await reminderKeys(b.bookingId)).toEqual([]);
    // The next sweep reminds what is owed next: the adjustment the change added (due within 7 days).
    const next = await t.app.get(PaymentRemindersService).run(tenAm(today()), { bookingId: b.bookingId });
    expect(next.queued).toBe(1);
    expect((await reminderKeys(b.bookingId))[0]).toMatch(new RegExp(`^balance-reminder:${b.bookingId}:adjustment:`));
  });
});

describe('erasure with a credit pending (review M4, task 5.5)', () => {
  /** Sets a booking's status as the tables' owner, with the bookings triggers off for that one transaction (as 5.5's tests). */
  async function forceStatus(bookingId: string, status: 'completed'): Promise<void> {
    const { default: pg } = await import('pg');
    const ownerDb = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await ownerDb.connect();
    try {
      await ownerDb.query('BEGIN');
      await ownerDb.query('ALTER TABLE bookings DISABLE TRIGGER USER');
      await ownerDb.query(`UPDATE bookings SET status = $2::"BookingStatus" WHERE id = $1::uuid`, [bookingId, status]);
      await ownerDb.query('ALTER TABLE bookings ENABLE TRIGGER USER');
      await ownerDb.query('COMMIT');
    } catch (err) {
      await ownerDb.query('ROLLBACK');
      throw err;
    } finally {
      await ownerDb.end();
    }
  }
  const reason = (customerId: string) => t.app.get(ErasureService).blockedBy(t.prisma, customerId);

  it('erasure_refused_with_credit_pending: paid beyond the changed total blocks erasure in any state, completed included', async () => {
    const world = await amendWorld(admin);
    c = await payingCustomer(t); // a customer with no other booking: only the credit can block the erasure
    // 100 000 paid; the runner becomes a supporter alone: 82 500. A credit of 17 500 is pending.
    const b = await paidBooking(world);
    await amend(b.bookingId, keep(world, { rooms: [{ roomOptionId: world.doubleId, travellers: [{ participationType: 'supporter', replacesSlot: 1 }] }], reasonCode: 'correction' }));
    const customerId = (await row(b.bookingId)).customerId;
    // balance_paid before the trip ends: the earlier branch already blocks; once completed, only the credit does.
    expect(await reason(customerId)).toBe('trip_not_finished');
    await forceStatus(b.bookingId, 'completed');
    expect(await reason(customerId)).toBe('refund_may_be_due');
    expect(await t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).toMatchObject({ anonymisedAt: null });
    // The database function itself refuses (as 5.5's erasure runs it: the API role, after anonymising, in one transaction).
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id: customerId }, data: { anonymisedAt: new Date() } });
      await tx.$queryRawUnsafe('SELECT public.privacy_erase_customer($1::uuid)', customerId);
    })).rejects.toThrow(/active_trip/);
    expect(await t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).toMatchObject({ anonymisedAt: null });
    // Control: a completed booking that collected no more than its total (only the deposit was paid) holds nothing back
    // for the rule's last branch.
    const other = await payingCustomer(t);
    const keepC = c;
    c = other;
    try {
      const x = await paidBooking(world);
      await forceStatus(x.bookingId, 'completed');
      expect(await reason((await row(x.bookingId)).customerId)).toBeNull();
    } finally {
      c = keepC;
    }
  });
});
