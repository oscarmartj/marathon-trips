// The Airwallex adapter inside the API, against the fake Airwallex (plan docs/plans/9.2-airwallex.md, sections 13, 19
// and 20): checkout to booking, signed webhooks through the real route, sweeps, refunds from the panel and from the web
// app, disputes, and the failure paths. The registry's Airwallex adapter is swapped for one with the fake for this file.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AirwallexProvider } from '../../../src/modules/payments/adapters/airwallex/airwallex';
import type { AirwallexTransport } from '../../../src/modules/payments/adapters/airwallex/http';
import { PaymentAttemptSyncService } from '../../../src/modules/payments/core/attempt-sync.service';
import { PaymentWebhooksService, webhookPathTokenHash } from '../../../src/modules/payments/core/webhooks.service';
import { PaymentAdapterRegistry } from '../../../src/modules/payments/core/registry';
import { ProviderGateway, credentialsAad, webhookSecretAad } from '../../../src/modules/payments/core/gateway';
import type { PaymentProvider } from '../../../src/modules/payments/core/provider';
import { insertDefaultRules } from '../../../src/modules/payments/core/routing-admin.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { closeCatalogue } from '../../support/catalogue';
import { cleanBookingEvents } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import { PayingCustomer, approvedBooking, cleanPayments, expireNow, onlyAccount, payingCustomer, paymentsStaff, resetGatewayHealth, sendWebhook } from '../../support/payments';
import { FAKE_CHECKOUT_ORIGIN, FakeAirwallex, signedDelivery } from '../../contract/subjects/airwallex-fake';
import { ledgerOf } from '../../support/ledger';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let c: PayingCustomer;
const fake = new FakeAirwallex();
/** A test sets this: the session URL Airwallex answers points at another origin. */
let foreignUrl = false;
const transport: AirwallexTransport = async (req) => {
  const res = await fake.transport(req);
  if (foreignUrl && req.url.endsWith('/checkout_sessions/create')) return { ...res, body: res.body.replace(FAKE_CHECKOUT_ORIGIN, 'https://evil.example') };
  return res;
};
let registered: PaymentProvider | undefined;
interface AirwallexAccount { id: string; pathToken: string; secret: string; clientId: string; apiKey: string }
let acc: AirwallexAccount;

/** An Airwallex test account as the panel leaves it once tested and activated (test mode, its default routing rules). */
async function airwallexAccount(status: 'active' | 'paused' = 'active'): Promise<AirwallexAccount> {
  const keys = fake.newAccount();
  const id = randomUUID();
  const pathToken = randomBytes(32).toString('base64url');
  const secretValue = `whsec_${randomBytes(24).toString('hex')}`;
  const creds = t.box.encrypt(JSON.stringify(keys), credentialsAad(id));
  const secret = t.box.encrypt(secretValue, webhookSecretAad(id));
  const registry = t.app.get(PaymentAdapterRegistry);
  await t.prisma.$transaction(async (tx) => {
    const row = await tx.providerAccount.create({
      data: {
        id, adapterKey: 'airwallex', displayName: `Airwallex ${id.slice(0, 8)}`, mode: 'test', status,
        credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
        webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
        webhookPathTokenHash: webhookPathTokenHash(t.config.AUTH_HMAC_KEY, pathToken),
      },
      select: { createdAt: true },
    });
    await insertDefaultRules(tx, id, registry.get('airwallex')!.manifest, row.createdAt);
  });
  return { id, pathToken, secret: secretValue, ...keys };
}

async function activate(id: string): Promise<void> {
  const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id }, select: { status: true } });
  if (row.status === 'active') return;
  await t.prisma.providerAccount.update({ where: { id }, data: { status: 'active', lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date() } });
}

beforeAll(async () => {
  t = await makeApp();
  const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
  registered = byKey.get('airwallex');
  byKey.set('airwallex', new AirwallexProvider({ transport, now: () => fake.now() }));
  admin = await paymentsStaff(t);
  acc = await airwallexAccount();
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
beforeEach(async () => {
  await resetGatewayHealth(t);
  await activate(acc.id);
  await onlyAccount(t, acc.id);
  fake.ignoreFilters = false;
  fake.refundOutcome = 'SETTLED';
  foreignUrl = false;
});
afterAll(async () => {
  if (registered) (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey.set('airwallex', registered);
  await t.prisma.providerAccount.updateMany({ where: { adapterKey: 'airwallex', status: 'active' }, data: { status: 'paused' } });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

type Delivery = { body: Buffer; headers: Record<string, string>; eventId: string };
const withId = (event: Record<string, unknown>, at: Date, secret = acc.secret): Delivery => ({ ...signedDelivery(secret, event, at), eventId: String(event.id) });
const paymentEvent = (ref: string, at = new Date()) => withId(fake.paymentEvent(acc.clientId, ref, at), at);
async function deliverTo(a: AirwallexAccount, w: Delivery): Promise<string> {
  const res = await sendWebhook(t, a, w);
  if (res.status !== 200) return `http_${res.status}`;
  const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: a.id, providerEventId: w.eventId } } });
  return t.app.get(PaymentWebhooksService).process(ev.id);
}
const refresh = (reference: string) => t.http().post(`/booking-requests/${reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});
const sync = () => t.app.get(PaymentAttemptSyncService);
const statusOf = async (id: string) => (await t.prisma.payment.findUniqueOrThrow({ where: { id } })).status;

async function checkout() {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const res = await c.pay(reference, { method: 'card' });
  const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
  return { reference, bookingId, res, p };
}

async function panelRefund(paymentId: string) {
  const version = (await t.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).version;
  return admin.post(`/admin/payments/payments/${paymentId}/refunds`, { paymentVersion: version, purpose: 'overpayment_return', reason: 'Paid twice' }).set('Idempotency-Key', randomUUID());
}

describe('Airwallex checkout through the API (plan 9.2)', () => {
  it('checkout_redirects_only_to_airwallex_origin; the customer pays; the return reads it; one posting; the event changes nothing', async () => {
    const { reference, bookingId, res, p } = await checkout();
    expect(res.status).toBe(201);
    expect(res.body.nextAction.url.startsWith(`${FAKE_CHECKOUT_ORIGIN}/pay?s=`)).toBe(true);
    expect([p.adapterKey, p.providerPaymentRef]).toEqual(['airwallex', expect.stringMatching(new RegExp(`^mt-${p.id}-[0-9]{10}$`))]);
    fake.pay(acc.clientId, p.providerPaymentRef!);
    expect((await refresh(reference)).status).toBe(200);
    expect(await statusOf(p.id)).toBe('succeeded');
    expect((await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey)).toEqual([`payment:${p.id}:succeeded`]);
    expect(await deliverTo(acc, paymentEvent(p.providerPaymentRef!))).toBe('processed');
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(1);
  });

  it('foreign_redirect_url_never_handed_out', async () => {
    foreignUrl = true;
    const { res } = await checkout();
    expect(JSON.stringify(res.body)).not.toContain('evil.example');
  });

  it('paid_by_webhook_marks_booking_paid; duplicate_and_out_of_order_events_are_harmless; forged and stale deliveries name the event', async () => {
    const { p, bookingId } = await checkout();
    const ref = p.providerPaymentRef!;
    const older = paymentEvent(ref);
    fake.pay(acc.clientId, ref);
    const paid = paymentEvent(ref);
    const forged = { ...paid, headers: { ...paid.headers, 'x-signature': 'a'.repeat(64) } };
    expect((await sendWebhook(t, acc, forged)).status).toBe(400);
    expect((await t.prisma.webhookRejection.findFirstOrThrow({ where: { claimedEventId: paid.eventId } })).reason).toBe('bad_signature');
    const staleAt = new Date(Date.now() - 400_000);
    const stale = withId(fake.paymentEvent(acc.clientId, ref, staleAt), staleAt);
    expect((await sendWebhook(t, acc, stale)).status).toBe(400);
    expect((await t.prisma.webhookRejection.findFirstOrThrow({ where: { claimedEventId: stale.eventId } })).reason).toBe('stale_timestamp');
    expect(await deliverTo(acc, paid)).toBe('processed');
    expect(await statusOf(p.id)).toBe('succeeded');
    expect((await sendWebhook(t, acc, paid)).body.duplicate).toBe(true);
    // The older checkout_session.created event (requires_action) arrives last: nothing moves back.
    expect(await deliverTo(acc, older)).toBe('processed');
    expect(await statusOf(p.id)).toBe('succeeded');
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(1);
  });

  it('paid_while_pending_review_waits_then_succeeds (the sweep reads it)', async () => {
    const { p } = await checkout();
    const intent = fake.pay(acc.clientId, p.providerPaymentRef!, 'PENDING_REVIEW');
    await sync().run(p.id, 'sync');
    expect(await statusOf(p.id)).toBe('pending');
    fake.setIntentStatus(acc.clientId, intent.id, 'SUCCEEDED');
    await sync().run(p.id, 'sync');
    expect(await statusOf(p.id)).toBe('succeeded');
  });

  it('intent_cancelled_after_checkout_is_failed_no_money', async () => {
    const { p, bookingId } = await checkout();
    const intent = fake.pay(acc.clientId, p.providerPaymentRef!, 'PENDING_REVIEW');
    fake.setIntentStatus(acc.clientId, intent.id, 'CANCELLED');
    await sync().run(p.id, 'sync');
    expect(await statusOf(p.id)).toBe('failed');
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(0);
  });

  it('amount_mismatch_opens_task (Airwallex charged A$1 more); nothing recorded as paid', async () => {
    const { p, bookingId } = await checkout();
    const intent = fake.pay(acc.clientId, p.providerPaymentRef!);
    intent.amount = `${(p.amountMinor + 100n) / 100n}.${((p.amountMinor + 100n) % 100n).toString().padStart(2, '0')}`;
    await sync().run(p.id, 'sync');
    expect(await statusOf(p.id)).not.toBe('succeeded');
    expect(await t.prisma.task.count({ where: { entityId: p.id, status: 'open' } })).toBeGreaterThan(0);
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(0);
  });

  it('foreign_order_id_event_is_unknown_payment: an event for an order id we do not hold opens a task', async () => {
    const ref = `mt-${randomUUID()}-${Math.floor(Date.now() / 1000)}`;
    const event = { id: `evt_${randomBytes(6).toString('hex')}`, name: 'payment_intent.succeeded', created_at: new Date().toISOString(), data: { object: { id: 'int_x1', status: 'SUCCEEDED', amount: '12.50', currency: 'AUD', merchant_order_id: ref } } };
    const w = withId(event, new Date());
    expect(await deliverTo(acc, w)).toBe('ignored');
    const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: w.eventId } } });
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:unknown_event:${ev.id}` } })).toBe(1);
  });

  it('ignored_filter_never_matches_foreign_intent: another booking paid the same amount; ours stays unpaid', async () => {
    const a = await checkout();
    const b = await checkout();
    expect(a.p.amountMinor).toBe(b.p.amountMinor);
    fake.ignoreFilters = true;
    fake.pay(acc.clientId, b.p.providerPaymentRef!);
    await sync().run(a.p.id, 'sync');
    await sync().run(b.p.id, 'sync');
    expect([await statusOf(a.p.id), await statusOf(b.p.id)]).toEqual(['requires_action', 'succeeded']);
  });

  it('expired_session_with_open_intent_is_cancelled_and_unblocks_booking: the intent ends CANCELLED at Airwallex', async () => {
    const a = await checkout();
    const intent = fake.pay(acc.clientId, a.p.providerPaymentRef!, 'REQUIRES_CUSTOMER_ACTION');
    fake.expire(acc.clientId, a.p.providerPaymentRef!);
    await expireNow(a.p.id);
    await sync().run(a.p.id, 'expire');
    expect(await statusOf(a.p.id)).toBe('expired');
    expect(fake.account(acc.clientId).intents.get(intent.id)!.status).toBe('CANCELLED');
    // The booking can pay again (P2 released).
    const again = await c.pay(a.reference, { method: 'card' });
    expect(again.status).toBe(201);
  });

  it('a lost create answer: the retry finds the same session, never a second', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    fake.loseNext((r) => r.url.endsWith('/checkout_sessions/create'));
    expect((await c.pay(reference, { method: 'card' })).status).toBe(503);
    const again = await c.pay(reference, { method: 'card' });
    expect(again.status).toBe(201);
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(await t.prisma.payment.count({ where: { bookingId } })).toBe(1);
    expect(fake.sessionPosts(acc.clientId, p.providerPaymentRef!)).toBe(1);
  });

  it('late_success_after_cancelled_follows_late_payment_path; refunded from the panel as an overpayment; refund_accepted_stays_pending_until_settled', async () => {
    // Attempt a expires and is cancelled at Airwallex; the customer pays with attempt b.
    const a = await checkout();
    await expireNow(a.p.id);
    await sync().run(a.p.id, 'expire');
    expect(await statusOf(a.p.id)).toBe('expired');
    expect((await c.pay(a.reference, { method: 'card' })).status).toBe(201);
    const b = await t.prisma.payment.findFirstOrThrow({ where: { bookingId: a.bookingId }, orderBy: { attemptNumber: 'desc' } });
    fake.pay(acc.clientId, b.providerPaymentRef!);
    await refresh(a.reference);
    expect(await statusOf(b.id)).toBe('succeeded');
    // A race at Airwallex: the first checkout was paid as it was being cancelled. Its event records the late money.
    fake.sessionOfRef(acc.clientId, a.p.providerPaymentRef!).status = 'ACTIVE';
    fake.pay(acc.clientId, a.p.providerPaymentRef!);
    expect(await deliverTo(acc, paymentEvent(a.p.providerPaymentRef!))).toBe('processed');
    expect(await statusOf(a.p.id)).toBe('succeeded');
    // Returned from the panel as an overpayment: pending while Airwallex has only accepted it, succeeded once settled.
    fake.refundOutcome = 'ACCEPTED';
    const asked = await panelRefund(a.p.id);
    expect([201, 202], JSON.stringify(asked.body)).toContain(asked.status);
    const r = await t.prisma.refund.findFirstOrThrow({ where: { paymentId: a.p.id } });
    expect([r.origin, r.status, r.amountMinor > 0n && r.amountMinor <= a.p.amountMinor]).toEqual(['app', 'pending', true]);
    fake.setRefundStatus(acc.clientId, r.providerRefundRef!, 'SETTLED');
    expect(await deliverTo(acc, withId(fake.refundEvent(acc.clientId, r.providerRefundRef!, new Date()), new Date()))).toBe('processed');
    expect((await t.prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('succeeded');
    expect((await ledgerOf(t, a.bookingId)).filter((x) => x.kind === 'refund')).toHaveLength(1);
  });

  it('web_app_refund_recorded_as_external, once', async () => {
    const { p, reference, bookingId } = await checkout();
    fake.pay(acc.clientId, p.providerPaymentRef!);
    await refresh(reference);
    const r = fake.dashboardRefund(acc.clientId, p.providerPaymentRef!, 500n);
    const w = withId(fake.refundEvent(acc.clientId, r.id, new Date()), new Date());
    expect(await deliverTo(acc, w)).toBe('processed');
    expect((await sendWebhook(t, acc, w)).body.duplicate).toBe(true);
    const refund = await t.prisma.refund.findFirstOrThrow({ where: { bookingId } });
    expect([refund.origin, refund.status, refund.amountMinor, refund.providerRefundRef]).toEqual(['external', 'succeeded', 500n, r.id]);
  });

  it('dispute_event_opens_review_task, also for a dispute event name we do not know', async () => {
    for (const name of ['payment_dispute.created', 'payment_dispute.unknown_new_state']) {
      const event = { id: `evt_${randomBytes(6).toString('hex')}`, name, created_at: new Date().toISOString(), data: { object: { id: 'dsp_1' } } };
      const w = withId(event, new Date());
      expect(await deliverTo(acc, w)).toBe('ignored');
      const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: w.eventId } } });
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:gateway_review:${ev.id}`, status: 'open' } })).toBe(1);
    }
  });

  it('retired_account_still_refunds_and_processes_webhooks; a paused account takes no new checkout', async () => {
    const main = acc;
    acc = await airwallexAccount();
    try {
      await onlyAccount(t, acc.id);
      const a = await checkout();
      fake.pay(acc.clientId, a.p.providerPaymentRef!);
      await refresh(a.reference);
      await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'retired' } });
      const r = await t.app.get(ProviderGateway).call(acc.id, 'refund', (p, ctx) => p.createRefund(ctx, {
        paymentRef: a.p.providerPaymentRef!, amount: { amountMinor: 100n, currency: 'AUD' }, idempotencyKey: `refund:retired:${randomUUID()}`, metadata: { refundId: randomUUID(), paymentId: a.p.id, bookingId: a.bookingId }, createdAt: new Date(),
      }));
      expect(r.status).toBe('succeeded');
      expect(await deliverTo(acc, paymentEvent(a.p.providerPaymentRef!))).toBe('processed');
      const { reference } = await approvedBooking(t, admin, await pricedWorld(admin), c);
      const before = fake.log.filter((l) => l.path.endsWith('/checkout_sessions/create')).length;
      expect((await c.pay(reference, { method: 'card' })).status).not.toBe(201);
      expect(fake.log.filter((l) => l.path.endsWith('/checkout_sessions/create')).length).toBe(before);
    } finally {
      acc = main;
    }
  });

  it('the catalogue shows Airwallex with its status and capabilities; credentials are never returned by the panel', async () => {
    const cat = await admin.get('/admin/payments/adapters');
    expect(cat.status).toBe(200);
    expect(JSON.stringify(cat.body)).toContain('airwallex');
    const res = await admin.get('/admin/payments/provider-accounts');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text.includes(acc.apiKey) || text.includes(acc.secret) || text.includes(acc.clientId)).toBe(false);
  });
});
