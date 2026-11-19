// Task 6.4: cancellations with tiered policies, the penalty and the refund (plan docs/plans/6.4-cancellation-policies.md,
// sections 6, 9, 10 and 13). Failure paths first; the money goes through the simulator and the 4.5 refund machinery.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cancellationQuoteViewSchema, paymentPlanItemViewSchema, paymentPlanViewSchema } from '@mt/shared';
import { CANCELLATION_REQUEST_HOLD_DAYS } from '../../../src/modules/bookings';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { cleanBookingEvents, customerClient, requestBody, staffCancel } from '../../support/bookings';
import type { CustomerClient } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import type { Client } from '../../support/catalogue';
import { FOUR_TIERS, activePolicy, assignPolicy, pct, setCustomerCancellations, shownPolicy } from '../../support/cancellations';
import type { TierBody } from '../../support/cancellations';
import { walkTo } from '../../support/customer-portal';
import { ledgerOf } from '../../support/ledger';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import {
  PayingCustomer, SimAccount, acceptCurrentTerms, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount,
} from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Client;
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
  await setCustomerCancellations(t, false);
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const row = (bookingId: string) => t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
const cancellationOf = (bookingId: string) => t.prisma.cancellation.findUnique({ where: { bookingId } });
const quoteOf = async (bookingId: string, operator = false) => {
  const r = await admin.get(`/admin/bookings/${bookingId}/cancellation-quote${operator ? '?operatorCancelled=true' : ''}`);
  expect(r.status).toBe(200);
  return cancellationQuoteViewSchema.parse(r.body);
};
const today = async () => (await t.prisma.$queryRaw<Array<{ d: string }>>`SELECT to_char((now() AT TIME ZONE 'Australia/Brisbane')::date, 'YYYY-MM-DD') AS d`)[0]!.d;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A real row lock on a booking, held by another connection until released (the barrier of plan 0.1, 6.3 tests). */
async function holdBooking(bookingId: string): Promise<{ release: () => Promise<void> }> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  await db.query('SELECT id FROM bookings WHERE id = $1::uuid FOR UPDATE', [bookingId]);
  return { release: async () => { await db.query('COMMIT'); await db.end(); } };
}
/** Waits until `n` sessions are waiting on a lock (pg_stat_activity), so the order is the one the test set up. */
async function waitForLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const r = await t.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
    if (r[0]!.n >= BigInt(n)) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`fewer than ${n} sessions waited on a lock`);
}

/** A priced, open package selling under a new active policy. */
async function policyWorld(tiers: TierBody[] = FOUR_TIERS): Promise<{ w: PricedWorld; policy: { id: string; digest: string } }> {
  const w = await pricedWorld(admin);
  const policy = await activePolicy(admin, tiers);
  await assignPolicy(admin, w.pkg.id, policy.id);
  return { w, policy };
}

/** The customer's request for that package, sent with the policy shown, approved by staff, terms accepted. */
async function approvedWithPolicy(who: PayingCustomer, w: PricedWorld, policy: { id: string; digest: string } | null) {
  const res = await who.request(requestBody(w, { cancellationPolicy: policy }));
  expect(res.status).toBe(201);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string } });
  expect((await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version })).status).toBe(200);
  await acceptCurrentTerms(t, who, b.reference);
  return { reference: b.reference, bookingId: b.id };
}

/** Pays through the simulator up to `upTo` (everything when absent), settled as succeeded. */
async function pay(who: PayingCustomer, reference: string, bookingId: string, upTo?: number) {
  expect((await who.pay(reference, { method: 'card', ...(upTo ? { upToSequence: upTo } : {}) })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, acc, await eventFor(t, acc, p.id))).outcome).toBe('processed');
  return t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
}

/**
 * A booking written straight to the tables that departs `days` from today (Brisbane), sold under `policyId`, with 2
 * places and a A$4,000 total, walked to `status` with its plan. Nothing is paid: the quote's policy penalty is still
 * the policy's, which is what the boundary rows check.
 */
async function departingIn(w: PricedWorld, days: number, policyId: string | null, status: 'confirmed' | 'deposit_paid' = 'confirmed') {
  const customer = await t.prisma.customer.create({ data: { email: `c-${randomUUID()}@example.test`, givenName: 'T', familyName: 'C', countryOfResidence: 'AU', source: 'panel' } });
  const departure = addDays(await today(), days);
  const id = await t.prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({
      data: {
        reference: `MT-${randomUUID().slice(0, 6).toUpperCase()}`, customerId: customer.id, kind: 'catalogue', packageId: w.pkg.id, editionId: w.edition.id, status: 'requested', currentSnapshotVersion: 1,
        departureDate: new Date(departure), returnDate: new Date(addDays(departure, 3)), currency: 'AUD', totalMinor: 400_000n, depositMinor: 100_000n, balanceDueDate: new Date(addDays(departure, -1)),
        residenceCountry: 'AU', requestedAt: new Date(), requestExpiresAt: new Date(Date.now() + 86_400_000), sourceChannel: 'panel',
        requestKeyHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), requestConfigHash: '0'.repeat(64), requestContactHmac: null,
      },
      select: { id: true },
    });
    await tx.bookingSnapshot.create({
      data: { bookingId: b.id, version: 1, kind: 'original', configuration: { rooms: [{ travellers: [{ slot: 1 }, { slot: 2 }] }] }, priceBreakdown: {}, totalMinor: 400_000n, depositMinor: 100_000n, currency: 'AUD', priceVersionId: w.versionId, engineVersion: 'pricing-0.0.0', cancellationPolicyId: policyId },
    });
    return b.id;
  });
  await walkTo(t, id, status);
  return { bookingId: id, customerId: customer.id, departure };
}

describe('cancellation_tier_boundaries: the penalty matches the policy on the exact day of each tier', () => {
  // A$4,000, 2 places: 60 d 10 %, 30 d 50 %, 14 d A$500 a person, 0 d 100 %.
  const ROWS: Array<[number, number, bigint]> = [[61, 60, 40_000n], [60, 60, 40_000n], [59, 30, 200_000n], [30, 30, 200_000n], [29, 14, 100_000n], [14, 14, 100_000n], [13, 0, 400_000n], [1, 0, 400_000n], [0, 0, 400_000n], [-1, 0, 400_000n]];
  it.each(ROWS)('%i days → the %i-day tier', async (days, tier, penalty) => {
    const { w, policy } = await policyWorld();
    const { bookingId } = await departingIn(w, days, policy.id);
    const q = await quoteOf(bookingId);
    expect([q.basis, q.daysBeforeDeparture, q.tier?.minDaysBeforeDeparture, q.policyPenaltyMinor, q.blockedReason]).toEqual(['policy', days, tier, penalty.toString(), null]);
    // And the cancellation itself records the same tier and policy penalty (staff may cancel after departure).
    const b = await row(bookingId);
    const res = await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'Boundary', quoteDigest: q.quoteDigest });
    expect(res.status).toBe(200);
    const cx = (await cancellationOf(bookingId))!;
    expect([cx.basis, cx.daysBeforeDeparture, cx.tierMinDays, cx.policyPenaltyMinor, cx.penaltyMinor, cx.waivedMinor]).toEqual(['policy', days, tier, penalty, 0n, penalty]);
  });
});

describe('cancellation_plan_becomes_penalty, posted once, and the refund through the 4.5 machinery', () => {
  it('cancellation_plan_becomes_penalty and cancellation_plan_posted_once', async () => {
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    const p = await pay(c, reference, bookingId);
    const b = await row(bookingId);
    const planBefore = await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId } });
    const q = await quoteOf(bookingId);
    // Departure is more than 60 days away: the 10 % tier, on the snapshot's total.
    const expected = (b.totalMinor * 1000n + 5000n) / 10_000n;
    expect([q.tier?.minDaysBeforeDeparture, q.penaltyMinor, q.refundableMinor, q.heldMinor]).toEqual([60, expected.toString(), (p.amountMinor - expected).toString(), p.amountMinor.toString()]);
    const res = await staffCancel(admin, bookingId, { version: b.version, reason: 'Customer asked' });
    expect([res.status, res.body.status, res.body.cancellation.penaltyMinor]).toEqual([200, 'cancelled', expected.toString()]);
    const plan = await t.prisma.paymentSchedule.findUniqueOrThrow({ where: { bookingId }, include: { items: { where: { state: 'active' } } } });
    expect(plan.version).toBe(planBefore.version + 1);
    expect(plan.items.map((i) => [i.kind, i.amountMinor, i.planVersion])).toEqual([['penalty', expected, plan.version]]);
    const cx = (await cancellationOf(bookingId))!;
    const ledger = await ledgerOf(t, bookingId);
    expect(ledger.filter((x) => x.idempotencyKey === `cancellation:${cx.id}:plan`)).toHaveLength(1);
    expect(ledger.filter((x) => x.idempotencyKey === `schedule:${bookingId}:v${plan.version}:reallocation`)).toHaveLength(0);
    expect(await t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] })).toEqual([]);
    expect(await t.prisma.task.count({ where: { sourceRef: `bookings:cancellation_refund_due:${bookingId}`, status: 'open' } })).toBe(1);
    // The cancellation refund: the amount comes from the server (no amount in the body), capped at what is refundable.
    const r = await admin.post(`/admin/payments/payments/${p.id}/refunds`, { paymentVersion: (await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).version, purpose: 'cancellation', reason: 'Cancelled, 10 % kept' }).set('Idempotency-Key', randomUUID());
    expect([r.status, r.body.amountMinor, r.body.purpose]).toEqual([201, (p.amountMinor - expected).toString(), 'cancellation']);
    expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: r.body.id } })).cancellationId).toBe(cx.id);
    const again = await admin.post(`/admin/payments/payments/${p.id}/refunds`, { paymentVersion: (await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).version, purpose: 'cancellation', reason: 'Again' }).set('Idempotency-Key', randomUUID());
    expect([again.status, again.body.code]).toEqual([409, 'cancellation_refund_cap_reached']);
    expect((await row(bookingId)).status).toBe('cancelled');
    expect(await t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] })).toEqual([]);
  });

  it('cancellation_refunds_capped_at_refundable: money that arrives after the cancellation is not a cancellation refund', async () => {
    const { w, policy } = await policyWorld([pct(0, 5000)]);
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    const a = await pay(c, reference, bookingId, 1);
    // A second attempt is started before the cancellation and succeeds after it (late money: an overpayment).
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const late = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
    const res = await staffCancel(admin, bookingId, { version: (await row(bookingId)).version, reason: 'Cancel' });
    expect(res.status).toBe(200);
    const cx = (await cancellationOf(bookingId))!;
    expect(cx.collectedMinor).toBe(a.amountMinor);
    sim.settle(acc.id, late.providerPaymentRef!, 'succeeded');
    expect((await deliver(t, acc, await eventFor(t, acc, late.id))).outcome).toBe('processed');
    const ask = async (paymentId: string, purpose: string) => admin.post(`/admin/payments/payments/${paymentId}/refunds`, { paymentVersion: (await t.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).version, purpose, reason: 'Cap test' }).set('Idempotency-Key', randomUUID());
    // Both payments asked at once: the booking lock serialises them, and together they never pass the cancellation's cap.
    const [r1, r2] = await Promise.all([ask(late.id, 'cancellation'), ask(a.id, 'cancellation')]);
    const ok = [r1, r2].filter((r) => r.status === 201);
    const total = ok.reduce((s, r) => s + BigInt(r.body.amountMinor as string), 0n);
    expect(total).toBe(cx.refundableMinor);
    for (const r of [r1, r2]) expect([201, 409]).toContain(r.status);
    // What is left beyond the cap goes back as an overpayment return.
    const rest = await ask(late.id, 'overpayment_return');
    const rest2 = rest.status === 201 ? rest : await ask(a.id, 'overpayment_return');
    expect(rest2.status).toBe(201);
    const sum = (await t.prisma.refund.findMany({ where: { bookingId, status: { in: ['requested', 'pending', 'succeeded'] } } })).reduce((s, r) => s + r.amountMinor, 0n);
    expect(sum).toBe(a.amountMinor + late.amountMinor - cx.penaltyMinor);
    expect(await t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] })).toEqual([]);
  });

  it('cancellation_refund_rejected_until_cancellations_exist: a booking without a cancellation has no cancellation refund', async () => {
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    const p = await pay(c, reference, bookingId);
    const r = await admin.post(`/admin/payments/payments/${p.id}/refunds`, { paymentVersion: p.version, purpose: 'cancellation', reason: 'Not cancelled' }).set('Idempotency-Key', randomUUID());
    expect([r.status, r.body.code]).toEqual([409, 'cancellation_refund_rejected_until_cancellations_exist']);
    const extra = await admin.post(`/admin/payments/payments/${p.id}/refunds`, { paymentVersion: p.version, purpose: 'cancellation', reason: 'x', amountMinor: '1' }).set('Idempotency-Key', randomUUID());
    expect(extra.status).toBe(422);
  });
});

describe('penalty_above_collected_is_not_charged (finding 7)', () => {
  it('a 100 % policy with only the deposit paid keeps the deposit, waives the rest and never asks for it', async () => {
    const { w, policy } = await policyWorld([pct(0, 10_000)]);
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    const dep = await pay(c, reference, bookingId, 1);
    const b = await row(bookingId);
    const res = await staffCancel(admin, bookingId, { version: b.version, reason: 'Late cancel' });
    expect(res.status).toBe(200);
    const cx = (await cancellationOf(bookingId))!;
    expect([cx.policyPenaltyMinor, cx.penaltyMinor, cx.waivedMinor, cx.refundableMinor]).toEqual([b.totalMinor, dep.amountMinor, b.totalMinor - dep.amountMinor, 0n]);
    const items = await t.prisma.paymentScheduleItem.findMany({ where: { bookingId, state: 'active' } });
    expect(items.map((i) => [i.kind, i.amountMinor])).toEqual([['penalty', dep.amountMinor]]);
    // Nothing can be paid on a cancelled booking, and its plan view (the new kind included) parses with the shared schema.
    expect((await c.pay(reference, { method: 'card' })).status).toBe(409);
    const plan = await c.plan(reference);
    expect(plan.status).toBe(200);
    expect(() => paymentPlanViewSchema.parse(plan.body)).not.toThrow();
    expect(plan.body.outstandingMinor).toBe('0');
    // cancelled_plan_view_validates: the panel's view and the customer area show the new kind with the shared schema.
    const panel = await admin.get(`/admin/payments/bookings/${bookingId}`);
    expect(panel.status).toBe(200);
    const kinds = (panel.body.schedule.items as Array<{ kind: string; state: string }>).filter((i) => i.state === 'active').map((i) => paymentPlanItemViewSchema.shape.kind.parse(i.kind));
    expect(kinds).toEqual(['penalty']);
    const area = await t.http().get(`/account/bookings/${reference}`).set('Cookie', c.cookie);
    expect(area.status).toBe(200);
    expect(() => paymentPlanViewSchema.parse(area.body.plan)).not.toThrow();
    expect(area.body.cancellation.record.penaltyMinor).toBe(dep.amountMinor.toString());
  });
});

describe('operator_cancellation_refunds_everything (review M3)', () => {
  it('staff cancelling on our side keep nothing, with a reason and step-up; customers cannot ask for it', async () => {
    const { w, policy } = await policyWorld([pct(0, 10_000)]);
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    const p = await pay(c, reference, bookingId);
    const q = await quoteOf(bookingId, true);
    expect([q.basis, q.penaltyMinor, q.refundableMinor]).toEqual(['operator_cancelled', '0', p.amountMinor.toString()]);
    const noReason = await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: (await row(bookingId)).version, reason: '', quoteDigest: q.quoteDigest, operatorCancelled: true });
    expect(noReason.status).toBe(422);
    // The operator flag is part of the quote: a quote without it does not cancel with it.
    const plain = await quoteOf(bookingId);
    const mixed = await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: (await row(bookingId)).version, reason: 'Race cancelled', quoteDigest: plain.quoteDigest, operatorCancelled: true });
    expect([mixed.status, mixed.body.code]).toEqual([409, 'cancellation_quote_changed']);
    const res = await staffCancel(admin, bookingId, { version: (await row(bookingId)).version, reason: 'Race cancelled by the organiser', operatorCancelled: true });
    expect([res.status, res.body.cancellation.basis, res.body.cancellation.refundableMinor]).toEqual([200, 'operator_cancelled', p.amountMinor.toString()]);
    const audit = await t.prisma.auditLog.findFirst({ where: { entityId: bookingId, action: 'bookings.cancellation.recorded' } });
    expect((audit!.changes as Record<string, unknown>).basis).toBeDefined();
    await setCustomerCancellations(t, true);
    try {
      const own = await t.http().post(`/account/bookings/${reference}/cancel`).set(STATE_HEADERS).set('Cookie', c.cookie).set('Idempotency-Key', randomUUID()).send({ quoteDigest: q.quoteDigest, operatorCancelled: true });
      expect(own.status).toBe(422);
    } finally {
      await setCustomerCancellations(t, false);
    }
  });
});

describe('one_cancellation_per_booking and the races around a cancellation', () => {
  it('two cancels at once (two tabs): one wins, one cancellation, the stock comes back once', async () => {
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    await pay(c, reference, bookingId);
    const before = (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.roomPoolId } })).consumed;
    const b = await row(bookingId);
    const q = await quoteOf(bookingId);
    const send = () => admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'Twice', quoteDigest: q.quoteDigest });
    const rs = await Promise.all([send(), send()]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.prisma.cancellation.count({ where: { bookingId } })).toBe(1);
    expect((await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.roomPoolId } })).consumed).toBeLessThan(before);
    expect(await t.prisma.inventoryMovement.count({ where: { bookingId, reason: 'release' } })).toBeGreaterThan(0);
    const released = await t.prisma.inventoryMovement.count({ where: { bookingId, reason: 'release' } });
    expect((await send()).status).toBe(409);
    expect(await t.prisma.inventoryMovement.count({ where: { bookingId, reason: 'release' } })).toBe(released);
  });

  it('cancellation_vs_payment_success_concurrent: the cancel holds the booking first, the webhook waits, its money is an overpayment', async () => {
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    await pay(c, reference, bookingId, 1);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const live = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
    sim.settle(acc.id, live.providerPaymentRef!, 'succeeded');
    const hookEvent = await eventFor(t, acc, live.id);
    const q = await quoteOf(bookingId);
    const version = (await row(bookingId)).version;
    // A barrier on the real row lock: the cancel queues first, then the webhook; PostgreSQL grants them in that order.
    const gate = await holdBooking(bookingId);
    const cancel = admin.post(`/admin/bookings/${bookingId}/cancel`, { version, reason: 'Race', quoteDigest: q.quoteDigest }).then((r) => r);
    await waitForLockWaiters(1);
    const hook = deliver(t, acc, hookEvent);
    await waitForLockWaiters(2);
    await gate.release();
    const [cr, hr] = await Promise.all([cancel, hook]);
    expect([cr.status, hr.outcome]).toEqual([200, 'processed']);
    expect((await row(bookingId)).status).toBe('cancelled');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('succeeded');
    const cx = (await cancellationOf(bookingId))!;
    // The late money is not what the cancellation counted: it is an overpayment above the cancellation's refundable.
    const view = await admin.get(`/admin/payments/bookings/${bookingId}/refunds`);
    const late = (view.body.refundable as Array<{ paymentId: string; refundableMinor: string }>).find((r) => r.paymentId === live.id)!;
    expect(BigInt(late.refundableMinor)).toBe(live.amountMinor);
    expect(cx.collectedMinor).toBeLessThan(cx.collectedMinor + live.amountMinor);
    expect(await t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] })).toEqual([]);
  });

  it('cancellation_vs_amendment_concurrent: a change and a cancellation at once; one wins, the other is a 409', async () => {
    const { amendableBookingOf, setCustomerAmendments } = await import('../../support/amendments');
    const session = await customerClient(t);
    const { reference, bookingId, body } = await amendableBookingOf(t, session);
    try {
      const preview = await t.http().post(`/account/bookings/${reference}/amendments/preview`).set(STATE_HEADERS).set('Cookie', session.cookie).send(body);
      expect(preview.status).toBe(200);
      const q = await quoteOf(bookingId);
      const version = (await row(bookingId)).version;
      const gate = await holdBooking(bookingId);
      const amend = t.http().post(`/account/bookings/${reference}/amendments`).set(STATE_HEADERS).set('Cookie', session.cookie).set('Idempotency-Key', randomUUID()).send({ ...body, previewDigest: preview.body.previewDigest, acceptNewPrice: true }).then((r) => r);
      const cancel = admin.post(`/admin/bookings/${bookingId}/cancel`, { version, reason: 'Race', quoteDigest: q.quoteDigest }).then((r) => r);
      await waitForLockWaiters(2);
      await gate.release();
      const [ar, cr] = await Promise.all([amend, cancel]);
      const won = [ar, cr].filter((r) => r.status >= 200 && r.status < 300);
      expect(won).toHaveLength(1);
      expect([ar, cr].filter((r) => r.status === 409)).toHaveLength(1);
      const final = await row(bookingId);
      if (cr.status === 200) {
        expect([final.status, await t.prisma.bookingAmendment.count({ where: { bookingId } })]).toEqual(['cancelled', 0]);
      } else {
        expect([final.status === 'cancelled', final.currentSnapshotVersion, await t.prisma.cancellation.count({ where: { bookingId } })]).toEqual([false, 2, 0]);
      }
    } finally {
      await setCustomerAmendments(t, false);
    }
  });
});

describe('cancellation_blocked_while_money_moves and the blocked request keeping its date (review M4)', () => {
  it('a debit pending at the bank blocks the cancellation; the first attempt is recorded once, with a task', async () => {
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    await pay(c, reference, bookingId, 1);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const live = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
    sim.settle(acc.id, live.providerPaymentRef!, 'pending');
    expect((await deliver(t, acc, await eventFor(t, acc, live.id, { status: 'pending' }))).outcome).toBe('processed');
    expect((await quoteOf(bookingId)).blockedReason).toBe('cancellation_blocked_by_pending_payment');
    for (let i = 0; i < 2; i++) {
      const res = await staffCancel(admin, bookingId, { version: (await row(bookingId)).version, reason: 'Wants out' });
      expect([res.status, res.body.code]).toEqual([409, 'cancellation_blocked_by_pending_payment']);
    }
    const reqs = await t.prisma.cancellationRequest.findMany({ where: { bookingId } });
    expect(reqs.map((r) => [r.requestedBy, r.blockedReason, r.businessDate.toISOString().slice(0, 10)])).toEqual([['staff', 'cancellation_blocked_by_pending_payment', await today()]]);
    expect(await t.prisma.task.count({ where: { sourceRef: `bookings:cancellation_requested:${bookingId}:${await today()}` } })).toBe(1);
    expect(await t.prisma.cancellation.count({ where: { bookingId } })).toBe(0);
  });

  it.each(['app refund requested', 'app refund pending', 'external refund pending', 'late pending at the gateway'] as const)('cancellation_blocked_by_refund_in_progress: %s', async (kind) => {
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    const p = await pay(c, reference, bookingId);
    const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await db.connect();
    try {
      const id = randomUUID();
      const external = kind === 'external refund pending';
      await db.query(`INSERT INTO refunds (id, "paymentId", "bookingId", "providerAccountId", mode, currency, "amountMinor", origin, purpose, reason, status, "idempotencyKey", "providerRefundRef", "requestedById", "updatedAt")
        SELECT $2::uuid, p.id, p."bookingId", p."providerAccountId", p.mode, p.currency, 1, $3::"RefundOrigin", $4::"RefundPurpose", 'In flight', $5::"RefundStatus", 'refund:test:' || $2, $6, $7::uuid, now() FROM payments p WHERE p.id = $1::uuid`,
        [p.id, id, external ? 'external' : 'app', external ? null : 'overpayment_return', external ? 'pending' : 'requested', external ? `ext_${id}` : null, external ? null : (await t.prisma.user.findFirstOrThrow({ where: { kind: 'staff' } })).id]);
      if (kind === 'app refund pending') await db.query(`UPDATE refunds SET status = 'pending', "providerRefundRef" = 'sim_ref_' || id::text, version = version + 1 WHERE id = $1::uuid`, [id]);
      if (kind === 'late pending at the gateway') await db.query(`UPDATE refunds SET status = 'failed', "failureCode" = 'late_pending_at_gateway', version = version + 1 WHERE id = $1::uuid`, [id]);
    } finally {
      await db.end();
    }
    expect((await quoteOf(bookingId)).blockedReason).toBe('cancellation_blocked_by_refund_in_progress');
    const res = await staffCancel(admin, bookingId, { version: (await row(bookingId)).version, reason: 'In flight' });
    expect([res.status, res.body.code]).toEqual([409, 'cancellation_blocked_by_refund_in_progress']);
    expect(await t.prisma.cancellation.count({ where: { bookingId } })).toBe(0);
  });

  it('blocked_again_after_window_starts_new_request; inside the window the task comes back, the date stays (review of the code, 2)', async () => {
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    await pay(c, reference, bookingId, 1);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const live = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
    sim.settle(acc.id, live.providerPaymentRef!, 'pending');
    expect((await deliver(t, acc, await eventFor(t, acc, live.id, { status: 'pending' }))).outcome).toBe('processed');
    // A request from long ago, whose window has run out.
    const old = addDays(await today(), -(CANCELLATION_REQUEST_HOLD_DAYS + 16));
    await requestOn(bookingId, old);
    const block = async () => expect((await staffCancel(admin, bookingId, { version: (await row(bookingId)).version, reason: 'Again' })).body.code).toBe('cancellation_blocked_by_pending_payment');
    await block();
    const dates = async () => (await t.prisma.cancellationRequest.findMany({ where: { bookingId }, orderBy: { businessDate: 'asc' } })).map((r) => r.businessDate.toISOString().slice(0, 10));
    expect(await dates()).toEqual([old, await today()]);
    const ref = `bookings:cancellation_requested:${bookingId}:${await today()}`;
    expect(await t.prisma.task.count({ where: { sourceRef: ref, status: 'open' } })).toBe(1);
    // Oscar closes the task; the customer asks again within the window: no new request, the task is open again.
    await t.prisma.task.updateMany({ where: { sourceRef: ref }, data: { status: 'done' } });
    await block();
    expect(await dates()).toEqual([old, await today()]);
    expect(await t.prisma.task.count({ where: { sourceRef: ref, status: 'open' } })).toBe(1);
  });

  const requestOn = (bookingId: string, date: string) => t.prisma.$executeRawUnsafe(
    `INSERT INTO cancellation_requests (id, "bookingId", "requestedBy", "requestedById", "businessDate", "blockedReason", "quoteDigest") VALUES (gen_random_uuid(), $1::uuid, 'customer', gen_random_uuid(), $2::date, 'cancellation_blocked_by_pending_payment', repeat('a', 64))`, bookingId, date);

  it('blocked_cancellation_keeps_request_date_within_window: the tier of the day it was asked', async () => {
    const { w, policy } = await policyWorld();
    // 29 days away today (the 14-day tier); asked 1 day ago, when it was 30 days away (the 30-day tier).
    const { bookingId } = await departingIn(w, 29, policy.id);
    await requestOn(bookingId, addDays(await today(), -1));
    const q = await quoteOf(bookingId);
    expect([q.effectiveDate, q.daysBeforeDeparture, q.tier?.minDaysBeforeDeparture]).toEqual([addDays(await today(), -1), 30, 30]);
    expect((await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: (await row(bookingId)).version, reason: 'Kept date', quoteDigest: q.quoteDigest })).status).toBe(200);
    const cx = (await cancellationOf(bookingId))!;
    expect([cx.tierMinDays, cx.businessDate.toISOString().slice(0, 10), cx.processedDate.toISOString().slice(0, 10), cx.cancellationRequestId !== null]).toEqual([30, addDays(await today(), -1), await today(), true]);
  });

  it('blocked_cancellation_after_window_uses_processing_date', async () => {
    const { w, policy } = await policyWorld();
    const { bookingId } = await departingIn(w, 29, policy.id);
    await requestOn(bookingId, addDays(await today(), -(CANCELLATION_REQUEST_HOLD_DAYS + 1)));
    const q = await quoteOf(bookingId);
    expect([q.effectiveDate, q.tier?.minDaysBeforeDeparture]).toEqual([await today(), 14]);
    expect((await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: (await row(bookingId)).version, reason: 'Late', quoteDigest: q.quoteDigest })).status).toBe(200);
    expect((await cancellationOf(bookingId))!.cancellationRequestId).toBeNull();
  });

  it('staff_cancels_with_open_dispute_excluding_disputed_amount; the customer stays blocked and is recorded', async () => {
    const who = await payingCustomer(t);
    const { w, policy } = await policyWorld([pct(0, 5000)]);
    const { reference, bookingId } = await approvedWithPolicy(who, w, policy);
    const dep = await pay(who, reference, bookingId, 1);
    const bal = await pay(who, reference, bookingId);
    const d = sim.openDispute(acc.id, bal.providerPaymentRef!);
    expect((await deliver(t, acc, sim.disputeEvent(acc.secret, acc.id, d.ref))).outcome).toBe('processed');
    await setCustomerCancellations(t, true);
    try {
      const cq = await t.http().get(`/account/bookings/${reference}/cancellation-quote`).set('Cookie', who.cookie);
      expect(cq.body.blockedReason).toBe('cancellation_blocked_by_dispute');
      const key = randomUUID();
      const own = await t.http().post(`/account/bookings/${reference}/cancel`).set(STATE_HEADERS).set('Cookie', who.cookie).set('Idempotency-Key', key).send({ quoteDigest: cq.body.quoteDigest });
      expect([own.status, own.body.code]).toEqual([409, 'cancellation_blocked_by_dispute']);
      // The same key again after a refused attempt: the same answer, never "in progress" or a stored success.
      const again = await t.http().post(`/account/bookings/${reference}/cancel`).set(STATE_HEADERS).set('Cookie', who.cookie).set('Idempotency-Key', key).send({ quoteDigest: cq.body.quoteDigest });
      expect([again.status, again.body.code]).toEqual([409, 'cancellation_blocked_by_dispute']);
      expect(await t.prisma.cancellationRequest.count({ where: { bookingId } })).toBe(1);
      expect((await t.prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId } })).requestedBy).toBe('customer');
    } finally {
      await setCustomerCancellations(t, false);
    }
    const q = await quoteOf(bookingId);
    expect([q.blockedReason, q.heldMinor]).toEqual([null, dep.amountMinor.toString()]);
    expect((await staffCancel(admin, bookingId, { version: (await row(bookingId)).version, reason: 'Disputed' })).status).toBe(200);
    const cx = (await cancellationOf(bookingId))!;
    const b = await row(bookingId);
    const half = (b.totalMinor * 5000n + 5000n) / 10_000n;
    expect([cx.collectedMinor, cx.penaltyMinor]).toEqual([dep.amountMinor, half < dep.amountMinor ? half : dep.amountMinor]);
    // The request kept its date for the cancellation staff made.
    expect(cx.cancellationRequestId).not.toBeNull();
  });
});

describe('customer cancellations', () => {
  const quoteFor = (who: CustomerClient, reference: string) => t.http().get(`/account/bookings/${reference}/cancellation-quote`).set('Cookie', who.cookie);
  const cancelAs = (who: CustomerClient, reference: string, quoteDigest: string, key = randomUUID()) => t.http().post(`/account/bookings/${reference}/cancel`).set(STATE_HEADERS).set('Cookie', who.cookie).set('Idempotency-Key', key).send({ quoteDigest });

  it('customer_cancellation_disabled_by_default and customer_cancellation_rejected_until_policies_exist (finding 5)', async () => {
    const who = await payingCustomer(t);
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(who, w, policy);
    await pay(who, reference, bookingId);
    const q = await quoteFor(who, reference);
    expect([q.status, q.body.blockedReason]).toEqual([200, 'customer_cancellation_disabled']);
    expect((await cancelAs(who, reference, q.body.quoteDigest)).body.code).toBe('customer_cancellation_disabled');
    // Sold without a policy: the customer is sent to us even with online cancellations on.
    const w2 = await pricedWorld(admin);
    const other = await approvedWithPolicy(who, w2, null);
    await pay(who, other.reference, other.bookingId);
    await setCustomerCancellations(t, true);
    try {
      const q2 = await quoteFor(who, other.reference);
      expect(q2.body.blockedReason).toBe('customer_cancellation_rejected_until_policies_exist');
      expect([(await cancelAs(who, other.reference, q2.body.quoteDigest)).status, (await row(other.bookingId)).status]).toEqual([409, 'confirmed']);
    } finally {
      await setCustomerCancellations(t, false);
    }
  });

  it('customer cancels once per key, with the digest of the quote seen; a stale digest is refused (customer_cancellation_quote_digest_mismatch_rejected)', async () => {
    const who = await payingCustomer(t);
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(who, w, policy);
    await pay(who, reference, bookingId, 1);
    await setCustomerCancellations(t, true);
    try {
      const q = await quoteFor(who, reference);
      expect(q.body.blockedReason).toBeNull();
      // Money arrives between the quote and the cancel: what it means changed.
      await pay(who, reference, bookingId);
      const stale = await cancelAs(who, reference, q.body.quoteDigest);
      expect([stale.status, stale.body.code]).toEqual([409, 'cancellation_quote_changed']);
      const fresh = await quoteFor(who, reference);
      const key = randomUUID();
      const done = await cancelAs(who, reference, fresh.body.quoteDigest, key);
      expect([done.status, done.body.created, done.body.cancelled.requestedBy, done.body.cancelled.basis]).toEqual([201, true, 'customer', 'policy']);
      const replay = await cancelAs(who, reference, fresh.body.quoteDigest, key);
      expect([replay.status, replay.body.created, replay.body.cancelled.id]).toEqual([200, false, done.body.cancelled.id]);
      expect(await t.prisma.cancellation.count({ where: { bookingId } })).toBe(1);
      expect((await row(bookingId)).statusReason).toBe('Cancelled by the customer online');
    } finally {
      await setCustomerCancellations(t, false);
    }
  });

  it('customer_cannot_cancel_after_departure; staff still can', async () => {
    const { w, policy } = await policyWorld();
    const { bookingId } = await departingIn(w, -1, policy.id);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { reference: true, customerId: true } });
    await setCustomerCancellations(t, true);
    try {
      const view = await t.app.get((await import('../../../src/modules/bookings')).BookingCancellationService).quote({ reference: b.reference }, 'customer');
      expect(view.blockedReason).toBe('customer_cannot_cancel_after_departure');
    } finally {
      await setCustomerCancellations(t, false);
    }
    expect((await quoteOf(bookingId)).blockedReason).toBeNull();
  });
});

describe('the policy the customer saw (review M2)', () => {
  it('request_with_stale_cancellation_policy_rejected: a package that gained, lost or changed its policy', async () => {
    const w = await pricedWorld(admin);
    const p1 = await activePolicy(admin);
    // The package has none; the request claims one.
    expect((await c.request(requestBody(w, { cancellationPolicy: p1 }))).body.code).toBe('cancellation_policy_changed');
    await assignPolicy(admin, w.pkg.id, p1.id);
    // public_policy_reflects_assignment_at_once: the API answers the new assignment at once.
    expect(await shownPolicy(t, w.pkg.id)).toEqual(p1);
    // The package gained one; the request says none (a page that still showed no policy).
    expect((await c.request(requestBody(w))).body.code).toBe('cancellation_policy_changed');
    // Another policy now; the request carries the old one, or a forged digest.
    const p2 = await activePolicy(admin, [pct(0, 2000)]);
    await assignPolicy(admin, w.pkg.id, p2.id);
    expect((await c.request(requestBody(w, { cancellationPolicy: p1 }))).body.code).toBe('cancellation_policy_changed');
    expect((await c.request(requestBody(w, { cancellationPolicy: { id: p2.id, digest: p1.digest } }))).body.code).toBe('cancellation_policy_changed');
    const ok = await c.request(requestBody(w, { cancellationPolicy: p2 }));
    expect(ok.status).toBe(201);
    const snap = await t.prisma.bookingSnapshot.findFirstOrThrow({ where: { booking: { reference: ok.body.reference as string } } });
    expect(snap.cancellationPolicyId).toBe(p2.id);
  });

  it('terms_acceptance_records_cancellation_policy_digest', async () => {
    const { w, policy } = await policyWorld();
    const res = await c.request(requestBody(w, { cancellationPolicy: policy }));
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string } });
    await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version });
    const view = await t.http().get(`/booking-requests/${b.reference}/checkout-terms`).set('Cookie', c.cookie);
    expect(view.body.cancellationPolicy).toMatchObject({ id: policy.id, digest: policy.digest });
    const without = await t.http().post(`/booking-requests/${b.reference}/terms-acceptance`).set(STATE_HEADERS).set('Cookie', c.cookie).send({ version: view.body.version, digest: view.body.digest });
    expect([without.status, without.body.code]).toEqual([409, 'cancellation_policy_changed']);
    const ok = await t.http().post(`/booking-requests/${b.reference}/terms-acceptance`).set(STATE_HEADERS).set('Cookie', c.cookie).send({ version: view.body.version, digest: view.body.digest, cancellationPolicyDigest: policy.digest });
    expect(ok.status).toBe(200);
    expect((await t.prisma.termsAcceptance.findFirstOrThrow({ where: { bookingId: b.id } })).cancellationPolicyDigest).toBe(policy.digest);
  });

  it('quote_acceptance_with_stale_cancellation_policy_rejected', async () => {
    const { linkedCustomer, makeQuote, sendQuote, crmStaff } = await import('../../support/crm');
    const staff = await crmStaff(t);
    const { client, customerId } = await linkedCustomer(t);
    const w = await pricedWorld(admin);
    const q = await sendQuote(staff, await makeQuote(staff, customerId, w));
    const policy = await activePolicy(admin);
    await assignPolicy(admin, w.pkg.id, policy.id);
    const view = await t.http().get(`/quotes/${q.reference}`).set('Cookie', client.cookie);
    expect(view.body.cancellationPolicy).toMatchObject({ id: policy.id });
    const stale = await t.http().post(`/quotes/${q.reference}/accept`).set(STATE_HEADERS).set('Cookie', client.cookie).send({});
    expect([stale.status, stale.body.code]).toEqual([409, 'cancellation_policy_changed']);
    const ok = await t.http().post(`/quotes/${q.reference}/accept`).set(STATE_HEADERS).set('Cookie', client.cookie).send({ cancellationPolicy: { id: policy.id, digest: policy.digest } });
    expect(ok.status).toBe(200);
    const snap = await t.prisma.bookingSnapshot.findFirstOrThrow({ where: { booking: { reference: ok.body.bookingReference as string } } });
    expect(snap.cancellationPolicyId).toBe(policy.id);
  });

  it('cancellation_policy_in_use and cancellation_policy_currency_mismatch through the API', async () => {
    const w = await pricedWorld(admin);
    const p = await activePolicy(admin);
    await assignPolicy(admin, w.pkg.id, p.id);
    const pol = await admin.get(`/admin/pricing/cancellation-policies/${p.id}`);
    const inUse = await admin.post(`/admin/pricing/cancellation-policies/${p.id}/archive`, { version: pol.body.version });
    expect([inUse.status, inUse.body.code]).toEqual([409, 'cancellation_policy_in_use']);
    // A policy with a fixed tier in NZD (the API takes AUD only, so it is written as the owner) cannot be given to an AUD package.
    const nzd = randomUUID();
    const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await db.connect();
    try {
      await db.query(`INSERT INTO cancellation_policies (id, name, description, currency, "updatedAt") VALUES ($1::uuid, 'NZD policy', '{"en-AU": "x"}', 'NZD', now())`, [nzd]);
      await db.query(`INSERT INTO cancellation_tiers (id, "policyId", "minDaysBeforeDeparture", "penaltyMode", "penaltyMinor", currency) VALUES (gen_random_uuid(), $1::uuid, 0, 'fixed_per_booking', 1000, 'NZD')`, [nzd]);
      await db.query(`UPDATE cancellation_policies SET status = 'active', "activatedAt" = now() WHERE id = $1::uuid`, [nzd]);
    } finally {
      await db.end();
    }
    const cur = await admin.get(`/admin/pricing/packages/${w.pkg.id}/cancellation-policy`);
    const mismatch = await admin.put(`/admin/pricing/packages/${w.pkg.id}/cancellation-policy`, { policyId: nzd, version: cur.body.version });
    expect([mismatch.status, mismatch.body.code]).toEqual([409, 'cancellation_policy_currency_mismatch']);
    expect((await admin.get(`/admin/pricing/packages/${w.pkg.id}/cancellation-policy`)).body.policyId).toBe(p.id);
  });

  it('policy_change_does_not_alter_existing_bookings: archived policies still bind what was sold under them', async () => {
    const { w, policy } = await policyWorld();
    const { bookingId } = await departingIn(w, 45, policy.id);
    const before = await quoteOf(bookingId);
    const p2 = await activePolicy(admin, [pct(0, 10_000)]);
    await assignPolicy(admin, w.pkg.id, p2.id);
    const pol = await admin.get(`/admin/pricing/cancellation-policies/${policy.id}`);
    expect((await admin.post(`/admin/pricing/cancellation-policies/${policy.id}/archive`, { version: pol.body.version })).status).toBe(200);
    const after = await quoteOf(bookingId);
    expect([after.policy?.id, after.policyPenaltyMinor, after.tier?.minDaysBeforeDeparture]).toEqual([policy.id, before.policyPenaltyMinor, 30]);
  });
});

describe('the database keeps the rules (section 5, review m1, m4, m5, m8)', () => {
  const owner = () => new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const app = () => new pg.Client({ connectionString: process.env.DATABASE_URL });
  const code = async (db: pg.Client, sql: string, params: unknown[] = []) => {
    await db.query('BEGIN');
    try {
      await db.query(sql, params);
      await db.query('COMMIT');
      return null;
    } catch (err) {
      await db.query('ROLLBACK');
      return (err as { code?: string; message: string }).message;
    }
  };

  it('active_policy_is_immutable: tiers and terms of an active policy never change, nor is it deleted', async () => {
    const p = await activePolicy(admin);
    const db = app();
    await db.connect();
    try {
      expect(await code(db, `UPDATE cancellation_tiers SET "penaltyBps" = 1 WHERE "policyId" = $1::uuid AND "penaltyMode" = 'percent'`, [p.id])).toMatch(/never change/);
      expect(await code(db, `DELETE FROM cancellation_tiers WHERE "policyId" = $1::uuid`, [p.id])).toMatch(/never change/);
      expect(await code(db, `INSERT INTO cancellation_tiers (id, "policyId", "minDaysBeforeDeparture", "penaltyMode", "penaltyBps") VALUES (gen_random_uuid(), $1::uuid, 7, 'percent', 1)`, [p.id])).toMatch(/never change/);
      expect(await code(db, `UPDATE cancellation_policies SET name = 'x' WHERE id = $1::uuid`, [p.id])).toMatch(/never changes/);
      expect(await code(db, `DELETE FROM cancellation_policies WHERE id = $1::uuid`, [p.id])).toMatch(/never deleted/);
      const viaApi = await admin.put(`/admin/pricing/cancellation-policies/${p.id}/tiers`, { version: (await admin.get(`/admin/pricing/cancellation-policies/${p.id}`)).body.version, tiers: [pct(0, 1)] });
      expect([viaApi.status, viaApi.body.code]).toEqual([409, 'cancellation_policy_not_draft']);
    } finally {
      await db.end();
    }
  });

  it('a draft without a 0-day tier or with mixed rules cannot be activated', async () => {
    const d = (await admin.post('/admin/pricing/cancellation-policies', { name: 'Bad', description: { 'en-AU': 'x' } })).body;
    const t1 = (await admin.put(`/admin/pricing/cancellation-policies/${d.id}/tiers`, { version: d.version, tiers: [pct(30, 5000)] })).body;
    const r = await admin.post(`/admin/pricing/cancellation-policies/${d.id}/activate`, { version: t1.version });
    expect([r.status, r.body.code]).toEqual([422, 'cancellation_policy_invalid']);
    const db = app();
    await db.connect();
    try {
      expect(await code(db, `UPDATE cancellation_policies SET status = 'active', "activatedAt" = now() WHERE id = $1::uuid`, [d.id])).toMatch(/one at 0 days/);
    } finally {
      await db.end();
    }
  });

  it('archive_and_assign_policy_concurrent: an assignment holds the policy; the archive waits, then is refused', async () => {
    const p = await activePolicy(admin);
    const w = await pricedWorld(admin);
    const a = app();
    const b = app();
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await a.query(`INSERT INTO package_cancellation_policies ("packageId", currency, "policyId", "updatedAt") VALUES ($1::uuid, 'AUD', $2::uuid, now())`, [w.pkg.id, p.id]);
      const archived = code(b, `UPDATE cancellation_policies SET status = 'archived', "archivedAt" = now() WHERE id = $1::uuid`, [p.id]);
      // The archive waits on a real lock (the assignment's FOR SHARE) before the assignment commits.
      for (let i = 0; i < 100; i++) {
        const waiting = await t.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE cancellation_policies SET status%'`;
        if (waiting[0]!.n > 0n) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await a.query('COMMIT');
      expect(await archived).toMatch(/in use by a package/);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('amendment_snapshot_keeps_cancellation_policy and a request is sold only under an active policy', async () => {
    const { w, policy } = await policyWorld();
    const { bookingId } = await departingIn(w, 90, policy.id);
    const other = await activePolicy(admin);
    const db = owner();
    await db.connect();
    try {
      expect(await code(db, `INSERT INTO booking_snapshots (id, "bookingId", version, kind, configuration, "priceBreakdown", "totalMinor", "depositMinor", currency, "priceVersionId", "engineVersion", "cancellationPolicyId")
        SELECT gen_random_uuid(), "bookingId", 2, 'amendment', configuration, "priceBreakdown", "totalMinor", "depositMinor", currency, "priceVersionId", "engineVersion", $2::uuid FROM booking_snapshots WHERE "bookingId" = $1::uuid AND version = 1`, [bookingId, other.id])).toMatch(/keeps the cancellation policy/);
      const draft = (await admin.post('/admin/pricing/cancellation-policies', { name: 'Draft', description: { 'en-AU': 'x' } })).body;
      await expect(departingIn(w, 90, draft.id)).rejects.toThrow(/only under an active cancellation policy/);
    } finally {
      await db.end();
    }
  });

  it('refund_purpose_scope_enforced_by_database (m1): a cancellation refund needs its cancellation; an external one carries none', async () => {
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(c, w, policy);
    const p = await pay(c, reference, bookingId);
    await staffCancel(admin, bookingId, { version: (await row(bookingId)).version, reason: 'Scope' });
    const cx = (await cancellationOf(bookingId))!;
    const db = owner();
    await db.connect();
    const insert = (purpose: string | null, cancellationId: string | null, origin = 'app') => code(db, `INSERT INTO refunds (id, "paymentId", "bookingId", "providerAccountId", mode, currency, "amountMinor", origin, purpose, reason, status, "idempotencyKey", "cancellationId", "requestedById", "providerRefundRef", "updatedAt")
      SELECT gen_random_uuid(), p.id, p."bookingId", p."providerAccountId", p.mode, p.currency, 1, $2::"RefundOrigin", $3::"RefundPurpose", 'Scope test', 'requested', 'refund:test:' || gen_random_uuid()::text, $4::uuid, (SELECT id FROM users WHERE kind = 'staff' LIMIT 1), CASE WHEN $2 = 'external' THEN 'ext_' || gen_random_uuid()::text END, now() FROM payments p WHERE p.id = $1::uuid`, [p.id, origin, purpose, cancellationId]);
    try {
      expect(await insert('cancellation', null)).toMatch(/refunds_cancellation_check/);
      expect(await insert('overpayment_return', cx.id)).toMatch(/refunds_cancellation_check/);
      expect(await insert(null, cx.id, 'external')).toMatch(/refunds_cancellation_check/);
      // And the same external refund without a cancellation is fine: the check is about the purpose, not the origin.
      expect(await insert(null, null, 'external')).toBeNull();
      expect(await insert('price_reduction', null)).toMatch(/refunds_purpose_scope_check/);
      const otherBooking = await departingIn(w, 90, policy.id);
      await staffCancel(admin, otherBooking.bookingId, { version: (await row(otherBooking.bookingId)).version, reason: 'Other' });
      const other = (await cancellationOf(otherBooking.bookingId))!;
      expect(await insert('cancellation', other.id)).toMatch(/refunds_cancellation_fkey/);
    } finally {
      await db.end();
    }
  });

  it('a cancellation is written with its booking (m4): no record without the move, no move without the record, never edited', async () => {
    const { w, policy } = await policyWorld();
    const { bookingId } = await departingIn(w, 90, policy.id);
    const db = app();
    await db.connect();
    try {
      expect(await code(db, `UPDATE bookings SET status = 'cancelled', version = version + 1, "cancelledAt" = now() WHERE id = $1::uuid`, [bookingId])).toMatch(/cancelled with its cancellation record|must add up/);
      expect(await code(db, `INSERT INTO cancellations (id, "bookingId", currency, "requestedBy", "requestedById", "bookingStatus", "snapshotVersion", basis, "businessDate", "processedDate", "daysBeforeDeparture", "policySnapshot", "baseTotalMinor", places, "collectedMinor", "policyPenaltyMinor", "penaltyMinor", "waivedMinor", "refundableMinor")
        SELECT gen_random_uuid(), id, currency, 'staff', gen_random_uuid(), status, 1, 'operator_cancelled', current_date, current_date, 0, '{}', "totalMinor", 2, 0, 0, 0, 0, 0 FROM bookings WHERE id = $1::uuid`, [bookingId])).toMatch(/belongs to a cancelled booking/);
      // basis against the state, and the customer's limits.
      expect(await code(db, `INSERT INTO cancellations (id, "bookingId", currency, "requestedBy", "requestedById", "bookingStatus", "snapshotVersion", basis, "businessDate", "processedDate", "daysBeforeDeparture", "policySnapshot", "baseTotalMinor", places, "collectedMinor", "policyPenaltyMinor", "penaltyMinor", "waivedMinor", "refundableMinor")
        SELECT gen_random_uuid(), id, currency, 'staff', gen_random_uuid(), status, 1, 'not_contracted', current_date, current_date, 0, '{}', "totalMinor", 2, 0, 0, 0, 0, 0 FROM bookings WHERE id = $1::uuid`, [bookingId])).toMatch(/cancellations_basis_check/);
      expect(await code(db, `INSERT INTO cancellations (id, "bookingId", currency, "requestedBy", "requestedById", "bookingStatus", "snapshotVersion", basis, "businessDate", "processedDate", "daysBeforeDeparture", "policySnapshot", "baseTotalMinor", places, "collectedMinor", "policyPenaltyMinor", "penaltyMinor", "waivedMinor", "refundableMinor")
        SELECT gen_random_uuid(), id, currency, 'customer', gen_random_uuid(), status, 1, 'operator_cancelled', current_date, current_date, 0, '{}', "totalMinor", 2, 0, 0, 0, 0, 0 FROM bookings WHERE id = $1::uuid`, [bookingId])).toMatch(/cancellations_basis_check/);
      const q = await quoteOf(bookingId);
      await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: (await row(bookingId)).version, reason: 'Real', quoteDigest: q.quoteDigest });
      expect(await code(db, `UPDATE cancellations SET "penaltyMinor" = 0 WHERE "bookingId" = $1::uuid`, [bookingId])).not.toBeNull();
      expect(await code(db, `DELETE FROM cancellations WHERE "bookingId" = $1::uuid`, [bookingId])).not.toBeNull();
    } finally {
      await db.end();
    }
  });

  it('payment_plan_owes_penalty_when_cancelled: the plan of a cancelled booking adds up to its penalty at commit', async () => {
    const { w, policy } = await policyWorld();
    const { bookingId } = await departingIn(w, 90, policy.id);
    await t.prisma.$transaction(async (tx) => {
      // A record that keeps nothing, while the plan still owes the whole total: refused at commit.
      await tx.$executeRawUnsafe(`INSERT INTO cancellations (id, "bookingId", currency, "requestedBy", "requestedById", "bookingStatus", "snapshotVersion", basis, "businessDate", "processedDate", "daysBeforeDeparture", "policySnapshot", "baseTotalMinor", places, "collectedMinor", "policyPenaltyMinor", "penaltyMinor", "waivedMinor", "refundableMinor")
        SELECT gen_random_uuid(), id, currency, 'staff', gen_random_uuid(), status, 1, 'operator_cancelled', current_date, current_date, 0, '{}', "totalMinor", 2, 0, 0, 0, 0, 0 FROM bookings WHERE id = $1::uuid`, bookingId);
      await tx.$executeRawUnsafe(`UPDATE bookings SET status = 'cancelled', version = version + 1, "cancelledAt" = now() WHERE id = $1::uuid`, bookingId);
    }).then(() => { throw new Error('committed'); }, (err: Error) => expect(err.message).toMatch(/must add up to what the booking owes/));
  });

  it('bookings_cancelled_before_0038_keep_working (m8): no record, the plan owes 0, refunded and back, the old erasure rule', async () => {
    const w = await pricedWorld(admin);
    const { bookingId, customerId } = await departingIn(w, 90, null);
    // A booking cancelled before this migration has no record: written here with the new trigger switched off once.
    const db = owner();
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query('ALTER TABLE bookings DISABLE TRIGGER bookings_cancelled_has_cancellation');
      await db.query(`UPDATE payment_schedule_items SET state = 'superseded', "supersededInVersion" = 2 WHERE "bookingId" = $1::uuid AND state = 'active'`, [bookingId]);
      await db.query(`UPDATE payment_schedules SET version = 2 WHERE "bookingId" = $1::uuid`, [bookingId]);
      await db.query(`UPDATE bookings SET status = 'cancelled', version = version + 1, "cancelledAt" = now() WHERE id = $1::uuid`, [bookingId]);
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.query('ALTER TABLE bookings ENABLE TRIGGER bookings_cancelled_has_cancellation');
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
    expect(await t.prisma.cancellation.count({ where: { bookingId } })).toBe(0);
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'refunded', version = version + 1 WHERE id = $1::uuid`, bookingId);
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'cancelled', version = version + 1 WHERE id = $1::uuid`, bookingId);
    expect((await row(bookingId)).status).toBe('cancelled');
    const reason = await t.prisma.$queryRaw<Array<{ r: string | null }>>`SELECT public.privacy_active_trip_reason(${customerId}::uuid) AS r`;
    expect(reason[0]!.r).toBeNull();
  });
});

describe('erasure after a cancellation (review M1)', () => {
  const reasonFor = async (customerId: string) => (await t.prisma.$queryRaw<Array<{ r: string | null }>>`SELECT public.privacy_active_trip_reason(${customerId}::uuid) AS r`)[0]!.r;

  it('erasure_refused_while_cancellation_refund_due, then erasure_allowed_after_cancellation_refunds_settled', async () => {
    const who = await payingCustomer(t);
    const { w, policy } = await policyWorld();
    const { reference, bookingId } = await approvedWithPolicy(who, w, policy);
    const p = await pay(who, reference, bookingId);
    await staffCancel(admin, bookingId, { version: (await row(bookingId)).version, reason: 'Erase later' });
    const customerId = (await row(bookingId)).customerId;
    expect(await reasonFor(customerId)).toBe('refund_may_be_due');
    const r = await admin.post(`/admin/payments/payments/${p.id}/refunds`, { paymentVersion: (await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).version, purpose: 'cancellation', reason: 'Refund' }).set('Idempotency-Key', randomUUID());
    expect(r.status).toBe(201);
    expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('succeeded');
    // Only the penalty is held now, which the cancellation keeps: nothing is due back.
    expect((await row(bookingId)).status).toBe('cancelled');
    expect(await reasonFor(customerId)).toBeNull();
  });
});

describe('paid_cancellation_releases_places_and_promotes_waitlist (phase criterion 3)', () => {
  it('a confirmed booking cancelled gives its places back and the first on the list is offered them', async () => {
    const { soldOutWorld, joinList } = await import('../../support/waitlist');
    const s = await soldOutWorld(t, admin as never);
    const waiting = await customerClient(t);
    const entryId = await joinList(t, waiting, s.w);
    await walkTo(t, s.holderBookingId, 'confirmed');
    expect((await staffCancel(admin, s.holderBookingId, { version: (await row(s.holderBookingId)).version, reason: 'Paid booking cancelled' })).status).toBe(200);
    expect((await t.prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } })).status).toBe('offered');
  });
});

describe('penalty_independent_of_payment_method', () => {
  it('the same terms quote the same penalty whatever was started or paid, and the calculation never reads a method', async () => {
    const { w, policy } = await policyWorld([pct(0, 3333)]);
    const one = await approvedWithPolicy(c, w, policy);
    const two = await approvedWithPolicy(c, w, policy);
    expect((await c.pay(one.reference, { method: 'card' })).status).toBe(201);
    const [q1, q2] = [await quoteOf(one.bookingId), await quoteOf(two.bookingId)];
    expect(q1.policyPenaltyMinor).toBe(q2.policyPenaltyMinor);
    // The engine's input has no method at all (a structural check on the pure function).
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../src/modules/pricing/engine/cancellation.ts'), 'utf8');
    expect(src).not.toMatch(/method/i);
  });
});
