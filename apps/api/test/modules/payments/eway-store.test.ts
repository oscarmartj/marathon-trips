// eWAY's card sessions on the database (plan docs/plans/9.1-eway.md, sections 11, 12 and 20 M2, m8): the whole contract
// suite through PrismaCardSessionStore, the one charge under concurrency, and the 0041 triggers: each flow its own edges
// and reference shapes, fixed at insert from the account's adapter.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaCardSessionStore } from '../../../src/modules/payments/core/card-sessions/prisma-store';
import { credentialsAad } from '../../../src/modules/payments/core/gateway';
import type { ProviderContext } from '../../../src/modules/payments/core/provider';
import { webhookPathTokenHash } from '../../../src/modules/payments/core/webhooks.service';
import { TasksService } from '../../../src/platform/common/tasks/tasks.service';
import { TestApp, makeApp } from '../../support/auth';
import { describePaymentProviderContract } from '../../contract/payment-provider.contract';
import { FakeEway } from '../../contract/subjects/eway-fake';
import { EWAY_PAYER, ewayLocalSubject } from '../../contract/subjects/eway';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let store: PrismaCardSessionStore;
const fake = new FakeEway();

beforeAll(async () => {
  t = await makeApp();
  store = new PrismaCardSessionStore(t.prisma, t.app.get(TasksService));
});
afterAll(async () => {
  await t.prisma.providerAccount.updateMany({ where: { adapterKey: { in: ['eway', 'pin_payments'] }, status: 'active' }, data: { status: 'paused' } });
});

async function account(adapterKey: 'eway' | 'pin_payments', credentials: Record<string, string>): Promise<ProviderContext> {
  const id = randomUUID();
  const creds = t.box.encrypt(JSON.stringify(credentials), credentialsAad(id));
  await t.prisma.providerAccount.create({
    data: {
      id, adapterKey, displayName: `Store ${adapterKey} ${id.slice(0, 8)}`, mode: 'test', status: 'paused',
      credentialsCiphertext: creds.ciphertext, credentialsKeyVersion: creds.keyVersion,
      webhookPathTokenHash: webhookPathTokenHash(t.config.AUTH_HMAC_KEY, randomBytes(32).toString('base64url')),
    },
  });
  return { accountId: id, mode: 'test', credentials, webhookSecret: randomBytes(32).toString('hex') };
}

const lazyStore = new Proxy({} as PrismaCardSessionStore, { get: (_o, k) => (store as unknown as Record<string | symbol, unknown>)[k] instanceof Function ? (store as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[k]!.bind(store) : (store as unknown as Record<string | symbol, unknown>)[k] });
const subject = ewayLocalSubject(fake, lazyStore, (acc) => account('eway', { ...acc }));
describePaymentProviderContract('eway on the database store', subject);

const input = () => ({
  amount: { amountMinor: 1500n, currency: 'AUD' }, method: 'card' as const, idempotencyKey: `store:${randomUUID()}`,
  metadata: { paymentId: randomUUID(), bookingId: randomUUID() }, returnUrl: 'https://example.com/payments/return', customerCountry: 'AU', createdAt: new Date(),
});

async function owner<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<string>) => Promise<T>): Promise<T> {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    return await fn((sql, params) => c.query(sql, params).then(() => 'ok', (e: { message?: string; code?: string }) => e.message?.match(/card_[a-z_]+/)?.[0] ?? e.code ?? 'error'));
  } finally {
    await c.end();
  }
}

describe('eWAY card sessions on the database (plan 9.1, sections 11 and 20 M2, m8)', () => {
  it('authorise_charges_once_under_concurrency: ten concurrent authorisations of one session send one charge', async () => {
    const ctx = await subject.context();
    const p = await subject.provider.createPayment(ctx, input());
    const code = fake.tokenise(ctx.credentials.publicApiKey!, 'pay');
    const r = await subject.provider.submitCard(ctx, p.ref, code, EWAY_PAYER);
    if (r.next.kind !== 'authenticate') throw new Error('expected a challenge');
    fake.challenge(ctx.credentials.apiKey!, r.next.authRef, true);
    const authRef = r.next.authRef;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => subject.provider.authoriseCard(ctx, p.ref, authRef, code, EWAY_PAYER.ipAddress)));
    expect(fake.chargePosts(ctx.credentials.apiKey!, p.ref)).toBe(1);
    expect(results.filter((x) => x.status === 'fulfilled' && x.value.next.kind === 'redirect').length).toBeGreaterThanOrEqual(1);
    expect((await store.byRef(ctx.accountId, p.ref))?.status).toBe('succeeded');
  });

  it('concurrent cancel and submit before the charge: a cancelled session is never authorised or charged', async () => {
    for (let i = 0; i < 5; i++) {
      const ctx = await subject.context();
      const p = await subject.provider.createPayment(ctx, input());
      const code = fake.tokenise(ctx.credentials.publicApiKey!, 'pay_frictionless');
      const [, submitted] = await Promise.all([subject.provider.cancelPayment(ctx, p.ref, 'k'), subject.provider.submitCard(ctx, p.ref, code, EWAY_PAYER)]);
      const after = await subject.provider.cancelPayment(ctx, p.ref, 'k2');
      expect(after.status).toBe('cancelled');
      if (submitted.next.kind === 'authenticate') {
        const r = await subject.provider.authoriseCard(ctx, p.ref, submitted.next.authRef, code, EWAY_PAYER.ipAddress);
        expect(r.next.kind).toBe('not_open');
      }
      expect(fake.chargePosts(ctx.credentials.apiKey!, p.ref)).toBe(0);
    }
  });

  it('flow_fixed_from_the_account: an eWAY account gets before_charge sessions, a Pin account after_charge (m8)', async () => {
    const ew = await subject.context();
    const pin = await account('pin_payments', { secretKey: 'x'.repeat(20), publishableKey: 'y'.repeat(20) });
    const row = (accountId: string, flow: string) => owner((q) => q(
      `INSERT INTO card_sessions (id, ref, "providerAccountId", mode, flow, "idempotencyKey", "paymentId", "bookingId", currency, "amountMinor", "returnUrl", "expiresAt")
       VALUES (gen_random_uuid(), 'cs_' || md5(random()::text), $1::uuid, 'test', $2, gen_random_uuid()::text, gen_random_uuid(), gen_random_uuid(), 'AUD', 100, 'https://example.com/r', now() + interval '1 hour')`, [accountId, flow]));
    expect(await row(ew.accountId, 'before_charge')).toBe('ok');
    expect(await row(ew.accountId, 'after_charge')).toBe('card_session_flow_mismatch');
    expect(await row(pin.accountId, 'after_charge')).toBe('ok');
    expect(await row(pin.accountId, 'before_charge')).toBe('card_session_flow_mismatch');
  });

  it('before_charge_edges: open → authenticating → submitting | cancelled | failed (pre-charge codes); never succeeded without a charge (M2)', async () => {
    const ctx = await subject.context();
    const mk = async () => {
      const p = await subject.provider.createPayment(ctx, input());
      return (await store.byRef(ctx.accountId, p.ref))!;
    };
    const hash = 'a'.repeat(64);
    const upd = (id: string, set: string) => owner((q) => q(`UPDATE card_sessions SET ${set}, version = version + 1 WHERE id = $1::uuid`, [id]));
    let s = await mk();
    expect(await upd(s.id, `status = 'authenticating'`)).not.toBe('ok');
    expect(await upd(s.id, `status = 'authenticating', "authCardHash" = '${hash}'`)).toBe('ok');
    expect(await upd(s.id, `status = 'succeeded', "chargeRef" = 'ewt_123', "chargedMinor" = 100`)).not.toBe('ok');
    expect(await upd(s.id, `status = 'failed', "failureCode" = 'outcome_unknown'`)).not.toBe('ok');
    expect(await upd(s.id, `status = 'submitting', "submittedAt" = now()`)).toBe('card_session_transition');
    expect(await upd(s.id, `"authRef" = 'AC1234567890abc'`)).toBe('ok');
    expect(await upd(s.id, `"authRef" = 'AC0000000000xyz'`)).toBe('card_session_auth_fixed');
    expect(await upd(s.id, `status = 'submitting', "submittedAt" = now()`)).toBe('ok');
    expect(await upd(s.id, `status = 'cancelled', "submittedAt" = NULL`)).not.toBe('ok');
    expect(await upd(s.id, `status = 'authenticating'`)).toBe('card_session_transition');
    expect(await upd(s.id, `status = 'succeeded', "chargeRef" = 'ch_${'a'.repeat(20)}', "chargedMinor" = 100`)).not.toBe('ok');
    expect(await upd(s.id, `status = 'succeeded', "chargeRef" = 'ewt_123456', "chargedMinor" = 100`)).toBe('ok');
    s = await mk();
    expect(await upd(s.id, `status = 'authenticating', "authCardHash" = '${hash}'`)).toBe('ok');
    expect(await upd(s.id, `status = 'cancelled', "failureCode" = 'expired'`)).toBe('ok');
    s = await mk();
    expect(await upd(s.id, `status = 'authenticating', "authCardHash" = '${hash}'`)).toBe('ok');
    expect(await upd(s.id, `status = 'failed', "failureCode" = 'card_not_authenticated'`)).toBe('ok');
    expect(await upd(s.id, `status = 'succeeded', "chargeRef" = 'ewt_9', "chargedMinor" = 100`)).toBe('card_session_transition');
  });

  it('reference shapes follow the adapter: ewt_/ewr_ only on eWAY accounts, ch_/rf_ only elsewhere (m8)', async () => {
    const ew = await subject.context();
    const pin = await account('pin_payments', { secretKey: 'x'.repeat(20), publishableKey: 'y'.repeat(20) });
    const intent = (accountId: string, chargeRef: string) => owner((q) => q(
      `INSERT INTO card_refund_intents (id, "providerAccountId", mode, "idempotencyKey", "refundId", "chargeRef", "amountMinor", currency, "updatedAt") VALUES (gen_random_uuid(), $1::uuid, 'test', gen_random_uuid()::text, gen_random_uuid(), $2, 100, 'AUD', now())`, [accountId, chargeRef]));
    expect(await intent(ew.accountId, 'ewt_123')).toBe('ok');
    expect(await intent(ew.accountId, `ch_${'a'.repeat(20)}`)).toBe('card_ref_shape_mismatch');
    expect(await intent(pin.accountId, `ch_${'a'.repeat(20)}`)).toBe('ok');
    expect(await intent(pin.accountId, 'ewt_123')).toBe('card_ref_shape_mismatch');
    // A malformed Pin reference is still refused by the widened checks.
    expect(await intent(pin.accountId, 'ch_short')).not.toBe('ok');
  });
});
