// The Pin Payments adapter inside the API, against the fake Pin and the database card session store (plan
// docs/plans/4.4-au-card-gateway.md, sections 6, 7, 10, 13 and 18): checkout to the card page, the one card submission,
// 3-D Secure and its return, every session path through the real payment state machine, unknown outcomes and late
// money, refunds whose answer is lost, signed webhooks, and what the card page may receive.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinPaymentsGateway } from '../../../src/modules/payments/adapters/pin_payments/pin';
import { PrismaCardSessionStore } from '../../../src/modules/payments/core/card-sessions/prisma-store';
import { CardSessionProvider } from '../../../src/modules/payments/core/card-sessions/provider';
import { PaymentAttemptSyncService } from '../../../src/modules/payments/core/attempt-sync.service';
import { credentialsAad, webhookSecretAad, ProviderGateway } from '../../../src/modules/payments/core/gateway';
import type { PaymentProvider } from '../../../src/modules/payments/core/provider';
import { PaymentAdapterRegistry } from '../../../src/modules/payments/core/registry';
import { insertDefaultRules } from '../../../src/modules/payments/core/routing-admin.service';
import { PaymentWebhooksService, webhookPathTokenHash } from '../../../src/modules/payments/core/webhooks.service';
import { TasksService } from '../../../src/platform/common/tasks/tasks.service';
import { STATE_HEADERS, TestApp, WEB_ORIGIN, makeApp } from '../../support/auth';
import { cleanBookingEvents } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { ledgerOf } from '../../support/ledger';
import { PayingCustomer, approvedBooking, cleanPayments, expireNow, onlyAccount, payingCustomer, paymentsStaff, resetGatewayHealth, sendWebhook } from '../../support/payments';
import { pricedWorld } from '../../support/pricing';
import { FakePin } from '../../contract/subjects/pin-fake';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let c: PayingCustomer;
const fake = new FakePin();
let registered: PaymentProvider | undefined;
interface PinAccount { id: string; pathToken: string; secret: string; secretKey: string; publishableKey: string }
let acc: PinAccount;
let provider: CardSessionProvider;

async function pinAccount(status: 'active' | 'paused' = 'active'): Promise<PinAccount> {
  const keys = fake.newAccount();
  const id = randomUUID();
  const pathToken = randomBytes(32).toString('base64url');
  const creds = t.box.encrypt(JSON.stringify({ secretKey: keys.secretKey, publishableKey: keys.publishableKey }), credentialsAad(id));
  const secret = t.box.encrypt(keys.webhookKey, webhookSecretAad(id));
  const registry = t.app.get(PaymentAdapterRegistry);
  await t.prisma.$transaction(async (tx) => {
    const row = await tx.providerAccount.create({
      data: {
        id, adapterKey: 'pin_payments', displayName: `Pin ${id.slice(0, 8)}`, mode: 'test', status,
        credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion, webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
        webhookPathTokenHash: webhookPathTokenHash(t.config.AUTH_HMAC_KEY, pathToken),
      },
      select: { createdAt: true },
    });
    await insertDefaultRules(tx, id, registry.get('pin_payments')!.manifest, row.createdAt);
  });
  return { id, pathToken, secret: keys.webhookKey, secretKey: keys.secretKey, publishableKey: keys.publishableKey };
}

async function activate(id: string): Promise<void> {
  const row = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id }, select: { status: true } });
  if (row.status === 'active') return;
  await t.prisma.providerAccount.update({ where: { id }, data: { status: 'active', lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date() } });
}

beforeAll(async () => {
  t = await makeApp();
  const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
  registered = byKey.get('pin_payments');
  provider = new CardSessionProvider(new PinPaymentsGateway({ transport: fake.transport }), new PrismaCardSessionStore(t.prisma, t.app.get(TasksService)), { cardPageOrigin: WEB_ORIGIN, usable: true });
  byKey.set('pin_payments', provider);
  admin = await paymentsStaff(t);
  acc = await pinAccount();
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
beforeEach(async () => {
  await resetGatewayHealth(t);
  await activate(acc.id);
  await onlyAccount(t, acc.id);
  for (const k of Object.keys(fake.switches)) delete (fake.switches as Record<string, unknown>)[k];
});
afterAll(async () => {
  if (registered) (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey.set('pin_payments', registered);
  await t.prisma.providerAccount.updateMany({ where: { adapterKey: 'pin_payments' }, data: { status: 'paused' } });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const sync = () => t.app.get(PaymentAttemptSyncService);
const statusOf = async (id: string) => (await t.prisma.payment.findUniqueOrThrow({ where: { id } })).status;
const sessionOf = (ref: string) => t.prisma.cardSession.findUniqueOrThrow({ where: { ref } });
const view = (ref: string) => t.http().post('/payments/card-sessions/view').set(STATE_HEADERS).send({ ref });
const submit = (ref: string, cardToken: string, extra: Record<string, unknown> = {}) => t.http().post('/payments/card-sessions/submit').set(STATE_HEADERS).send({ ref, cardToken, ...extra });
const back = (ref: string, sessionToken?: string) => t.http().get(`/payments/card-sessions/${ref}/authenticated${sessionToken ? `?session_token=${sessionToken}` : ''}`);
/** Moves a session's expiry into the past, as the owner with its guard off inside one transaction (as expireNow). */
async function expireSession(ref: string): Promise<void> {
  const pg = (await import('pg')).default;
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE card_sessions DISABLE TRIGGER card_sessions_guard');
    await owner.query(`UPDATE card_sessions SET "expiresAt" = clock_timestamp() - interval '1 minute' WHERE ref = $1`, [ref]);
    await owner.query('ALTER TABLE card_sessions ENABLE TRIGGER card_sessions_guard');
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
}
const refresh = (reference: string) => t.http().post(`/booking-requests/${reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});

async function deliverTo(a: PinAccount, w: { body: Buffer; headers: Record<string, string>; eventId: string }): Promise<string> {
  const res = await sendWebhook(t, a, w);
  if (res.status !== 200) return `http_${res.status}`;
  const ev = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: a.id, providerEventId: w.eventId } } });
  return t.app.get(PaymentWebhooksService).process(ev.id);
}

async function checkout() {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const res = await c.pay(reference, { method: 'card' });
  expect(res.status).toBe(201);
  const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } });
  return { reference, bookingId, res, p, ref: p.providerPaymentRef! };
}

/** The customer on the card page through to the bank's page and back (3-D Secure). */
async function payWith3ds(ref: string, outcome: 'pay' | 'decline' = 'pay') {
  const s = await submit(ref, fake.tokenise(acc.publishableKey, 'pay'));
  expect(s.status).toBe(200);
  expect(s.body.next).toBe('redirect');
  expect(s.body.url).toMatch(/^https:\/\/sandbox\.checkout\.com\//);
  const session = await sessionOf(ref);
  const st = fake.finishChallenge(acc.secretKey, session.chargeRef!, outcome);
  const r = await back(ref, st);
  expect(r.status).toBe(303);
  expect(r.headers.location).toBe(session.returnUrl);
}

describe('Pin card page through the API (plan 4.4)', () => {
  it('end to end: card page, the one submission, 3-D Secure, the way back, one posting; a later webhook changes nothing', async () => {
    const { reference, bookingId, res, p, ref } = await checkout();
    expect(res.body.nextAction.url).toBe(`${WEB_ORIGIN}/pay/card/${ref}`);
    expect(ref).toMatch(/^cs_[0-9a-f]{32}$/);
    const v = await view(ref);
    expect(v.status).toBe(200);
    expect(v.headers['cache-control']).toBe('no-store');
    expect(v.body).toEqual({ status: 'open', amountMinor: p.amountMinor.toString(), currency: 'AUD', card: { publishableKey: acc.publishableKey, sandbox: true, scriptUrl: 'https://cdn.pinpayments.com/pin.hosted_fields.v1.js' } });
    await payWith3ds(ref);
    expect((await refresh(reference)).status).toBe(200);
    expect(await statusOf(p.id)).toBe('succeeded');
    expect(['deposit_paid', 'confirmed']).toContain((await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status);
    expect((await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey)).toEqual([`payment:${p.id}:succeeded`]);
    const s = await sessionOf(ref);
    expect(await deliverTo(acc, fake.chargeEvent(acc.secretKey, s.chargeRef!, new Date()))).toBe('processed');
    expect(await t.prisma.ledgerTransaction.count({ where: { bookingId } })).toBe(1);
    // What Pin received: the amount the core set, our metadata, 3-D Secure always on with no fallback, the callback.
    const post = fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/1/charges')).pop()!;
    const sent = JSON.parse(post.body!) as Record<string, unknown>;
    expect(sent).toMatchObject({ amount: Number(p.amountMinor), currency: 'AUD', capture: true, metadata: { mt_session: ref, mt_payment: p.id }, three_d_secure: { enabled: true, fallback_ok: false, callback_url: `${WEB_ORIGIN}/api/payments/card-sessions/${ref}/authenticated` } });
    expect(Object.keys(sent).sort()).toEqual(['amount', 'capture', 'card_token', 'currency', 'description', 'email', 'ip_address', 'metadata', 'three_d_secure']);
    // The card page of a finished session: no key, the way back.
    expect((await view(ref)).body).toEqual({ status: 'finished', amountMinor: p.amountMinor.toString(), currency: 'AUD', returnUrl: s.returnUrl });
  });

  it('card_session_paths_with_real_state_machine: decline, failed 3-D Secure after the sweep saw pending, abandoned, cancel, expiry', async () => {
    // Decline: the session and the attempt fail; the customer starts a new attempt, which works.
    const a = await checkout();
    const d = await submit(a.ref, fake.tokenise(acc.publishableKey, 'decline'));
    expect(d.body).toEqual({ next: 'redirect', url: (await sessionOf(a.ref)).returnUrl });
    await sync().run(a.p.id, 'sync');
    expect(await statusOf(a.p.id)).toBe('failed');
    expect((await sessionOf(a.ref)).failureCode).toBe('card_declined');
    expect((await submit(a.ref, fake.tokenise(acc.publishableKey, 'pay'))).status).toBe(409);
    expect((await c.pay(a.reference, { method: 'card' })).status).toBe(201);

    // 3-D Secure fails after the sweep already holds `pending`: pending -> failed.
    const b = await checkout();
    expect((await submit(b.ref, fake.tokenise(acc.publishableKey, 'pay'))).body.next).toBe('redirect');
    await sync().run(b.p.id, 'sync');
    expect(await statusOf(b.p.id)).toBe('pending');
    const sb = await sessionOf(b.ref);
    await back(b.ref, fake.finishChallenge(acc.secretKey, sb.chargeRef!, 'decline'));
    await sync().run(b.p.id, 'sync');
    expect(await statusOf(b.p.id)).toBe('failed');
    expect((await sessionOf(b.ref)).failureCode).toBe('card_declined');

    // Abandoned at the bank: pending stays pending; cancelling it (replacement) is refused while the charge may succeed.
    const e = await checkout();
    await submit(e.ref, fake.tokenise(acc.publishableKey, 'pay'));
    await sync().run(e.p.id, 'sync');
    await sync().run(e.p.id, 'cancel');
    expect(await statusOf(e.p.id)).toBe('pending');
    expect((await sessionOf(e.ref)).status).toBe('authenticating');

    // Cancel while open: cancelled; the card page then takes no card.
    const f = await checkout();
    await sync().run(f.p.id, 'cancel');
    expect(await statusOf(f.p.id)).toBe('cancelled');
    expect((await sessionOf(f.ref)).status).toBe('cancelled');
    expect((await submit(f.ref, fake.tokenise(acc.publishableKey, 'pay'))).status).toBe(409);

    // Expiry while open: the sweep asks, the session is cancelled, the attempt expires.
    const g = await checkout();
    await expireNow(g.p.id);
    await sync().run(g.p.id, 'expire');
    expect(await statusOf(g.p.id)).toBe('expired');
    expect((await sessionOf(g.ref)).status).toBe('cancelled');
  });

  it('unknown submission: never reopened, found by our reference, and a cancel while unknown is not a cancel (P2)', async () => {
    const a = await checkout();
    fake.switches.loseNextChargeAnswer = true;
    expect((await submit(a.ref, fake.tokenise(acc.publishableKey, 'pay_frictionless'))).body).toEqual({ next: 'wait' });
    expect((await sessionOf(a.ref)).status).toBe('submitting');
    // A second card on the same session: refused, no second POST.
    const posts = () => fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/1/charges')).length;
    const before = posts();
    expect((await submit(a.ref, fake.tokenise(acc.publishableKey, 'pay_frictionless'))).status).toBe(409);
    expect(posts()).toBe(before);
    // Search hidden for now (A8): a cancel does not cancel; the attempt stays live.
    fake.switches.searchHidden = true;
    await sync().run(a.p.id, 'cancel');
    expect(await statusOf(a.p.id)).toBe('requires_action');
    fake.switches.searchHidden = false;
    await sync().run(a.p.id, 'sync');
    expect(await statusOf(a.p.id)).toBe('succeeded');
    const s = await sessionOf(a.ref);
    expect([s.status, s.chargeRef !== null]).toEqual(['succeeded', true]);
    expect(await t.prisma.cardSessionCharge.count({ where: { sessionId: s.id } })).toBe(1);
  });

  it('late_success_after_unknown_submit_is_refundable: failed with an unknown outcome, then the money is seen and refunded from the panel; the refund answer is lost and its event comes first (finding 4)', async () => {
    const a = await checkout();
    fake.switches.loseNextChargeAnswer = true;
    fake.switches.searchHidden = true;
    expect((await submit(a.ref, fake.tokenise(acc.publishableKey, 'pay_frictionless'))).body).toEqual({ next: 'wait' });
    // The session's own expiry passes with nothing found: failed, outcome_unknown; the attempt fails.
    await expireSession(a.ref);
    await sync().run(a.p.id, 'sync');
    expect(await statusOf(a.p.id)).toBe('failed');
    expect(await sessionOf(a.ref)).toMatchObject({ status: 'failed', failureCode: 'outcome_unknown', chargeRef: null });
    // The customer pays again with a new attempt.
    expect((await c.pay(a.reference, { method: 'card' })).status).toBe(201);
    const b = await t.prisma.payment.findFirstOrThrow({ where: { bookingId: a.bookingId }, orderBy: { attemptNumber: 'desc' } });
    await payWith3ds(b.providerPaymentRef!);
    await sync().run(b.id, 'sync');
    expect(await statusOf(b.id)).toBe('succeeded');
    // The first charge appears (search catches up): its next read sees it, and its webhook records a late success.
    fake.switches.searchHidden = false;
    expect((await t.app.get(ProviderGateway).call(acc.id, 'retrieve', (p, ctx) => p.retrievePayment(ctx, { ref: a.ref })))?.status).toBe('succeeded');
    const s = await sessionOf(a.ref);
    expect([s.status, s.failureCode]).toEqual(['succeeded', 'outcome_unknown']);
    expect(await deliverTo(acc, fake.chargeEvent(acc.secretKey, s.chargeRef!, new Date()))).toBe('processed');
    expect(await statusOf(a.p.id)).toBe('succeeded');
    // Refunded from the panel as an overpayment; Pin makes the refund but its answer is lost.
    fake.switches.loseNextRefundAnswer = true;
    const version = (await t.prisma.payment.findUniqueOrThrow({ where: { id: a.p.id } })).version;
    const asked = await admin.post(`/admin/payments/payments/${a.p.id}/refunds`, { paymentVersion: version, purpose: 'overpayment_return', reason: 'Paid twice' }).set('Idempotency-Key', randomUUID());
    expect(asked.status).toBe(202);
    const [r] = await t.prisma.refund.findMany({ where: { paymentId: a.p.id } });
    expect(r).toMatchObject({ origin: 'app', providerRefundRef: null });
    const intent = await t.prisma.cardRefundIntent.findFirstOrThrow({ where: { refundId: r!.id } });
    expect(intent.status).toBe('submitting');
    const made = fake.refundsOf(acc.secretKey, s.chargeRef!);
    expect(made).toHaveLength(1);
    // refund.created first: matched to our refund through retrieveRefund, never recorded as external.
    expect(await deliverTo(acc, fake.refundEvent(acc.secretKey, made[0]!, new Date()))).toBe('processed');
    expect(await t.prisma.refund.findMany({ where: { paymentId: a.p.id } })).toMatchObject([{ id: r!.id, origin: 'app', providerRefundRef: made[0], status: 'pending' }]);
    fake.settleRefund(acc.secretKey, made[0]!);
    expect(await deliverTo(acc, fake.refundEvent(acc.secretKey, made[0]!, new Date()))).toBe('processed');
    expect(await t.prisma.refund.findMany({ where: { paymentId: a.p.id } })).toMatchObject([{ id: r!.id, status: 'succeeded' }]);
    expect(fake.refundsOf(acc.secretKey, s.chargeRef!)).toHaveLength(1);
    expect((await ledgerOf(t, a.bookingId)).filter((x) => x.kind === 'refund')).toHaveLength(1);
  });

  it('dashboard_refund_event_after_webhook_only_success and expiry_after_webhook_only_success_ends_succeeded (M3)', async () => {
    const a = await checkout();
    fake.switches.loseNextChargeAnswer = true;
    fake.switches.searchHidden = true;
    await submit(a.ref, fake.tokenise(acc.publishableKey, 'pay_frictionless'));
    // Only the webhook tells the core: succeeded; the store still says submitting.
    const charge = fake.chargesWith(acc.secretKey, a.ref)[0]!;
    expect(await deliverTo(acc, fake.chargeEvent(acc.secretKey, charge.token, new Date()))).toBe('processed');
    expect(await statusOf(a.p.id)).toBe('succeeded');
    expect((await sessionOf(a.ref)).status).toBe('submitting');
    // Oscar refunds on Pin's dashboard; the refund event names the charge, which resolves to our session.
    fake.switches.searchHidden = false;
    const rf = fake.dashboardRefund(acc.secretKey, charge.token, 100);
    expect(await deliverTo(acc, fake.refundEvent(acc.secretKey, rf, new Date()))).toBe('processed');
    expect(await t.prisma.refund.count({ where: { paymentId: a.p.id, origin: 'external', providerRefundRef: rf } })).toBe(1);
    expect(await sessionOf(a.ref)).toMatchObject({ status: 'succeeded', chargeRef: charge.token });
    // No sweep reads an attempt the core holds as succeeded; the first read after the session's expiry finds the money
    // first, so it ends succeeded, never failed (18 M3).
    const b = await checkout();
    fake.switches.loseNextChargeAnswer = true;
    fake.switches.searchHidden = true;
    await submit(b.ref, fake.tokenise(acc.publishableKey, 'pay_frictionless'));
    const bc = fake.chargesWith(acc.secretKey, b.ref)[0]!;
    expect(await deliverTo(acc, fake.chargeEvent(acc.secretKey, bc.token, new Date()))).toBe('processed');
    await expireSession(b.ref);
    fake.switches.searchHidden = false;
    expect((await t.app.get(ProviderGateway).call(acc.id, 'retrieve', (p, ctx) => p.retrievePayment(ctx, { ref: b.ref })))?.status).toBe('succeeded');
    expect(await sessionOf(b.ref)).toMatchObject({ status: 'succeeded', chargeRef: bc.token, failureCode: null });
  });

  it('submit_refused_unless_attempt_live_booking_payable_account_active, and finish_authentication_allowed_on_paused_account', async () => {
    const a = await checkout();
    await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'paused' } });
    const r = await submit(a.ref, fake.tokenise(acc.publishableKey, 'pay'));
    expect(r.status).toBe(409);
    expect((await sessionOf(a.ref)).status).toBe('open');
    // The card page of a paused account shows no card fields.
    expect((await view(a.ref)).body.card).toBeUndefined();
    await activate(acc.id);
    // Started while active, finished while paused: the way back only reads.
    const b = await checkout();
    await submit(b.ref, fake.tokenise(acc.publishableKey, 'pay'));
    const sb = await sessionOf(b.ref);
    const st = fake.finishChallenge(acc.secretKey, sb.chargeRef!, 'pay');
    await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'paused' } });
    expect((await back(b.ref, st)).status).toBe(303);
    expect((await sessionOf(b.ref)).status).toBe('succeeded');
    await activate(acc.id);
  });

  it('card_data_never_reaches_api (card session): any other field is a 422 and nothing is written', async () => {
    const a = await checkout();
    for (const extra of [{ number: '4200000000000000' }, { cvc: '123' }, { expiry: '12/30' }, { amountMinor: '1' }, { returnUrl: 'https://evil.example' }]) {
      const r = await submit(a.ref, fake.tokenise(acc.publishableKey, 'pay'), extra);
      expect(r.status, JSON.stringify(extra)).toBe(422);
    }
    expect((await submit(a.ref, 'not-a-token')).status).toBe(422);
    expect((await sessionOf(a.ref)).status).toBe('open');
    expect(fake.requests.some((x) => x.body?.includes('4200000000000000'))).toBe(false);
  });

  it('card_session_view_exposes_only_publishable_key: never the secret or webhook key, and never in the panel', async () => {
    const a = await checkout();
    const v = await view(a.ref);
    const text = JSON.stringify(v.body);
    expect(text).toContain(acc.publishableKey);
    expect(text.includes(acc.secretKey) || text.includes(acc.secret)).toBe(false);
    const list = await admin.get('/admin/payments/provider-accounts');
    expect(list.status).toBe(200);
    const all = JSON.stringify(list.body) + JSON.stringify((await admin.get('/admin/payments/adapters')).body);
    for (const k of [acc.publishableKey, acc.secretKey, acc.secret]) expect(all.includes(k)).toBe(false);
    // Unknown, malformed and foreign references: the same 404.
    for (const ref of [`cs_${randomBytes(16).toString('hex')}`, 'cs_x']) expect([404, 422]).toContain((await view(ref)).status);
  });

  it('authenticated_callback_redirects_only_to_stored_return_url; card_session_endpoints_rate_limited', async () => {
    const a = await checkout();
    const s = await sessionOf(a.ref);
    expect((await back(a.ref, 'se_aaaaaaaaaaaaaaaa')).headers.location).toBe(s.returnUrl);
    expect((await t.http().get(`/payments/card-sessions/${a.ref}/authenticated?session_token=se_aaaaaaaaaaaa&next=https://evil.example`)).headers.location).toBe(s.returnUrl);
    expect((await back(`cs_${randomBytes(16).toString('hex')}`)).headers.location).toBe(`${WEB_ORIGIN}/`);
    const t2 = await makeApp({ CARD_SUBMITS_PER_10_MIN_PER_IP: '2', CARD_AUTHENTICATED_PER_10_MIN_PER_IP: '2' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await t2.http().post('/payments/card-sessions/submit').set(STATE_HEADERS).send({ ref: `cs_${randomBytes(16).toString('hex')}`, cardToken: `card_${randomBytes(8).toString('hex')}` })).status);
      expect(codes).toEqual([404, 404, 429]);
    } finally {
      await t2.app.close();
    }
  });

  it('webhook_duplicate_out_of_order_bad_signature (pin): forged refused, duplicate once, an older failure after success changes nothing', async () => {
    const a = await checkout();
    await payWith3ds(a.ref);
    const s = await sessionOf(a.ref);
    const ok = fake.chargeEvent(acc.secretKey, s.chargeRef!, new Date());
    const forged = { ...ok, headers: { ...ok.headers, 'pin-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` } };
    expect((await sendWebhook(t, acc, forged)).status).toBe(400);
    expect(await deliverTo(acc, ok)).toBe('processed');
    expect((await sendWebhook(t, acc, ok)).body.duplicate).toBe(true);
    const older = fake.event(acc.secretKey, 'charge.failed', { ...fake.charge(acc.secretKey, s.chargeRef!), success: false, captured: false, status_message: 'Failed' }, new Date());
    expect(await deliverTo(acc, older)).toBe('processed');
    expect(await statusOf(a.p.id)).toBe('succeeded');
    // A dispute event: a task for Oscar, nothing applied.
    const dispute = fake.event(acc.secretKey, 'dispute.evidence_required', { token: 'dis_contract', charge: s.chargeRef }, new Date());
    expect(await deliverTo(acc, dispute)).toBe('ignored');
  });

  it('second_charge_on_session_surfaces_task and no_surcharge_by_payment_method (task 4.4)', async () => {
    const a = await checkout();
    fake.switches.loseNextChargeAnswer = true;
    await submit(a.ref, fake.tokenise(acc.publishableKey, 'pay_frictionless'));
    const extra = fake.extraCharge(acc.secretKey, a.ref, 500);
    await sync().run(a.p.id, 'sync');
    expect(await statusOf(a.p.id)).toBe('succeeded');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:card_session_extra_charge:${extra}`, status: 'open' } })).toBe(1);
    expect(await t.prisma.cardSessionCharge.count({ where: { sessionId: (await sessionOf(a.ref)).id } })).toBe(2);
    // The amount on the card page and in the charge is the attempt's: no surcharge for paying by card here.
    const b = await checkout();
    expect((await view(b.ref)).body.amountMinor).toBe(b.p.amountMinor.toString());
    await submit(b.ref, fake.tokenise(acc.publishableKey, 'pay'));
    const post = fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/1/charges')).pop()!;
    expect((JSON.parse(post.body!) as { amount: number }).amount).toBe(Number(b.p.amountMinor));
  });

  it('card_session_trigger_transitions: the database refuses every way back and every edit of fixed columns', async () => {
    const a = await checkout();
    const pg = (await import('pg')).default;
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      const tryUpdate = async (set: string) => {
        try {
          await app.query(`UPDATE card_sessions SET ${set}, version = version + 1 WHERE ref = $1`, [a.ref]);
          return 'ok';
        } catch (err) {
          return (err as { message: string }).message;
        }
      };
      expect(await tryUpdate(`status = 'succeeded'`)).toMatch(/card_session_transition|succeeded_check/);
      expect(await tryUpdate(`"amountMinor" = 1`)).toMatch(/card_session_fixed_column/);
      expect(await tryUpdate(`status = 'submitting', "submittedAt" = now()`)).toBe('ok');
      expect(await tryUpdate(`status = 'open', "submittedAt" = NULL`)).toMatch(/card_session_(transition|submitted_once)/);
      expect(await tryUpdate(`"submittedAt" = now() + interval '1 second'`)).toMatch(/card_session_submitted_once/);
      await expect(app.query(`DELETE FROM card_sessions WHERE ref = $1`, [a.ref])).rejects.toThrow();
      await expect(app.query(`UPDATE card_session_charges SET success = true`)).rejects.toThrow();
    } finally {
      await app.end();
    }
  });
});
