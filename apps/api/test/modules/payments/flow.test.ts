// The payment plan and payment attempts through HTTP, the simulator and a real PostgreSQL
// (plan docs/plans/3.1-payment-provider-core.md, sections 4, 5, 7, 10 and 14).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentAttemptSyncService } from '../../../src/modules/payments/core/attempt-sync.service';
import { ProviderGateway, modeForEnv } from '../../../src/modules/payments/core/gateway';
import { PaymentRouting } from '../../../src/modules/payments/core/routing';
import { PaymentScheduleService } from '../../../src/modules/payments/core/schedule.service';
import { succeededPaymentsSource } from '../../../src/modules/payments/core/payable';
import { SIMULATOR_CHECKOUT_ORIGIN } from '../../../src/modules/payments/adapters/simulator/simulator';
import { TestApp, makeApp } from '../../support/auth';
import { closeCatalogue } from '../../support/catalogue';
import { cleanBookingEvents, makeBookingFor } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import {
  PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, expireNow, insertValidSchedule, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount,
} from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let w: PricedWorld;
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  w = await pricedWorld(admin);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const booking = (ref: string) => t.prisma.booking.findUniqueOrThrow({ where: { reference: ref } });
const paymentsOf = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
const fresh = async () => approvedBooking(t, admin, await pricedWorld(admin), c);
const sync = () => t.app.get(PaymentAttemptSyncService);

/** A booking of customer c with a chosen total and deposit (written like makeBookingFor), approved through the API. */
async function smallDepositBooking(depositMinor: bigint, totalMinor: bigint): Promise<{ reference: string; bookingId: string }> {
  const ww = await pricedWorld(admin);
  // The customer row exists from c's first request.
  if (!(await t.prisma.customer.findFirst({ where: { userId: c.userId } }))) await fresh();
  const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: c.userId } });
  const { bookingId } = await makeBookingFor(t, ww, customer.id);
  await t.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE bookings SET "currentSnapshotVersion" = 2, "totalMinor" = $2, "depositMinor" = $3 WHERE id = $1::uuid`, bookingId, totalMinor, depositMinor);
    await tx.bookingSnapshot.create({ data: { bookingId, version: 2, kind: 'amendment', configuration: {}, priceBreakdown: {}, totalMinor, depositMinor, currency: 'AUD', priceVersionId: ww.versionId, engineVersion: 'pricing-0.0.0' } });
  });
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  const ok = await admin.post(`/admin/bookings/${bookingId}/approve`, { version: b.version });
  if (ok.status !== 200) throw new Error(`approve failed ${ok.status} ${JSON.stringify(ok.body)}`);
  return { reference: b.reference, bookingId };
}

describe('the payment plan (plan 3.1, section 4)', () => {
  it('schedule_created_atomically_with_approval: deposit and balance from the snapshot, audited and published', async () => {
    const { reference, bookingId } = await fresh();
    const b = await booking(reference);
    const plan = await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId }, include: { items: { orderBy: { sequence: 'asc' } } } });
    expect(plan.version).toBe(1);
    expect(plan.items.map((i) => [i.kind, i.sequence, i.amountMinor, i.state])).toEqual([['deposit', 1, b.depositMinor, 'active'], ['balance', 2, b.totalMinor - b.depositMinor, 'active']]);
    expect(b.depositMinor > 0n && b.totalMinor > b.depositMinor).toBe(true);
    expect(plan.items[1]!.dueDate.toISOString().slice(0, 10)).toBe(b.balanceDueDate.toISOString().slice(0, 10));
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.schedule.created', entityId: plan.id } })).toBe(1);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.schedule.created', aggregateId: plan.id } })).toBe(1);
  });

  it('schedule_failure_rolls_back_approval: a failing plan leaves the request as it was', async () => {
    const res = await c.request((await import('../../support/bookings')).requestBody(w));
    const b = await booking(res.body.reference as string);
    const spy = vi.spyOn(t.app.get(PaymentScheduleService), 'onApprove').mockRejectedValueOnce(new Error('boom'));
    const r = await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version });
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect((await booking(b.reference)).status).toBe('requested');
    expect(await t.prisma.paymentSchedule.count({ where: { bookingId: b.id } })).toBe(0);
  });

  it('approved_without_schedule_rejected_at_commit and schedule_items_sum_equals_booking_total (SQL nets)', async () => {
    const { bookingId } = await makeBookingFor(t, w);
    const approve = `UPDATE bookings SET status = 'approved', version = version + 1, "approvedAt" = now(), "approvalExpiresAt" = now() + interval '3 days' WHERE id = $1::uuid`;
    await expect(t.prisma.$executeRawUnsafe(approve, bookingId)).rejects.toThrow(/an approved booking has a payment plan/);
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(approve, bookingId);
      await insertValidSchedule(tx, bookingId);
      await tx.$executeRawUnsafe(`UPDATE payment_schedule_items SET state = 'superseded', "supersededInVersion" = 2 WHERE "bookingId" = $1::uuid`, bookingId);
    })).rejects.toThrow(/must add up to what the booking owes/);
    await expect(t.prisma.$transaction(async (tx) => insertValidSchedule(tx, bookingId))).rejects.toThrow(/request has no payment plan/);
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('requested');
  });

  it('schedule_item_identity_immutable: an item is never edited or deleted, only superseded', async () => {
    const { bookingId } = await fresh();
    const [item] = await t.prisma.paymentScheduleItem.findMany({ where: { bookingId } });
    for (const set of [`"amountMinor" = 1`, `currency = 'NZD'`, `sequence = 9`, `"dueDate" = '2030-01-01'`, `kind = 'adjustment'`]) {
      await expect(t.prisma.$executeRawUnsafe(`UPDATE payment_schedule_items SET ${set} WHERE id = $1::uuid`, item!.id)).rejects.toThrow();
    }
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM payment_schedule_items WHERE id = $1::uuid`, item!.id)).rejects.toThrow(/never deleted/);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM payment_schedules WHERE "bookingId" = $1::uuid`, bookingId)).rejects.toThrow(/never deleted/);
  });

  it('cancellation_supersedes_schedule (and a request without a plan cancels as before)', async () => {
    const { bookingId } = await fresh();
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect((await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'Customer asked' })).status).toBe(200);
    const plan = await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId }, include: { items: true } });
    expect(plan.version).toBe(2);
    expect(plan.items.every((i) => i.state === 'superseded' && i.supersededInVersion === 2)).toBe(true);
    const req = await c.request((await import('../../support/bookings')).requestBody(w));
    const rb = await booking(req.body.reference as string);
    expect((await admin.post(`/admin/bookings/${rb.id}/cancel`, { version: rb.version, reason: 'x' })).status).toBe(200);
  });

  it('the customer sees the plan, the amounts as strings, the methods and no internal ids', async () => {
    const { reference } = await fresh();
    const b = await booking(reference);
    const res = await c.plan(reference);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reference, currency: 'AUD', payable: true, collectedMinor: '0', outstandingMinor: b.totalMinor.toString(), nextPayable: { sequence: 1, amountMinor: b.depositMinor.toString() }, methods: ['apple_pay', 'card', 'google_pay'], liveAttempt: null });
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('payment attempts (plan 3.1, section 5)', () => {
  it('starting a payment: the deposit, from the server, through the simulator, with a redirect to its hosted page', async () => {
    const { reference, bookingId } = await fresh();
    const b = await booking(reference);
    const res = await c.pay(reference, { method: 'card' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'requires_action', method: 'card', amountMinor: b.depositMinor.toString(), currency: 'AUD' });
    expect(res.body.nextAction.url.startsWith(`${SIMULATOR_CHECKOUT_ORIGIN}/`)).toBe(true);
    const [p] = await paymentsOf(bookingId);
    expect(p).toMatchObject({ attemptNumber: 1, idempotencyKey: `booking:${bookingId}:attempt:1`, mode: 'test', adapterKey: 'simulator', liveBookingId: bookingId });
    expect(p!.providerPaymentRef).toMatch(/^sim_pay_/);
    expect(sim.find(acc.id, { paymentId: p!.id })?.amount.amountMinor).toBe(b.depositMinor);
  });

  it('client_amount_field_rejected and card_data_never_reaches_api: any amount, card or URL field is a 422 and nothing is written', async () => {
    const { reference, bookingId } = await fresh();
    for (const extra of [{ amountMinor: '1' }, { cardNumber: '4242424242424242' }, { card: { cvc: '123' } }, { returnUrl: 'https://evil.test' }, { currency: 'USD' }]) {
      const res = await c.pay(reference, { method: 'card', ...extra });
      expect(res.status).toBe(422);
    }
    expect(await t.prisma.payment.count({ where: { bookingId } })).toBe(0);
  });

  it('single_payment_covers_deposit_and_balance: up to the balance is the whole total', async () => {
    const { reference } = await fresh();
    const b = await booking(reference);
    const res = await c.pay(reference, { method: 'card', upToSequence: 2 });
    expect([res.status, res.body.amountMinor]).toEqual([201, b.totalMinor.toString()]);
    expect((await c.pay(reference, { method: 'card', upToSequence: 3 })).status).toBe(422);
  });

  it('same_idempotency_key_charges_once: a repeat returns the same attempt and creates nothing at the gateway', async () => {
    const { reference, bookingId } = await fresh();
    const key = randomUUID();
    const a = await c.pay(reference, { method: 'card' }, key);
    const b = await c.pay(reference, { method: 'card' }, key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.amountMinor).toBe(a.body.amountMinor);
    const ps = await paymentsOf(bookingId);
    expect(ps).toHaveLength(1);
    expect((await c.pay(reference, { method: 'apple_pay' }, key)).status).toBe(422);
  });

  it('same_key_two_bookings_isolated: one key on two bookings is two attempts, one each', async () => {
    const one = await fresh();
    const two = await fresh();
    const key = randomUUID();
    expect((await c.pay(one.reference, { method: 'card' }, key)).status).toBe(201);
    expect((await c.pay(two.reference, { method: 'card' }, key)).status).toBe(201);
    expect((await paymentsOf(one.bookingId)).length).toBe(1);
    expect((await paymentsOf(two.bookingId)).length).toBe(1);
  });

  it('concurrent_create_attempt_different_keys_one_provider_object: ten at once, one attempt and one gateway object', async () => {
    const { reference, bookingId } = await fresh();
    const objectsBefore = sim.objectCount(acc.id);
    const results = await Promise.all(Array.from({ length: 10 }, () => c.pay(reference, { method: 'card' })));
    expect(results.every((r) => r.status === 201 || (r.status === 409 && ['payment_attempt_in_progress', 'busy_try_again', 'idempotency_in_progress'].includes(r.body.code)))).toBe(true);
    const ps = await paymentsOf(bookingId);
    expect(ps).toHaveLength(1);
    // Exactly one new object at the gateway for these ten requests (review M4).
    expect(sim.objectCount(acc.id) - objectsBefore).toBe(1);
  });

  it('second_live_attempt_for_booking_rejected (and the database refuses a second live row)', async () => {
    const { reference, bookingId } = await fresh();
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const res = await c.pay(reference, { method: 'apple_pay' });
    expect([res.status, res.body.code]).toEqual([409, 'payment_attempt_in_progress']);
    const [p] = await paymentsOf(bookingId);
    // The unique index on liveBookingId is what refuses it (review M4).
    await expect(t.prisma.payment.create({ data: { ...p!, id: randomUUID(), attemptNumber: 2, idempotencyKey: `booking:${bookingId}:attempt:2`, providerPaymentRef: null, status: 'created', version: 0 } })).rejects.toThrow(/Unique constraint failed[\s\S]*liveBookingId/);
  });

  it('resume_does_not_extend_pending_expiry, and expired_unswept_attempt_not_resumed', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [before] = await paymentsOf(bookingId);
    await new Promise((r) => setTimeout(r, 20));
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const [after] = await paymentsOf(bookingId);
    expect(after!.pendingExpiresAt.getTime()).toBe(before!.pendingExpiresAt.getTime());
    await expireNow(before!.id);
    const res = await c.pay(reference, { method: 'card' });
    expect([res.status, res.body.code]).toEqual([409, 'payment_attempt_in_progress']);
    const job = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pgboss.job WHERE name = 'payments.attempts' AND data->>'paymentId' = $1 AND data->>'action' = 'expire'`, before!.id);
    expect(Number(job[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('new_attempt_after_approval_expiry_rejected', async () => {
    const { reference, bookingId } = await fresh();
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET "approvalExpiresAt" = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, bookingId);
    const res = await c.pay(reference, { method: 'card' });
    expect([res.status, res.body.code]).toEqual([409, 'approval_expired']);
    expect((await c.plan(reference)).body).toMatchObject({ payable: false, notPayableReason: 'approval_expired' });
  });

  it('attempt_on_unpayable_state_409: a request, a cancelled or declined booking take no payment', async () => {
    const req = await c.request((await import('../../support/bookings')).requestBody(w));
    expect((await c.pay(req.body.reference as string, { method: 'card' })).body.code).toBe('booking_not_payable');
    const { reference, bookingId } = await fresh();
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'x' });
    const res = await c.pay(reference, { method: 'card' });
    expect([res.status, res.body.code]).toEqual([409, 'booking_not_payable']);
  });

  it('nothing_to_pay_409: once everything is collected', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card', upToSequence: 2 });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    expect((await deliver(t, acc, await eventFor(t, acc, p!.id))).outcome).toBe('processed');
    const res = await c.pay(reference, { method: 'card' });
    expect([res.status, res.body.code]).toEqual([409, 'nothing_to_pay']);
    expect((await c.plan(reference)).body).toMatchObject({ outstandingMinor: '0', nextPayable: null, notPayableReason: 'nothing_to_pay' });
  });

  it('no_routable_account_409_without_error: with every gateway off the booking stays an unpaid approval', async () => {
    const { reference } = await fresh();
    await onlyAccount(t, null);
    try {
      expect((await c.plan(reference)).body).toMatchObject({ payable: false, notPayableReason: 'no_payment_method_available', methods: [] });
      const res = await c.pay(reference, { method: 'card' });
      expect([res.status, res.body.code]).toEqual([409, 'no_payment_method_available']);
      expect((await c.pay(reference, { method: 'bpay' })).body.code).toBe('no_payment_method_available');
    } finally {
      await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'active' } });
    }
  });

  it('provider_timeout_leaves_created_and_retry_reuses_key: one gateway object however often it is retried', async () => {
    const { reference, bookingId } = await fresh();
    sim.queue(acc.id, 'timeout_after_create');
    const key = randomUUID();
    const first = await c.pay(reference, { method: 'card' }, key);
    expect([first.status, first.body.code]).toEqual([503, 'provider_unavailable']);
    const [p] = await paymentsOf(bookingId);
    expect([p!.status, p!.providerPaymentRef]).toEqual(['created', null]);
    const again = await c.pay(reference, { method: 'card' }, key);
    expect([again.status, again.body.status]).toEqual([201, 'requires_action']);
    const other = await c.pay(reference, { method: 'card' });
    expect(other.status).toBe(201);
    const [q] = await paymentsOf(bookingId);
    expect(q!.providerPaymentRef).toBe(sim.find(acc.id, { paymentId: p!.id })!.ref);
    expect(await paymentsOf(bookingId)).toHaveLength(1);
  });

  it('provider_decline_marks_failed_and_allows_new_attempt', async () => {
    const { reference, bookingId } = await fresh();
    sim.queue(acc.id, 'decline');
    const res = await c.pay(reference, { method: 'card' });
    expect([res.status, res.body.status, res.body.nextAction]).toEqual([201, 'failed', undefined]);
    const next = await c.pay(reference, { method: 'card' });
    expect([next.status, next.body.status]).toEqual([201, 'requires_action']);
    const ps = await paymentsOf(bookingId);
    expect(ps.map((p) => [p.attemptNumber, p.status, p.failureCode])).toEqual([[1, 'failed', 'card_declined'], [2, 'requires_action', null]]);
  });

  it('customer_cannot_act_on_other_customers_booking: 404 for both routes, nothing written', async () => {
    const { reference, bookingId } = await fresh();
    const other = await payingCustomer(t);
    expect((await other.plan(reference)).status).toBe(404);
    expect((await other.pay(reference, { method: 'card' })).status).toBe(404);
    expect(await t.prisma.payment.count({ where: { bookingId } })).toBe(0);
  });
});

describe('expiry and cancellation of attempts (plan 3.1, 5.3 and 14.3)', () => {
  it('expiry_of_pending_attempt_queries_provider_first: collected at the gateway means succeeded, not expired', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    await expireNow(p!.id);
    expect(await sync().run(p!.id, 'expire')).toBe('applied');
    expect((await paymentsOf(bookingId))[0]!.status).toBe('succeeded');
  });

  it('expired_attempt_cancelled_at_provider_before_expiring', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    expect(await sync().run(p!.id, 'expire')).toBe('not_due');
    await expireNow(p!.id);
    expect(await sync().run(p!.id, 'expire')).toBe('applied');
    expect(sim.find(acc.id, { paymentId: p!.id })!.status).toBe('cancelled');
    const after = (await paymentsOf(bookingId))[0]!;
    expect([after.status, after.liveBookingId]).toEqual(['expired', null]);
  });

  it('a pending debit is never expired: the sweep leaves it for the gateway', async () => {
    const { reference, bookingId } = await fresh();
    sim.queue(acc.id, 'pending');
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    await expireNow(p!.id);
    expect(await sync().run(p!.id, 'expire')).toBe('still_pending');
    expect((await paymentsOf(bookingId))[0]!.status).toBe('pending');
    expect((await c.pay(reference, { method: 'card' })).body.code).toBe('payment_attempt_in_progress');
  });

  it('ref_less_attempt_not_expired_without_provider_confirmation (a task after 24 hours)', async () => {
    const { reference, bookingId } = await fresh();
    sim.queue(acc.id, 'timeout');
    expect((await c.pay(reference, { method: 'card' })).status).toBe(503);
    const [p] = await paymentsOf(bookingId);
    await expireNow(p!.id);
    sim.failNextRetrieve(acc.id, 'unavailable');
    await expect(sync().run(p!.id, 'expire')).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(await sync().run(p!.id, 'expire')).toBe('unresolved');
    expect((await paymentsOf(bookingId))[0]!.status).toBe('created');
    expect(await sync().run(p!.id, 'expire', new Date(Date.now() + 25 * 3_600_000))).toBe('unresolved');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:unresolved:${p!.id}`, status: 'open' } })).toBe(1);
    await sync().run(p!.id, 'expire', new Date(Date.now() + 26 * 3_600_000));
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:unresolved:${p!.id}` } })).toBe(1);
  });

  it('create_charge_vs_expire_concurrent: never two live attempts, never a 500', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    await expireNow(p!.id);
    const [r1, r2] = await Promise.allSettled([c.pay(reference, { method: 'card' }), sync().run(p!.id, 'expire')]);
    expect(r1.status === 'fulfilled' && [201, 409].includes(r1.value.status)).toBe(true);
    expect(r2.status).toBe('fulfilled');
    const res = await c.pay(reference, { method: 'card' });
    expect(res.status).toBe(201);
    const live = (await paymentsOf(bookingId)).filter((x) => x.liveBookingId !== null);
    expect(live).toHaveLength(1);
  });

  it('cancel_enqueues_live_attempt_cancellation and cancel_hook_takes_no_payment_lock', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    const locker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM payments WHERE id = $1::uuid FOR UPDATE`, [p!.id]);
      const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      const started = Date.now();
      const res = await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'Changed plans' });
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }
    const jobs = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pgboss.job WHERE name = 'payments.attempts' AND data->>'paymentId' = $1 AND data->>'action' = 'cancel'`, p!.id);
    expect(Number(jobs[0]!.n)).toBe(1);
    expect(await sync().run(p!.id, 'cancel')).toBe('applied');
    expect((await paymentsOf(bookingId))[0]!.status).toBe('cancelled');
  });

  it('no_next_action_after_booking_cancelled: the redirect is not handed out for a cancelled booking', async () => {
    const { reference, bookingId } = await fresh();
    const key = randomUUID();
    const first = await c.pay(reference, { method: 'card' }, key);
    expect(first.body.nextAction).toBeDefined();
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'x' });
    const again = await c.pay(reference, { method: 'card' }, key);
    expect(again.status).toBe(201);
    expect(again.body.nextAction).toBeUndefined();
  });

  it('cancel_with_collected_money_rejected: a booking with money in cannot be cancelled until refunds exist', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, p!.id));
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const res = await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'x' });
    expect([res.status, res.body.code]).toEqual([409, 'cancellation_needs_payments']);
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('approved');
    expect((await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId } })).version).toBe(1);
  });

  it('late_success_on_cancelled_booking_recorded_with_task', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'x' });
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    expect((await deliver(t, acc, await eventFor(t, acc, p!.id))).outcome).toBe('processed');
    expect((await paymentsOf(bookingId))[0]!.status).toBe('succeeded');
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe('cancelled');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${p!.id}` } })).toBe(1);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.booking.overpaid', aggregateId: p!.id } })).toBe(1);
  });

  it('late_success_after_new_attempt_flags_overpayment', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [p1] = await paymentsOf(bookingId);
    expect((await deliver(t, acc, await eventFor(t, acc, p1!.id, { status: 'failed' }))).outcome).toBe('processed');
    expect((await c.pay(reference, { method: 'card', upToSequence: 2 })).status).toBe(201);
    const p2 = (await paymentsOf(bookingId))[1]!;
    sim.settle(acc.id, p2.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, p2.id));
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${p2.id}` } })).toBe(0);
    // The first attempt's money arrives after all: recorded (the money wins), flagged for Oscar.
    await deliver(t, acc, await eventFor(t, acc, p1!.id, { status: 'succeeded' }));
    const ps = await paymentsOf(bookingId);
    expect(ps.map((p) => p.status)).toEqual(['succeeded', 'succeeded']);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${p1!.id}` } })).toBe(1);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.booking.overpaid', aggregateId: p1!.id } })).toBe(1);
  });
});

describe('gateway errors never end a live attempt by themselves (review G1)', () => {
  it('retrieve_error_keeps_attempt_live: a refusal while reading an existing object is a 503 and the attempt stays live', async () => {
    const { reference, bookingId } = await fresh();
    const key = randomUUID();
    expect((await c.pay(reference, { method: 'card' }, key)).status).toBe(201);
    for (const fault of ['auth_failed', 'not_found_error', 'unavailable'] as const) {
      sim.failNextRetrieve(acc.id, fault);
      const res = await c.pay(reference, { method: 'card' }, key);
      expect([res.status, res.body.code]).toEqual([503, 'provider_unavailable']);
      const [p] = await paymentsOf(bookingId);
      expect([p!.status, p!.liveBookingId]).toEqual(['requires_action', bookingId]);
    }
    // A second tab cannot start a new attempt meanwhile.
    expect((await c.pay(reference, { method: 'apple_pay' })).body.code).toBe('payment_attempt_in_progress');
    expect((await c.pay(reference, { method: 'card' }, key)).body.status).toBe('requires_action');
  });

  it('pending_attempt_not_failed_by_provider_error', async () => {
    const { reference, bookingId } = await fresh();
    sim.queue(acc.id, 'pending');
    const key = randomUUID();
    expect((await c.pay(reference, { method: 'card' }, key)).body.status).toBe('pending');
    sim.failNextRetrieve(acc.id, 'not_found_error');
    expect((await c.pay(reference, { method: 'card' }, key)).status).toBe(503);
    expect((await paymentsOf(bookingId))[0]!.status).toBe('pending');
  });

  it('idempotency key in use at the gateway: the refusal is checked by key and the existing object is used, never failed', async () => {
    const { reference, bookingId } = await fresh();
    const before = sim.objectCount(acc.id);
    sim.queue(acc.id, 'in_use_after_create');
    const res = await c.pay(reference, { method: 'card' });
    expect([res.status, res.body.status]).toEqual([201, 'requires_action']);
    expect(res.body.nextAction).toBeDefined();
    const [p] = await paymentsOf(bookingId);
    expect(p!.providerPaymentRef).toBe(sim.find(acc.id, { paymentId: p!.id })!.ref);
    expect(sim.objectCount(acc.id) - before).toBe(1);
  });

  it('a refusal on create fails the attempt only when the gateway holds nothing under our key; doubt is a 503', async () => {
    const one = await fresh();
    sim.queue(acc.id, 'auth_failed');
    expect((await c.pay(one.reference, { method: 'card' })).body.status).toBe('failed');
    expect((await paymentsOf(one.bookingId))[0]).toMatchObject({ status: 'failed', failureCode: 'provider_auth_failed', liveBookingId: null });
    const two = await fresh();
    sim.queue(acc.id, 'rejected');
    sim.failNextRetrieve(acc.id, 'unavailable');
    expect((await c.pay(two.reference, { method: 'card' })).status).toBe(503);
    expect((await paymentsOf(two.bookingId))[0]).toMatchObject({ status: 'created', liveBookingId: two.bookingId });
  });

  it('late_success_of_an_ended_deposit_attempt_is_flagged_whatever_the_totals (review M1)', async () => {
    // A booking whose two deposits stay well under the total (500 on 3000), as in the review's scenario.
    const { reference, bookingId } = await smallDepositBooking(50000n, 300000n);
    await c.pay(reference, { method: 'card' });
    const [p1] = await paymentsOf(bookingId);
    await deliver(t, acc, await eventFor(t, acc, p1!.id, { status: 'failed' }));
    await c.pay(reference, { method: 'card' });
    const p2 = (await paymentsOf(bookingId))[1]!;
    sim.settle(acc.id, p2.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, p2.id));
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:late_success:${p2.id}` } })).toBe(0);
    await deliver(t, acc, await eventFor(t, acc, p1!.id, { status: 'succeeded' }));
    expect((await paymentsOf(bookingId)).map((p) => p.status)).toEqual(['succeeded', 'succeeded']);
    // No overpayment (two deposits are under the total), yet the late success is flagged.
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:overpaid:${p1!.id}` } })).toBe(0);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:late_success:${p1!.id}` } })).toBe(1);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.payment.late_succeeded', aggregateId: p1!.id } })).toBe(1);
  });

  it('resume compares the account: a paused account neither resumes nor hands out its redirect (review M3)', async () => {
    const { reference, bookingId } = await fresh();
    const key = randomUUID();
    expect((await c.pay(reference, { method: 'card' }, key)).body.nextAction).toBeDefined();
    await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'paused' } });
    try {
      const replay = await c.pay(reference, { method: 'card' }, key);
      expect([replay.status, replay.body.status, replay.body.nextAction]).toEqual([201, 'requires_action', undefined]);
      const other = await c.pay(reference, { method: 'card' });
      expect(other.status).toBe(409);
      expect(await paymentsOf(bookingId)).toHaveLength(1);
    } finally {
      await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'active' } });
    }
  });
});

describe('environments (plan 0.1, P11)', () => {
  it('production_routing_excludes_test_accounts and test_mode_payment_not_counted_in_production', async () => {
    const { reference, bookingId } = await fresh();
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    await deliver(t, acc, await eventFor(t, acc, p!.id));
    const real = t.app.get(ProviderGateway);
    const prodGateway = Object.create(real, { env: { get: () => 'production' }, mode: { get: () => modeForEnv('production') } }) as ProviderGateway;
    const routing = new PaymentRouting(prodGateway);
    expect(await t.prisma.providerAccount.count({ where: { status: 'active', mode: 'test' } })).toBeGreaterThan(0);
    expect(await routing.candidates(t.prisma, { method: 'card', currency: 'AUD', country: 'AU' })).toEqual([]);
    expect(await succeededPaymentsSource.collected(t.prisma, bookingId, modeForEnv('production'))).toBe(0n);
    expect(await succeededPaymentsSource.collected(t.prisma, bookingId, modeForEnv('test'))).toBe(p!.amountMinor);
  });
});

describe('limits', () => {
  it('payment_rate_limited_per_user_and_ip', async () => {
    const envs: Array<Record<string, string>> = [{ PAYMENT_ATTEMPTS_PER_HOUR_PER_USER: '2' }, { PAYMENT_ATTEMPTS_PER_HOUR_PER_IP: '2' }];
    for (const env of envs) {
      const t2 = await makeApp(env);
      try {
        const admin2 = await paymentsStaff(t2);
        const c2 = await payingCustomer(t2);
        const { reference } = await approvedBooking(t2, admin2, await pricedWorld(admin2), c2);
        const statuses: number[] = [];
        for (let i = 0; i < 3; i++) statuses.push((await c2.pay(reference, { method: 'card' })).status);
        expect(statuses).toEqual([201, 201, 429]);
      } finally {
        await cleanPayments(t2);
        await t2.close();
      }
    }
  });
});
