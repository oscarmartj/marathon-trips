// The Stripe adapter's pure parts and its behaviour against the fake (plan docs/plans/3.3-stripe-adapter-ledger.md,
// sections 5 and 12.5). No database, no network.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseStripeEvent, sessionStatus, signStripe, stripeError, verifyStripeSignature, refundStatus } from '../../../src/modules/payments/adapters/stripe/mapping';
import { LATE_CREATE_AFTER_MS, StripeProvider, sessionParams } from '../../../src/modules/payments/adapters/stripe/stripe';
import type { StripeRequest } from '../../../src/modules/payments/adapters/stripe/stripe';
import { ProviderError } from '../../../src/modules/payments/core/provider';
import type { CreatePaymentInput, ProviderContext } from '../../../src/modules/payments/core/provider';
import { FakeStripe } from '../../contract/subjects/stripe-fake';

const secret = `whsec_${randomBytes(20).toString('hex')}`;

describe('stripe_status_mapping_table', () => {
  it.each([
    [{ status: 'open', payment_status: 'unpaid' }, undefined, 'requires_action'],
    [{ status: 'complete', payment_status: 'paid' }, undefined, 'succeeded'],
    [{ status: 'complete', payment_status: 'paid' }, 'succeeded', 'succeeded'],
    [{ status: 'complete', payment_status: 'unpaid' }, 'processing', 'pending'],
    [{ status: 'complete', payment_status: 'unpaid' }, null, 'pending'],
    [{ status: 'complete', payment_status: 'unpaid' }, 'requires_payment_method', 'failed'],
    [{ status: 'complete', payment_status: 'unpaid' }, 'canceled', 'failed'],
    [{ status: 'expired', payment_status: 'unpaid' }, undefined, 'cancelled'],
    [{ status: 'weird', payment_status: 'paid' }, undefined, null],
    [{ status: 'complete', payment_status: 'weird' }, undefined, null],
  ] as const)('%o with PaymentIntent %s → %s', (session, pi, expected) => {
    expect(sessionStatus(session, pi)).toBe(expected);
  });

  it.each([['pending', 'pending'], ['requires_action', 'pending'], ['succeeded', 'succeeded'], ['failed', 'failed'], ['canceled', 'cancelled'], ['other', null]] as const)('refund %s → %s', (s, expected) => {
    expect(refundStatus(s)).toBe(expected);
  });
});

describe('stripe_error_mapping_table', () => {
  it.each([
    [400, { error: { type: 'idempotency_error' } }, 'idempotency_error'],
    [400, { error: { type: 'invalid_request_error' } }, { code: 'provider_rejected', retryable: false }],
    [402, { error: { type: 'card_error' } }, { code: 'provider_rejected', retryable: false }],
    [401, {}, { code: 'provider_auth_failed', retryable: false }],
    [403, {}, { code: 'provider_auth_failed', retryable: false }],
    [404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }, { code: 'provider_not_found', retryable: false }],
    [409, {}, { code: 'provider_busy', retryable: true }],
    [429, {}, { code: 'provider_busy', retryable: true }],
    [500, {}, { code: 'provider_unavailable', retryable: true }],
    [503, 'not json', { code: 'provider_unavailable', retryable: true }],
  ] as const)('%i %o', (status, body, expected) => {
    expect(stripeError(status, body)).toEqual(expected);
  });
});

describe('stripe_signature_table', () => {
  const body = Buffer.from(JSON.stringify({ id: 'evt_1', object: 'event' }));
  const at = new Date('2026-11-19T10:00:00Z');
  const good = signStripe(secret, body, at);
  const v1 = good.split('v1=')[1]!;
  const t = Math.floor(at.getTime() / 1000);
  it.each([
    ['valid', good, body, secret, at, { ok: true }],
    ['tampered body', good, Buffer.from(JSON.stringify({ id: 'evt_2', object: 'event' })), secret, at, { ok: false, code: 'bad_signature' }],
    ['other secret', good, body, `whsec_${randomBytes(20).toString('hex')}`, at, { ok: false, code: 'bad_signature' }],
    ['second v1 is the good one', `t=${t},v1=${'0'.repeat(64)},v1=${v1}`, body, secret, at, { ok: true }],
    ['v0 only', `t=${t},v0=${v1}`, body, secret, at, { ok: false, code: 'bad_signature' }],
    ['299 s later', good, body, secret, new Date(at.getTime() + 299_000), { ok: true }],
    ['301 s later', good, body, secret, new Date(at.getTime() + 301_000), { ok: false, code: 'stale_timestamp' }],
    ['301 s earlier', good, body, secret, new Date(at.getTime() - 301_000), { ok: false, code: 'stale_timestamp' }],
    ['no t', `v1=${v1}`, body, secret, at, { ok: false, code: 'bad_signature' }],
    ['header over 4 KB', `${good},${'x'.repeat(5000)}`, body, secret, at, { ok: false, code: 'bad_signature' }],
    ['empty secret', good, body, '', at, { ok: false, code: 'bad_signature' }],
  ] as const)('%s', (_label, header, b, s, now, expected) => {
    expect(verifyStripeSignature(header, b, s, now)).toEqual(expected);
  });

  it('stripe_live_event_refused: a live event to a test account is malformed, a test one is accepted', () => {
    const p = new StripeProvider();
    const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { secretKey: `sk_test_${randomBytes(12).toString('hex')}` }, webhookSecret: secret };
    const event = (livemode: boolean) => Buffer.from(JSON.stringify({ id: 'evt_x', object: 'event', type: 'payout.paid', created: Math.floor(Date.now() / 1000), livemode, data: { object: {} } }));
    const now = new Date();
    for (const live of [true, false]) {
      const b = event(live);
      expect(p.verifyWebhook(ctx, b, { 'stripe-signature': signStripe(secret, b, now) }, now)).toMatchObject(live ? { ok: false, code: 'malformed' } : { ok: true });
    }
  });

  it('parses only what it knows: unsupported types, broken objects', () => {
    expect(parseStripeEvent({ id: 'evt_1', object: 'event', type: 'charge.dispute.created', created: 1, data: { object: {} } })?.kind).toBe('unsupported');
    expect(parseStripeEvent({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', created: 1, data: { object: { object: 'checkout.session', id: 'cs_1' } } })).toBeNull();
    expect(parseStripeEvent({ id: 'evt_1', object: 'event', type: 'refund.updated', created: 1, data: { object: { object: 'refund', id: 're_1', amount: 1.5, currency: 'aud', status: 'succeeded', payment_intent: 'pi_1' } } })).toBeNull();
    expect(parseStripeEvent({ id: 'bad id!', object: 'event', type: 'x', created: 1 })).toBeNull();
  });
});

describe('Stripe adapter against the fake', () => {
  const setup = () => {
    const fake = new FakeStripe();
    const seen: StripeRequest[] = [];
    const provider = new StripeProvider({ transport: async (r) => (seen.push(r), fake.transport(r)), now: () => fake.now() });
    const key = fake.newAccount();
    const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { secretKey: key }, webhookSecret: secret };
    const input = (over: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
      amount: { amountMinor: 25_000n, currency: 'AUD' }, method: 'card', idempotencyKey: `booking:${randomUUID()}:attempt:1`, metadata: { paymentId: randomUUID(), bookingId: randomUUID() },
      returnUrl: 'https://example.com/payments/return?ref=MT-ABC123', customerCountry: 'AU', createdAt: fake.now(), ...over,
    });
    return { fake, provider, key, ctx, input, seen };
  };

  it('stripe_create_params_deterministic_for_key: every parameter comes from the row, expires_at from its createdAt', () => {
    const createdAt = new Date('2026-11-19T00:00:00Z');
    const base = { amount: { amountMinor: 25_000n, currency: 'AUD' }, method: 'card' as const, idempotencyKey: 'booking:b:attempt:1', metadata: { paymentId: 'p', bookingId: 'b' }, returnUrl: 'https://x.test/r', customerCountry: 'AU', createdAt };
    expect(sessionParams(base)).toEqual(sessionParams({ ...base }));
    const map = new Map(sessionParams(base));
    expect(map.get('expires_at')).toBe(String(Math.floor(createdAt.getTime() / 1000) + 45 * 60));
    expect(map.get('line_items[0][price_data][unit_amount]')).toBe('25000');
    expect(map.get('line_items[0][price_data][currency]')).toBe('aud');
    expect(map.get('metadata[mt_payment_id]')).toBe('p');
    expect(map.get('payment_intent_data[metadata][mt_idempotency_key]')).toBe('booking:b:attempt:1');
    // No customer data goes to Stripe.
    expect([...map.keys()].some((k) => /email|name\]$|phone|address/.test(k) && k !== 'line_items[0][price_data][product_data][name]')).toBe(false);
  });

  it('stripe_live_key_refused_before_network', async () => {
    const { provider, ctx, input, seen } = setup();
    for (const k of [`sk_live_${randomBytes(12).toString('hex')}`, `rk_live_${randomBytes(12).toString('hex')}`, 'not-a-key']) {
      await expect(provider.createPayment({ ...ctx, credentials: { secretKey: k } }, input())).rejects.toMatchObject({ code: 'provider_auth_failed', retryable: false });
    }
    expect(seen).toHaveLength(0);
  });

  it('stripe_live_object_is_auth_failed: a live object in a test account is refused', async () => {
    const { provider, ctx, input } = setup();
    const live = new StripeProvider({ transport: async () => ({ status: 200, headers: {}, body: JSON.stringify({ object: 'checkout.session', id: 'cs_1', livemode: true }) }) });
    await expect(live.createPayment(ctx, input())).rejects.toMatchObject({ code: 'provider_auth_failed' });
    expect(provider).toBeDefined();
  });

  it('stripe_replay_refetches_session: a replay of the create answers with the session as it is now', async () => {
    const { fake, provider, key, ctx, input } = setup();
    const i = input();
    const first = await provider.createPayment(ctx, i);
    fake.pay(key, first.ref);
    const again = await provider.createPayment(ctx, i);
    expect([again.ref, again.status]).toEqual([first.ref, 'succeeded']);
  });

  it('create_retry_uses_row_createdAt: a retry with another createdAt is the same object (idempotency_error is "look it up")', async () => {
    const { provider, ctx, input, fake } = setup();
    const i = input();
    const first = await provider.createPayment(ctx, i);
    // A retry that (wrongly) sent other parameters under the same key: Stripe answers idempotency_error; the adapter finds the session.
    const other = await provider.createPayment(ctx, { ...i, returnUrl: 'https://example.com/other', createdAt: new Date(i.createdAt.getTime() + 60_000) });
    expect(other.ref).toBe(first.ref);
    expect(fake.account(ctx.credentials.secretKey!).createCalls).toBe(1);
  });

  it('late_create_retry_looks_up_then_refuses: past 14 minutes a create never calls Stripe to create', async () => {
    const { fake, provider, ctx, input, key } = setup();
    const created = fake.now();
    const lost = input({ createdAt: created });
    const kept = input({ createdAt: created });
    const firstKept = await provider.createPayment(ctx, kept);
    const later = new Date(created.getTime() + LATE_CREATE_AFTER_MS + 60_000);
    fake.now = () => later;
    // The first call of `lost` never reached Stripe: a definitive refusal, nothing created.
    await expect(provider.createPayment(ctx, lost)).rejects.toMatchObject({ code: 'provider_rejected', retryable: false });
    expect(await provider.retrievePayment(ctx, { idempotencyKey: lost.idempotencyKey, createdAt: lost.createdAt })).toBeNull();
    // The first call of `kept` did reach Stripe: found by key, the same session.
    expect((await provider.createPayment(ctx, kept)).ref).toBe(firstKept.ref);
    expect(fake.account(key).createCalls).toBe(1);
    // A session created 20 minutes ago can no longer be created now anyway: Stripe refuses expires_at under 30 minutes.
    fake.now = () => created;
  });

  it('stripe_retrieve_by_key_scans_window_and_pages', async () => {
    const { fake, provider, ctx, input } = setup();
    const t0 = new Date('2026-11-19T00:00:00Z');
    fake.now = () => t0;
    const target = input({ createdAt: t0 });
    // 250 sessions in the window, the one we want in the middle: three pages.
    for (let n = 0; n < 120; n++) await provider.createPayment(ctx, input({ createdAt: t0 }));
    const p = await provider.createPayment(ctx, target);
    for (let n = 0; n < 130; n++) await provider.createPayment(ctx, input({ createdAt: t0 }));
    expect((await provider.retrievePayment(ctx, { idempotencyKey: target.idempotencyKey, createdAt: t0 }))?.ref).toBe(p.ref);
    // Outside the window it is not found (and never created).
    expect(await provider.retrievePayment(ctx, { idempotencyKey: target.idempotencyKey, createdAt: new Date(t0.getTime() + 3 * 3_600_000) })).toBeNull();
  });

  it('a 500 saved under the key stays retryable, and a lookup by key says nothing exists', async () => {
    const { fake, provider, ctx, input, key } = setup();
    fake.account(key).faults.push(500);
    const i = input();
    const e = await provider.createPayment(ctx, i).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect([(e as ProviderError).code, (e as ProviderError).retryable]).toEqual(['provider_unavailable', true]);
    expect(await provider.retrievePayment(ctx, { idempotencyKey: i.idempotencyKey, createdAt: i.createdAt })).toBeNull();
  });

  it('amounts outside Stripe limits and other currencies are refused without a call', async () => {
    const { provider, ctx, input, seen } = setup();
    for (const amount of [{ amountMinor: 49n, currency: 'AUD' }, { amountMinor: 100_000_000n, currency: 'AUD' }, { amountMinor: 5000n, currency: 'USD' }]) {
      await expect(provider.createPayment(ctx, input({ amount }))).rejects.toMatchObject({ code: 'provider_rejected', retryable: false });
    }
    expect(seen).toHaveLength(0);
  });

  it('an async failure ends the session failed, the same in the event and on retrieve', async () => {
    const { fake, provider, ctx, input, key } = setup();
    const p = await provider.createPayment(ctx, input());
    fake.asyncFail(key, p.ref);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('failed');
    const w = fake.event(key, secret, p.ref, new Date(), { type: 'checkout.session.async_payment_failed' });
    const v = provider.verifyWebhook(ctx, w.body, w.headers, new Date());
    expect(v.ok && v.event.payment?.status).toBe('failed');
  });
});
