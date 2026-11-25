// The Stripe pay-later adapter without a database (plan docs/plans/9.3-stripe-pay-later.md, sections 6, 13 and 19): the
// method table, refusals before the network, the session body, the reading of an expired session by its PaymentIntent,
// cancel while the customer is at the provider, the refund window, events of card sessions, and the routing limits.
// Every Stripe, Afterpay, Klarna and Zip fact behind the fake is UNVERIFIED until the sandbox run.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PaymentMethod } from '@mt/shared';
import { createAdapters } from '../../../src/modules/payments/adapters';
import { BNPL_METHODS, STRIPE_BNPL_KEY, StripeBnplProvider, bnplSessionToPayment, bnplTypesFor, stripeBnplManifest } from '../../../src/modules/payments/adapters/stripe/bnpl';
import { signStripe } from '../../../src/modules/payments/adapters/stripe/mapping';
import { StripeProvider, sessionParams, stripeManifest } from '../../../src/modules/payments/adapters/stripe/stripe';
import type { StripeRequest } from '../../../src/modules/payments/adapters/stripe/stripe';
import { catalogueCapabilities } from '../../../src/modules/payments/core/account-admin.service';
import type { AccountForCall } from '../../../src/modules/payments/core/gateway';
import { EVENTLESS_ADAPTER_KEYS, ProviderError } from '../../../src/modules/payments/core/provider';
import type { CreatePaymentInput, ProviderContext } from '../../../src/modules/payments/core/provider';
import { manifestProblems } from '../../../src/modules/payments/core/registry';
import { MAX_LIMIT_MINOR, type HealthState, type RouteContext, type RuleRow, amountGaps, defaultRules, route } from '../../../src/modules/payments/core/routing-rules';
import { FakeStripe } from '../../contract/subjects/stripe-fake';

const DAY_S = 86_400;

function setup() {
  const fake = new FakeStripe();
  const seen: StripeRequest[] = [];
  const provider = new StripeBnplProvider({ transport: async (r) => (seen.push(r), fake.transport(r)), now: () => fake.now() });
  const key = fake.newAccount();
  const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { secretKey: key }, webhookSecret: `whsec_${randomBytes(24).toString('hex')}` };
  const input = (over: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
    amount: { amountMinor: 25_000n, currency: 'AUD' }, method: 'bnpl', idempotencyKey: `booking:${randomUUID()}:attempt:1`, metadata: { paymentId: randomUUID(), bookingId: randomUUID() },
    returnUrl: 'https://example.com/payments/return', customerCountry: 'AU', createdAt: fake.now(), ...over,
  });
  const creates = () => seen.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions').length;
  const session = (ref: string) => fake.account(key).sessions.get(ref)!;
  return { fake, provider, key, ctx, input, seen, creates, session };
}

const refundInput = (paymentRef: string, amountMinor = 1_000n) => ({
  paymentRef, amount: { amountMinor, currency: 'AUD' }, idempotencyKey: `refund:${randomUUID()}`, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date(),
});

/** sha256 of every other adapter's manifest and signature headers, as on main before task 9.3 (7be4588). */
const MANIFESTS_BEFORE_9_3 = 'c28ae5fe2684eaed28ee8378be7c83450e3145185c5e54ae8f53b5dc7fdb2e55';

describe('manifest and registry (plan 9.3, 6.1 and 12)', () => {
  it('the manifest: experimental, pay later only, AU and AUD, its amount range, disputes; born off', () => {
    const m = stripeBnplManifest();
    expect([m.key, m.status, m.testOnly, m.cardDataHandling, m.methods, m.currencies, m.countries, m.checkoutOrigin]).toEqual([STRIPE_BNPL_KEY, 'experimental', false, 'hosted_only', ['bnpl'], ['AUD'], ['AU'], 'https://checkout.stripe.com']);
    expect(m.amountRange).toEqual({ minMinor: 100n, maxMinor: 500_000n });
    expect(m.capabilities).toEqual({ refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'stays_payable', disputes: 'events' });
    expect(manifestProblems([m])).toEqual([]);
    expect(defaultRules(m)).toEqual([]);
    expect(catalogueCapabilities(m)).toEqual({ refunds: 'partial', deferredCapture: false, disputes: true, reconciliation: null, gatewayEvents: 'signed', cardEntry: 'gateway_page' });
    expect(EVENTLESS_ADAPTER_KEYS).toEqual(['eway']);
  });

  it('an amount range must be positive and not empty', () => {
    const m = stripeBnplManifest();
    for (const amountRange of [{ minMinor: 0n, maxMinor: 10n }, { minMinor: 10n, maxMinor: 9n }]) expect(manifestProblems([{ ...m, amountRange }])).toContain(`${STRIPE_BNPL_KEY}: amount range must be positive and not empty`);
  });

  it('existing_manifests_unchanged_9_3: every other adapter is as it was before task 9.3; stripe keeps its own manifest', () => {
    const adapters = createAdapters({ webOrigin: 'http://localhost:3000' });
    expect(adapters.map((a) => a.manifest.key)).toEqual(['simulator', 'stripe', 'paypal', 'pin_payments', 'eway', 'airwallex', 'stripe_bnpl']);
    const others = adapters.filter((a) => a.manifest.key !== STRIPE_BNPL_KEY);
    const hash = createHash('sha256').update(JSON.stringify(others.map((a) => [a.manifest, [...a.signatureHeaders]]))).digest('hex');
    expect(hash).toBe(MANIFESTS_BEFORE_9_3);
    expect(adapters.find((a) => a.manifest.key === 'stripe')!.manifest).toEqual(stripeManifest());
    expect(others.some((a) => a.manifest.amountRange !== undefined)).toBe(false);
  });
});

describe('the method table (plan 9.3, 6.1; review 3 and 6)', () => {
  it.each([
    [99n, []], [100n, ['afterpay_clearpay', 'klarna', 'zip']], [200_000n, ['afterpay_clearpay', 'klarna', 'zip']], [200_001n, ['afterpay_clearpay', 'zip']],
    [400_000n, ['afterpay_clearpay', 'zip']], [400_001n, ['zip']], [500_000n, ['zip']], [500_001n, []], [5_000_000n, []],
  ])('%s → %j', (amount, types) => {
    expect(bnplTypesFor(amount)).toEqual(types);
  });

  it('the table is in minor units with a fixed order', () => {
    expect(BNPL_METHODS.map((m) => m.type)).toEqual(['afterpay_clearpay', 'klarna', 'zip']);
  });
});

describe('create (plan 9.3, 6.2)', () => {
  it('refused before the network: another method, a customer outside AU, another currency, an amount no method takes', async () => {
    const { provider, ctx, input, creates } = setup();
    const refused: Array<Partial<CreatePaymentInput>> = [
      ...(['card', 'apple_pay', 'payto'] as PaymentMethod[]).map((method) => ({ method })),
      ...['NZ', 'US', ''].map((customerCountry) => ({ customerCountry })),
      { amount: { amountMinor: 25_000n, currency: 'USD' } }, { amount: { amountMinor: 99n, currency: 'AUD' } }, { amount: { amountMinor: 500_001n, currency: 'AUD' } },
    ];
    for (const over of refused) await expect(provider.createPayment(ctx, input(over)), JSON.stringify(over, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).rejects.toMatchObject({ code: 'provider_rejected', retryable: false });
    expect(creates()).toBe(0);
  });

  it('a live key is refused before anything else', async () => {
    const { provider, ctx, input, seen } = setup();
    await expect(provider.createPayment({ ...ctx, credentials: { secretKey: `sk_live_${randomBytes(12).toString('hex')}` } }, input())).rejects.toMatchObject({ code: 'provider_auth_failed', retryable: false });
    expect(seen).toHaveLength(0);
  });

  it('the session body: the pay-later types for the amount, no card, no fee; everything else as the card session; the same on a retry', async () => {
    const { provider, ctx, input, seen } = setup();
    const i = input({ amount: { amountMinor: 300_000n, currency: 'AUD' } });
    const p = await provider.createPayment(ctx, i);
    await provider.createPayment(ctx, i);
    expect(p.status).toBe('requires_action');
    expect(p.nextAction?.url.startsWith('https://checkout.stripe.com/')).toBe(true);
    const posts = seen.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.form).toEqual(posts[0]!.form);
    const form = posts[0]!.form!;
    expect(form.filter(([k]) => k.startsWith('payment_method_types'))).toEqual([['payment_method_types[0]', 'afterpay_clearpay'], ['payment_method_types[1]', 'zip']]);
    expect(form.filter(([k]) => !k.startsWith('payment_method_types'))).toEqual(sessionParams(i).filter(([k]) => !k.startsWith('payment_method_types')));
    expect(form.some(([k, v]) => /surcharge|fee|application_fee|shipping|payment_method_options/.test(k) || v === 'card')).toBe(false);
    expect(new Map(form).get('line_items[0][price_data][unit_amount]')).toBe('300000');
  });

  it('the card adapter builds exactly the card session (its path did not change)', async () => {
    const fake = new FakeStripe();
    const seen: StripeRequest[] = [];
    const card = new StripeProvider({ transport: async (r) => (seen.push(r), fake.transport(r)), now: () => fake.now() });
    const i: CreatePaymentInput = { amount: { amountMinor: 25_000n, currency: 'AUD' }, method: 'card', idempotencyKey: `booking:${randomUUID()}:attempt:1`, metadata: { paymentId: randomUUID(), bookingId: randomUUID() }, returnUrl: 'https://example.com/r', customerCountry: 'AU', createdAt: fake.now() };
    await card.createPayment({ accountId: randomUUID(), mode: 'test', credentials: { secretKey: fake.newAccount() }, webhookSecret: '' }, i);
    expect(seen[0]!.form).toEqual(sessionParams(i));
  });
});

describe('an expired session reads by its PaymentIntent (plan 9.3, 19 point 1)', () => {
  const base = { object: 'checkout.session', id: 'cs_test_1', amount_total: 25_000, currency: 'aud', metadata: { mt_payment_id: 'p1' }, url: null, payment_status: 'unpaid' };
  it.each([
    [null, 'cancelled'], [{ id: 'pi_1', status: 'succeeded' }, 'succeeded'], [{ id: 'pi_1', status: 'processing' }, 'pending'], [{ id: 'pi_1', status: 'requires_capture' }, 'pending'],
    [{ id: 'pi_1', status: 'canceled' }, 'cancelled'], [{ id: 'pi_1', status: 'requires_action' }, 'requires_action'], [{ id: 'pi_1', status: 'requires_payment_method' }, 'requires_action'],
    [{ id: 'pi_1', status: 'requires_confirmation' }, 'requires_action'],
  ])('PaymentIntent %j → %s', (pi, status) => {
    const p = bnplSessionToPayment({ ...base, status: 'expired', payment_intent: pi });
    expect(p?.status).toBe(status);
    expect(p?.nextAction).toBeUndefined();
  });

  it('a PaymentIntent that is only an id, or in a state we do not know, is unknown', () => {
    expect(bnplSessionToPayment({ ...base, status: 'expired', payment_intent: 'pi_1' })).toBeNull();
    expect(bnplSessionToPayment({ ...base, status: 'expired', payment_intent: { id: 'pi_1', status: 'new_state' } })).toBeNull();
  });

  it('open and complete sessions read as for cards', () => {
    expect(bnplSessionToPayment({ ...base, status: 'open', payment_intent: { id: 'pi_1', status: 'requires_action' }, url: 'https://checkout.stripe.com/c/pay/x' })?.status).toBe('requires_action');
    expect(bnplSessionToPayment({ ...base, status: 'complete', payment_status: 'paid', payment_intent: { id: 'pi_1', status: 'succeeded' } })?.status).toBe('succeeded');
  });

  it('approved at the provider after the session expired: read as succeeded, never cancelled', async () => {
    const { fake, provider, ctx, input, key } = setup();
    const p = await provider.createPayment(ctx, input());
    fake.startAtProvider(key, p.ref);
    const t0 = fake.now().getTime();
    fake.now = () => new Date(t0 + 50 * 60_000);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    fake.approveAtProvider(key, p.ref);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('succeeded');
  });
});

describe('cancel while the customer is at the provider (plan 9.3, 19 point 1)', () => {
  it('expires the session, then cancels the PaymentIntent, then reads: cancelled', async () => {
    const { fake, provider, ctx, input, key, session, seen } = setup();
    const p = await provider.createPayment(ctx, input());
    const pi = fake.startAtProvider(key, p.ref);
    const out = await provider.cancelPayment(ctx, p.ref, 'k1:cancel');
    expect(out.status).toBe('cancelled');
    expect(session(p.ref).status).toBe('expired');
    expect(fake.account(key).intents.get(pi)!.status).toBe('canceled');
    const paths = seen.filter((r) => r.method === 'POST').map((r) => r.path);
    expect(paths.indexOf(`/v1/checkout/sessions/${p.ref}/expire`)).toBeLessThan(paths.indexOf(`/v1/payment_intents/${pi}/cancel`));
    expect(() => fake.approveAtProvider(key, p.ref)).toThrow();
  });

  it('a PaymentIntent Stripe will not cancel: retryable, never requires_action; once approved it reads succeeded', async () => {
    const { fake, provider, ctx, input, key } = setup();
    const p = await provider.createPayment(ctx, input());
    fake.startAtProvider(key, p.ref);
    fake.account(key).refusePiCancel = true;
    const err = await provider.cancelPayment(ctx, p.ref, 'k2:cancel').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: 'provider_unavailable', retryable: true });
    fake.approveAtProvider(key, p.ref);
    expect((await provider.cancelPayment(ctx, p.ref, 'k2:cancel')).status).toBe('succeeded');
  });

  it('an unpaid session with no PaymentIntent: cancelled, and again cancelled (idempotent)', async () => {
    const { provider, ctx, input } = setup();
    const p = await provider.createPayment(ctx, input());
    expect((await provider.cancelPayment(ctx, p.ref, 'k3:cancel')).status).toBe('cancelled');
    expect((await provider.cancelPayment(ctx, p.ref, 'k3:cancel')).status).toBe('cancelled');
  });
});

describe('the refund window (plan 9.3, 19 point 2a)', () => {
  async function paid(amountMinor: bigint) {
    const s = setup();
    const p = await s.provider.createPayment(s.ctx, s.input({ amount: { amountMinor, currency: 'AUD' } }));
    s.fake.pay(s.key, p.ref);
    const refundPosts = () => s.seen.filter((r) => r.method === 'POST' && r.path === '/v1/refunds').length;
    return { ...s, p, refundPosts };
  }

  it('Afterpay (120 days): taken at 118 days, refused past 119 with nothing sent', async () => {
    const a = await paid(25_000n);
    a.fake.ageCharge(a.key, a.p.ref, 118 * DAY_S);
    expect((await a.provider.createRefund(a.ctx, refundInput(a.p.ref))).status).toBe('succeeded');
    a.fake.ageCharge(a.key, a.p.ref, 1 * DAY_S + 3600);
    await expect(a.provider.createRefund(a.ctx, refundInput(a.p.ref))).rejects.toMatchObject({ code: 'provider_rejected', retryable: false });
    expect(a.refundPosts()).toBe(1);
  });

  it('Zip (180 days): taken at 178 days, refused past 179', async () => {
    const z = await paid(450_000n);
    z.fake.ageCharge(z.key, z.p.ref, 178 * DAY_S);
    expect((await z.provider.createRefund(z.ctx, refundInput(z.p.ref))).status).toBe('succeeded');
    z.fake.ageCharge(z.key, z.p.ref, 1 * DAY_S + 3600);
    await expect(z.provider.createRefund(z.ctx, refundInput(z.p.ref))).rejects.toMatchObject({ code: 'provider_rejected', retryable: false });
  });

  it('a refund already made under our key is returned, never refused, even past the window', async () => {
    const a = await paid(25_000n);
    const i = refundInput(a.p.ref);
    const first = await a.provider.createRefund(a.ctx, i);
    a.fake.ageCharge(a.key, a.p.ref, 200 * DAY_S);
    expect((await a.provider.createRefund(a.ctx, i)).ref).toBe(first.ref);
    expect(a.refundPosts()).toBe(1);
  });

  it('an unreadable charge is unknown (retryable), never guessed', async () => {
    const a = await paid(25_000n);
    a.fake.account(a.key).charges.clear();
    await expect(a.provider.createRefund(a.ctx, refundInput(a.p.ref))).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(a.refundPosts()).toBe(0);
  });
});

describe('events (plan 9.3, 19 points 1 and 4)', () => {
  const at = new Date();
  const deliver = (provider: StripeBnplProvider, ctx: ProviderContext, type: string, object: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify({ id: `evt_${randomBytes(6).toString('hex')}`, object: 'event', type, created: Math.floor(at.getTime() / 1000), livemode: false, data: { object } }));
    const v = provider.verifyWebhook(ctx, body, { 'stripe-signature': signStripe(ctx.webhookSecret, body, at) }, at);
    return { v, parsed: provider.parseEvent(body) };
  };
  const session = { object: 'checkout.session', id: 'cs_test_1', amount_total: 25_000, currency: 'aud', metadata: { mt_payment_id: randomUUID() }, payment_status: 'paid', status: 'complete', payment_intent: 'pi_1' };

  it('a card session of a shared Stripe account is unsupported, so it never reaches matching', () => {
    const { provider, ctx } = setup();
    for (const types of [['card'], ['card', 'afterpay_clearpay']]) {
      const { v, parsed } = deliver(provider, ctx, 'checkout.session.completed', { ...session, payment_method_types: types });
      expect(v).toMatchObject({ ok: true, event: { kind: 'unsupported' } });
      expect(parsed?.kind).toBe('unsupported');
    }
    expect(deliver(provider, ctx, 'checkout.session.completed', { ...session, payment_method_types: ['afterpay_clearpay'] }).v).toMatchObject({ ok: true, event: { kind: 'payment', payment: { status: 'succeeded' } } });
  });

  it('an expired session with a PaymentIntent is left to the reads; without one it is cancelled', () => {
    const { provider, ctx } = setup();
    const expired = { ...session, status: 'expired', payment_status: 'unpaid', payment_method_types: ['zip'] };
    expect(deliver(provider, ctx, 'checkout.session.expired', expired).v).toMatchObject({ ok: true, event: { kind: 'unsupported' } });
    expect(deliver(provider, ctx, 'checkout.session.expired', { ...expired, payment_intent: null }).v).toMatchObject({ ok: true, event: { kind: 'payment', payment: { status: 'cancelled' } } });
  });

  it('PaymentIntent events stay unsupported; a bad signature is still refused', () => {
    const { provider, ctx } = setup();
    expect(deliver(provider, ctx, 'payment_intent.succeeded', { object: 'payment_intent', id: 'pi_1', status: 'succeeded', amount: 25_000, currency: 'aud', metadata: {} }).v).toMatchObject({ ok: true, event: { kind: 'unsupported' } });
    const body = Buffer.from('{"id":"evt_1","object":"event"}');
    expect(provider.verifyWebhook(ctx, body, { 'stripe-signature': signStripe('whsec_other', body, at) }, at)).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(provider.parseEvent(Buffer.from('not json'))).toBeNull();
  });
});

describe('routing never offers pay later outside the adapter range (plan 9.3, 19 point 6)', () => {
  const m = stripeBnplManifest();
  const account: AccountForCall = { id: 'B', adapterKey: STRIPE_BNPL_KEY, mode: 'test', status: 'active' };
  const ctx: RouteContext = { accounts: new Map([[account.id, account]]), manifest: (k) => (k === STRIPE_BNPL_KEY ? m : undefined), env: 'test', manualOffered: new Set(), manualKey: 'manual', health: new Map<string, HealthState>() };
  const rule: RuleRow = { id: 'r1', providerAccountId: 'B', method: 'bnpl', countries: ['AU'], anyCountry: false, currency: 'AUD', minAmountMinor: null, maxAmountMinor: null, priority: 100, enabled: true, fallbackForRuleId: null, createdAt: new Date('2026-01-01T00:00:00Z') };
  const q = (amountMinor: bigint | null) => ({ method: 'bnpl' as PaymentMethod, country: 'AU', currency: 'AUD', amountMinor });

  it('a rule without limits: offered from A$1 to A$5,000 only', () => {
    expect(route([rule], ctx, q(99n))).toEqual([]);
    expect(route([rule], ctx, q(100n)).map((c) => c.accountId)).toEqual(['B']);
    expect(route([rule], ctx, q(500_000n)).map((c) => c.accountId)).toEqual(['B']);
    expect(route([rule], ctx, q(500_001n))).toEqual([]);
  });

  it('coverage shows the gaps outside the range', () => {
    expect(amountGaps([rule], ctx, { method: 'bnpl', country: 'AU', currency: 'AUD' })).toEqual([{ fromMinor: 1n, toMinor: 99n }, { fromMinor: 500_001n, toMinor: MAX_LIMIT_MINOR }]);
  });
});
