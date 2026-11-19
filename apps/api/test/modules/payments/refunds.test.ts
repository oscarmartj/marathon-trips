// Refunds made at the gateway, through the simulator (plan docs/plans/3.3-stripe-adapter-ledger.md, sections 2, 3 and
// 12.3, 12.6, 12.9): recorded once, posted, reversed, re-read when stale, refused when they cannot be true, and the
// review that stops reminders and new payments. Failure paths first.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentsMaintenanceService } from '../../../src/modules/payments/core/maintenance.service';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { PaymentRemindersService } from '../../../src/modules/payments/core/reminders.service';
import { PaymentWebhooksService } from '../../../src/modules/payments/core/webhooks.service';
import { coverageLostTaskRef } from '../../../src/modules/payments/core/refunds.service';
import { ErasureService } from '../../../src/modules/privacy';
import { SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { TestApp, makeApp } from '../../support/auth';
import { closeCatalogue } from '../../support/catalogue';
import { cleanBookingEvents } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import {
  PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, paymentsStaff, sendWebhook, sim, simulatorAccount,
} from '../../support/payments';
import { balancesOf, connect, ledgerOf } from '../../support/ledger';

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
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const check = (bookingId: string) => t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] });
const statusOf = async (id: string) => (await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const refundEvent = (ref: string, over: Parameters<typeof sim.refundEvent>[3] = {}) => sim.refundEvent(acc.secret, acc.id, ref, over);

/** A booking whose deposit was paid through the simulator. */
async function paidDeposit() {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
  const p0 = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
  sim.settle(acc.id, p0.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, acc, await eventFor(t, acc, p0.id))).outcome).toBe('processed');
  const p = await t.prisma.payment.findUniqueOrThrow({ where: { id: p0.id } });
  return { reference, bookingId, p };
}

describe('refund_initiated_outside_app_recorded_once (plan 0.1, P5)', () => {
  it('a dashboard refund, already succeeded, sent twice under two event ids: one refund, one posting, one task; the booking keeps its status', async () => {
    const { bookingId, p } = await paidDeposit();
    const before = await statusOf(bookingId);
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, p.amountMinor);
    expect((await deliver(t, acc, refundEvent(r.ref))).outcome).toBe('processed');
    expect((await deliver(t, acc, refundEvent(r.ref))).outcome).toBe('processed');
    const refunds = await t.prisma.refund.findMany({ where: { bookingId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ origin: 'external', status: 'succeeded', amountMinor: p.amountMinor, providerRefundRef: r.ref, purpose: null, reason: null });
    expect(refunds[0]!.idempotencyKey).toBe(`refund:external:${acc.id}:${r.ref}`);
    const ledger = await ledgerOf(t, bookingId);
    expect(ledger.map((x) => x.idempotencyKey)).toEqual([`payment:${p.id}:succeeded`, `refund:${refunds[0]!.id}:succeeded`]);
    expect(ledger[1]).toEqual({ idempotencyKey: `refund:${refunds[0]!.id}:succeeded`, kind: 'refund', entries: { clearing: -p.amountMinor, customer_funds: p.amountMinor } });
    expect(await balancesOf(t, bookingId)).toEqual({ fundsMinor: 0n, overpaymentsMinor: 0n, receivableMinor: 0n });
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:external_refund:${refunds[0]!.id}` } })).toBe(1);
    expect(await statusOf(bookingId)).toBe(before);
    expect(await check(bookingId)).toEqual([]);
    // Both events point at the refund.
    expect(await t.prisma.webhookEvent.count({ where: { refundId: refunds[0]!.id, status: 'processed' } })).toBe(2);
  });
});

describe('booking under review after money out (plan 3.3, 12.3)', () => {
  it('coverage_lost_blocks_new_attempt and coverage_lost_suppresses_reminders, until Oscar closes the task', async () => {
    const { reference, bookingId, p } = await paidDeposit();
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 1000n);
    expect((await deliver(t, acc, refundEvent(r.ref))).outcome).toBe('processed');
    const task = await t.prisma.task.findFirstOrThrow({ where: { sourceRef: coverageLostTaskRef(bookingId), status: 'open' } });
    const res = await c.pay(reference, { method: 'card' });
    expect([res.status, res.body.code]).toEqual([409, 'booking_payment_under_review']);
    expect(await t.prisma.payment.count({ where: { bookingId } })).toBe(1);
    const item = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId, state: 'active', kind: 'balance' } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
    expect(await t.app.get(PaymentRemindersService).remind(item.id, bookingId, [14, 7, 3], today)).toBe('payment_under_review');
    // Oscar closes the task: payments are possible again (here the 1 000 that went out).
    await t.prisma.task.update({ where: { id: task.id }, data: { status: 'done' } });
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const again = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
    expect(again.amountMinor).toBe(1000n);
  });

  it('a refund of only the overpaid part puts nothing under review', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const first = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    await deliver(t, acc, await eventFor(t, acc, first.id, { status: 'failed' }));
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const second = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
    sim.settle(acc.id, second.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, second.id));
    sim.settle(acc.id, first.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, first.id));
    const over = (await balancesOf(t, bookingId)).overpaymentsMinor;
    expect(over).toBeGreaterThan(0n);
    const r = sim.gatewayRefund(acc.id, first.providerPaymentRef!, over);
    expect((await deliver(t, acc, refundEvent(r.ref))).outcome).toBe('processed');
    const refund = await t.prisma.refund.findFirstOrThrow({ where: { bookingId } });
    expect((await ledgerOf(t, bookingId)).at(-1)!.entries).toEqual({ clearing: -over, customer_overpayments: over });
    expect(await t.prisma.task.count({ where: { sourceRef: coverageLostTaskRef(bookingId) } })).toBe(0);
    expect(refund.status).toBe('succeeded');
    expect(await check(bookingId)).toEqual([]);
  });
});

describe('refund states (plan 0.1, 6.2)', () => {
  it('pending, then succeeded: posted only once it succeeds', async () => {
    const { bookingId, p } = await paidDeposit();
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 2000n, 'pending');
    await deliver(t, acc, refundEvent(r.ref));
    expect((await t.prisma.refund.findFirstOrThrow({ where: { bookingId } })).status).toBe('pending');
    expect(await ledgerOf(t, bookingId)).toHaveLength(1);
    sim.settleRefund(acc.id, r.ref, 'succeeded');
    await deliver(t, acc, refundEvent(r.ref));
    expect((await t.prisma.refund.findFirstOrThrow({ where: { bookingId } })).status).toBe('succeeded');
    expect(await ledgerOf(t, bookingId)).toHaveLength(2);
    // An older "pending" arriving late changes nothing.
    await deliver(t, acc, refundEvent(r.ref, { status: 'pending' }));
    expect((await t.prisma.refund.findFirstOrThrow({ where: { bookingId } })).status).toBe('succeeded');
  });

  it('refund_failed_after_success_treated_as_reversal: confirmed by the gateway, reversed with its own posting', async () => {
    const { bookingId, p } = await paidDeposit();
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 3000n);
    await deliver(t, acc, refundEvent(r.ref));
    // An event that says "failed" while the gateway still says succeeded is not believed.
    await deliver(t, acc, refundEvent(r.ref, { status: 'failed' }));
    expect((await t.prisma.refund.findFirstOrThrow({ where: { bookingId } })).status).toBe('succeeded');
    sim.settleRefund(acc.id, r.ref, 'failed', 'bank_rejected');
    await deliver(t, acc, refundEvent(r.ref));
    const refund = await t.prisma.refund.findFirstOrThrow({ where: { bookingId } });
    expect(refund.status).toBe('reversed');
    const rev = await t.prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `refund:${refund.id}:reversed` } });
    const orig = await t.prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: `refund:${refund.id}:succeeded` } });
    expect([rev.kind, rev.reversesTransactionId]).toEqual(['reversal', orig.id]);
    expect((await ledgerOf(t, bookingId)).at(-1)!.entries).toEqual({ clearing: 3000n, customer_funds: -3000n });
    expect(await balancesOf(t, bookingId)).toEqual({ fundsMinor: p.amountMinor, overpaymentsMinor: 0n, receivableMinor: 0n });
    expect(await check(bookingId)).toEqual([]);
  });

  it('refund_pending_requeried: a refund still pending after a day is read again by the sweep', async () => {
    const { bookingId, p } = await paidDeposit();
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 1500n, 'pending');
    await deliver(t, acc, refundEvent(r.ref));
    const refund = await t.prisma.refund.findFirstOrThrow({ where: { bookingId } });
    sim.settleRefund(acc.id, r.ref, 'succeeded');
    // Its event is lost; a day passes.
    const db = await connect('owner');
    await db.query(`UPDATE refunds SET "updatedAt" = now() - interval '25 hours' WHERE id = $1::uuid`, [refund.id]);
    await db.end();
    const run = await t.app.get(PaymentsMaintenanceService).run();
    expect(run.refundsRequeried).toContain(refund.id);
    expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('succeeded');
    expect(await t.prisma.ledgerTransaction.count({ where: { idempotencyKey: `refund:${refund.id}:succeeded` } })).toBe(1);
  });
});

describe('refund events that are not posted (plan 3.3, 3.3 and 12.6)', () => {
  it('stale_pending_refund_does_not_block_a_real_refund: a local pending refund the gateway failed is re-read before the cap', async () => {
    const { bookingId, p } = await paidDeposit();
    const a = sim.gatewayRefund(acc.id, p.providerPaymentRef!, p.amountMinor, 'pending');
    await deliver(t, acc, refundEvent(a.ref));
    // The gateway fails A but its event is lost; staff then refund the whole payment on the dashboard.
    sim.settleRefund(acc.id, a.ref, 'failed');
    const b = sim.gatewayRefund(acc.id, p.providerPaymentRef!, p.amountMinor);
    expect((await deliver(t, acc, refundEvent(b.ref))).outcome).toBe('processed');
    const rows = await t.prisma.refund.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.providerRefundRef, r.status])).toEqual([[a.ref, 'failed'], [b.ref, 'succeeded']]);
    expect(await balancesOf(t, bookingId)).toEqual({ fundsMinor: 0n, overpaymentsMinor: 0n, receivableMinor: 0n });
  });

  it('refund_over_payment_not_posted and refund_currency_mismatch_not_posted: ignored with a code and a task', async () => {
    const { bookingId, p } = await paidDeposit();
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 500n);
    for (const [over, code] of [[{ amountMinor: p.amountMinor + 1n }, 'refund_over_payment'], [{ currency: 'NZD' }, 'refund_currency_mismatch']] as const) {
      const w = refundEvent(r.ref, over);
      expect((await deliver(t, acc, w)).outcome).toBe('ignored');
      const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: w.eventId } } });
      expect(ev.errorCode).toBe(code);
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:refund_refused:${ev.id}` } })).toBe(1);
    }
    expect(await t.prisma.refund.count({ where: { bookingId } })).toBe(0);
    expect(await ledgerOf(t, bookingId)).toHaveLength(1);
  });

  it('refund_event_before_payment_success_syncs_payment_first', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    // The payment's own event never arrived; a refund's does.
    sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 700n);
    expect((await deliver(t, acc, refundEvent(r.ref))).outcome).toBe('processed');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('succeeded');
    // Both in one database transaction (same occurredAt): the payment's posting and the refund's.
    expect((await ledgerOf(t, bookingId)).map((x) => x.kind).sort()).toEqual(['payment', 'refund']);
    expect(await check(bookingId)).toEqual([]);
  });

  it('webhook_metadata_id_from_other_account_not_matched (refunds): another account cannot name our payment', async () => {
    const { bookingId, p } = await paidDeposit();
    const other = await simulatorAccount(t);
    await t.prisma.providerAccount.update({ where: { id: other.id }, data: { status: 'paused' } });
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 400n);
    // The same body, signed for the other account: it does not know the payment.
    const w = sim.refundEvent(other.secret, acc.id, r.ref);
    expect((await sendWebhook(t, other, w)).status).toBe(200);
    const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: other.id, providerEventId: w.eventId } } });
    expect(await t.app.get(PaymentWebhooksService).process(ev.id)).toBe('ignored');
    expect((await t.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).errorCode).toBe('unknown_payment');
    expect(await t.prisma.refund.count({ where: { bookingId } })).toBe(0);
  });

  it('a gateway error while reading the payment leaves the event failed and retryable, never ignored', async () => {
    const { bookingId, p } = await paidDeposit();
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 600n);
    const w = refundEvent(r.ref);
    expect((await sendWebhook(t, acc, w)).status).toBe(200);
    const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: w.eventId } } });
    sim.failNextRetrieve(acc.id, 'unavailable');
    await expect(t.app.get(PaymentWebhooksService).process(ev.id)).rejects.toBeTruthy();
    expect((await t.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('failed');
    expect(await t.app.get(PaymentWebhooksService).process(ev.id)).toBe('processed');
    expect(await t.prisma.refund.count({ where: { bookingId } })).toBe(1);
  });
});

describe('erasure and refunds (tasks 5.5 and 6.3, plan 3.3, 3.1)', () => {
  /** Sets a booking's status as the tables' owner, with the bookings triggers off for that one transaction (as 5.5's tests). */
  async function forceStatus(bookingId: string, status: 'completed'): Promise<void> {
    const db = await connect('owner');
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE bookings DISABLE TRIGGER USER');
      await db.query(`UPDATE bookings SET status = $2::"BookingStatus" WHERE id = $1::uuid`, [bookingId, status]);
      await db.query('ALTER TABLE bookings ENABLE TRIGGER USER');
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      await db.end();
    }
  }
  const reason = (customerId: string) => t.app.get(ErasureService).blockedBy(t.prisma, customerId);
  const customerOf = async (bookingId: string) => (await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).customerId;

  it('pending_refund_blocks_erasure, then erasure_keeps_ledger_and_clears_refund_reason once it settles', async () => {
    const keepC = c;
    c = await payingCustomer(t); // only this booking can block the erasure
    try {
      const { bookingId, p } = await paidDeposit();
      const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 1000n, 'pending');
      await deliver(t, acc, refundEvent(r.ref));
      await forceStatus(bookingId, 'completed');
      const customerId = await customerOf(bookingId);
      // Only the refund in progress blocks it now (the booking is closed and collected no more than its total).
      expect(await reason(customerId)).toBe('live_payment');
      await expect(t.app.get(ErasureService).erase(customerId, SYSTEM_ACTOR)).rejects.toMatchObject({ code: 'erasure_rejected_with_active_trip' });
      sim.settleRefund(acc.id, r.ref, 'succeeded');
      await deliver(t, acc, refundEvent(r.ref));
      expect(await reason(customerId)).toBeNull();
      const ledgerBefore = await ledgerOf(t, bookingId);
      expect((await t.app.get(ErasureService).erase(customerId, SYSTEM_ACTOR)).status).toBe('completed');
      // The ledger is kept as it was; the refund keeps its money facts and has no reason left.
      expect(await ledgerOf(t, bookingId)).toEqual(ledgerBefore);
      expect(await t.prisma.refund.findFirstOrThrow({ where: { bookingId } })).toMatchObject({ status: 'succeeded', amountMinor: 1000n, reason: null });
    } finally {
      c = keepC;
    }
  });

  it('a credit is what was collected net of refunds: a dashboard refund of the overpaid part lets erasure go ahead', async () => {
    const keepC = c;
    c = await payingCustomer(t);
    try {
      const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
      expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
      const first = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
      await deliver(t, acc, await eventFor(t, acc, first.id, { status: 'failed' }));
      expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
      const second = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
      sim.settle(acc.id, second.providerPaymentRef!, 'succeeded');
      await deliver(t, acc, await eventFor(t, acc, second.id));
      sim.settle(acc.id, first.providerPaymentRef!, 'succeeded');
      await deliver(t, acc, await eventFor(t, acc, first.id));
      const total = (await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).totalMinor;
      const over = first.amountMinor + second.amountMinor - total;
      expect(over).toBeGreaterThan(0n);
      await forceStatus(bookingId, 'completed');
      const customerId = await customerOf(bookingId);
      expect(await reason(customerId)).toBe('refund_may_be_due');
      // Part of the credit back: still owed.
      const part = sim.gatewayRefund(acc.id, first.providerPaymentRef!, over - 1n);
      await deliver(t, acc, refundEvent(part.ref));
      expect(await reason(customerId)).toBe('refund_may_be_due');
      // The rest: nothing is owed any more.
      const rest = sim.gatewayRefund(acc.id, first.providerPaymentRef!, 1n);
      await deliver(t, acc, refundEvent(rest.ref));
      expect(await reason(customerId)).toBeNull();
    } finally {
      c = keepC;
    }
  });
});

describe('refund failures are believed only when the gateway confirms them (plan 0.1, 6.2)', () => {
  it('a "failed" event for a refund the gateway does not know leaves the event failed and the refund as it was', async () => {
    const { bookingId, p } = await paidDeposit();
    const r = sim.gatewayRefund(acc.id, p.providerPaymentRef!, 800n);
    await deliver(t, acc, refundEvent(r.ref));
    const w = refundEvent(r.ref, { status: 'failed' });
    expect((await sendWebhook(t, acc, w)).status).toBe(200);
    const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: w.eventId } } });
    // The gateway answers "no such refund" to the confirmation.
    sim.failNextRefundRetrieve(acc.id, 'not_found');
    await expect(t.app.get(PaymentWebhooksService).process(ev.id)).rejects.toBeTruthy();
    expect((await t.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('failed');
    expect((await t.prisma.refund.findFirstOrThrow({ where: { bookingId } })).status).toBe('succeeded');
    expect(await ledgerOf(t, bookingId)).toHaveLength(2);
  });
});
