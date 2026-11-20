// The Pin Payments contract subjects (plan docs/plans/4.4-au-card-gateway.md, sections 12 and 18 M1). Local: the
// registered CardSessionProvider over the Pin gateway class against the in-process fake, with a store (memory by
// default; the database one in test/modules/payments/card-sessions.store.test.ts). Sandbox: the same classes against
// test-api.pinpayments.com, credentials from PIN_TEST_* variables; written and type-checked, never run here (no Pin
// test account): Pin's hosted fields and the bank's 3-D Secure page need a browser and Pin's test cards.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PinPaymentsGateway } from '../../../src/modules/payments/adapters/pin_payments/pin';
import { pinSignature, verifyPinWebhook } from '../../../src/modules/payments/adapters/pin_payments/webhook';
import { MemoryCardSessionStore } from '../../../src/modules/payments/core/card-sessions/memory-store';
import { CardSessionProvider } from '../../../src/modules/payments/core/card-sessions/provider';
import type { CardSessionStore } from '../../../src/modules/payments/core/card-sessions/store';
import type { ProviderContext, ProviderPayment } from '../../../src/modules/payments/core/provider';
import { NO_GATEWAY_EVENT } from '../payment-provider.contract';
import type { ContractSubject } from '../payment-provider.contract';
import { FakePin } from './pin-fake';

export const CARD_PAGE_ORIGIN = 'http://localhost:3000';
const PAYER = { email: 'payer@example.test', ipAddress: '203.0.113.10' };
const secretOf = (ctx: ProviderContext) => ctx.credentials.secretKey!;

/** A well-formed secret key Pin does not know: 401 everywhere. */
const unknownCredentials = (ctx: ProviderContext): ProviderContext => ({ ...ctx, credentials: { ...ctx.credentials, secretKey: `sk${randomBytes(18).toString('hex')}` } });

/**
 * A store whose sessions can be ended one by one at their expiry (the end the gateway gives an unpaid session is none:
 * it expires), without moving a clock the other clauses share. Reads report the session as already expired.
 */
export function expiringStore(inner: CardSessionStore): CardSessionStore & { expire(ref: string): void } {
  const expired = new Set<string>();
  const view = <T extends { ref: string; expiresAt: Date } | null>(s: T): T => (s && expired.has(s.ref) ? { ...s, expiresAt: new Date(inner.now().getTime() - 1000) } : s);
  return {
    now: () => inner.now(),
    createOrGet: async (i) => view(await inner.createOrGet(i)),
    byRef: async (a, r) => view(await inner.byRef(a, r)),
    byKey: async (a, k) => view(await inner.byKey(a, k)),
    byChargeRef: async (a, c) => view(await inner.byChargeRef(a, c)),
    unresolvedOfBooking: async (a, b) => (await inner.unresolvedOfBooking(a, b)).map((s) => view(s)),
    update: async (s, c) => view(await inner.update(s, c)),
    recordCharge: (s, c) => inner.recordCharge(s, c),
    intentByKey: (a, k) => inner.intentByKey(a, k),
    intentByRefundRef: (a, r) => inner.intentByRefundRef(a, r),
    submittingIntents: (a, c) => inner.submittingIntents(a, c),
    createIntent: (i) => inner.createIntent(i),
    updateIntent: (i, c) => inner.updateIntent(i, c),
    openTask: (k, a, s) => inner.openTask(k, a, s),
    expire: (ref) => void expired.add(ref),
  };
}

export interface PinLocalSubject extends ContractSubject {
  fake: FakePin;
  provider: CardSessionProvider;
  store: CardSessionStore;
}

/**
 * The customer on our card page: the fake tokenises a card, our provider submits it once; with 3-D Secure the customer
 * passes the bank's page and comes back to the callback. Throws if the session takes no card.
 */
export async function payOnCardPage(fake: FakePin, provider: CardSessionProvider, ctx: ProviderContext, ref: string, outcome: 'pay' | 'decline' | 'pay_frictionless'): Promise<void> {
  const token = fake.tokenise(ctx.credentials.publishableKey!, outcome);
  const r = await provider.submitCard(ctx, ref, token, PAYER);
  if (r.next.kind === 'not_open') throw new Error('fake pin: the session takes no card');
  if (r.session.status === 'authenticating' && r.session.chargeRef) {
    const st = fake.finishChallenge(secretOf(ctx), r.session.chargeRef, 'pay');
    await provider.finishAuthentication(ctx, ref, st);
  }
}

export function pinLocalSubject(fake = new FakePin(), inner: CardSessionStore = new MemoryCardSessionStore(), contextFor?: (acc: ReturnType<FakePin['newAccount']>) => Promise<ProviderContext>): PinLocalSubject {
  const store = expiringStore(inner);
  const provider = new CardSessionProvider(new PinPaymentsGateway({ transport: fake.transport }), store, { cardPageOrigin: CARD_PAGE_ORIGIN, usable: true });
  const sessionOf = async (ctx: ProviderContext, ref: string) => {
    const s = await store.byRef(ctx.accountId, ref);
    if (!s) throw new Error('fake pin: no such session');
    return s;
  };
  return {
    fake,
    provider,
    store,
    async context() {
      const acc = fake.newAccount();
      if (contextFor) return contextFor(acc);
      return { accountId: randomUUID(), mode: 'test', credentials: { secretKey: acc.secretKey, publishableKey: acc.publishableKey }, webhookSecret: acc.webhookKey };
    },
    badCredentials: unknownCredentials,
    async customerCompletes(ctx, payment: ProviderPayment, outcome) {
      await payOnCardPage(fake, provider, ctx, payment.ref, outcome);
    },
    async endAtGateway(ctx, payment) {
      // The end an unpaid session gets on its own: its expiry (no gateway object exists to end).
      await sessionOf(ctx, payment.ref);
      store.expire(payment.ref);
    },
    async webhookFor(ctx, ref, at) {
      const s = await sessionOf(ctx, ref);
      const charges = fake.chargesWith(secretOf(ctx), ref);
      // Plan 4.4, 18 M1: the marker only while the session has no charge, here and at the (fake) gateway.
      if (s.chargeRef === null && charges.length === 0) return NO_GATEWAY_EVENT;
      const token = s.chargeRef ?? charges[0]!.token;
      return fake.chargeEvent(secretOf(ctx), token, at);
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      const s = await sessionOf(ctx, payment.ref);
      const ref = fake.dashboardRefund(secretOf(ctx), s.chargeRef!, Number(amountMinor));
      return (await provider.retrieveRefund(ctx, { ref }))!;
    },
    async refundWebhookFor(ctx, refundRef, at) {
      return fake.refundEvent(secretOf(ctx), refundRef, at);
    },
    async refundSettles(ctx, refundRef) {
      fake.settleRefund(secretOf(ctx), refundRef);
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials() {
      throw new Error('the local Pin subject uses the fake: run the sandbox subject');
    },
  };
}

/** A recorded real delivery: headers and the raw body, base64 (A1 to A3, A16). */
interface RecordedDelivery { headers: Record<string, string>; bodyBase64: string; receivedAt: string }

const KEY = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Pin's test environment (blocked: no test account). The card is tokenised with Pin's documented test cards through
 * the Cards API and the publishable key, in this test process only; a 3-D Secure challenge needs Pin's test ACS, driven
 * in a browser (PIN_TEST_ACS_SCRIPT), which may need a person. Webhooks are checked on recorded real deliveries.
 */
export function pinSandboxSubject(): ContractSubject {
  const env = process.env;
  const store = expiringStore(new MemoryCardSessionStore());
  const provider = new CardSessionProvider(new PinPaymentsGateway(), store, { cardPageOrigin: 'https://localhost.invalid', usable: true });
  const api = async (ctx: ProviderContext, method: string, path: string, body?: unknown, key = ctx.credentials.secretKey!) => {
    const res = await fetch(`https://test-api.pinpayments.com/1${path}`, {
      method, headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error',
    });
    return (await res.json()) as { response?: Record<string, unknown> };
  };
  let checkedRecorded = false;
  const checkRecorded = (ctx: ProviderContext) => {
    const recorded = JSON.parse(readFileSync(env.PIN_TEST_RECORDED_DELIVERY!, 'utf8')) as RecordedDelivery[];
    const kinds = new Set<string>();
    for (const d of recorded) {
      const v = verifyPinWebhook(ctx.webhookSecret, Buffer.from(d.bodyBase64, 'base64'), d.headers, new Date(d.receivedAt));
      if (!v.ok) throw new Error(`pin sandbox: a recorded delivery does not verify (${v.code})`);
      kinds.add(v.event.kind);
    }
    if (!kinds.has('payment') || !kinds.has('refund')) throw new Error('pin sandbox: record one charge event and one refund event');
  };
  const sign = (ctx: ProviderContext, type: string, data: unknown, at: Date) => {
    // Pin cannot be asked to sign for us: the same scheme with the endpoint's key, checked on real deliveries above.
    const body = Buffer.from(JSON.stringify({ token: `evt_${randomBytes(10).toString('hex')}`, type, data, created_at: at.toISOString() }));
    const t = String(Math.floor(at.getTime() / 1000));
    return { body, headers: { 'pin-signature': `t=${t},v1=${pinSignature(ctx.webhookSecret, t, body)}` } };
  };
  return {
    provider,
    async context() {
      const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { secretKey: env.PIN_TEST_SECRET_KEY ?? '', publishableKey: env.PIN_TEST_PUBLISHABLE_KEY ?? '' }, webhookSecret: env.PIN_TEST_WEBHOOK_KEY ?? '' };
      if (!checkedRecorded) {
        checkRecorded(ctx);
        checkedRecorded = true;
      }
      return ctx;
    },
    badCredentials: unknownCredentials,
    async customerCompletes(ctx, payment, outcome) {
      const card = outcome === 'pay' ? env.PIN_TEST_CARD_PAY : env.PIN_TEST_CARD_DECLINE;
      if (!card) throw new Error('pin sandbox: set PIN_TEST_CARD_PAY and PIN_TEST_CARD_DECLINE from Pin\'s Test Cards page');
      const tok = await api(ctx, 'POST', '/cards', { number: card, expiry_month: 12, expiry_year: new Date().getFullYear() + 2, cvc: '123', name: 'Contract Test', address_line1: '1 Test St', address_city: 'Brisbane', address_country: 'Australia' }, ctx.credentials.publishableKey!);
      const token = tok.response?.token;
      if (typeof token !== 'string') throw new Error('pin sandbox: no card token');
      const r = await provider.submitCard(ctx, payment.ref, token, PAYER);
      if (r.next.kind === 'not_open') throw new Error('pin sandbox: the session takes no card');
      if (r.session.status === 'authenticating') throw new Error('pin sandbox: a 3-D Secure challenge needs Pin\'s test ACS in a browser; see the guide');
    },
    async endAtGateway(ctx, payment) {
      store.expire(payment.ref);
    },
    async webhookFor(ctx, ref, at) {
      const s = await store.byRef(ctx.accountId, ref);
      const search = await api(ctx, 'GET', `/charges/search?query=${ref}`);
      const all = (search.response as unknown as Array<Record<string, unknown>> | undefined) ?? [];
      // Only charges whose metadata names exactly this session (the search matches any field).
      const mine = all.filter((c) => (c.metadata as Record<string, unknown> | undefined)?.mt_session === ref);
      if (!s?.chargeRef && mine.length === 0) return NO_GATEWAY_EVENT;
      const token = s?.chargeRef ?? String(mine[0]!.token);
      const charge = (await api(ctx, 'GET', `/charges/${token}`)).response!;
      return sign(ctx, charge.success ? 'charge.captured' : 'charge.failed', charge, at);
    },
    async gatewayRefunds(ctx, payment, amountMinor) {
      const s = await store.byRef(ctx.accountId, payment.ref);
      const r = await api(ctx, 'POST', `/charges/${s!.chargeRef}/refunds`, { amount: Number(amountMinor) });
      return (await provider.retrieveRefund(ctx, { ref: String(r.response!.token) }))!;
    },
    async refundWebhookFor(ctx, refundRef, at) {
      const r = (await api(ctx, 'GET', `/refunds/${refundRef}`)).response!;
      const type = r.status_message === 'Success' ? 'refund.succeeded' : r.status_message === 'Failed' ? 'refund.failed' : 'refund.created';
      return sign(ctx, type, r, at);
    },
    async refundSettles() {
      // Pin settles refunds on its own schedule: the sandbox run waits for it (unverified how long).
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    },
    unsupportedCurrency: 'USD',
    assertSandboxCredentials(e) {
      for (const name of ['PIN_TEST_SECRET_KEY', 'PIN_TEST_PUBLISHABLE_KEY'] as const) if (!KEY.test(e[name] ?? '')) throw new Error(`pin sandbox: ${name} is not set or has no key shape`);
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(e.PIN_TEST_WEBHOOK_KEY ?? '')) throw new Error('pin sandbox: PIN_TEST_WEBHOOK_KEY is not set or has no key shape');
      if (!e.PIN_TEST_RECORDED_DELIVERY) throw new Error('pin sandbox: PIN_TEST_RECORDED_DELIVERY (recorded real deliveries) is required');
    },
  };
}

