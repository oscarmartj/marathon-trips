// Refunds from the panel through a gateway (plan docs/plans/4.5-refunds-disputes.md, sections 2, 3, 7, 9 and 14), with
// the simulator. Failure paths first: what is refused, what is capped, what is never sent twice.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRefundsService, refundReviewTaskRef } from '../../../src/modules/payments/core/app-refunds.service';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { PaymentLedgerCheckService } from '../../../src/modules/payments/core/ledger-check.service';
import { coverageLostTaskRef } from '../../../src/modules/payments/core/refunds.service';
import { TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../support/bookings';
import { CATALOGUE_AND_PRICING, Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { balancesOf, connect, ledgerOf, txError } from '../../support/ledger';
import { pricedWorld } from '../../support/pricing';
import {
  ALL_PAYMENT_PERMISSIONS, PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount,
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
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const check = (bookingId: string) => t.app.get(PaymentLedgerCheckService).check({ bookingIds: [bookingId] });
const statusOf = async (id: string) => (await t.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const paymentOf = (id: string) => t.prisma.payment.findUniqueOrThrow({ where: { id } });
const refundsOf = (bookingId: string) => t.prisma.refund.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
const view = (bookingId: string, who: Client = admin) => who.get(`/admin/payments/bookings/${bookingId}/refunds`);
const refundableOf = async (bookingId: string, paymentId: string) => ((await view(bookingId)).body.refundable as Array<{ paymentId: string; refundableMinor: string; blockedReason: string | null; paymentVersion: number }>).find((r) => r.paymentId === paymentId)!;
const ask = async (paymentId: string, over: Record<string, unknown> = {}, key: string = randomUUID(), who: Client = admin) => {
  const version = over.paymentVersion ?? (await t.prisma.payment.findUnique({ where: { id: paymentId } }))?.version ?? 0;
  return who.post(`/admin/payments/payments/${paymentId}/refunds`, { paymentVersion: version, purpose: 'overpayment_return', reason: 'Paid twice by mistake', ...over }).set('Idempotency-Key', key);
};
const simRefunds = (paymentRef: string) => [...(sim as unknown as { world: { account(id: string): { refunds: Map<string, { paymentRef: string; idempotencyKey?: string }> } } }).world.account(acc.id).refunds.values()].filter((r) => r.paymentRef === paymentRef);

/** Pays through the simulator: a new attempt up to `upTo`, settled as succeeded. */
async function payNow(reference: string, bookingId: string, upTo?: number) {
  expect((await c.pay(reference, { method: 'card', ...(upTo ? { upToSequence: upTo } : {}) })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } }))[0]!;
  return p;
}

/**
 * Two payments where the first attempt succeeds late (plan 3.2): `late` is the first attempt (up to `lateUpTo`), `paid`
 * the second (up to `paidUpTo`), which succeeds first. The late one owns any overpayment.
 */
async function overpaid(lateUpTo: number | undefined, paidUpTo: number | undefined) {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const late = await payNow(reference, bookingId, lateUpTo);
  await deliver(t, acc, await eventFor(t, acc, late.id, { status: 'failed' }));
  const paid = await payNow(reference, bookingId, paidUpTo);
  sim.settle(acc.id, paid.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, acc, await eventFor(t, acc, paid.id))).outcome).toBe('processed');
  sim.settle(acc.id, late.providerPaymentRef!, 'succeeded');
  expect((await deliver(t, acc, await eventFor(t, acc, late.id))).outcome).toBe('processed');
  return { reference, bookingId, late: await paymentOf(late.id), paid: await paymentOf(paid.id) };
}

describe('what a refund request may not carry or ask (P1, P9)', () => {
  it('refund_amount_field_rejected, refund_without_reason_rejected and an unknown purpose: 422, nothing created', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    for (const body of [{ amountMinor: '100' }, { amount: 1 }, { reason: '' }, { reason: 'ok' }, { reason: 'x'.repeat(501) }, { purpose: 'goodwill' }]) {
      expect((await ask(late.id, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await t.http().post(`/admin/payments/payments/${late.id}/refunds`)).status).toBeGreaterThanOrEqual(400);
    expect(await refundsOf(bookingId)).toHaveLength(0);
  });

  it('price_reduction_refund_rejected_until_amendments_exist and cancellation_refund_rejected_until_cancellations_exist: 409', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const a = await ask(late.id, { purpose: 'price_reduction' });
    const b = await ask(late.id, { purpose: 'cancellation' });
    expect([a.status, a.body.code, b.status, b.body.code]).toEqual([409, 'price_reduction_refund_rejected_until_amendments_exist', 409, 'cancellation_refund_rejected_until_cancellations_exist']);
    expect(await refundsOf(bookingId)).toHaveLength(0);
  });

  it('refund_purpose_scope_enforced_by_database: the API role cannot write another purpose, nor an app refund without a reason', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const db = await connect('app');
    try {
      const base = [late.id, bookingId, late.providerAccountId];
      const insert = (purpose: string, reason: string | null) => txError(db, [[
        `INSERT INTO refunds (id, "paymentId", "bookingId", "providerAccountId", mode, currency, "amountMinor", origin, purpose, reason, status, "idempotencyKey", "requestedById", "updatedAt")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'test', 'AUD', 100, 'app', $4::"RefundPurpose", $5, 'requested', 'refund:app:' || gen_random_uuid()::text, $6::uuid, now())`,
        [...base, purpose, reason, (admin as unknown as { staff: { id: string } }).staff.id],
      ]]);
      expect(await insert('cancellation', 'A reason')).toBe('23514');
      expect(await insert('price_reduction', 'A reason')).toBe('23514');
      expect(await insert('overpayment_return', null)).toBe('23514');
    } finally {
      await db.end();
    }
  });

  it('refund_requires_permission_and_step_up', async () => {
    const { late } = await overpaid(2, 2);
    const stale = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
    await t.prisma.session.updateMany({ where: { userId: stale.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const r = await ask(late.id, {}, randomUUID(), stale);
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    const reader = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, 'payments.payment.read']);
    expect((await ask(late.id, {}, randomUUID(), reader)).status).toBe(403);
    expect((await ask(late.id, {}, 'short')).status).toBe(422);
  });

  it('refund_of_unsucceeded_payment_rejected and an unknown payment', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    const live = await payNow(reference, bookingId);
    expect(live.status).not.toBe('succeeded');
    const r = await ask(live.id);
    expect([r.status, r.body.code]).toEqual([409, 'payment_not_refundable']);
    expect((await ask(randomUUID())).status).toBe(404);
    expect(await refundsOf(bookingId)).toHaveLength(0);
  });
});

describe('total and partial refunds (plan 4.5, 3.1 and 3.2)', () => {
  it('a payment that is all overpayment is refunded whole; the one that paid the plan gives nothing (overpayment_refund_cannot_touch_schedule_items)', async () => {
    const { bookingId, late, paid } = await overpaid(2, 2);
    const before = await statusOf(bookingId);
    expect((await refundableOf(bookingId, paid.id))).toMatchObject({ refundableMinor: '0', blockedReason: 'nothing_to_refund' });
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe(late.amountMinor.toString());
    const none = await ask(paid.id);
    expect([none.status, none.body.code]).toEqual([409, 'nothing_to_refund']);
    const r = await ask(late.id);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'succeeded', amountMinor: late.amountMinor.toString(), origin: 'app', purpose: 'overpayment_return', manualRefund: false });
    expect(r.body.providerRefundRef).toMatch(/^sim_ref_/);
    const [row] = await refundsOf(bookingId);
    expect(row).toMatchObject({ idempotencyKey: `refund:app:${row!.id}`, reason: 'Paid twice by mistake', requestedById: (admin as unknown as { staff: { id: string } }).staff.id });
    expect(simRefunds(late.providerPaymentRef!).map((x) => x.idempotencyKey)).toEqual([row!.idempotencyKey]);
    expect((await ledgerOf(t, bookingId)).at(-1)).toEqual({ idempotencyKey: `refund:${row!.id}:succeeded`, kind: 'refund', entries: { clearing: -late.amountMinor, customer_overpayments: late.amountMinor } });
    expect((await balancesOf(t, bookingId)).overpaymentsMinor).toBe(0n);
    expect(await statusOf(bookingId)).toBe(before);
    expect(await check(bookingId)).toEqual([]);
    expect(await t.prisma.task.count({ where: { sourceRef: coverageLostTaskRef(bookingId) } })).toBe(0);
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe('0');
  });

  it('a partial refund: only the part beyond the plan (overpayment_return_via_other_payment_keeps_schedule_covered)', async () => {
    const { bookingId, late, paid } = await overpaid(undefined, 2);
    // `paid` covered the whole plan first; `late` (the deposit) is all overpayment. The reverse case: pay the deposit
    // first, then the whole plan late.
    const swap = await overpaid(2, undefined);
    const part = await refundableOf(swap.bookingId, swap.late.id);
    expect(BigInt(part.refundableMinor)).toBeGreaterThan(0n);
    expect(BigInt(part.refundableMinor)).toBeLessThan(swap.late.amountMinor);
    const other = await ask(swap.paid.id);
    expect([other.status, other.body.code]).toEqual([409, 'nothing_to_refund']);
    const r = await ask(swap.late.id);
    expect([r.status, r.body.amountMinor]).toEqual([201, part.refundableMinor]);
    const items = await t.prisma.paymentScheduleItem.findMany({ where: { bookingId: swap.bookingId, state: 'active' } });
    const total = items.reduce((s, i) => s + i.amountMinor, 0n);
    const b = await balancesOf(t, swap.bookingId);
    expect([b.fundsMinor, b.overpaymentsMinor]).toEqual([total, 0n]);
    expect(await check(swap.bookingId)).toEqual([]);
    void bookingId; void late; void paid;
  });

  it('same_refund_request_key_returns_same_refund: a replay answers the refund as it stands, one refund at the gateway', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const key = randomUUID();
    const a = await ask(late.id, {}, key);
    const b = await ask(late.id, { paymentVersion: late.version }, key);
    expect([a.status, b.status, b.body.id]).toEqual([201, 201, a.body.id]);
    expect(await refundsOf(bookingId)).toHaveLength(1);
    expect(simRefunds(late.providerPaymentRef!)).toHaveLength(1);
  });

  it('stale_payment_version_refund_rejected: the version the panel read is bumped by a request', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const stale = await ask(late.id, { paymentVersion: late.version + 7 });
    expect([stale.status, stale.body.code]).toEqual([409, 'stale_payment_version']);
    sim.queueRefund(acc.id, 'pending');
    expect((await ask(late.id, { paymentVersion: late.version })).status).toBe(201);
    const again = await ask(late.id, { paymentVersion: late.version });
    expect([again.status, again.body.code]).toEqual([409, 'stale_payment_version']);
    expect(await refundsOf(bookingId)).toHaveLength(1);
  });

  it('concurrent_refunds_cannot_exceed_payment: two requests at once, one refund', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const res = await Promise.all([ask(late.id, { paymentVersion: late.version }), ask(late.id, { paymentVersion: late.version })]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await refundsOf(bookingId)).toHaveLength(1);
    expect(simRefunds(late.providerPaymentRef!)).toHaveLength(1);
  });

  it('concurrent_overpayment_returns_cannot_exceed_overpayment: a refund in flight reserves its money', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    const first = await ask(late.id);
    expect([first.status, first.body.status]).toEqual([202, 'requested']);
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe('0');
    const second = await ask(late.id);
    expect([second.status, second.body.code]).toEqual([409, 'nothing_to_refund']);
    // The reserved money stays in overpayments in the ledger, and the check agrees.
    expect((await balancesOf(t, bookingId)).overpaymentsMinor).toBe(late.amountMinor);
    expect(await check(bookingId)).toEqual([]);
  });
});

describe('retries and the way out (plan 4.5, 3.3, 3.4 and 14.2, 14.3)', () => {
  const service = () => t.app.get(AppRefundsService);

  it('refund_request_without_response_requeried_and_retried_same_key: looked up first, then sent again with the same key', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    expect(r).toMatchObject({ status: 'requested', requestAttempts: 1, providerRefundRef: null });
    expect(r!.nextAttemptAt).not.toBeNull();
    // Not due yet: the sweep leaves it.
    expect(await service().retryDue(new Date())).not.toContain(r!.id);
    expect(await service().retryDue(new Date(Date.now() + 2 * 60_000))).toContain(r!.id);
    const after = await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } });
    expect(after.status).toBe('succeeded');
    expect(simRefunds(late.providerPaymentRef!).map((x) => x.idempotencyKey)).toEqual([r!.idempotencyKey]);
    expect(await check(bookingId)).toEqual([]);
  });

  it('crash_between_call_and_store_repaired_by_lookup: the gateway made it, we never stored it; the retry adopts it', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    await t.app.get(ProviderGateway).call(acc.id, 'refund', (p, ctx) => p.createRefund(ctx, {
      paymentRef: late.providerPaymentRef!, amount: { amountMinor: r!.amountMinor, currency: r!.currency }, idempotencyKey: r!.idempotencyKey,
      metadata: { refundId: r!.id, paymentId: late.id, bookingId }, createdAt: r!.createdAt,
    }));
    await service().retryOne(r!.id);
    expect(await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({ status: 'succeeded' });
    expect(simRefunds(late.providerPaymentRef!)).toHaveLength(1);
    expect((await ledgerOf(t, bookingId)).filter((x) => x.kind === 'refund')).toHaveLength(1);
  });

  it('webhook_before_provider_response_matches_app_refund: matched by our id, its reference filled, posted once', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    const made = await t.app.get(ProviderGateway).call(acc.id, 'refund', (p, ctx) => p.createRefund(ctx, {
      paymentRef: late.providerPaymentRef!, amount: { amountMinor: r!.amountMinor, currency: r!.currency }, idempotencyKey: r!.idempotencyKey,
      metadata: { refundId: r!.id, paymentId: late.id, bookingId }, createdAt: r!.createdAt,
    }));
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, made.ref))).outcome).toBe('processed');
    expect(await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({ status: 'succeeded', providerRefundRef: made.ref, nextAttemptAt: null });
    await service().retryDue(new Date(Date.now() + 2 * 60_000));
    expect(await refundsOf(bookingId)).toHaveLength(1);
    expect((await ledgerOf(t, bookingId)).filter((x) => x.kind === 'refund')).toHaveLength(1);
  });

  it('refund_retry_never_after_key_lifetime: past 23 hours nothing is sent; it goes to review', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    expect(await service().retryOne(r!.id, new Date(Date.now() + 24 * 3_600_000))).toBe('review');
    expect(simRefunds(late.providerPaymentRef!)).toHaveLength(0);
    expect(await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({ status: 'requested', nextAttemptAt: null });
    expect(await t.prisma.task.count({ where: { sourceRef: refundReviewTaskRef(r!.id), status: 'open' } })).toBe(1);
  });

  it('refund_retry_stopped_by_dispute and refund_retry_stopped_by_external_refund: no second payout', async () => {
    for (const how of ['dispute', 'external'] as const) {
      // A partial refund for the external case, so the gateway could still take ours as well as the dashboard's.
      const { bookingId, late } = how === 'dispute' ? await overpaid(2, 2) : await overpaid(2, undefined);
      sim.queueRefund(acc.id, 'unavailable');
      expect((await ask(late.id)).status).toBe(202);
      const [r] = await refundsOf(bookingId);
      if (how === 'dispute') {
        const d = sim.openDispute(acc.id, late.providerPaymentRef!);
        expect((await deliver(t, acc, sim.disputeEvent(acc.secret, acc.id, d.ref))).outcome).toBe('processed');
      } else {
        const ext = sim.gatewayRefund(acc.id, late.providerPaymentRef!, 100n);
        expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, ext.ref))).outcome).toBe('processed');
      }
      const before = simRefunds(late.providerPaymentRef!).length;
      expect(await service().retryOne(r!.id, new Date(Date.now() + 2 * 60_000)), how).toBe('review');
      expect(simRefunds(late.providerPaymentRef!), how).toHaveLength(before);
      expect(await t.prisma.task.count({ where: { sourceRef: refundReviewTaskRef(r!.id), status: 'open' } }), how).toBe(1);
    }
  });

  it('stuck_refund_resolved_by_staff_only_on_confirmed_absence; reversed_refund_frees_cap', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    sim.failNextRefundRetrieve(acc.id, 'unavailable');
    const down = await admin.post(`/admin/payments/refunds/${r!.id}/resolve`, { version: r!.version });
    expect([down.status, down.body.code]).toEqual([502, 'gateway_unavailable']);
    expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).status).toBe('requested');
    const stale = await admin.post(`/admin/payments/refunds/${r!.id}/resolve`, { version: r!.version + 3 });
    expect(stale.status).toBe(409);
    const ok = await admin.post(`/admin/payments/refunds/${r!.id}/resolve`, { version: r!.version });
    expect([ok.status, ok.body.status, ok.body.failureCode]).toEqual([200, 'failed', 'resolved_by_staff']);
    // The money is free again: refundable in full, and a new refund goes through.
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe(late.amountMinor.toString());
    const again = await ask(late.id);
    expect([again.status, again.body.status]).toEqual([201, 'succeeded']);
    // The gateway reverses it after its success: the cap is free once more.
    sim.settleRefund(acc.id, again.body.providerRefundRef, 'failed');
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, again.body.providerRefundRef))).outcome).toBe('processed');
    expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: again.body.id } })).status).toBe('reversed');
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe(late.amountMinor.toString());
    expect(await check(bookingId)).toEqual([]);
  });

  it('refund_refused_by_gateway_frees_cap: a definitive refusal fails the refund and sends nothing again', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    // At the gateway, part of it went back on the dashboard (event not delivered yet): our full refund is refused.
    sim.gatewayRefund(acc.id, late.providerPaymentRef!, 100n);
    const r = await ask(late.id);
    expect([r.status, r.body.code]).toEqual([409, 'refund_refused_by_gateway']);
    const [row] = await refundsOf(bookingId);
    expect(row).toMatchObject({ status: 'failed', failureCode: 'provider_rejected', nextAttemptAt: null });
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe(late.amountMinor.toString());
    expect(await service().retryDue(new Date(Date.now() + 3_600_000))).not.toContain(row!.id);
  });
});

describe('gateways that cannot refund the way asked (plan 4.5, 3.1)', () => {
  it('refunds_not_supported_capability_rejected and partial_refund_not_supported_rejected', async () => {
    const caps = t.app.get(ProviderGateway).registry.get('simulator')!.manifest.capabilities as { refunds: string };
    const keep = caps.refunds;
    try {
      const { bookingId, late } = await overpaid(2, 2);
      caps.refunds = 'none';
      expect((await ask(late.id)).body.code).toBe('refunds_not_supported');
      caps.refunds = 'full';
      const swap = await overpaid(2, undefined);
      expect((await refundableOf(swap.bookingId, swap.late.id)).blockedReason).toBe('partial_refund_not_supported');
      expect((await ask(swap.late.id)).body.code).toBe('partial_refund_not_supported');
      // A payment that is all overpayment can still be refunded in full.
      expect((await ask(late.id)).status).toBe(201);
      expect(await refundsOf(bookingId)).toHaveLength(1);
    } finally {
      caps.refunds = keep;
    }
  });

  it('retired_account_refunds_app_refund', async () => {
    // Its own account: a retired account never comes back (plan 4.1, 4.3).
    const keep = acc;
    acc = await simulatorAccount(t);
    await onlyAccount(t, acc.id);
    try {
      const { bookingId, late } = await overpaid(2, 2);
      await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'retired' } });
      expect((await ask(late.id)).status).toBe(201);
      expect((await refundsOf(bookingId))[0]!.status).toBe('succeeded');
    } finally {
      acc = keep;
      await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'active' } });
    }
  });
});

describe('money out on a cancelled booking (plan 0.1, 6.2; plan 4.5, section 7)', () => {
  it('overpayment_return_refunds_cancelled_booking, then refund_reversed_moves_refunded_back_to_cancelled', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    const p = await payNow(reference, bookingId);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect((await admin.post(`/admin/bookings/${bookingId}/cancel`, { version: b.version, reason: 'Customer asked' })).status).toBe(200);
    // The attempt went through after all: money on a cancelled booking is an overpayment.
    sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
    expect((await deliver(t, acc, await eventFor(t, acc, p.id))).outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('cancelled');
    const r = await ask(p.id);
    expect([r.status, r.body.status]).toEqual([201, 'succeeded']);
    expect(await statusOf(bookingId)).toBe('refunded');
    expect(await t.prisma.outboxEvent.count({ where: { aggregateId: bookingId, type: 'bookings.booking.refunded' } })).toBe(1);
    sim.settleRefund(acc.id, r.body.providerRefundRef, 'failed');
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, r.body.providerRefundRef))).outcome).toBe('processed');
    expect(await statusOf(bookingId)).toBe('cancelled');
    expect(await t.prisma.outboxEvent.count({ where: { aggregateId: bookingId, type: 'bookings.booking.refund_reversed' } })).toBe(1);
    expect(await check(bookingId)).toEqual([]);
  });

  it('external_refund_over_cap_recorded_with_task: a dashboard refund after a chargeback is recorded, the excess is owed', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const d = sim.openDispute(acc.id, late.providerPaymentRef!, { amountMinor: late.amountMinor / 2n, withdrawn: true, status: 'won' });
    expect((await deliver(t, acc, sim.disputeEvent(acc.secret, acc.id, d.ref))).outcome).toBe('processed');
    const ext = sim.gatewayRefund(acc.id, late.providerPaymentRef!, late.amountMinor);
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, ext.ref))).outcome).toBe('processed');
    const r = (await refundsOf(bookingId)).find((x) => x.origin === 'external')!;
    expect(r.status).toBe('succeeded');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:refund_over_cap:${r.id}` } })).toBe(1);
    expect(await check(bookingId)).toEqual([]);
  });
});

describe('review of the code (H1, H2, M2)', () => {
  const service = () => t.app.get(AppRefundsService);

  it('resolve_and_retry_never_interleave: while staff resolve a refund, the sweep sends nothing; a held lease blocks resolve', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    // A sender holds the lease (the sweep in the middle of its call): staff cannot resolve now.
    await t.prisma.$executeRawUnsafe(`UPDATE refunds SET "sendingUntil" = clock_timestamp() + interval '1 minute' WHERE id = $1::uuid`, r!.id);
    const busy = await admin.post(`/admin/payments/refunds/${r!.id}/resolve`, { version: r!.version });
    expect([busy.status, busy.body.code]).toEqual([409, 'refund_send_in_progress']);
    await t.prisma.$executeRawUnsafe(`UPDATE refunds SET "sendingUntil" = NULL WHERE id = $1::uuid`, r!.id);
    // Barrier: the sweep runs while resolve is asking the gateway; it must not send.
    const gateway = t.app.get(ProviderGateway);
    const real = gateway.call.bind(gateway);
    let during: string | null = null;
    const spy = vi.spyOn(gateway, 'call').mockImplementation(async (id, op, fn) => {
      if (op === 'retrieve' && during === null) during = await service().retryOne(r!.id, new Date(Date.now() + 2 * 60_000));
      return real(id, op, fn as never) as never;
    });
    try {
      const ok = await admin.post(`/admin/payments/refunds/${r!.id}/resolve`, { version: r!.version });
      expect([ok.status, ok.body.status]).toEqual([200, 'failed']);
    } finally {
      spy.mockRestore();
    }
    expect(during).toBe('skipped');
    expect(simRefunds(late.providerPaymentRef!)).toHaveLength(0);
    expect(await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({ nextAttemptAt: null, sendingUntil: null });
  });

  it('late_success_of_failed_app_refund_is_recorded_with_review: the money went, so it is posted and the cap is taken again', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    expect((await admin.post(`/admin/payments/refunds/${r!.id}/resolve`, { version: r!.version })).body.status).toBe('failed');
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe(late.amountMinor.toString());
    // The gateway made it after all (a request that was still in flight somewhere): its webhook arrives.
    const made = await t.app.get(ProviderGateway).call(acc.id, 'refund', (p, ctx) => p.createRefund(ctx, {
      paymentRef: late.providerPaymentRef!, amount: { amountMinor: r!.amountMinor, currency: r!.currency }, idempotencyKey: r!.idempotencyKey,
      metadata: { refundId: r!.id, paymentId: late.id, bookingId }, createdAt: r!.createdAt,
    }));
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, made.ref))).outcome).toBe('processed');
    expect(await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({ status: 'succeeded', providerRefundRef: made.ref });
    expect((await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey)).toContain(`refund:${r!.id}:succeeded`);
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe('0');
    expect(await t.prisma.task.count({ where: { sourceRef: refundReviewTaskRef(r!.id), status: 'open' } })).toBe(1);
    expect(await check(bookingId)).toEqual([]);
  });

  it('external_pending_refund_blocks_app_refunds (P10, in flight + new)', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const ext = sim.gatewayRefund(acc.id, late.providerPaymentRef!, 100n, 'pending');
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, ext.ref))).outcome).toBe('processed');
    expect(await refundableOf(bookingId, late.id)).toMatchObject({ refundableMinor: '0', blockedReason: 'external_refund_in_progress' });
    const r = await ask(late.id);
    expect([r.status, r.body.code]).toEqual([409, 'external_refund_in_progress']);
    sim.settleRefund(acc.id, ext.ref, 'succeeded');
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, ext.ref))).outcome).toBe('processed');
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe((late.amountMinor - 100n).toString());
  });

  it('refund_of_disputed_payment_rejected: a payment with an overpayment, disputed, gives nothing back from the app', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe(late.amountMinor.toString());
    const d = sim.openDispute(acc.id, late.providerPaymentRef!);
    expect((await deliver(t, acc, sim.disputeEvent(acc.secret, acc.id, d.ref))).outcome).toBe('processed');
    expect(await refundableOf(bookingId, late.id)).toMatchObject({ refundableMinor: '0', blockedReason: 'payment_disputed' });
    const r = await ask(late.id);
    expect([r.status, r.body.code]).toEqual([409, 'refund_of_disputed_payment_rejected']);
  });

  it('refund_on_planned_or_missing_adapter_rejected: no adapter, no refund and no row', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const registry = t.app.get(ProviderGateway).registry;
    const get = registry.get.bind(registry);
    const spy = vi.spyOn(registry, 'get').mockImplementation((k: string) => (k === 'simulator' ? undefined : get(k)));
    try {
      const r = await ask(late.id);
      expect([r.status, r.body.code]).toEqual([409, 'adapter_unavailable']);
    } finally {
      spy.mockRestore();
    }
    expect(await refundsOf(bookingId)).toHaveLength(0);
  });

  it('reallocation_does_not_consume_overpayment_reserved_by_pending_refund: a plan that grows is not filled with promised money', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    // The plan grows by 300 (as a change of the booking would), then the ledger reallocates.
    const owner = await connect('owner');
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE payment_schedule_items DISABLE TRIGGER USER');
      await owner.query(`UPDATE payment_schedule_items SET "amountMinor" = "amountMinor" + 300 WHERE id = (SELECT id FROM payment_schedule_items WHERE "bookingId" = $1::uuid AND state = 'active' ORDER BY sequence DESC LIMIT 1)`, [bookingId]);
      await owner.query('ALTER TABLE payment_schedule_items ENABLE TRIGGER USER');
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    const { LedgerService } = await import('../../../src/modules/payments/core/ledger.service');
    await t.prisma.$transaction((tx) => t.app.get(LedgerService).reallocate(tx, { id: bookingId, currency: 'AUD' }, 'test', `test:${randomUUID()}:reallocation`));
    const items = (await admin.get(`/admin/payments/bookings/${bookingId}`)).body.allocation.items as Array<{ amountMinor: string; paidMinor: string }>;
    expect(items.reduce((s, i) => s + BigInt(i.amountMinor) - BigInt(i.paidMinor), 0n)).toBe(300n);
    expect((await balancesOf(t, bookingId)).overpaymentsMinor).toBe(late.amountMinor);
    // Released (the gateway never had it), the money fills the grown plan.
    expect((await admin.post(`/admin/payments/refunds/${r!.id}/resolve`, { version: r!.version })).body.status).toBe('failed');
    const after = (await admin.get(`/admin/payments/bookings/${bookingId}`)).body.allocation.items as Array<{ amountMinor: string; paidMinor: string }>;
    expect(after.every((i) => i.paidMinor === i.amountMinor)).toBe(true);
    expect((await balancesOf(t, bookingId)).overpaymentsMinor).toBe(late.amountMinor - 300n);
  });

  it('refund_vs_funds_withdrawal_concurrent: the refund waits on the booking lock the dispute holds, then sees the dispute', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    const d = sim.openDispute(acc.id, late.providerPaymentRef!, { withdrawn: true, status: 'lost' });
    const { PaymentDisputesService } = await import('../../../src/modules/payments/core/disputes.service');
    const disputes = t.app.get(PaymentDisputesService);
    const real = disputes.applyRemote.bind(disputes);
    let request: Promise<Awaited<ReturnType<typeof ask>>> | null = null;
    let waited = false;
    const spy = vi.spyOn(disputes, 'applyRemote').mockImplementation(async (...args) => {
      const out = await real(...args);
      // Barrier: with the booking locked by this transaction, the refund request starts and must wait for the lock.
      request = ask(late.id, { paymentVersion: late.version });
      for (let i = 0; i < 100 && !waited; i++) {
        const [w] = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`);
        waited = (w?.n ?? 0n) > 0n;
        if (!waited) await new Promise((r) => setTimeout(r, 50));
      }
      return out;
    });
    try {
      expect((await deliver(t, acc, sim.disputeEvent(acc.secret, acc.id, d.ref))).outcome).toBe('processed');
    } finally {
      spy.mockRestore();
    }
    expect(waited).toBe(true);
    const res = await request!;
    // Our guard, not the gateway, refuses it: the request read the dispute after the lock was released.
    expect([res.status, res.body.code]).toEqual([409, 'refund_of_disputed_payment_rejected']);
    expect(await refundsOf(bookingId)).toHaveLength(0);
    expect(simRefunds(late.providerPaymentRef!)).toHaveLength(0);
    expect(await check(bookingId)).toEqual([]);
  });

  it('late_pending_of_failed_app_refund_blocks_refunds: the gateway still processing a refund we failed blocks new ones', async () => {
    const { bookingId, late } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    expect((await admin.post(`/admin/payments/refunds/${r!.id}/resolve`, { version: r!.version })).body.status).toBe('failed');
    sim.queueRefund(acc.id, 'pending');
    const made = await t.app.get(ProviderGateway).call(acc.id, 'refund', (p, ctx) => p.createRefund(ctx, {
      paymentRef: late.providerPaymentRef!, amount: { amountMinor: r!.amountMinor, currency: r!.currency }, idempotencyKey: r!.idempotencyKey,
      metadata: { refundId: r!.id, paymentId: late.id, bookingId }, createdAt: r!.createdAt,
    }));
    expect(made.status).toBe('pending');
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, made.ref))).outcome).toBe('processed');
    expect(await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({ status: 'failed', failureCode: 'late_pending_at_gateway', providerRefundRef: made.ref });
    expect(await refundableOf(bookingId, late.id)).toMatchObject({ refundableMinor: '0', blockedReason: 'external_refund_in_progress' });
    expect((await ask(late.id)).body.code).toBe('external_refund_in_progress');
    expect(await t.prisma.task.count({ where: { sourceRef: refundReviewTaskRef(r!.id), status: 'open' } })).toBe(1);
    // It goes through at the gateway: recorded as made, the cap taken.
    sim.settleRefund(acc.id, made.ref, 'succeeded');
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, made.ref))).outcome).toBe('processed');
    expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: r!.id } })).status).toBe('succeeded');
    expect((await refundableOf(bookingId, late.id)).refundableMinor).toBe('0');
    expect(await check(bookingId)).toEqual([]);
  });

  it('refund_retry_stopped_by_external_refund_of_another_payment: the cap is per booking', async () => {
    const { bookingId, late, paid } = await overpaid(2, 2);
    sim.queueRefund(acc.id, 'unavailable');
    expect((await ask(late.id)).status).toBe(202);
    const [r] = await refundsOf(bookingId);
    // The dashboard refund is on the other payment of the booking.
    const ext = sim.gatewayRefund(acc.id, paid.providerPaymentRef!, 100n);
    expect((await deliver(t, acc, sim.refundEvent(acc.secret, acc.id, ext.ref))).outcome).toBe('processed');
    const extRow = (await refundsOf(bookingId)).find((x) => x.origin === 'external')!;
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:refund_over_cap:${extRow.id}` } })).toBe(1);
    expect(await service().retryOne(r!.id, new Date(Date.now() + 2 * 60_000))).toBe('review');
    expect(simRefunds(late.providerPaymentRef!)).toHaveLength(0);
  });
});
