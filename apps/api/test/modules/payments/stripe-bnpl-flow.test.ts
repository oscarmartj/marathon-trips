// The Stripe pay-later adapter inside the API, against the fake Stripe (plan docs/plans/9.3-stripe-pay-later.md, sections
// 13 and 19): born off, routing next to a card account, checkout to booking, signed webhooks through the real route,
// money approved after the session expired, cancel while the customer is at the provider, refunds (window, failed
// later), disputes and events of a shared Stripe account. The registry's Stripe adapters are swapped for ones with the
// fake's transport for this file only; nothing reaches Stripe.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StripeBnplProvider } from '../../../src/modules/payments/adapters/stripe/bnpl';
import { signStripe } from '../../../src/modules/payments/adapters/stripe/mapping';
import { StripeProvider } from '../../../src/modules/payments/adapters/stripe/stripe';
import { ProviderAccountsService } from '../../../src/modules/payments';
import { AppRefundsService } from '../../../src/modules/payments/core/app-refunds.service';
import { PaymentAttemptSyncService } from '../../../src/modules/payments/core/attempt-sync.service';
import { refundFailedTaskRef } from '../../../src/modules/payments/core/refunds.service';
import { ProviderGateway, credentialsAad, webhookSecretAad } from '../../../src/modules/payments/core/gateway';
import type { PaymentProvider } from '../../../src/modules/payments/core/provider';
import { PaymentAdapterRegistry } from '../../../src/modules/payments/core/registry';
import { insertDefaultRules } from '../../../src/modules/payments/core/routing-admin.service';
import { PaymentWebhooksService, webhookPathTokenHash } from '../../../src/modules/payments/core/webhooks.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { cleanBookingEvents } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { ledgerOf } from '../../support/ledger';
import { PayingCustomer, approvedBooking, cleanPayments, expireNow, onlyAccount, payingCustomer, paymentsStaff, resetGatewayHealth, sendWebhook } from '../../support/payments';
import { pricedWorld } from '../../support/pricing';
import { FakeStripe } from '../../contract/subjects/stripe-fake';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let c: PayingCustomer;
const fake = new FakeStripe();
const realNow = () => new Date();
const registered = new Map<string, PaymentProvider | undefined>();
interface Account { id: string; key: string; secret: string; pathToken: string }
let bnpl: Account;
let card: Account;
const DAY_S = 86_400;

/** A pay-later account as the panel leaves it once tested and activated: test mode, and no routing rule (born off). */
async function bnplAccount(): Promise<Account> {
  const key = fake.newAccount();
  const id = randomUUID();
  const pathToken = randomBytes(32).toString('base64url');
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  const creds = t.box.encrypt(JSON.stringify({ secretKey: key }), credentialsAad(id));
  const sealed = t.box.encrypt(secret, webhookSecretAad(id));
  await t.prisma.$transaction(async (tx) => {
    const row = await tx.providerAccount.create({
      data: {
        id, adapterKey: 'stripe_bnpl', displayName: `Pay later ${id.slice(0, 8)}`, mode: 'test', status: 'active',
        credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion, webhookSecretCiphertext: sealed.ciphertext, webhookKeyVersion: sealed.keyVersion,
        webhookPathTokenHash: webhookPathTokenHash(t.config.AUTH_HMAC_KEY, pathToken), lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date(),
      },
      select: { createdAt: true },
    });
    expect(await insertDefaultRules(tx, id, t.app.get(PaymentAdapterRegistry).get('stripe_bnpl')!.manifest, row.createdAt)).toBe(0);
  });
  return { id, key, secret, pathToken };
}

async function cardAccount(): Promise<Account> {
  const key = fake.newAccount();
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  const { id, webhookUrl } = await t.app.get(ProviderAccountsService).createStripeTestAccount({ secretKey: key, webhookSecret: secret, displayName: `Stripe ${randomUUID().slice(0, 8)}` });
  return { id, key, secret, pathToken: webhookUrl.split('/').pop()! };
}

const addBnplRule = (accountId: string) => t.prisma.routingRule.create({ data: { providerAccountId: accountId, method: 'bnpl', countries: ['AU'], anyCountry: false, currency: 'AUD', priority: 100 } });

beforeAll(async () => {
  t = await makeApp();
  const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
  for (const k of ['stripe', 'stripe_bnpl']) registered.set(k, byKey.get(k));
  byKey.set('stripe', new StripeProvider({ transport: fake.transport, now: () => fake.now() }));
  byKey.set('stripe_bnpl', new StripeBnplProvider({ transport: fake.transport, now: () => fake.now() }));
  admin = await paymentsStaff(t);
  bnpl = await bnplAccount();
  card = await cardAccount();
  c = await payingCustomer(t);
});
beforeEach(async () => {
  fake.now = realNow;
  await resetGatewayHealth(t);
  await t.prisma.providerAccount.update({ where: { id: bnpl.id }, data: { status: 'active', lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date() } });
  await onlyAccount(t, bnpl.id);
  await t.prisma.providerAccount.update({ where: { id: card.id }, data: { status: 'active', lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date() } });
});
afterAll(async () => {
  const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
  for (const [k, v] of registered) if (v) byKey.set(k, v);
  await t.prisma.providerAccount.updateMany({ where: { adapterKey: { in: ['stripe', 'stripe_bnpl'] }, status: 'active' }, data: { status: 'paused' } });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

type Delivery = { body: Buffer; headers: Record<string, string>; eventId: string };
const event = (a: Account, objectId: string, opts: { type?: string; eventId?: string } = {}): Delivery => fake.event(a.key, a.secret, objectId, new Date(), opts);
async function deliverTo(a: Account, w: Delivery): Promise<string> {
  const res = await sendWebhook(t, a, w);
  if (res.status !== 200) return `http_${res.status}`;
  const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: a.id, providerEventId: w.eventId } } });
  return t.app.get(PaymentWebhooksService).process(ev.id);
}
const refresh = (reference: string) => t.http().post(`/booking-requests/${reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});
const sync = () => t.app.get(PaymentAttemptSyncService);
const statusOf = async (id: string) => (await t.prisma.payment.findUniqueOrThrow({ where: { id } })).status;
const sessionOf = (a: Account, ref: string) => fake.account(a.key).sessions.get(ref)!;

async function checkout(method: 'bnpl' | 'card' = 'bnpl') {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const res = await c.pay(reference, { method });
  const p = await t.prisma.payment.findFirst({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } });
  return { reference, bookingId, res, p };
}

/**
 * A booking paid twice by pay later (a race at the gateway: the first checkout is paid as it is being ended), so the
 * late payment `b` can be refunded as an overpayment.
 */
async function overpaid() {
  const a = await checkout();
  await expireNow(a.p!.id);
  await sync().run(a.p!.id, 'expire');
  expect(await statusOf(a.p!.id)).toBe('expired');
  expect((await c.pay(a.reference, { method: 'bnpl' })).status).toBe(201);
  const second = await t.prisma.payment.findFirstOrThrow({ where: { bookingId: a.bookingId }, orderBy: { attemptNumber: 'desc' } });
  fake.pay(bnpl.key, second.providerPaymentRef!);
  await refresh(a.reference);
  expect(await statusOf(second.id)).toBe('succeeded');
  sessionOf(bnpl, a.p!.providerPaymentRef!).status = 'open';
  fake.pay(bnpl.key, a.p!.providerPaymentRef!);
  expect(await deliverTo(bnpl, event(bnpl, a.p!.providerPaymentRef!))).toBe('processed');
  expect(await statusOf(a.p!.id)).toBe('succeeded');
  const b = await t.prisma.payment.findUniqueOrThrow({ where: { id: a.p!.id } });
  return { ...a, b };
}
async function panelRefund(paymentId: string) {
  const version = (await t.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).version;
  return admin.post(`/admin/payments/payments/${paymentId}/refunds`, { paymentVersion: version, purpose: 'overpayment_return', reason: 'Paid twice' }).set('Idempotency-Key', randomUUID());
}

describe('pay later through the API (plan 9.3)', () => {
  it('new_account_offers_nothing_until_a_bnpl_rule; then offered to an AU customer on Stripe Checkout with only pay-later types', async () => {
    const off = await checkout();
    expect(off.res.status).not.toBe(201);
    expect(off.p).toBeNull();
    const rule = await addBnplRule(bnpl.id);
    try {
      const on = await checkout();
      expect(on.res.status, JSON.stringify(on.res.body)).toBe(201);
      expect(on.res.body.nextAction.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      expect([on.p!.adapterKey, on.p!.providerAccountId]).toEqual(['stripe_bnpl', bnpl.id]);
      const s = sessionOf(bnpl, on.p!.providerPaymentRef!);
      expect(s.payment_method_types).toBeDefined();
      expect(s.payment_method_types).not.toContain('card');
      // no_surcharge_by_payment_method: what Stripe is asked for is the payment-plan amount, nothing added.
      expect(BigInt(s.amount_total)).toBe(on.p!.amountMinor);
    } finally {
      await t.prisma.routingRule.delete({ where: { id: rule.id } });
    }
  });

  describe('with a pay-later rule', () => {
    let ruleId: string;
    beforeAll(async () => {
      ruleId = (await addBnplRule(bnpl.id)).id;
    });
    afterAll(async () => {
      await t.prisma.routingRule.delete({ where: { id: ruleId } });
    });

    it('card_routes_unchanged_by_a_bnpl_account: a card checkout goes to the card account, with the card session; same amount as pay later', async () => {
      const k = await checkout('card');
      expect(k.res.status, JSON.stringify(k.res.body)).toBe(201);
      expect([k.p!.adapterKey, k.p!.providerAccountId]).toEqual(['stripe', card.id]);
      const s = sessionOf(card, k.p!.providerPaymentRef!);
      expect(s.payment_method_types).toBeUndefined();
      const b = await checkout('bnpl');
      expect(b.p!.amountMinor).toBe(k.p!.amountMinor);
    });

    it('paid_by_webhook_marks_booking_paid; duplicate_and_out_of_order_events_are_harmless; one posting', async () => {
      const { p, bookingId } = await checkout();
      const ref = p!.providerPaymentRef!;
      fake.pay(bnpl.key, ref);
      const paid = event(bnpl, ref);
      expect(await deliverTo(bnpl, paid)).toBe('processed');
      expect(await statusOf(p!.id)).toBe('succeeded');
      expect((await sendWebhook(t, bnpl, paid)).body.duplicate).toBe(true);
      // An "expired" event arriving last, for a session with a PaymentIntent, is left to the reads: nothing moves back.
      expect(await deliverTo(bnpl, event(bnpl, ref, { type: 'checkout.session.expired' }))).toBe('ignored');
      expect(await statusOf(p!.id)).toBe('succeeded');
      expect((await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey)).toEqual([`payment:${p!.id}:succeeded`]);
    });

    it('declined_bnpl_stays_payable_then_paid', async () => {
      const { p, reference } = await checkout();
      fake.decline(bnpl.key, p!.providerPaymentRef!);
      await refresh(reference);
      expect(await statusOf(p!.id)).toBe('requires_action');
      fake.pay(bnpl.key, p!.providerPaymentRef!);
      await refresh(reference);
      expect(await statusOf(p!.id)).toBe('succeeded');
    });

    it('bnpl_paid_after_session_expiry_is_recorded: the expired event is left to the reads, the attempt stays live, the approval is recorded', async () => {
      const { p, bookingId } = await checkout();
      const ref = p!.providerPaymentRef!;
      fake.startAtProvider(bnpl.key, ref);
      fake.account(bnpl.key).refusePiCancel = true;
      try {
        const t0 = Date.now();
        fake.now = () => new Date(t0 + 50 * 60_000);
        expect(sessionOf(bnpl, ref).status).toBe('open');
        expect(await deliverTo(bnpl, event(bnpl, ref, { type: 'checkout.session.expired' }))).toBe('ignored');
        expect(sessionOf(bnpl, ref).status).toBe('expired');
        expect(await statusOf(p!.id)).toBe('requires_action');
        // The attempt's own expiry: the read says the customer may still be at the provider, the cancel is refused.
        await expireNow(p!.id);
        await expect(sync().run(p!.id, 'expire')).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
        expect(await statusOf(p!.id)).toBe('requires_action');
        // The customer approves at minute 50: the next sweep records the money, once.
        fake.approveAtProvider(bnpl.key, ref);
        await sync().run(p!.id, 'expire');
        expect(await statusOf(p!.id)).toBe('succeeded');
        expect((await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey)).toEqual([`payment:${p!.id}:succeeded`]);
      } finally {
        fake.account(bnpl.key).refusePiCancel = false;
      }
    });

    it('cancel_while_customer_at_provider: session expired, PaymentIntent cancelled, attempt ended, booking can pay again', async () => {
      const { p, reference } = await checkout();
      const pi = fake.startAtProvider(bnpl.key, p!.providerPaymentRef!);
      await expireNow(p!.id);
      await sync().run(p!.id, 'expire');
      expect(await statusOf(p!.id)).toBe('expired');
      expect(fake.account(bnpl.key).intents.get(pi)!.status).toBe('canceled');
      expect((await c.pay(reference, { method: 'bnpl' })).status).toBe(201);
    });

    it('booking cancelled or attempt replaced while the customer is at the provider: the PaymentIntent is cancelled; if Stripe refuses, the attempt stays live', async () => {
      for (const action of ['cancel', 'replace'] as const) {
        const { p } = await checkout();
        const pi = fake.startAtProvider(bnpl.key, p!.providerPaymentRef!);
        await sync().run(p!.id, action);
        expect(await statusOf(p!.id)).toBe('cancelled');
        expect(fake.account(bnpl.key).intents.get(pi)!.status).toBe('canceled');
      }
      const { p } = await checkout();
      fake.startAtProvider(bnpl.key, p!.providerPaymentRef!);
      fake.account(bnpl.key).refusePiCancel = true;
      try {
        await expect(sync().run(p!.id, 'cancel')).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
        expect(await statusOf(p!.id)).toBe('requires_action');
      } finally {
        fake.account(bnpl.key).refusePiCancel = false;
      }
      await sync().run(p!.id, 'cancel');
      expect(await statusOf(p!.id)).toBe('cancelled');
    });

    it('refund_partial_then_idempotent from the panel', async () => {
      const { b } = await overpaid();
      const asked = await panelRefund(b.id);
      expect([201, 202], JSON.stringify(asked.body)).toContain(asked.status);
      const r = await t.prisma.refund.findFirstOrThrow({ where: { paymentId: b.id } });
      expect([r.origin, r.status]).toEqual(['app', 'succeeded']);
      expect(fake.account(bnpl.key).refunds.size).toBeGreaterThan(0);
    });

    it('refund_refused_after_window_is_a_409_and_nothing_moves; no refund-failed task for a refusal staff saw', async () => {
      const { b } = await overpaid();
      fake.ageCharge(bnpl.key, b.providerPaymentRef!, 200 * DAY_S);
      const before = fake.account(bnpl.key).refunds.size;
      const asked = await panelRefund(b.id);
      expect(asked.status).toBe(409);
      expect(asked.body.code ?? asked.body.error?.code).toBe('refund_refused_by_gateway');
      expect(fake.account(bnpl.key).refunds.size).toBe(before);
      const r = await t.prisma.refund.findFirstOrThrow({ where: { paymentId: b.id } });
      expect(r.status).toBe('failed');
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:refund_failed:${r.id}` } })).toBe(0);
      expect((await ledgerOf(t, b.bookingId)).filter((x) => x.kind === 'refund')).toHaveLength(0);
    });

    it('refund_failed_event_records_failure: a refund that fails later opens one task; the same event again opens no second', async () => {
      const { b } = await overpaid();
      fake.account(bnpl.key).nextRefund.push('pending');
      const asked = await panelRefund(b.id);
      expect([201, 202], JSON.stringify(asked.body)).toContain(asked.status);
      const r = await t.prisma.refund.findFirstOrThrow({ where: { paymentId: b.id } });
      expect(r.status).toBe('pending');
      fake.setRefundStatus(bnpl.key, r.providerRefundRef!, 'failed');
      const failed = event(bnpl, r.providerRefundRef!, { type: 'refund.failed' });
      expect(await deliverTo(bnpl, failed)).toBe('processed');
      expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('failed');
      const tasks = () => t.prisma.task.findMany({ where: { sourceRef: `payments:refund_failed:${r.id}` } });
      expect(await tasks()).toHaveLength(1);
      const [task] = await tasks();
      expect(task!.title).toMatch(/^Refund failed at the payment gateway on booking /);
      expect(task!.description).not.toMatch(/@|\+61|card/i);
      expect((await sendWebhook(t, bnpl, failed)).body.duplicate).toBe(true);
      expect(await deliverTo(bnpl, event(bnpl, r.providerRefundRef!, { type: 'refund.failed' }))).toBe('processed');
      expect(await tasks()).toHaveLength(1);
      // The gateway moves it after all (code review 2): the "refund another way" task closes, the review task opens.
      fake.setRefundStatus(bnpl.key, r.providerRefundRef!, 'succeeded');
      expect(await deliverTo(bnpl, event(bnpl, r.providerRefundRef!, { type: 'refund.updated' }))).toBe('processed');
      expect((await tasks()).map((x) => x.status)).toEqual(['done']);
      expect(await t.prisma.task.count({ where: { entityId: r.id, status: 'open' } })).toBe(1);
    });

    it('a refund failed at the gateway, then pending, then failed again: the refund-another-way task stays open, once', async () => {
      const { b } = await overpaid();
      fake.account(bnpl.key).nextRefund.push('pending');
      expect([201, 202]).toContain((await panelRefund(b.id)).status);
      const r = await t.prisma.refund.findFirstOrThrow({ where: { paymentId: b.id } });
      const ref = r.providerRefundRef!;
      const open = () => t.prisma.task.count({ where: { sourceRef: refundFailedTaskRef(r.id), status: 'open' } });
      const all = () => t.prisma.task.count({ where: { sourceRef: refundFailedTaskRef(r.id) } });
      fake.setRefundStatus(bnpl.key, ref, 'failed');
      expect(await deliverTo(bnpl, event(bnpl, ref, { type: 'refund.failed' }))).toBe('processed');
      expect([await open(), await all()]).toEqual([1, 1]);
      fake.setRefundStatus(bnpl.key, ref, 'pending');
      expect(await deliverTo(bnpl, event(bnpl, ref, { type: 'refund.updated' }))).toBe('processed');
      expect([await open(), await all()]).toEqual([1, 1]);
      fake.setRefundStatus(bnpl.key, ref, 'failed');
      expect(await deliverTo(bnpl, event(bnpl, ref, { type: 'refund.failed' }))).toBe('processed');
      expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('failed');
      expect([await open(), await all()]).toEqual([1, 1]);
      // Pending once more, then succeeded: only then is it closed.
      fake.setRefundStatus(bnpl.key, ref, 'pending');
      expect(await deliverTo(bnpl, event(bnpl, ref, { type: 'refund.updated' }))).toBe('processed');
      fake.setRefundStatus(bnpl.key, ref, 'succeeded');
      expect(await deliverTo(bnpl, event(bnpl, ref, { type: 'refund.updated' }))).toBe('processed');
      expect([await open(), await all()]).toEqual([0, 1]);
    });

    it('refund_refused_on_sweep_retry_opens_one_task (code review 1): no answer first (202), refused when the sweep retries', async () => {
      const { b } = await overpaid();
      fake.account(bnpl.key).faults.push(500);
      const asked = await panelRefund(b.id);
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      const r = await t.prisma.refund.findFirstOrThrow({ where: { paymentId: b.id } });
      expect(r.status).toBe('requested');
      fake.ageCharge(bnpl.key, b.providerPaymentRef!, 200 * DAY_S);
      await t.app.get(AppRefundsService).retryOne(r.id);
      expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('failed');
      expect(await t.prisma.task.count({ where: { sourceRef: refundFailedTaskRef(r.id) } })).toBe(1);
      await t.app.get(AppRefundsService).retryOne(r.id);
      expect(await t.prisma.task.count({ where: { sourceRef: refundFailedTaskRef(r.id) } })).toBe(1);
    });

    it('dispute_event_opens_dispute', async () => {
      const { p, reference, bookingId } = await checkout();
      fake.pay(bnpl.key, p!.providerPaymentRef!);
      await refresh(reference);
      const d = fake.openDispute(bnpl.key, p!.providerPaymentRef!);
      expect(await deliverTo(bnpl, event(bnpl, d.id, { type: 'charge.dispute.created' }))).toBe('processed');
      expect(await t.prisma.dispute.count({ where: { bookingId } })).toBe(1);
    });

    it('a card session of a shared Stripe account reaching the pay-later endpoint is ignored, with no unknown-payment task', async () => {
      const k = await checkout('card');
      fake.pay(card.key, k.p!.providerPaymentRef!);
      const w = fake.event(card.key, bnpl.secret, k.p!.providerPaymentRef!, new Date());
      // The card session as a shared account would deliver it: with Stripe's payment_method_types (A11).
      const body = JSON.parse(w.body.toString('utf8')) as { data: { object: Record<string, unknown> } };
      body.data.object.payment_method_types = ['card'];
      const raw = Buffer.from(JSON.stringify(body));
      const shared: Delivery = { body: raw, eventId: w.eventId, headers: { ...w.headers, 'stripe-signature': signStripe(bnpl.secret, raw, new Date()) } };
      expect(await deliverTo(bnpl, shared)).toBe('ignored');
      const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: bnpl.id, providerEventId: w.eventId } } });
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:unknown_event:${ev.id}` } })).toBe(0);
    });

    it('a retired pay-later account still refunds and takes no new checkout', async () => {
      const main = bnpl;
      bnpl = await bnplAccount();
      const rule = await addBnplRule(bnpl.id);
      try {
        await onlyAccount(t, bnpl.id);
        const a = await checkout();
        expect(a.p!.providerAccountId).toBe(bnpl.id);
        fake.pay(bnpl.key, a.p!.providerPaymentRef!);
        await refresh(a.reference);
        await t.prisma.providerAccount.update({ where: { id: bnpl.id }, data: { status: 'retired' } });
        const r = await t.app.get(ProviderGateway).call(bnpl.id, 'refund', (prov, ctx) => prov.createRefund(ctx, {
          paymentRef: a.p!.providerPaymentRef!, amount: { amountMinor: 100n, currency: 'AUD' }, idempotencyKey: `refund:retired:${randomUUID()}`, metadata: { refundId: randomUUID(), paymentId: a.p!.id, bookingId: a.bookingId }, createdAt: new Date(),
        }));
        expect(r.status).toBe('succeeded');
        const creates = fake.account(bnpl.key).createCalls;
        const again = await checkout();
        expect(again.res.status).not.toBe(201);
        expect(fake.account(bnpl.key).createCalls).toBe(creates);
      } finally {
        await t.prisma.routingRule.delete({ where: { id: rule.id } });
        bnpl = main;
      }
    });

    it('the catalogue shows the pay-later adapter; credentials are never returned by the panel', async () => {
      const cat = await admin.get('/admin/payments/adapters');
      expect(cat.status).toBe(200);
      expect(JSON.stringify(cat.body)).toContain('stripe_bnpl');
      const res = await admin.get('/admin/payments/provider-accounts');
      const text = JSON.stringify(res.body);
      expect(text.includes(bnpl.key) || text.includes(bnpl.secret)).toBe(false);
    });
  });
});
