// The coverage rule, Oscar's confirmation, the approval expiry and the replacement of attempts, through HTTP, the
// simulator and a real PostgreSQL (plan docs/plans/3.2-payment-plan-coverage.md, sections 1 to 5 and 11).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingStateMachine } from '../../../src/modules/bookings';
import type { BookingStatus } from '@mt/shared';
import { readBookingForPayments } from '../../../src/modules/bookings';
import { BookingCoverage } from '../../../src/modules/bookings/coverage';
import { BookingExpiryService } from '../../../src/modules/bookings/expiry.service';
import { lockPayment } from '../../../src/modules/payments/core/attempt-state';
import { PaymentAttemptSyncService } from '../../../src/modules/payments/core/attempt-sync.service';
import { PaymentsMaintenanceService } from '../../../src/modules/payments/core/maintenance.service';
import { PaymentScheduleService } from '../../../src/modules/payments/core/schedule.service';
import { PaymentWebhooksService } from '../../../src/modules/payments/core/webhooks.service';
import { SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { runTransaction, TRANSACTION_RETRIES } from '../../../src/platform/database/transaction';
import { AppError } from '../../../src/platform/errors/safe-error';
import { TestApp, makeApp } from '../../support/auth';
import { CATALOGUE_AND_PRICING, closeCatalogue, staffClient } from '../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents, makeBookingFor, staffCancel, insertBareCancellation } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import {
  PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, expireNow, insertValidSchedule, onlyAccount, payingCustomer, paymentsStaff, sendWebhook, sim, simulatorAccount,
  acceptCurrentTerms,
} from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'bookings.maintenance' AND data ? 'bookingId'`);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const bookingRow = (id: string) => t.prisma.booking.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) => (await bookingRow(id)).status;
const paymentsOf = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
const eventsOf = (bookingId: string, type: string) => t.prisma.outboxEvent.count({ where: { aggregateId: bookingId, type } });
const sync = () => t.app.get(PaymentAttemptSyncService);

/** A fresh package (so its auto-confirmation can change) and an approved booking of customer c on it. */
async function booked(autoConfirm = true): Promise<{ reference: string; bookingId: string; pkgId: string }> {
  const w = await pricedWorld(admin);
  if (!autoConfirm) await t.prisma.$executeRawUnsafe(`UPDATE packages SET "autoConfirmOnDeposit" = false WHERE id = $1::uuid`, w.pkg.id);
  const b = await approvedBooking(t, admin, w, c);
  return { ...b, pkgId: w.pkg.id };
}

/** Starts a payment and makes the simulator collect it, through a signed webhook. */
async function payAndCollect(reference: string, bookingId: string, body: object = { method: 'card' }) {
  const res = await c.pay(reference, body);
  expect(res.status).toBe(201);
  const p = (await paymentsOf(bookingId)).at(-1)!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  const d = await deliver(t, acc, await eventFor(t, acc, p.id));
  return { p, d };
}

/** A booking of customer c with a chosen total and deposit (as in flow.test.ts), approved through the API. */
async function amounts(depositMinor: bigint, totalMinor: bigint): Promise<{ reference: string; bookingId: string }> {
  const ww = await pricedWorld(admin);
  if (!(await t.prisma.customer.findFirst({ where: { userId: c.userId } }))) await booked();
  const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: c.userId } });
  // Task 6.3: the chosen amounts are the first snapshot's (a snapshot of kind amendment now needs its amendment record).
  const { bookingId } = await makeBookingFor(t, ww, customer.id, undefined, { totalMinor, depositMinor });
  const b = await bookingRow(bookingId);
  const ok = await admin.post(`/admin/bookings/${bookingId}/approve`, { version: b.version });
  if (ok.status !== 200) throw new Error(`approve failed ${ok.status} ${JSON.stringify(ok.body)}`);
  // A free booking is paid in full at approval and takes no payment, so it has no terms to accept.
  if (totalMinor > 0n) await acceptCurrentTerms(t, c, b.reference);
  return { reference: b.reference, bookingId };
}

const pastApproval = (bookingId: string) => t.prisma.$executeRawUnsafe(`UPDATE bookings SET "approvalExpiresAt" = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, bookingId);
const confirm = async (bookingId: string, who = admin) => who.post(`/admin/bookings/${bookingId}/confirm`, { version: (await bookingRow(bookingId)).version });

describe('the coverage rule with the simulator (sections 1.2 and 1.4)', () => {
  it('deposit_payment_moves_to_deposit_paid_and_confirmed: one transaction, audited, one event each', async () => {
    const { reference, bookingId } = await booked();
    const { d } = await payAndCollect(reference, bookingId);
    expect(d.outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('confirmed');
    expect(await eventsOf(bookingId, 'bookings.booking.deposit_paid')).toBe(1);
    expect(await eventsOf(bookingId, 'bookings.booking.confirmed')).toBe(1);
    expect(await eventsOf(bookingId, 'bookings.booking.balance_paid')).toBe(0);
    const audit = await t.prisma.auditLog.findMany({ where: { entityId: bookingId, action: 'bookings.booking.status_changed' }, orderBy: { id: 'asc' } });
    expect(audit.map((a) => (a.changes as { _context: { event: string } })._context.event)).toEqual(['approve', 'deposit_covered', 'auto_confirm']);
    expect(audit.slice(1).every((a) => a.actorType === 'system')).toBe(true);
  });

  it('deposit_paid_waits_without_auto_confirm', async () => {
    const { reference, bookingId } = await booked(false);
    await payAndCollect(reference, bookingId);
    expect(await statusOf(bookingId)).toBe('deposit_paid');
  });

  it('single_payment_covers_deposit_and_balance: deposit and balance at once end in balance_paid', async () => {
    const { reference, bookingId } = await booked();
    await payAndCollect(reference, bookingId, { method: 'card', upToSequence: 2 });
    expect(await statusOf(bookingId)).toBe('balance_paid');
    const plan = await c.plan(reference);
    expect(plan.body).toMatchObject({ outstandingMinor: '0', overpaidMinor: '0', payable: false, notPayableReason: 'nothing_to_pay', depositDueBy: null });
    expect(plan.body.items.every((i: { amountMinor: string; paidMinor: string }) => i.amountMinor === i.paidMinor)).toBe(true);
  });

  it('balance_payment_moves_confirmed_to_balance_paid', async () => {
    const { reference, bookingId } = await booked();
    await payAndCollect(reference, bookingId);
    expect(await statusOf(bookingId)).toBe('confirmed');
    await payAndCollect(reference, bookingId);
    expect(await statusOf(bookingId)).toBe('balance_paid');
    expect(await eventsOf(bookingId, 'bookings.booking.balance_paid')).toBe(1);
  });

  it('full_payment_before_confirmation_waits_for_oscar; his confirmation then ends in balance_paid', async () => {
    const { reference, bookingId } = await booked(false);
    await payAndCollect(reference, bookingId, { method: 'card', upToSequence: 2 });
    expect(await statusOf(bookingId)).toBe('deposit_paid');
    const res = await confirm(bookingId);
    expect([res.status, res.body.status]).toEqual([200, 'balance_paid']);
    expect(await eventsOf(bookingId, 'bookings.booking.confirmed')).toBe(1);
    expect(await eventsOf(bookingId, 'bookings.booking.balance_paid')).toBe(1);
  });

  it('duplicate_success_applies_coverage_once, and out_of_order_webhooks_keep_booking_status', async () => {
    const { reference, bookingId } = await booked();
    const { p } = await payAndCollect(reference, bookingId);
    // The same event again, a different event saying the same, then a late "failed".
    const again = await eventFor(t, acc, p.id);
    expect((await deliver(t, acc, again)).outcome).toBe('processed');
    expect((await deliver(t, acc, await eventFor(t, acc, p.id, { status: 'failed' }))).outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('confirmed');
    expect((await paymentsOf(bookingId))[0]!.status).toBe('succeeded');
    expect(await eventsOf(bookingId, 'bookings.booking.deposit_paid')).toBe(1);
    expect(await eventsOf(bookingId, 'bookings.booking.confirmed')).toBe(1);
  });

  it('out_of_order_webhooks_keep_booking_status: succeeded after cancelled applies the coverage rule once', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    expect((await deliver(t, acc, await eventFor(t, acc, p!.id, { status: 'cancelled' }))).outcome).toBe('processed');
    expect((await paymentsOf(bookingId))[0]!.status).toBe('cancelled');
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    expect((await deliver(t, acc, await eventFor(t, acc, p!.id))).outcome).toBe('processed');
    expect((await deliver(t, acc, await eventFor(t, acc, p!.id))).outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('confirmed');
    expect(await eventsOf(bookingId, 'bookings.booking.deposit_paid')).toBe(1);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:late_success:${p!.id}` } })).toBe(1);
  });

  it('payment_on_cancelled_or_expired_booking_does_not_reactivate: an overpayment and a task', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    // The attempt ends at the gateway, the booking is cancelled, then the money arrives late.
    sim.settle(acc.id, p!.providerPaymentRef!, 'failed');
    await deliver(t, acc, await eventFor(t, acc, p!.id, { status: 'failed' }));
    const cancel = await staffCancel(admin, bookingId, { version: (await bookingRow(bookingId)).version, reason: 'Gone' });
    expect(cancel.status).toBe(200);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, p!.id));
    expect(await statusOf(bookingId)).toBe('cancelled');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${p!.id}` } })).toBe(1);
    expect((await c.plan(reference)).body).toMatchObject({ overpaidMinor: p!.amountMinor.toString(), payable: false });
  });

  it('zero_total_booking_fully_covered_at_approval; with no deposit, deposit_paid needs the first item', async () => {
    const zero = await amounts(0n, 0n);
    expect(await statusOf(zero.bookingId)).toBe('balance_paid');
    const noDeposit = await amounts(0n, 90_000n);
    expect(await statusOf(noDeposit.bookingId)).toBe('approved');
    const plan = await c.plan(noDeposit.reference);
    expect(plan.body.items.map((i: { kind: string }) => i.kind)).toEqual(['balance']);
    await payAndCollect(noDeposit.reference, noDeposit.bookingId);
    expect(await statusOf(noDeposit.bookingId)).toBe('balance_paid');
  });

  it('coverage_failure_rolls_back_payment_success, and persistent_coverage_failure_raises_task_and_keeps_attempt_live', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    const spy = vi.spyOn(t.app.get(BookingCoverage), 'apply').mockRejectedValue(new AppError('boom', 'injected'));
    try {
      const ev = await eventFor(t, acc, p!.id);
      await expect(deliver(t, acc, ev)).rejects.toMatchObject({ code: 'coverage_failed' });
      // Nothing recorded: the payment and the booking are as before; the event is failed with its code.
      expect((await paymentsOf(bookingId))[0]!.status).toBe('requires_action');
      expect(await statusOf(bookingId)).toBe('approved');
      const stored = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: ev.eventId } } });
      expect([stored.status, stored.errorCode]).toEqual(['failed', 'coverage_failed']);
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:coverage_failed:${p!.id}`, status: 'open' } })).toBe(1);
      // The cause is in the task as a code (review, point 1).
      expect((await t.prisma.task.findFirstOrThrow({ where: { sourceRef: `payments:coverage_failed:${p!.id}` } })).description).toContain('(boom)');
      // The customer's retry sees the gateway's success and gets a 503, the task stays one.
      const res = await c.pay(reference, { method: 'card' });
      expect([res.status, res.body.code]).toEqual([503, 'payment_processing_delayed']);
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:coverage_failed:${p!.id}` } })).toBe(1);
      // The attempt stays live, and the sweep leaves it alone: no loop.
      await expireNow(p!.id);
      const swept = await t.app.get(PaymentsMaintenanceService).run();
      expect(swept.expiring).not.toContain(p!.id);
    } finally {
      spy.mockRestore();
    }
    // Once fixed, the next delivery records it, applies the coverage rule and closes the task.
    expect((await deliver(t, acc, await eventFor(t, acc, p!.id))).outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('confirmed');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:coverage_failed:${p!.id}`, status: 'open' } })).toBe(0);
  });
});

describe("Oscar's confirmation (section 1.5)", () => {
  it('confirm_requires_deposit_covered; a booking already paid in full answers balance_paid', async () => {
    // deposit_paid by SQL with nothing collected: refused, nothing changes.
    const w = await pricedWorld(admin);
    const { bookingId } = await makeBookingFor(t, w);
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE bookings SET status = 'approved', version = version + 1, "approvedAt" = clock_timestamp(), "approvalExpiresAt" = clock_timestamp() + interval '3 days' WHERE id = $1::uuid`, bookingId);
      await insertValidSchedule(tx, bookingId);
    });
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'deposit_paid', version = version + 1 WHERE id = $1::uuid`, bookingId);
    const before = await bookingRow(bookingId);
    const res = await confirm(bookingId);
    expect([res.status, res.body.code]).toEqual([409, 'deposit_not_covered']);
    expect(await bookingRow(bookingId)).toMatchObject({ status: 'deposit_paid', version: before.version });
    // Paid in full without auto-confirmation: the route's answer is the final status.
    const paid = await booked(false);
    await payAndCollect(paid.reference, paid.bookingId, { method: 'card', upToSequence: 2 });
    const ok = await confirm(paid.bookingId);
    expect([ok.status, ok.body.status]).toEqual([200, 'balance_paid']);
  });

  it('confirm_needs_permission_step_up_and_version; money_events_not_routable', async () => {
    const { reference, bookingId } = await booked(false);
    await payAndCollect(reference, bookingId);
    const b = await bookingRow(bookingId);
    // No permission.
    const nobody = await staffClient(t, CATALOGUE_AND_PRICING);
    expect((await nobody.post(`/admin/bookings/${bookingId}/confirm`, { version: b.version })).status).toBe(403);
    // No recent TOTP check.
    const stale = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS]);
    await t.prisma.session.updateMany({ where: { userId: stale.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const r = await stale.post(`/admin/bookings/${bookingId}/confirm`, { version: b.version });
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    // A stale version.
    expect((await admin.post(`/admin/bookings/${bookingId}/confirm`, { version: b.version - 1 })).body.code).toBe('version_conflict');
    // No route sets a payment state.
    for (const e of ['deposit_covered', 'auto_confirm', 'total_covered', 'expire_approval']) expect((await admin.post(`/admin/bookings/${bookingId}/${e}`, { version: b.version })).status).toBe(404);
    // Two clicks: one confirms, the other is a version conflict.
    const [one, two] = await Promise.all([admin.post(`/admin/bookings/${bookingId}/confirm`, { version: b.version }), admin.post(`/admin/bookings/${bookingId}/confirm`, { version: b.version })]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(await statusOf(bookingId)).toBe('confirmed');
  });

  it('booking_money_cells_matrix: confirming, collecting and expiring the approval from every state', async () => {
    const STATES: BookingStatus[] = ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed', 'declined', 'expired', 'cancelled', 'refunded'];
    const PATH: Record<BookingStatus, BookingStatus[]> = {
      requested: [], approved: ['approved'], deposit_paid: ['approved', 'deposit_paid'], confirmed: ['approved', 'deposit_paid', 'confirmed'],
      balance_paid: ['approved', 'deposit_paid', 'confirmed', 'balance_paid'], completed: ['approved', 'deposit_paid', 'confirmed', 'completed'],
      declined: ['declined'], expired: ['approved', 'expired'], cancelled: ['cancelled'], refunded: ['cancelled', 'refunded'],
    };
    const STEP = `UPDATE bookings SET status = $2::"BookingStatus", version = version + 1,
      "approvedAt" = CASE WHEN $2 = 'approved' THEN clock_timestamp() ELSE "approvedAt" END,
      "approvalExpiresAt" = CASE WHEN $2 = 'approved' THEN clock_timestamp() - interval '1 minute' ELSE "approvalExpiresAt" END,
      "declinedAt" = CASE WHEN $2 = 'declined' THEN clock_timestamp() ELSE "declinedAt" END,
      "expiredAt" = CASE WHEN $2 = 'expired' THEN clock_timestamp() ELSE "expiredAt" END,
      "cancelledAt" = CASE WHEN $2 = 'cancelled' THEN clock_timestamp() ELSE "cancelledAt" END
      WHERE id = $1::uuid`;
    const w = await pricedWorld(admin);
    const walk = async (id: string, to: BookingStatus) => {
      for (const s of PATH[to]) {
        await t.prisma.$transaction(async (tx) => {
          // Task 6.4: a cancellation has its record (deferred trigger of 0038).
          if (s === 'cancelled') await insertBareCancellation(tx, id);
          await tx.$executeRawUnsafe(STEP, id, s);
          if (s === 'approved') await insertValidSchedule(tx, id);
          if (s === 'expired') await tx.$executeRawUnsafe(`UPDATE payment_schedule_items SET state = 'superseded', "supersededInVersion" = 2 WHERE "bookingId" = $1::uuid`, id).then(() => tx.$executeRawUnsafe(`UPDATE payment_schedules SET version = 2 WHERE "bookingId" = $1::uuid`, id));
        });
      }
    };
    // Confirm through the API (nothing collected), and the approval expiry through the state machine.
    const CONFIRM: Partial<Record<BookingStatus, string>> = { deposit_paid: 'deposit_not_covered' };
    const EXPIRE: Partial<Record<BookingStatus, BookingStatus>> = { approved: 'expired' };
    for (const s of STATES) {
      const { bookingId } = await makeBookingFor(t, w);
      await walk(bookingId, s);
      const res = await confirm(bookingId);
      expect([s, res.status, res.body.code]).toEqual([s, 409, CONFIRM[s] ?? 'transition_not_allowed']);
      const r = await runTransaction(t.prisma, (tx) => t.app.get(BookingStateMachine).transition(tx, bookingId, 'expire_approval', { actor: SYSTEM_ACTOR }));
      expect([s, r.changed ? (r as { to: string }).to : 'no_change']).toEqual([s, EXPIRE[s] ?? 'no_change']);
    }
    // Collecting: the coverage rule on every state with deposit and total covered.
    const FACTS = { depositCovered: true, totalCovered: true };
    const COVER: Partial<Record<BookingStatus, BookingStatus>> = { approved: 'balance_paid', confirmed: 'balance_paid' };
    for (const s of STATES) {
      const { bookingId } = await makeBookingFor(t, w);
      await walk(bookingId, s);
      const end = await runTransaction(t.prisma, async (tx) => {
        const b = await readBookingForPayments(tx, { id: bookingId }, true);
        return t.app.get(BookingCoverage).apply(tx, b!, FACTS, SYSTEM_ACTOR);
      });
      expect([s, end]).toEqual([s, COVER[s] ?? s]);
    }
  });

  it('confirm_vs_balance_success_concurrent_ends_balance_paid', async () => {
    const { reference, bookingId } = await booked(false);
    await payAndCollect(reference, bookingId);
    expect(await statusOf(bookingId)).toBe('deposit_paid');
    await c.pay(reference, { method: 'card' });
    const p = (await paymentsOf(bookingId)).at(-1)!;
    sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
    const ev = await eventFor(t, acc, p.id);
    const deadlocks = TRANSACTION_RETRIES.deadlock;
    const [r] = await Promise.all([confirm(bookingId), deliver(t, acc, ev)]);
    expect(r.status).toBe(200);
    expect(await statusOf(bookingId)).toBe('balance_paid');
    expect(TRANSACTION_RETRIES.deadlock - deadlocks).toBe(0);
  });
});

describe('the approval expiry (section 3)', () => {
  it('approval_expiry_expires_unpaid_and_supersedes_plan: stock back, plan owes 0, audited and published', async () => {
    const { bookingId } = await booked();
    const claims = await t.prisma.inventoryClaim.findMany({ where: { bookingId, status: 'held' } });
    const pool = claims[0]!.poolId;
    const before = (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: pool } })).consumed;
    await pastApproval(bookingId);
    expect(await t.app.get(BookingExpiryService).expireApproval(bookingId)).toBe('changed');
    const b = await bookingRow(bookingId);
    expect([b.status, b.expiredAt !== null]).toEqual(['expired', true]);
    expect((await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: pool } })).consumed).toBe(before - claims.filter((x) => x.poolId === pool).reduce((n, x) => n + x.quantity, 0));
    const plan = await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId }, include: { items: true } });
    expect(plan.version).toBe(2);
    expect(plan.items.every((i) => i.state === 'superseded' && i.supersededInVersion === 2)).toBe(true);
    expect(await t.prisma.auditLog.count({ where: { entityId: plan.id, action: 'payments.schedule.superseded' } })).toBe(1);
    expect(await eventsOf(bookingId, 'bookings.booking.expired')).toBe(1);
    // Running it again is no change.
    expect(await t.app.get(BookingExpiryService).expireApproval(bookingId)).toBe('unchanged');
  });

  it('approval_expiry_not_before_due; the sweep picks up those that are due', async () => {
    const early = await booked();
    expect(await t.app.get(BookingExpiryService).expireApproval(early.bookingId)).toBe('unchanged');
    expect(await statusOf(early.bookingId)).toBe('approved');
    const due = await booked();
    await pastApproval(due.bookingId);
    const r = await t.app.get(BookingExpiryService).run();
    expect(r.approvalsExpired).toBeGreaterThanOrEqual(1);
    expect(await statusOf(due.bookingId)).toBe('expired');
    expect(await statusOf(early.bookingId)).toBe('approved');
  });

  it.each(['created', 'requires_action', 'pending'] as const)('approval_expiry_skipped_while_payment_pending (%s)', async (state) => {
    const { reference, bookingId } = await booked();
    if (state === 'created') sim.queue(acc.id, 'timeout');
    if (state === 'pending') sim.queue(acc.id, 'pending');
    await c.pay(reference, { method: 'card' });
    expect((await paymentsOf(bookingId))[0]!.status).toBe(state);
    await pastApproval(bookingId);
    expect(await t.app.get(BookingExpiryService).expireApproval(bookingId)).toBe('blocked');
    expect(await statusOf(bookingId)).toBe('approved');
    expect((await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId } })).version).toBe(1);
  });

  it('approval_expiry_skipped_when_deposit_covered (the coverage rule not applied yet, by SQL)', async () => {
    const { reference, bookingId } = await booked(false);
    await payAndCollect(reference, bookingId);
    // Put it back to approved by hand (the trigger forbids it): instead check the hook on the state it guards.
    const r = await runTransaction(t.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: bookingId }, true);
      try {
        await t.app.get(PaymentScheduleService).onExpireApproval(tx, { id: b!.id, customerId: b!.customerId, packageId: '', currency: b!.currency, from: 'approved' }, { actor: SYSTEM_ACTOR, at: new Date() });
        return 'ran';
      } catch (err) {
        return (err as { code?: string }).code;
      }
    });
    expect(r).toBe('approval_expiry_blocked_by_payment');
    expect((await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId } })).version).toBe(1);
  });

  it('approval_expiry_reevaluated_when_live_attempt_ends, and attempt_end_requeues_expiry_in_lock_order', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    await pastApproval(bookingId);
    expect(await t.app.get(BookingExpiryService).expireApproval(bookingId)).toBe('blocked');
    sim.settle(acc.id, p!.providerPaymentRef!, 'failed');
    expect((await deliver(t, acc, await eventFor(t, acc, p!.id, { status: 'failed' }))).outcome).toBe('processed');
    // The attempt's own transaction did not expire the booking (it holds a payment): it queued a job for it.
    expect(await statusOf(bookingId)).toBe('approved');
    const jobs = await t.prisma.$queryRawUnsafe<Array<{ data: { bookingId: string }; singletonKey: string }>>(
      `SELECT data, singleton_key AS "singletonKey" FROM pgboss.job WHERE name = 'bookings.maintenance' AND data->>'bookingId' = $1`, bookingId);
    expect(jobs.map((j) => j.singletonKey)).toEqual([`expire-approval:${bookingId}`]);
    // The worker runs it for that booking only.
    expect(await t.app.get(BookingExpiryService).expireApproval(jobs[0]!.data.bookingId)).toBe('changed');
    expect(await statusOf(bookingId)).toBe('expired');
  });

  it('expiry_of_pending_debit_queries_provider_first: the attempt sweep asks the gateway before anything', async () => {
    const { reference, bookingId } = await booked();
    sim.queue(acc.id, 'pending');
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    await expireNow(p!.id);
    // The gateway now says it went through: the sweep records it and the booking moves on; nothing expires.
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    expect(await sync().run(p!.id, 'expire')).toBe('applied');
    expect((await paymentsOf(bookingId))[0]!.status).toBe('succeeded');
    expect(await statusOf(bookingId)).toBe('confirmed');
  });

  it('late_success_after_approval_expiry_becomes_overpayment: the booking stays expired', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'failed');
    await deliver(t, acc, await eventFor(t, acc, p!.id, { status: 'failed' }));
    await pastApproval(bookingId);
    expect(await t.app.get(BookingExpiryService).expireApproval(bookingId)).toBe('changed');
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, p!.id));
    expect(await statusOf(bookingId)).toBe('expired');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${p!.id}` } })).toBe(1);
    expect(await t.prisma.paymentScheduleItem.count({ where: { bookingId, state: 'active' } })).toBe(0);
    const view = await admin.get(`/admin/payments/bookings/${bookingId}`);
    expect(view.body.allocation.overpaidMinor).toBe(p!.amountMinor.toString());
    expect(view.body.allocation.byPayment).toEqual([{ paymentId: p!.id, sequence: null, amountMinor: p!.amountMinor.toString() }]);
  });

  it('approval_expiry_vs_payment_success_concurrent: either paid or expired with an overpayment, never a deadlock', async () => {
    const deadlocks = TRANSACTION_RETRIES.deadlock;
    for (let i = 0; i < 4; i++) {
      const { reference, bookingId } = await booked();
      await c.pay(reference, { method: 'card' });
      const [p] = await paymentsOf(bookingId);
      // The attempt failed, then the gateway collects it late while the sweep expires the approval.
      sim.settle(acc.id, p!.providerPaymentRef!, 'failed');
      await deliver(t, acc, await eventFor(t, acc, p!.id, { status: 'failed' }));
      await pastApproval(bookingId);
      sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
      const ev = await eventFor(t, acc, p!.id);
      await sendWebhook(t, acc, ev);
      const stored = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: ev.eventId } } });
      await Promise.all([t.app.get(PaymentWebhooksService).process(stored.id), t.app.get(BookingExpiryService).expireApproval(bookingId)]);
      const s = await statusOf(bookingId);
      expect(['confirmed', 'expired']).toContain(s);
      if (s === 'expired') expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${p!.id}` } })).toBe(1);
      else expect(await t.prisma.paymentScheduleItem.count({ where: { bookingId, state: 'active' } })).toBeGreaterThan(0);
    }
    expect(TRANSACTION_RETRIES.deadlock - deadlocks).toBe(0);
  });

  it('deposit_due_instant_shown_and_enforced', async () => {
    const { reference, bookingId } = await booked();
    const at = new Date(Date.now() + 60_000);
    await t.prisma.booking.update({ where: { id: bookingId }, data: { approvalExpiresAt: at } });
    const plan = await c.plan(reference);
    expect(plan.body.depositDueBy).toBe(at.toISOString());
    expect((await admin.get(`/admin/payments/bookings/${bookingId}`)).body.booking.depositDueBy).toBe(at.toISOString());
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    // At the instant itself: no new attempt.
    const late = await booked();
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET "approvalExpiresAt" = clock_timestamp() WHERE id = $1::uuid`, late.bookingId);
    const res = await c.pay(late.reference, { method: 'card' });
    expect([res.status, res.body.code]).toEqual([409, 'approval_expired']);
  });
});

describe('replacing a live attempt (section 4, plan 0.1 P2)', () => {
  it('abandoned_3ds_resumed_or_replaced_immediately', async () => {
    const { reference, bookingId } = await booked();
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    // Same method: resumed. Another without the flag: refused as in 3.1.
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    expect((await c.pay(reference, { method: 'apple_pay' })).body.code).toBe('payment_attempt_in_progress');
    expect(await paymentsOf(bookingId)).toHaveLength(1);
    // With the flag: the 3DS page is cancelled at the gateway, then a new attempt.
    const res = await c.pay(reference, { method: 'apple_pay', replaceLiveAttempt: true });
    expect([res.status, res.body.status, res.body.method]).toEqual([201, 'requires_action', 'apple_pay']);
    const ps = await paymentsOf(bookingId);
    expect(ps.map((p) => [p.attemptNumber, p.status, p.method])).toEqual([[1, 'cancelled', 'card'], [2, 'requires_action', 'apple_pay']]);
    expect(sim.find(acc.id, { ref: ps[0]!.providerPaymentRef! })!.status).toBe('cancelled');
  });

  it('replace_attempt_only_after_provider_confirms_cancel: gateway down, or no object yet, replaces nothing', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    sim.failNextRetrieve(acc.id, 'unavailable');
    const down = await c.pay(reference, { method: 'apple_pay', replaceLiveAttempt: true });
    expect([down.status, down.body.code]).toEqual([503, 'provider_unavailable']);
    sim.failNextCancel(acc.id);
    const cancelDown = await c.pay(reference, { method: 'apple_pay', replaceLiveAttempt: true });
    expect(cancelDown.status).toBe(503);
    expect((await paymentsOf(bookingId)).map((p) => p.status)).toEqual(['requires_action']);
    // An attempt the gateway has no object for yet (another tab may be creating it) is never replaced.
    const other = await booked();
    sim.queue(acc.id, 'timeout');
    expect((await c.pay(other.reference, { method: 'card' })).status).toBe(503);
    const r = await c.pay(other.reference, { method: 'apple_pay', replaceLiveAttempt: true });
    expect([r.status, r.body.code]).toEqual([409, 'payment_attempt_in_progress']);
    expect((await paymentsOf(other.bookingId)).map((p) => p.status)).toEqual(['created']);
  });

  it('pending_debit_blocks_new_attempt, even when asked to replace it', async () => {
    const { reference, bookingId } = await booked();
    sim.queue(acc.id, 'pending');
    await c.pay(reference, { method: 'card' });
    const res = await c.pay(reference, { method: 'apple_pay', replaceLiveAttempt: true });
    expect([res.status, res.body.code]).toEqual([409, 'payment_attempt_in_progress']);
    expect((await paymentsOf(bookingId)).map((p) => p.status)).toEqual(['pending']);
  });

  it('replace_reveals_success_records_it: the payment is recorded and no attempt is started for the balance', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    const objects = sim.objectCount(acc.id);
    const res = await c.pay(reference, { method: 'apple_pay', replaceLiveAttempt: true });
    expect([res.status, res.body.code]).toEqual([409, 'payment_already_recorded']);
    expect((await paymentsOf(bookingId)).map((x) => x.status)).toEqual(['succeeded']);
    expect(sim.objectCount(acc.id)).toBe(objects);
    expect(await statusOf(bookingId)).toBe('confirmed');
  });

  it('same_key_retry_after_payment_already_recorded_creates_nothing (review, point 4)', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    const objects = sim.objectCount(acc.id);
    const key = randomUUID();
    const body = { method: 'apple_pay', replaceLiveAttempt: true };
    const first = await c.pay(reference, body, key);
    expect([first.status, first.body.code]).toEqual([409, 'payment_already_recorded']);
    // Same key and body: the stored answer again, never an attempt for the balance.
    const again = await c.pay(reference, body, key);
    expect([again.status, again.body.code]).toEqual([409, 'payment_already_recorded']);
    expect((await paymentsOf(bookingId)).map((x) => x.status)).toEqual(['succeeded']);
    expect(sim.objectCount(acc.id)).toBe(objects);
    // A new key is a new decision of the customer: it pays the balance.
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
  });

  it('replace_flag_without_live_attempt_is_plain_create', async () => {
    const { reference, bookingId } = await booked();
    expect((await c.pay(reference, { method: 'card', replaceLiveAttempt: true })).status).toBe(201);
    expect(await paymentsOf(bookingId)).toHaveLength(1);
    expect((await c.pay(reference, { method: 'card', replaceLiveAttempt: 1 })).status).toBe(422);
  });

  it('late_success_of_cancelled_attempt_becomes_overpayment', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    await c.pay(reference, { method: 'apple_pay', replaceLiveAttempt: true });
    const [old, current] = await paymentsOf(bookingId);
    sim.settle(acc.id, current!.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, current!.id));
    expect(await statusOf(bookingId)).toBe('confirmed');
    // The customer had paid the cancelled one too (the gateway says so late).
    sim.settle(acc.id, old!.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, old!.id));
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:late_success:${old!.id}` } })).toBe(1);
    // The deposit twice covers part of the balance: no overpayment yet, and still only one move along the states.
    const plan = await c.plan(reference);
    expect(BigInt(plan.body.collectedMinor)).toBe(old!.amountMinor + current!.amountMinor);
    expect(await eventsOf(bookingId, 'bookings.booking.confirmed')).toBe(1);
  });

  it('concurrent_replace_creates_one_attempt: two tabs, one new attempt, one effective cancellation, one new object', async () => {
    const { reference, bookingId } = await booked();
    await c.pay(reference, { method: 'card' });
    const objects = sim.objectCount(acc.id);
    const cancels = sim.effectiveCancels(acc.id);
    const results = await Promise.all([1, 2].map(() => c.pay(reference, { method: 'apple_pay', replaceLiveAttempt: true })));
    expect(results.every((r) => r.status === 201 || (r.status === 409 && ['payment_attempt_in_progress', 'busy_try_again'].includes(r.body.code)))).toBe(true);
    const ps = await paymentsOf(bookingId);
    expect(ps.map((p) => p.status)).toEqual(['cancelled', 'requires_action']);
    expect(sim.effectiveCancels(acc.id) - cancels).toBe(1);
    expect(sim.objectCount(acc.id) - objects).toBe(1);
  });
});

describe('views and the lock order (sections 5 and 11.11)', () => {
  it('plan_view_shows_paid_per_item_and_overpaid; admin_view_shows_allocation_and_coverage', async () => {
    const { reference, bookingId } = await booked(false);
    const { p } = await payAndCollect(reference, bookingId);
    const plan = await c.plan(reference);
    expect(plan.body.items.map((i: { sequence: number; paidMinor: string }) => [i.sequence, i.paidMinor])).toEqual([[1, p.amountMinor.toString()], [2, '0']]);
    expect(plan.body).toMatchObject({ overpaidMinor: '0', depositDueBy: null });
    expect(JSON.stringify(plan.body)).not.toContain(p.id);
    const view = (await admin.get(`/admin/payments/bookings/${bookingId}`)).body;
    expect(view.coverage).toMatchObject({ depositCovered: true, totalCovered: false, collectedMinor: p.amountMinor.toString() });
    expect(view.allocation.byPayment).toEqual([{ paymentId: p.id, sequence: 1, amountMinor: p.amountMinor.toString() }]);
  });

  it('lock_payment_requires_locked_booking: a payment of another booking is refused', async () => {
    const one = await booked();
    const two = await booked();
    await c.pay(one.reference, { method: 'card' });
    const [p] = await paymentsOf(one.bookingId);
    await expect(runTransaction(t.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: two.bookingId }, true);
      return lockPayment(tx, b!, p!.id);
    })).rejects.toMatchObject({ code: 'payment_lock_order' });
  });

  it('overpayment_on_approval_expiry_event_has_the_payment_shape (review, point 2)', async () => {
    const { reference, bookingId } = await booked(false);
    const { p } = await payAndCollect(reference, bookingId);
    // Money in without the deposit covered cannot happen through the API; the hook is run with that fact forced,
    // inside a transaction that is then undone (the plan check at commit would refuse it on a paid booking).
    const coverage = t.app.get(PaymentScheduleService)['coverage'] as { money: (...a: unknown[]) => Promise<{ depositCovered: boolean; collectedMinor: bigint }> };
    const real = coverage.money.bind(coverage);
    const spy = vi.spyOn(coverage, 'money').mockImplementation(async (...a: unknown[]) => ({ ...(await real(...a)), depositCovered: false }));
    const seen = await t.prisma.$transaction(async (tx) => {
      const b = await readBookingForPayments(tx, { id: bookingId }, true);
      await t.app.get(PaymentScheduleService).onExpireApproval(tx, { id: b!.id, customerId: b!.customerId, packageId: '', currency: b!.currency, from: 'approved' }, { actor: SYSTEM_ACTOR, at: new Date() });
      const rows = await tx.outboxEvent.findMany({ where: { type: 'payments.booking.overpaid', payload: { path: ['bookingId'], equals: bookingId } }, select: { aggregateType: true, aggregateId: true, payload: true } });
      throw Object.assign(new Error('undo'), { rows });
    }).catch((e: { rows?: unknown }) => e.rows);
    spy.mockRestore();
    expect(seen).toEqual([{ aggregateType: 'Payment', aggregateId: p.id, payload: { paymentId: p.id, bookingId } }]);
  });

  it('cancel_with_collected_money_rejected stays in the hook (no refunds yet)', async () => {
    const { reference, bookingId } = await booked(false);
    await payAndCollect(reference, bookingId);
    const r = await runTransaction(t.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: bookingId }, true);
      try {
        await t.app.get(PaymentScheduleService).onCancel(tx, { id: b!.id, customerId: b!.customerId, packageId: '', currency: b!.currency, from: 'approved' }, { actor: SYSTEM_ACTOR, at: new Date() });
        return 'ran';
      } catch (err) {
        return (err as { code?: string }).code;
      }
    });
    expect(r).toBe('cancellation_needs_payments');
  });
});

