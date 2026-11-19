// The card session store on the database (plan docs/plans/4.4-au-card-gateway.md, sections 11, 12.1 and review finding
// 7): the whole contract suite for Pin through PrismaCardSessionStore (one provider account per context, so the mode
// trigger runs), then what only a database shows: concurrent submissions and cancels, concurrent refund retries, and
// the triggers refusing every way back.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaCardSessionStore } from '../../../src/modules/payments/core/card-sessions/prisma-store';
import { credentialsAad, webhookSecretAad } from '../../../src/modules/payments/core/gateway';
import type { ProviderContext } from '../../../src/modules/payments/core/provider';
import { webhookPathTokenHash } from '../../../src/modules/payments/core/webhooks.service';
import { TasksService } from '../../../src/platform/common/tasks/tasks.service';
import { TestApp, makeApp } from '../../support/auth';
import { describePaymentProviderContract } from '../../contract/payment-provider.contract';
import { FakePin } from '../../contract/subjects/pin-fake';
import { pinLocalSubject } from '../../contract/subjects/pin';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let store: PrismaCardSessionStore;
const fake = new FakePin();

beforeAll(async () => {
  t = await makeApp();
  store = new PrismaCardSessionStore(t.prisma, t.app.get(TasksService));
});
afterAll(async () => {
  await t.prisma.providerAccount.updateMany({ where: { adapterKey: 'pin_payments', status: 'active' }, data: { status: 'paused' } });
});

/** A paused test-mode Pin account row for a context (sessions and intents reference it; the trigger checks its mode). */
async function accountRow(keys: ReturnType<FakePin['newAccount']>): Promise<ProviderContext> {
  const id = randomUUID();
  const creds = t.box.encrypt(JSON.stringify({ secretKey: keys.secretKey, publishableKey: keys.publishableKey }), credentialsAad(id));
  const secret = t.box.encrypt(keys.webhookKey, webhookSecretAad(id));
  await t.prisma.providerAccount.create({
    data: {
      id, adapterKey: 'pin_payments', displayName: `Pin store ${id.slice(0, 8)}`, mode: 'test', status: 'paused',
      credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion, webhookSecretCiphertext: secret.ciphertext, webhookKeyVersion: secret.keyVersion,
      webhookPathTokenHash: webhookPathTokenHash(t.config.AUTH_HMAC_KEY, randomBytes(32).toString('base64url')),
    },
  });
  return { accountId: id, mode: 'test', credentials: { secretKey: keys.secretKey, publishableKey: keys.publishableKey }, webhookSecret: keys.webhookKey };
}

// The store is built in beforeAll; the subject reads it lazily through this proxy.
const lazyStore = new Proxy({} as PrismaCardSessionStore, { get: (_o, k) => (store as unknown as Record<string | symbol, unknown>)[k] instanceof Function ? (store as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[k]!.bind(store) : (store as unknown as Record<string | symbol, unknown>)[k] });
const subject = pinLocalSubject(fake, lazyStore, accountRow);
describePaymentProviderContract('pin_payments on the database store', subject);

const input = (over: { amountMinor?: bigint } = {}) => ({
  amount: { amountMinor: over.amountMinor ?? 1500n, currency: 'AUD' }, method: 'card' as const, idempotencyKey: `store:${randomUUID()}`,
  metadata: { paymentId: randomUUID(), bookingId: randomUUID() }, returnUrl: 'https://example.com/payments/return', customerCountry: 'AU', createdAt: new Date(),
});
const PAYER = { email: 'payer@example.test', ipAddress: '203.0.113.10' };

describe('card session store on the database: concurrency and triggers (plan 4.4, 18 finding 7)', () => {
  it('one_post_per_session_ever: ten concurrent submissions of one session make exactly one charge request', async () => {
    const ctx = await subject.context();
    const p = await subject.provider.createPayment(ctx, input());
    const posts = () => fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/1/charges')).length;
    const before = posts();
    const results = await Promise.all(Array.from({ length: 10 }, () => subject.provider.submitCard(ctx, p.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay_frictionless'), PAYER)));
    expect(posts() - before).toBe(1);
    expect(results.filter((r) => r.next.kind !== 'not_open')).toHaveLength(1);
    expect((await store.byRef(ctx.accountId, p.ref))?.status).toBe('succeeded');
  });

  it('concurrent cancel and submit: one wins; a cancelled session is never charged, a charged one never cancelled', async () => {
    for (let i = 0; i < 5; i++) {
      const ctx = await subject.context();
      const p = await subject.provider.createPayment(ctx, input());
      const [cancelled, submitted] = await Promise.all([
        subject.provider.cancelPayment(ctx, p.ref, 'k'),
        subject.provider.submitCard(ctx, p.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay_frictionless'), PAYER),
      ]);
      const s = (await store.byRef(ctx.accountId, p.ref))!;
      if (s.status === 'cancelled') {
        expect(submitted.next.kind).toBe('not_open');
        expect(fake.chargesWith(ctx.credentials.secretKey!, p.ref)).toHaveLength(0);
      } else {
        expect(s.status).toBe('succeeded');
        expect(['requires_action', 'succeeded']).toContain(cancelled.status);
      }
    }
  });

  it('concurrent refund retries with one key post once', async () => {
    const ctx = await subject.context();
    const p = await subject.provider.createPayment(ctx, input());
    await subject.provider.submitCard(ctx, p.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay_frictionless'), PAYER);
    const key = `refund:${randomUUID()}`;
    const ask = () => subject.provider.createRefund(ctx, { paymentRef: p.ref, amount: { amountMinor: 500n, currency: 'AUD' }, idempotencyKey: key, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() }).catch((e: unknown) => e);
    await Promise.all(Array.from({ length: 6 }, ask));
    const charge = (await store.byRef(ctx.accountId, p.ref))!.chargeRef!;
    expect(fake.refundsOf(ctx.credentials.secretKey!, charge)).toHaveLength(1);
    const again = await ask();
    expect((again as { ref?: string }).ref).toBe(fake.refundsOf(ctx.credentials.secretKey!, charge)[0]);
  });

  it('card_session_charges_append_only, card_session_mode_matches_account and the intent trigger', async () => {
    const ctx = await subject.context();
    const p = await subject.provider.createPayment(ctx, input());
    await subject.provider.submitCard(ctx, p.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay_frictionless'), PAYER);
    await expect(t.prisma.cardSessionCharge.updateMany({ where: { providerAccountId: ctx.accountId }, data: { success: false } })).rejects.toThrow();
    await expect(t.prisma.cardSession.create({ data: { ref: `cs_${randomBytes(16).toString('hex')}`, providerAccountId: ctx.accountId, mode: 'live', idempotencyKey: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID(), currency: 'AUD', amountMinor: 100n, returnUrl: 'https://example.com/r', expiresAt: new Date() } })).rejects.toThrow();
    const i = await store.createIntent({ accountId: ctx.accountId, mode: 'test', idempotencyKey: randomUUID(), refundId: randomUUID(), chargeRef: `ch_${'a'.repeat(20)}`, amountMinor: 100n, currency: 'AUD' });
    await expect(t.prisma.cardRefundIntent.update({ where: { id: i.id }, data: { status: 'bound', refundRef: `rf_${'a'.repeat(20)}`, version: 2 } })).rejects.toThrow();
    await expect(t.prisma.cardRefundIntent.update({ where: { id: i.id }, data: { amountMinor: 1n, version: 2 } })).rejects.toThrow();
  });
});
