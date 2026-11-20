// The eWAY adapter inside the API, against the fake eWAY and the database card session store (plan
// docs/plans/9.1-eway.md, sections 6, 7, 10, 15 and 20): checkout to the Secure Fields page, 3-D Secure before the one
// charge, the real payment state machine, lost answers and late money, duplicates, refunds, no webhooks, and what the
// card page and eWAY receive.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EwayGateway } from '../../../src/modules/payments/adapters/eway/eway';
import { PrismaCardSessionStore } from '../../../src/modules/payments/core/card-sessions/prisma-store';
import { CardSessionProvider } from '../../../src/modules/payments/core/card-sessions/provider';
import { CardSessionsService } from '../../../src/modules/payments/core/card-sessions/card-sessions.service';
import { PaymentAttemptSyncService } from '../../../src/modules/payments/core/attempt-sync.service';
import { ReconciliationService } from '../../../src/modules/payments/core/reconciliation.service';
import { credentialsAad, webhookSecretAad, ProviderGateway } from '../../../src/modules/payments/core/gateway';
import type { PaymentProvider } from '../../../src/modules/payments/core/provider';
import { PaymentAdapterRegistry } from '../../../src/modules/payments/core/registry';
import { insertDefaultRules } from '../../../src/modules/payments/core/routing-admin.service';
import { webhookPathTokenHash } from '../../../src/modules/payments/core/webhooks.service';
import { SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { TasksService } from '../../../src/platform/common/tasks/tasks.service';
import { STATE_HEADERS, TestApp, WEB_ORIGIN, makeApp } from '../../support/auth';
import { cleanBookingEvents, staffCancel } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { ledgerOf } from '../../support/ledger';
import { PayingCustomer, approvedBooking, cleanPayments, onlyAccount, payingCustomer, paymentsStaff, resetGatewayHealth, sendWebhook } from '../../support/payments';
import { pricedWorld } from '../../support/pricing';
import { FakeEway } from '../../contract/subjects/eway-fake';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let c: PayingCustomer;
const fake = new FakeEway();
let registered: PaymentProvider | undefined;
interface EwayAccount { id: string; pathToken: string; apiKey: string; apiPassword: string; publicApiKey: string }
let acc: EwayAccount;

async function ewayAccount(): Promise<EwayAccount> {
  const keys = fake.newAccount();
  const id = randomUUID();
  const pathToken = randomBytes(32).toString('base64url');
  const creds = t.box.encrypt(JSON.stringify(keys), credentialsAad(id));
  // As the panel creates it: a generated webhook secret (plan 9.1, D7), unused since eWAY sends nothing.
  const secret = t.box.encrypt(randomBytes(32).toString('hex'), webhookSecretAad(id));
  const registry = t.app.get(PaymentAdapterRegistry);
  await t.prisma.$transaction(async (tx) => {
    const row = await tx.providerAccount.create({
      data: {
        id, adapterKey: 'eway', displayName: `eWAY ${id.slice(0, 8)}`, mode: 'test', status: 'active', lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date(),
        credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion, webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion, webhookPathTokenHash: webhookPathTokenHash(t.config.AUTH_HMAC_KEY, pathToken),
      },
      select: { createdAt: true },
    });
    await insertDefaultRules(tx, id, registry.get('eway')!.manifest, row.createdAt);
  });
  return { id, pathToken, ...keys };
}

const setStatus = (status: 'active' | 'paused' | 'retired') => t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status, ...(status === 'active' ? { lastConnectionTestResult: 'ok', lastConnectionTestAt: new Date() } : {}) } });

beforeAll(async () => {
  t = await makeApp();
  const byKey = (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey;
  registered = byKey.get('eway');
  byKey.set('eway', new CardSessionProvider(new EwayGateway({ transport: fake.transport }), new PrismaCardSessionStore(t.prisma, t.app.get(TasksService)), { cardPageOrigin: WEB_ORIGIN, usable: true }));
  admin = await paymentsStaff(t);
  acc = await ewayAccount();
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
beforeEach(async () => {
  await resetGatewayHealth(t);
  await setStatus('active');
  await onlyAccount(t, acc.id);
  for (const k of Object.keys(fake.next)) delete (fake.next as Record<string, unknown>)[k];
});
afterAll(async () => {
  if (registered) (t.app.get(PaymentAdapterRegistry) as unknown as { byKey: Map<string, PaymentProvider> }).byKey.set('eway', registered);
  await t.prisma.providerAccount.updateMany({ where: { adapterKey: 'eway', status: 'active' }, data: { status: 'paused' } });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const sync = () => t.app.get(PaymentAttemptSyncService);
const statusOf = async (id: string) => (await t.prisma.payment.findUniqueOrThrow({ where: { id } })).status;
const sessionOf = (ref: string) => t.prisma.cardSession.findUniqueOrThrow({ where: { ref } });
const view = (ref: string) => t.http().post('/payments/card-sessions/view').set(STATE_HEADERS).send({ ref });
const submit = (ref: string, secureFieldCode: string, extra: Record<string, unknown> = {}) => t.http().post('/payments/card-sessions/secure-fields/submit').set(STATE_HEADERS).send({ ref, secureFieldCode, ...extra });
const authorise = (ref: string, accessCode: string, secureFieldCode: string) => t.http().post('/payments/card-sessions/secure-fields/authorise').set(STATE_HEADERS).send({ ref, accessCode, secureFieldCode });
const refresh = (reference: string) => t.http().post(`/booking-requests/${reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});
const tasks = (prefix: string) => t.prisma.task.findMany({ where: { sourceRef: { startsWith: prefix } } });

/** Moves session times, as the owner with the guard off inside one transaction (as pin-flow's expireSession). */
async function shiftSession(ref: string, set: string): Promise<void> {
  const pg = (await import('pg')).default;
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('ALTER TABLE card_sessions DISABLE TRIGGER card_sessions_guard');
    await owner.query(`UPDATE card_sessions SET ${set} WHERE ref = $1`, [ref]);
    await owner.query('ALTER TABLE card_sessions ENABLE TRIGGER card_sessions_guard');
    await owner.query('COMMIT');
  } finally {
    await owner.end();
  }
}

async function checkout(phone: string | null = '+61400000001') {
  const w = await pricedWorld(admin);
  const { reference, bookingId } = await approvedBooking(t, admin, w, c);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { customerId: true } });
  await t.prisma.customer.update({ where: { id: b.customerId }, data: { phone } });
  const res = await c.pay(reference, { method: 'card' });
  expect(res.status).toBe(201);
  const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId }, orderBy: { attemptNumber: 'desc' } });
  return { reference, bookingId, res, p, ref: p.providerPaymentRef! };
}

/** The customer on the Secure Fields page: the code, the challenge, the authorisation. */
async function pay(ref: string, opts: { outcome?: 'pay' | 'decline'; pass?: boolean } = {}) {
  const code = fake.tokenise(acc.publicApiKey, opts.outcome ?? 'pay');
  const s = await submit(ref, code);
  expect(s.status).toBe(200);
  expect(s.body.next).toBe('authenticate');
  fake.challenge(acc.apiKey, s.body.accessCode, opts.pass ?? true);
  return { code, accessCode: s.body.accessCode as string, answer: await authorise(ref, s.body.accessCode, code) };
}

describe('eWAY Secure Fields page through the API (plan 9.1)', () => {
  it('end to end: Secure Fields, 3-D Secure first, the one charge with our reference, one posting', async () => {
    const { reference, bookingId, res, p, ref } = await checkout();
    expect(res.body.nextAction.url).toBe(`${WEB_ORIGIN}/pay/secure-fields/${ref}`);
    const v = await view(ref);
    expect(v.body).toEqual({ status: 'open', amountMinor: p.amountMinor.toString(), currency: 'AUD', card: { publishableKey: acc.publicApiKey, sandbox: true, scriptUrl: 'https://secure.ewaypayments.com/scripts/eWAY.min.js' } });
    const { answer } = await pay(ref);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ next: 'redirect', url: (await sessionOf(ref)).returnUrl });
    expect((await refresh(reference)).status).toBe(200);
    expect(await statusOf(p.id)).toBe('succeeded');
    expect((await ledgerOf(t, bookingId)).map((x) => x.idempotencyKey)).toEqual([`payment:${p.id}:succeeded`]);
    const tx = fake.transactionsWith(acc.apiKey, ref);
    expect(tx).toHaveLength(1);
    expect(tx[0]!.TotalAmount).toBe(Number(p.amountMinor));
    expect(fake.chargePosts(acc.apiKey, ref)).toBe(1);
    const s = await sessionOf(ref);
    expect([s.flow, s.chargeRef, s.status]).toEqual(['before_charge', `ewt_${tx[0]!.TransactionID}`, 'succeeded']);
  });

  it('payer_details_from_the_payer: no phone, no 3-D Secure; nothing is stored or echoed (m9)', async () => {
    {
      const { ref } = await checkout(null);
      const r = await submit(ref, fake.tokenise(acc.publicApiKey, 'pay'));
      expect([r.status, r.body.code]).toEqual([409, 'card_session_phone_required']);
      expect((await sessionOf(ref)).status).toBe('open');
      const bad = await authorise(ref, 'not a code!', 'sfc_short');
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(bad.body)).not.toContain('sfc_short');
      expect(JSON.stringify(bad.body)).not.toContain('not a code!');
      expect(JSON.stringify(r.body)).not.toContain('+614');
    }
    const { ref } = await checkout();
    await pay(ref);
    const row = await t.prisma.cardSession.findUniqueOrThrow({ where: { ref } });
    expect(JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/\+61400000001|example\.test|sfc_/);
  });

  it('each card page posts to its own flow: the Pin route refuses an eWAY session', async () => {
    const { ref } = await checkout();
    const r = await t.http().post('/payments/card-sessions/submit').set(STATE_HEADERS).send({ ref, cardToken: `card_${'a'.repeat(20)}` });
    expect(r.status).toBe(404);
  });

  it('authorise_with_other_card_or_access_code_refused, and a failed challenge never charges', async () => {
    const a = await checkout();
    const code = fake.tokenise(acc.publicApiKey, 'pay');
    const s = await submit(a.ref, code);
    fake.challenge(acc.apiKey, s.body.accessCode, true);
    expect((await authorise(a.ref, s.body.accessCode, fake.tokenise(acc.publicApiKey, 'pay'))).status).toBe(409);
    expect((await authorise(a.ref, `AC${'0'.repeat(30)}`, code)).status).toBe(409);
    expect(fake.chargePosts(acc.apiKey, a.ref)).toBe(0);
    expect((await sessionOf(a.ref)).status).toBe('authenticating');

    const d = await checkout();
    const { answer } = await pay(d.ref, { pass: false });
    expect(answer.body.next).toBe('redirect');
    expect((await sessionOf(d.ref)).failureCode).toBe('card_not_authenticated');
    expect(fake.chargePosts(acc.apiKey, d.ref)).toBe(0);
    await sync().run(d.p.id, 'sync');
    expect(await statusOf(d.p.id)).toBe('failed');
  });

  it('not_enrolled_never_charges', async () => {
    const { ref, p } = await checkout();
    fake.next.notEnrolled = true;
    const code = fake.tokenise(acc.publicApiKey, 'pay');
    const s = await submit(ref, code);
    const r = await authorise(ref, s.body.accessCode, code);
    expect(r.body.next).toBe('redirect');
    expect((await sessionOf(ref)).failureCode).toBe('card_not_authenticated');
    expect(fake.chargePosts(acc.apiKey, ref)).toBe(0);
    await sync().run(p.id, 'sync');
    expect(await statusOf(p.id)).toBe('failed');
  });

  it('cancel_before_charge_is_final and expired_challenge_is_cancelled_not_pending', async () => {
    const a = await checkout();
    const code = fake.tokenise(acc.publicApiKey, 'pay');
    const s = await submit(a.ref, code);
    await sync().run(a.p.id, 'cancel');
    expect(await statusOf(a.p.id)).toBe('cancelled');
    fake.challenge(acc.apiKey, s.body.accessCode, true);
    expect((await authorise(a.ref, s.body.accessCode, code)).status).toBe(409);
    expect(fake.chargePosts(acc.apiKey, a.ref)).toBe(0);

    const b = await checkout();
    await submit(b.ref, fake.tokenise(acc.publicApiKey, 'pay'));
    await sync().run(b.p.id, 'sync');
    expect(await statusOf(b.p.id)).toBe('requires_action');
    await shiftSession(b.ref, `"expiresAt" = clock_timestamp() - interval '1 minute'`);
    await sync().run(b.p.id, 'sync');
    expect(await statusOf(b.p.id)).toBe('cancelled');
    expect((await sessionOf(b.ref)).status).toBe('cancelled');
  });

  it('unknown_charge_never_reposted: a lost answer is found by the read; a request never processed waits out the grace (M5)', async () => {
    const a = await checkout();
    fake.next.lose = 'charge';
    const { answer } = await pay(a.ref);
    expect(answer.body).toEqual({ next: 'wait' });
    expect((await refresh(a.reference)).status).toBe(200);
    expect(await statusOf(a.p.id)).toBe('succeeded');
    expect(fake.chargePosts(acc.apiKey, a.ref)).toBe(1);

    const b = await checkout();
    fake.next.timeoutBefore = 'charge';
    expect((await pay(b.ref)).answer.body).toEqual({ next: 'wait' });
    // The request never reached eWAY (timeout before it): nothing was received, and nothing is sent again.
    expect(fake.chargePosts(acc.apiKey, b.ref)).toBe(0);
    await shiftSession(b.ref, `"expiresAt" = clock_timestamp() - interval '1 minute'`);
    await sync().run(b.p.id, 'sync');
    // Past expiry but inside the grace: still live (P2 blocks a second payment; the sweeps read it again).
    expect((await sessionOf(b.ref)).status).toBe('submitting');
    expect(await statusOf(b.p.id)).toBe('requires_action');
    await shiftSession(b.ref, `"submittedAt" = clock_timestamp() - interval '16 minutes'`);
    await sync().run(b.p.id, 'sync');
    expect((await sessionOf(b.ref)).failureCode).toBe('outcome_unknown');
    expect(await statusOf(b.p.id)).toBe('failed');
    expect(fake.chargePosts(acc.apiKey, b.ref)).toBe(0);
    // Late money (it did reach eWAY after all): a read finds it and it can be refunded.
    fake.extraTransaction(acc.apiKey, b.ref, Number(b.p.amountMinor));
    const read = await t.app.get(ProviderGateway).call(acc.id, 'retrieve', (pr, ctx) => pr.retrievePayment(ctx, { ref: b.ref }));
    expect(read?.status).toBe('succeeded');
    const r = await t.app.get(ProviderGateway).call(acc.id, 'refund', (pr, ctx) => pr.createRefund(ctx, {
      paymentRef: b.ref, amount: { amountMinor: b.p.amountMinor, currency: 'AUD' }, idempotencyKey: `late:${randomUUID()}`, metadata: { refundId: randomUUID(), paymentId: b.p.id, bookingId: b.bookingId }, createdAt: new Date(),
    }));
    expect(r.status).toBe('succeeded');
    // Plan 9.1, 20 M5: once the attempt is no longer live, the daily reconciliation is what rereads it. It reports the
    // late money with a task; it does not record it (staff do, with the refund above or a manual registration).
    const run = await t.app.get(ReconciliationService).runAccount(acc.id, { now: new Date(Date.now() + 2 * 86_400_000) });
    expect(run?.differences.map((d) => [d.code, d.entityId])).toContainEqual(['payment_status_differs', b.p.id]);
    expect(await statusOf(b.p.id)).toBe('failed');
  });

  it('duplicate_after_unknown_reveals_earlier_charge (M4)', async () => {
    const a = await checkout();
    fake.next.lose = 'charge';
    fake.next.queryHides = 2;
    await pay(a.ref);
    await shiftSession(a.ref, `"expiresAt" = clock_timestamp() - interval '1 minute', "submittedAt" = clock_timestamp() - interval '16 minutes'`);
    await sync().run(a.p.id, 'sync');
    expect((await sessionOf(a.ref)).failureCode).toBe('outcome_unknown');
    expect(await statusOf(a.p.id)).toBe('failed');
    // The customer pays again; eWAY refuses it as a duplicate of what it already took.
    const res = await c.pay(a.reference, { method: 'card' });
    expect(res.status).toBe(201);
    const p2 = await t.prisma.payment.findFirstOrThrow({ where: { bookingId: a.bookingId }, orderBy: { attemptNumber: 'desc' } });
    fake.next.response = 'D4494';
    const { answer } = await pay(p2.providerPaymentRef!);
    expect(answer.body.next).toBe('redirect');
    expect((await sessionOf(p2.providerPaymentRef!)).failureCode).toBe('provider_rejected');
    expect(await tasks(`payments:card_duplicate_transaction:${p2.providerPaymentRef}`)).toHaveLength(1);
    // The earlier session was searched again and its charge found.
    expect((await sessionOf(a.ref)).status).toBe('succeeded');
  });

  it('authorise on a paused or retired account sends nothing', async () => {
    const main = acc;
    for (const status of ['paused', 'retired'] as const) {
      // A retired account never comes back: that case uses an account of its own.
      if (status === 'retired') {
        acc = await ewayAccount();
        await onlyAccount(t, acc.id);
      }
      const a = await checkout();
      const code = fake.tokenise(acc.publicApiKey, 'pay');
      const s = await submit(a.ref, code);
      fake.challenge(acc.apiKey, s.body.accessCode, true);
      await setStatus(status);
      const r = await authorise(a.ref, s.body.accessCode, code);
      expect(r.status, status).toBeGreaterThanOrEqual(400);
      expect(fake.chargePosts(acc.apiKey, a.ref)).toBe(0);
      if (status === 'paused') await setStatus('active');
    }
    acc = main;
    await onlyAccount(t, acc.id);
  });

  it('authorise_after_booking_cancelled_refused: the challenge passed, the booking cancelled by staff, nothing is charged', async () => {
    const a = await checkout();
    const code = fake.tokenise(acc.publicApiKey, 'pay');
    const s = await submit(a.ref, code);
    fake.challenge(acc.apiKey, s.body.accessCode, true);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: a.bookingId }, select: { version: true } });
    const cancelled = await staffCancel(admin, a.bookingId, { version: b.version, reason: 'Customer changed plans' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(300);
    const r = await authorise(a.ref, s.body.accessCode, code);
    expect(r.status).toBe(409);
    expect(fake.chargePosts(acc.apiKey, a.ref)).toBe(0);
    expect(await statusOf(a.p.id)).not.toBe('succeeded');
  });

  it('approvals other than A2000 are charges; a different amount opens the mismatch task (M3, A10)', async () => {
    for (const code of ['A2008', 'A2010', 'A2011', 'A2016']) {
      const a = await checkout();
      fake.next.approval = code;
      if (code === 'A2010') fake.next.chargedAmount = Number(a.p.amountMinor) - 100;
      await pay(a.ref);
      expect((await sessionOf(a.ref)).status, code).toBe('succeeded');
      await refresh(a.reference);
      if (code === 'A2010') {
        expect(await tasks(`payments:mismatch:${a.p.id}`)).toHaveLength(1);
        expect(await statusOf(a.p.id)).not.toBe('succeeded');
      } else {
        expect(await statusOf(a.p.id), code).toBe('succeeded');
      }
    }
  });

  it('webhook_to_eway_account_rejected_and_recorded', async () => {
    const r = await sendWebhook(t, { ...acc, secret: '' }, { body: Buffer.from(JSON.stringify({ TransactionID: 1, TransactionStatus: true })), headers: { 'content-type': 'application/json' }, eventId: 'x' });
    expect(r.status).toBe(400);
    const rej = await t.prisma.webhookRejection.findFirstOrThrow({ where: { providerAccountId: acc.id }, orderBy: { receivedAt: 'desc' } });
    expect(rej.reason).toBe('malformed');
  });

  it('a reference eWAY holds twice: task, then staff bind it from the console (m10)', async () => {
    const a = await checkout();
    fake.next.lose = 'charge';
    await pay(a.ref);
    const mine = fake.transactionsWith(acc.apiKey, a.ref)[0]!;
    fake.notUnique.add(a.ref);
    await expect(sync().run(a.p.id, 'sync')).rejects.toBeTruthy();
    expect(await tasks(`payments:card_reference_not_unique:${a.ref}`)).toHaveLength(1);
    const svc = t.app.get(CardSessionsService);
    await expect(svc.bindByStaff(SYSTEM_ACTOR, a.ref, '1')).rejects.toBeTruthy();
    expect((await svc.bindByStaff(SYSTEM_ACTOR, a.ref, String(mine.TransactionID))).status).toBe('succeeded');
    fake.notUnique.delete(a.ref);
    await sync().run(a.p.id, 'sync');
    expect(await statusOf(a.p.id)).toBe('succeeded');
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.cardSession.bound' } })).toBeGreaterThan(0);
  });
});
