// The Stripe adapter inside the API, against the fake Stripe (plan docs/plans/3.3-stripe-adapter-ledger.md, sections 5,
// 6 and 7): checkout to booking, signed webhooks through the real route, P5/P6 and finding 2, dashboard refunds. The
// registry's Stripe adapter is swapped for one with the fake's transport for this file only; nothing reaches Stripe.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StripeProvider } from '../../../src/modules/payments/adapters/stripe/stripe';
import type { StripeTransport } from '../../../src/modules/payments/adapters/stripe/stripe';
import { ProviderAccountsService } from '../../../src/modules/payments';
import { PaymentWebhooksService } from '../../../src/modules/payments/core/webhooks.service';
import { PaymentAdapterRegistry } from '../../../src/modules/payments/core/registry';
import { ProviderError } from '../../../src/modules/payments/core/provider';
import type { CreatePaymentInput, PaymentProvider } from '../../../src/modules/payments/core/provider';
import { TestApp, makeApp } from '../../support/auth';
import { closeCatalogue } from '../../support/catalogue';
import { cleanBookingEvents } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import { PayingCustomer, approvedBooking, cleanPayments, onlyAccount, payingCustomer, paymentsStaff, sendWebhook } from '../../support/payments';
import type { SimAccount } from '../../support/payments';
import { FakeStripe } from '../../contract/subjects/stripe-fake';
import { ledgerOf } from '../../support/ledger';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let c: PayingCustomer;
const fake = new FakeStripe();
/** Faults a test sets: the next session create reaches the fake, then the answer is lost. */
let loseNextCreateAnswer = false;
const transport: StripeTransport = async (req) => {
  const res = await fake.transport(req);
  if (loseNextCreateAnswer && req.method === 'POST' && req.path === '/v1/checkout/sessions') {
    loseNextCreateAnswer = false;
    throw new ProviderError('provider_timeout', true);
  }
  return res;
};
let registered: PaymentProvider | undefined;
/** Every createPayment input the adapter received, for the createdAt check. */
const creates: CreatePaymentInput[] = [];
interface StripeAccount extends SimAccount { key: string }
let acc: StripeAccount;

async function stripeAccount(): Promise<StripeAccount> {
  const key = fake.newAccount();
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  const { id, webhookUrl } = await t.app.get(ProviderAccountsService).createStripeTestAccount({ secretKey: key, webhookSecret: secret, displayName: `Stripe ${randomUUID().slice(0, 8)}` });
  return { id, key, secret, pathToken: webhookUrl.split('/').pop()! };
}

beforeAll(async () => {
  t = await makeApp();
  const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
  registered = byKey.get('stripe');
  const stripe = new StripeProvider({ transport, now: () => fake.now() });
  const create = stripe.createPayment.bind(stripe);
  stripe.createPayment = (ctx, input) => (creates.push(input), create(ctx, input));
  byKey.set('stripe', stripe);
  admin = await paymentsStaff(t);
  acc = await stripeAccount();
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
afterAll(async () => {
  if (registered) (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey.set('stripe', registered);
  await t.prisma.providerAccount.updateMany({ where: { adapterKey: 'stripe' }, data: { status: 'paused' } });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const event = (a: StripeAccount, objectId: string, opts: { type?: string; eventId?: string } = {}) => fake.event(a.key, a.secret, objectId, new Date(), opts);
async function deliverTo(a: StripeAccount, w: { body: Buffer; headers: Record<string, string>; eventId: string }): Promise<string> {
  const res = await sendWebhook(t, a, w);
  if (res.status !== 200) return `http_${res.status}`;
  const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: a.id, providerEventId: w.eventId } } });
  return t.app.get(PaymentWebhooksService).process(ev.id);
}

/** Checkout: the customer is sent to Stripe's hosted page. */
async function checkout() {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const res = await c.pay(reference, { method: 'card' });
  return { reference, bookingId, res };
}

describe('Stripe checkout through the API (plan 3.3, 5)', () => {
  it('end to end: hosted page, the customer pays, the signed webhook moves the booking, one posting', async () => {
    const { bookingId, res } = await checkout();
    expect(res.status).toBe(201);
    expect(res.body.nextAction.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect([p.adapterKey, p.providerPaymentRef?.startsWith('cs_')]).toEqual(['stripe', true]);
    fake.pay(acc.key, p.providerPaymentRef!);
    expect(await deliverTo(acc, event(acc, p.providerPaymentRef!))).toBe('processed');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('succeeded');
    expect(['deposit_paid', 'confirmed']).toContain((await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status);
    expect((await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey)).toEqual([`payment:${p.id}:succeeded`]);
  });

  it('same_success_via_two_event_types_posts_once (plan 0.1, P5)', async () => {
    const { bookingId } = await checkout();
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    fake.pay(acc.key, p.providerPaymentRef!);
    expect(await deliverTo(acc, event(acc, p.providerPaymentRef!, { type: 'checkout.session.completed' }))).toBe('processed');
    expect(await deliverTo(acc, event(acc, p.providerPaymentRef!, { type: 'checkout.session.async_payment_succeeded' }))).toBe('processed');
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(1);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.payment.succeeded', aggregateId: p.id } })).toBe(1);
  });

  it('stripe_webhook_duplicate_out_of_order_bad_signature (plan 0.1, P6)', async () => {
    const { bookingId } = await checkout();
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    fake.pay(acc.key, p.providerPaymentRef!);
    const ok = event(acc, p.providerPaymentRef!);
    const forged = { ...ok, headers: { ...ok.headers, 'stripe-signature': ok.headers['stripe-signature']!.replace(/v1=[0-9a-f]{4}/, 'v1=0000') } };
    // invalid_then_valid_same_event_id_processed_once
    expect((await sendWebhook(t, acc, forged)).status).toBe(400);
    expect((await t.prisma.webhookRejection.findFirstOrThrow({ where: { claimedEventId: ok.eventId } })).reason).toBe('bad_signature');
    expect(await deliverTo(acc, ok)).toBe('processed');
    expect((await sendWebhook(t, acc, ok)).body.duplicate).toBe(true);
    // An expiry event after the payment (out of order) changes nothing.
    const late = { ...event(acc, p.providerPaymentRef!, { type: 'checkout.session.expired' }) };
    expect(await deliverTo(acc, late)).toBe('processed');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('succeeded');
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(1);
  });

  it('stripe_oversized_webhook_rejected: over 256 KB, 413 and no row', async () => {
    const big = { body: Buffer.alloc(300 * 1024, 0x20), headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, eventId: 'evt_big' };
    const res = await sendWebhook(t, acc, big);
    expect(res.status).toBe(413);
    expect(await t.prisma.webhookEvent.count({ where: { providerEventId: 'evt_big' } })).toBe(0);
  });

  it('webhook_before_provider_response_matches_app_payment: the answer to the create is lost, the webhook fills in the reference', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    loseNextCreateAnswer = true;
    expect((await c.pay(reference, { method: 'card' })).status).toBe(503);
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(p.providerPaymentRef).toBeNull();
    const session = [...fake.account(acc.key).sessions.values()].find((s) => s.metadata.mt_payment_id === p.id)!;
    fake.pay(acc.key, session.id);
    expect(await deliverTo(acc, event(acc, session.id))).toBe('processed');
    const after = await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect([after.status, after.providerPaymentRef]).toEqual(['succeeded', session.id]);
  });

  it('webhook_metadata_id_from_other_account_not_matched (finding 2): another Stripe account cannot name our payment', async () => {
    const { bookingId } = await checkout();
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    const other = await stripeAccount();
    await t.prisma.providerAccount.update({ where: { id: other.id }, data: { status: 'paused' } });
    // A session of the other account that carries our payment's id in its metadata.
    const forged = fake.account(other.key);
    const s = { ...fake.account(acc.key).sessions.get(p.providerPaymentRef!)!, id: `cs_test_${randomBytes(8).toString('hex')}`, status: 'complete' as const, payment_status: 'paid' as const };
    forged.sessions.set(s.id, s);
    expect(await deliverTo(other, event(other, s.id))).toBe('ignored');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('requires_action');
  });

  it('a refund made on the Stripe dashboard is found through its PaymentIntent, recorded and posted', async () => {
    const { bookingId } = await checkout();
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    fake.pay(acc.key, p.providerPaymentRef!);
    expect(await deliverTo(acc, event(acc, p.providerPaymentRef!))).toBe('processed');
    const r = fake.dashboardRefund(acc.key, p.providerPaymentRef!, 2500);
    expect(await deliverTo(acc, event(acc, r.id))).toBe('processed');
    const refund = await t.prisma.refund.findFirstOrThrow({ where: { bookingId } });
    expect([refund.origin, refund.status, refund.amountMinor, refund.providerRefundRef]).toEqual(['external', 'succeeded', 2500n, r.id]);
    expect((await ledgerOf(t, bookingId)).map((x) => x.kind)).toEqual(['payment', 'refund']);
    // A Stripe refund cancelled before any money moved counts as failed (plan 3.3, 12.9).
    const r2 = fake.dashboardRefund(acc.key, p.providerPaymentRef!, 1000, 'pending');
    expect(await deliverTo(acc, event(acc, r2.id))).toBe('processed');
    fake.setRefundStatus(acc.key, r2.id, 'canceled');
    expect(await deliverTo(acc, event(acc, r2.id))).toBe('processed');
    expect((await t.prisma.refund.findFirstOrThrow({ where: { providerRefundRef: r2.id } })).status).toBe('failed');
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(2);
  });

  it('create_retry_uses_row_createdAt (through the API): the retry of a lost create sends the attempt row\'s createdAt again', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    creates.length = 0;
    loseNextCreateAnswer = true;
    expect((await c.pay(reference, { method: 'card' })).status).toBe(503);
    await new Promise((r) => setTimeout(r, 1100));
    // The customer tries again: the same attempt is resumed and created again under its key.
    const again = await c.pay(reference, { method: 'card' });
    expect(again.status).toBe(201);
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(await t.prisma.payment.count({ where: { bookingId } })).toBe(1);
    const mine = creates.filter((i) => i.metadata.paymentId === p.id);
    expect(mine).toHaveLength(2);
    for (const i of mine) expect(i.createdAt.getTime()).toBe(p.createdAt.getTime());
    expect(fake.account(acc.key).sessions.size).toBeGreaterThan(0);
    expect([...fake.account(acc.key).sessions.values()].filter((x) => x.metadata.mt_payment_id === p.id)).toHaveLength(1);
  });

  it('a refund of another session that carries our payment id is not posted against our payment (reference_mismatch)', async () => {
    const { bookingId } = await checkout();
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    fake.pay(acc.key, p.providerPaymentRef!);
    expect(await deliverTo(acc, event(acc, p.providerPaymentRef!))).toBe('processed');
    const orig = fake.account(acc.key).sessions.get(p.providerPaymentRef!)!;
    const twin = { ...orig, id: `cs_test_${randomBytes(8).toString('hex')}`, status: 'open' as const, payment_status: 'unpaid' as const, payment_intent: null };
    fake.account(acc.key).sessions.set(twin.id, twin);
    fake.pay(acc.key, twin.id);
    const r = fake.dashboardRefund(acc.key, twin.id, 500);
    const w = event(acc, r.id);
    expect(await deliverTo(acc, w)).toBe('ignored');
    const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: w.eventId } } });
    expect(ev.errorCode).toBe('reference_mismatch');
    expect(await t.prisma.refund.count({ where: { bookingId } })).toBe(0);
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(1);
  });
});
