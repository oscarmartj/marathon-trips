// The PayPal adapter inside the API, against the fake PayPal (plan docs/plans/4.3-paypal-adapter.md, section 11, API
// list): checkout to booking, capture only where the core finishes a payment (sync, drive, expire) and never on cancel,
// replace, orphan or a paused account (review point 1), signed webhooks through the real route with the certificate
// fetched first, dashboard refunds. The registry's PayPal adapter is swapped for one with the fake for this file only.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PayPalProvider } from '../../../src/modules/payments/adapters/paypal/paypal';
import type { PayPalTransport } from '../../../src/modules/payments/adapters/paypal/paypal';
import { PaymentAttemptSyncService } from '../../../src/modules/payments/core/attempt-sync.service';
import { PaymentWebhooksService, webhookPathTokenHash } from '../../../src/modules/payments/core/webhooks.service';
import { PaymentAdapterRegistry } from '../../../src/modules/payments/core/registry';
import { ProviderError } from '../../../src/modules/payments/core/provider';
import type { PaymentProvider } from '../../../src/modules/payments/core/provider';
import { credentialsAad, webhookSecretAad } from '../../../src/modules/payments/core/gateway';
import { insertDefaultRules } from '../../../src/modules/payments/core/routing-admin.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { closeCatalogue } from '../../support/catalogue';
import { cleanBookingEvents } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import { PayingCustomer, approvedBooking, cleanPayments, expireNow, onlyAccount, payingCustomer, paymentsStaff, resetGatewayHealth, sendWebhook } from '../../support/payments';
import { FakePayPal } from '../../contract/subjects/paypal-fake';
import { ledgerOf } from '../../support/ledger';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let c: PayingCustomer;
const fake = new FakePayPal();
let loseNextCreateAnswer = false;
const transport: PayPalTransport = async (req) => {
  const res = await fake.transport(req);
  if (loseNextCreateAnswer && req.method === 'POST' && req.url.endsWith('/v2/checkout/orders') && !req.body?.includes('"purchase_units":[]')) {
    loseNextCreateAnswer = false;
    throw new ProviderError('provider_timeout', true);
  }
  return res;
};
let registered: PaymentProvider | undefined;
interface PayPalAccount { id: string; pathToken: string; secret: string; clientId: string; clientSecret: string }
let acc: PayPalAccount;

/** A PayPal test account as the panel leaves it once tested and activated (test mode, its default routing rules). */
async function paypalAccount(status: 'active' | 'paused' = 'active', withWebhookId = true): Promise<PayPalAccount> {
  const app = fake.newAccount();
  const id = randomUUID();
  const pathToken = randomBytes(32).toString('base64url');
  const creds = t.box.encrypt(JSON.stringify({ clientId: app.clientId, clientSecret: app.clientSecret }), credentialsAad(id));
  const secret = t.box.encrypt(app.webhookId, webhookSecretAad(id));
  const registry = t.app.get(PaymentAdapterRegistry);
  await t.prisma.$transaction(async (tx) => {
    const row = await tx.providerAccount.create({
      data: {
        id, adapterKey: 'paypal', displayName: `PayPal ${id.slice(0, 8)}`, mode: 'test', status,
        credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
        ...(withWebhookId ? { webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion } : {}),
        webhookPathTokenHash: webhookPathTokenHash(t.config.AUTH_HMAC_KEY, pathToken),
      },
      select: { createdAt: true },
    });
    await insertDefaultRules(tx, id, registry.get('paypal')!.manifest, row.createdAt);
  });
  return { id, pathToken, secret: app.webhookId, clientId: app.clientId, clientSecret: app.clientSecret };
}

/** Back to active, as the panel does after an ok connection test (the trigger of 4.1 requires one). */
async function activate(id: string): Promise<void> {
  const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id }, select: { status: true } });
  if (row.status === 'active') return;
  await t.prisma.providerAccount.update({ where: { id }, data: { status: 'active', lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date() } });
}

beforeAll(async () => {
  t = await makeApp();
  const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
  registered = byKey.get('paypal');
  byKey.set('paypal', new PayPalProvider({ transport, now: () => fake.now(), certificates: fake.trust }));
  admin = await paymentsStaff(t);
  acc = await paypalAccount();
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
beforeEach(async () => {
  await resetGatewayHealth(t);
  await activate(acc.id);
  await onlyAccount(t, acc.id);
  fake.certDown = false;
});
afterAll(async () => {
  if (registered) (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey.set('paypal', registered);
  await t.prisma.providerAccount.updateMany({ where: { adapterKey: 'paypal' }, data: { status: 'paused' } });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const event = (a: PayPalAccount, ref: string, at = new Date()) => fake.event(a.clientId, a.secret, ref, at);
async function deliverTo(a: PayPalAccount, w: { body: Buffer; headers: Record<string, string>; eventId: string }): Promise<string> {
  const res = await sendWebhook(t, a, w);
  if (res.status !== 200) return `http_${res.status}`;
  const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: a.id, providerEventId: w.eventId } } });
  return t.app.get(PaymentWebhooksService).process(ev.id);
}
const refresh = (reference: string) => t.http().post(`/booking-requests/${reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});
const captures = () => fake.captureExecutions;

async function checkout() {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const res = await c.pay(reference, { method: 'card' });
  const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
  return { reference, bookingId, res, p };
}

describe('PayPal checkout through the API (plan 4.3)', () => {
  it('end to end: PayPal approval page, the payer approves, the return page captures, the booking moves, one posting', async () => {
    const { reference, bookingId, res, p } = await checkout();
    expect(res.status).toBe(201);
    expect(res.body.nextAction.url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
    expect(p.adapterKey).toBe('paypal');
    fake.approve(acc.clientId, p.providerPaymentRef!, 'good');
    const before = captures();
    expect((await refresh(reference)).status).toBe(200);
    expect(captures() - before).toBe(1);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('succeeded');
    expect(['deposit_paid', 'confirmed']).toContain((await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status);
    expect((await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey)).toEqual([`payment:${p.id}:succeeded`]);
    // The capture webhook afterwards changes nothing and posts nothing more.
    expect(await deliverTo(acc, event(acc, p.providerPaymentRef!))).toBe('processed');
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(1);
  });

  it('signed webhook: certificate fetched first, duplicate, an older APPROVED event after the capture, bad signature', async () => {
    const { p } = await checkout();
    const ref = p.providerPaymentRef!;
    const older = event(acc, ref);
    fake.approve(acc.clientId, ref, 'good');
    await t.app.get(PaymentAttemptSyncService).run(p.id, 'sync');
    const ok = event(acc, ref);
    const forged = { ...ok, headers: { ...ok.headers, 'paypal-transmission-sig': Buffer.from(randomBytes(256)).toString('base64') } };
    expect((await sendWebhook(t, acc, forged)).status).toBe(400);
    expect((await t.prisma.webhookRejection.findFirstOrThrow({ where: { claimedEventId: ok.eventId } })).reason).toBe('bad_signature');
    expect(await deliverTo(acc, ok)).toBe('processed');
    expect((await sendWebhook(t, acc, ok)).body.duplicate).toBe(true);
    expect(await deliverTo(acc, older)).toBe('processed');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('succeeded');
  });

  it('certificate download failing: the delivery is refused (fail closed) and accepted once PayPal retries after it works', async () => {
    const { p } = await checkout();
    const other = await paypalAccount('paused');
    // A fresh adapter, so no certificate is cached yet.
    const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
    const fresh = new PayPalProvider({ transport, now: () => fake.now(), certificates: fake.trust });
    byKey.set('paypal', fresh);
    try {
      fake.certDown = true;
      const w = event(acc, p.providerPaymentRef!);
      expect((await sendWebhook(t, acc, w)).status).toBe(400);
      expect((await t.prisma.webhookRejection.findFirstOrThrow({ where: { claimedEventId: w.eventId } })).reason).toBe('bad_signature');
      fake.certDown = false;
      fake.advance(61_000);
      const retried = event(acc, p.providerPaymentRef!, fake.now());
      expect(await deliverTo(acc, retried)).toBe('processed');
      void other;
    } finally {
      byKey.set('paypal', new PayPalProvider({ transport, now: () => fake.now(), certificates: fake.trust }));
    }
  });

  it('expiry sweep: an untouched order ends expired (marked); an approved one is captured and recorded', async () => {
    const a = await checkout();
    await expireNow(a.p.id);
    await t.app.get(PaymentAttemptSyncService).run(a.p.id, 'expire');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: a.p.id } })).status).toBe('expired');
    expect(fake.order(acc.clientId, a.p.providerPaymentRef!)?.customId?.startsWith('mt1:c:')).toBe(true);
    const b = await checkout();
    fake.approve(acc.clientId, b.p.providerPaymentRef!, 'good');
    await expireNow(b.p.id);
    await t.app.get(PaymentAttemptSyncService).run(b.p.id, 'expire');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: b.p.id } })).status).toBe('succeeded');
  });

  it('review point 1: approved then cancelled, replaced or orphaned, or on a paused account: nothing is captured', async () => {
    const sync = t.app.get(PaymentAttemptSyncService);
    // The payer approves and leaves; the booking is cancelled (schedule.service queues `cancel`).
    const a = await checkout();
    fake.approve(acc.clientId, a.p.providerPaymentRef!, 'good');
    const before = captures();
    await sync.run(a.p.id, 'cancel');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: a.p.id } })).status).toBe('cancelled');
    // An orphan of an ended attempt.
    await sync.run(a.p.id, 'cancel_orphan');
    // The customer changes method (replace).
    const b = await checkout();
    fake.approve(acc.clientId, b.p.providerPaymentRef!, 'good');
    await sync.replace(b.p.id);
    // A paused account: a sync reads but never captures.
    const d = await checkout();
    fake.approve(acc.clientId, d.p.providerPaymentRef!, 'good');
    await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'paused' } });
    await sync.run(d.p.id, 'sync');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: d.p.id } })).status).toBe('requires_action');
    expect(captures() - before).toBe(0);
    // Once active again, the next sync captures.
    await activate(acc.id);
    await sync.run(d.p.id, 'sync');
    expect(captures() - before).toBe(1);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: d.p.id } })).status).toBe('succeeded');
  });

  it('a booking that can no longer pay (approval run out): sync and drive read, never capture', async () => {
    const a = await checkout();
    fake.approve(acc.clientId, a.p.providerPaymentRef!, 'good');
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET "approvalExpiresAt" = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, a.bookingId);
    const before = captures();
    await t.app.get(PaymentAttemptSyncService).run(a.p.id, 'sync');
    await refresh(a.reference);
    expect(captures() - before).toBe(0);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: a.p.id } })).status).toBe('requires_action');
  });

  it('gateway: prepareWebhook runs before verifyWebhook, never while the webhook secret is empty, and a hanging one fails closed', async () => {
    const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
    const current = byKey.get('paypal') as PayPalProvider;
    const { p } = await checkout();
    let calls = 0;
    const spy = new PayPalProvider({ transport, now: () => fake.now(), certificates: fake.trust });
    const prepare = spy.prepareWebhook.bind(spy);
    spy.prepareWebhook = async (ctx, headers) => {
      calls++;
      return prepare(ctx, headers);
    };
    byKey.set('paypal', spy);
    try {
      expect(await deliverTo(acc, event(acc, p.providerPaymentRef!))).toBe('processed');
      expect(calls).toBe(1);
      // No webhook ID entered yet: refused before the adapter is asked.
      const blank = await paypalAccount('paused', false);
      expect((await sendWebhook(t, blank, event(acc, p.providerPaymentRef!))).status).toBe(400);
      expect(calls).toBe(1);
      // A hook that never answers: 5 s, then verification fails closed (a fresh adapter has no certificate cached).
      const hanging = new PayPalProvider({ transport, now: () => fake.now(), certificates: fake.trust });
      hanging.prepareWebhook = () => new Promise<void>(() => undefined);
      byKey.set('paypal', hanging);
      const w = event(acc, p.providerPaymentRef!);
      expect((await sendWebhook(t, acc, w)).status).toBe(400);
      expect((await t.prisma.webhookRejection.findFirstOrThrow({ where: { claimedEventId: w.eventId } })).reason).toBe('bad_signature');
    } finally {
      byKey.set('paypal', current);
    }
  });

  it('a refund made on the PayPal dashboard is recorded once, as external, and posted', async () => {
    const { p, bookingId, reference } = await checkout();
    fake.approve(acc.clientId, p.providerPaymentRef!, 'good');
    await refresh(reference);
    const r = fake.dashboardRefund(acc.clientId, p.providerPaymentRef!, 2500n);
    const w = event(acc, r.id);
    expect(await deliverTo(acc, w)).toBe('processed');
    expect((await sendWebhook(t, acc, w)).body.duplicate).toBe(true);
    const refund = await t.prisma.refund.findFirstOrThrow({ where: { bookingId } });
    expect([refund.origin, refund.status, refund.amountMinor, refund.providerRefundRef]).toEqual(['external', 'succeeded', 2500n, r.id]);
    expect((await ledgerOf(t, bookingId)).map((x) => x.kind)).toEqual(['payment', 'refund']);
  });

  it('finding 2: an event of another PayPal account naming our payment is not matched', async () => {
    const { p } = await checkout();
    const other = await paypalAccount('paused');
    // An order of the other account that carries our payment's custom_id.
    const ours = fake.order(acc.clientId, p.providerPaymentRef!)!;
    const token = JSON.parse((await fake.transport({ method: 'POST', url: 'https://api-m.sandbox.paypal.com/v1/oauth2/token', body: 'grant_type=client_credentials', headers: { authorization: `Basic ${Buffer.from(`${other.clientId}:${other.clientSecret}`).toString('base64')}` } })).body).access_token as string;
    const made = await fake.transport({ method: 'POST', url: 'https://api-m.sandbox.paypal.com/v2/checkout/orders', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ custom_id: ours.customId, amount: { currency_code: 'AUD', value: '1.00' } }] }) });
    const forgedRef = JSON.parse(made.body).id as string;
    fake.approve(other.clientId, forgedRef, 'good');
    expect(await deliverTo(other, event(other, forgedRef))).toBe('ignored');
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('requires_action');
  });

  it('a lost create answer: the retry under the same key gets the same order', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    loseNextCreateAnswer = true;
    expect((await c.pay(reference, { method: 'card' })).status).toBe(503);
    const again = await c.pay(reference, { method: 'card' });
    expect(again.status).toBe(201);
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(await t.prisma.payment.count({ where: { bookingId } })).toBe(1);
    expect(again.body.nextAction.url).toContain(p.providerPaymentRef!);
  });
});
