// The PayPal adapter without the database (plan docs/plans/4.3-paypal-adapter.md, section 11, unit list), against the
// fake PayPal. Failure paths first: money, signatures, certificates, capture only on completePayment, cancel, probe.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PayPalProvider, orderBody, paypalManifest } from '../../../src/modules/payments/adapters/paypal/paypal';
import { fromPayPalValue, toPayPalValue } from '../../../src/modules/payments/adapters/paypal/money';
import { captureToPayment, customId, parsePayPalEvent } from '../../../src/modules/payments/adapters/paypal/mapping';
import { CertificateStore, PAYPAL_HEADERS, PAYPAL_LEAF_NAMES, certUrlAllowed, crc32, signedMessage, signingKeyOf } from '../../../src/modules/payments/adapters/paypal/webhook';
import { ProviderError } from '../../../src/modules/payments/core/provider';
import type { CreatePaymentInput, ProviderContext } from '../../../src/modules/payments/core/provider';
import { manifestProblems } from '../../../src/modules/payments/core/registry';
import { FakePayPal } from '../../contract/subjects/paypal-fake';
import { issue, paypalTestChain } from '../../contract/subjects/paypal-certs';

const DAY = 86_400_000;

function world(opts: ConstructorParameters<typeof FakePayPal>[0] = {}) {
  const fake = new FakePayPal(opts);
  const provider = new PayPalProvider({ transport: fake.transport, now: () => fake.now(), certificates: fake.trust });
  const acc = fake.newAccount();
  const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { clientId: acc.clientId, clientSecret: acc.clientSecret }, webhookSecret: acc.webhookId };
  const input = (over: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
    amount: { amountMinor: 1500n, currency: 'AUD' }, method: 'card', idempotencyKey: `booking:${randomUUID()}:attempt:1`,
    metadata: { paymentId: randomUUID(), bookingId: randomUUID() }, returnUrl: 'https://example.com/payments/return?ref=MT-1', customerCountry: 'AU', createdAt: new Date(), ...over,
  });
  const captureCalls = () => fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/capture')).length;
  return { fake, provider, ctx, input, captureCalls };
}

async function code(p: Promise<unknown>): Promise<[string, boolean]> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProviderError) return [err.code, err.retryable];
    throw err;
  }
  throw new Error('expected a ProviderError');
}

describe('money (plan 5.1)', () => {
  it('minor units to PayPal values, exactly, and refusals without a request', async () => {
    for (const [m, v] of [[1n, '0.01'], [100n, '1.00'], [1500n, '15.00'], [1505n, '15.05'], [999_999_999n, '9999999.99']] as const) expect(toPayPalValue(m, 'AUD')).toBe(v);
    for (const m of [0n, -1n, 1_000_000_000n]) expect(toPayPalValue(m, 'AUD')).toBeNull();
    expect(toPayPalValue(100n, 'USD')).toBeNull();
    expect(toPayPalValue(100n, 'JPY')).toBeNull();
    const { provider, ctx, input, fake } = world();
    for (const amount of [{ amountMinor: 0n, currency: 'AUD' }, { amountMinor: 1_000_000_000n, currency: 'AUD' }, { amountMinor: 100n, currency: 'USD' }]) {
      expect(await code(provider.createPayment(ctx, input({ amount })))).toEqual(['provider_rejected', false]);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('PayPal values back to minor units; anything else is unreadable', () => {
    for (const [v, m] of [['15.00', 1500n], ['15', 1500n], ['15.5', 1550n], ['0.01', 1n], ['0', 0n], ['9999999.99', 999_999_999n]] as const) expect(fromPayPalValue(v, 'AUD')).toBe(m);
    for (const v of ['1e3', '15.001', '-1.00', '01.00', '1,000.00', ' 1.00', '1.00 ', '', '.5', '1.', 15, null]) expect(fromPayPalValue(v, 'AUD'), String(v)).toBeNull();
    expect(fromPayPalValue('1.00', 'JPY')).toBeNull();
  });

  it('no floating point anywhere near money in the adapter', () => {
    for (const f of ['money.ts', 'mapping.ts', 'paypal.ts']) {
      const text = readFileSync(join(__dirname, '../../../src/modules/payments/adapters/paypal', f), 'utf8');
      expect(/\bparseFloat\b|\bparseInt\b|\bNumber\(|toFixed\(/.test(text), f).toBe(false);
    }
  });
});

describe('manifest and credentials (plan 3)', () => {
  it('experimental, hosted only, test-mode shapes; samples hold', () => {
    const m = paypalManifest();
    expect(manifestProblems([m])).toEqual([]);
    expect([m.status, m.testOnly, m.cardDataHandling, m.methods, m.currencies, m.checkoutOrigin]).toEqual(['experimental', false, 'hosted_only', ['card'], ['AUD'], 'https://www.sandbox.paypal.com']);
    expect('disputes' in m.capabilities, 'no dispute capability (plan D12)').toBe(false);
    expect(m.account.webhookSecret.source).toBe('entered');
  });

  it('a malformed credential fails before any request', async () => {
    const { provider, ctx, input, fake } = world();
    expect(await code(provider.createPayment({ ...ctx, credentials: { clientId: 'sk_live_x'.padEnd(30, 'x'), clientSecret: ctx.credentials.clientSecret! } }, input()))).toEqual(['provider_auth_failed', false]);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('create (plan 5.2)', () => {
  it('the body comes only from the row: identical on retries; no payment_source, so the order is CREATED', async () => {
    const { provider, ctx, input, fake } = world();
    const i = input();
    expect(JSON.stringify(orderBody(i))).toBe(JSON.stringify(orderBody({ ...i, createdAt: new Date(0) })));
    expect(orderBody(i)).not.toHaveProperty('payment_source');
    const p = await provider.createPayment(ctx, i);
    expect(p.status).toBe('requires_action');
    expect(p.nextAction?.url.startsWith('https://www.sandbox.paypal.com/checkoutnow?token=')).toBe(true);
    expect(fake.order(ctx.credentials.clientId!, p.ref)?.status).toBe('CREATED');
    const posts = fake.requests.filter((r) => r.url.endsWith('/v2/checkout/orders'));
    expect(posts[0]!.headers['paypal-request-id']).toBe(i.idempotencyKey);
    const again = await provider.createPayment(ctx, i);
    expect(again.ref).toBe(p.ref);
    expect(fake.requests.filter((r) => r.url.endsWith('/v2/checkout/orders'))[1]!.body).toBe(posts[0]!.body);
  });

  it('a test context only ever reaches the sandbox hosts', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    await provider.retrievePayment(ctx, { ref: p.ref });
    await provider.cancelPayment(ctx, p.ref, 'k');
    expect(fake.requests.every((r) => r.url.startsWith('https://api-m.sandbox.paypal.com/'))).toBe(true);
  });

  it('errors map to the closed list (plan 8)', async () => {
    for (const [status, body, expected] of [
      [401, { name: 'AUTHENTICATION_FAILURE' }, ['provider_auth_failed', false]],
      [400, { name: 'INVALID_REQUEST' }, ['provider_rejected', false]],
      [403, { name: 'NOT_AUTHORIZED' }, ['provider_rejected', false]],
      [422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PREVIOUS_REQUEST_IN_PROGRESS' }] }, ['provider_busy', true]],
      [422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PAYPAL_REQUEST_ID_PREVIOUSLY_USED' }] }, ['provider_busy', true]],
      [409, {}, ['provider_busy', true]],
      [429, {}, ['provider_busy', true]],
      [500, {}, ['provider_unavailable', true]],
      [503, 'not json', ['provider_unavailable', true]],
    ] as const) {
      const { fake, ctx, input } = world();
      const provider = new PayPalProvider({
        now: () => fake.now(), certificates: fake.trust,
        transport: async (req) => (req.url.endsWith('/oauth2/token') ? fake.transport(req) : { status, body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      expect(await code(provider.createPayment(ctx, input())), String(status)).toEqual(expected);
    }
    // 2xx we cannot read; a transport failure.
    const { fake, ctx, input } = world();
    const garbage = new PayPalProvider({ transport: async (req) => (req.url.endsWith('/oauth2/token') ? fake.transport(req) : { status: 201, body: '{"id":"x"}' }) });
    expect(await code(garbage.createPayment(ctx, input()))).toEqual(['provider_unavailable', true]);
    const down = new PayPalProvider({ transport: async () => { throw new Error(`secret ${ctx.credentials.clientSecret}`); } });
    const err = await down.createPayment(ctx, input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(ctx.credentials.clientSecret!);
  });
});

describe('capture only on completePayment (plan 5.3, review points 1 and 4)', () => {
  it('retrievePayment never captures an approved order', async () => {
    const { provider, ctx, input, fake, captureCalls } = world();
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    for (let i = 0; i < 3; i++) expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    expect((await provider.cancelPayment(ctx, p.ref, 'k')).status).toBe('cancelled');
    expect(captureCalls()).toBe(0);
    // Cancelled: completePayment does not capture it either.
    expect((await provider.completePayment(ctx, p.ref, 'k')).status).toBe('cancelled');
    expect(captureCalls()).toBe(0);
  });

  it('captures once, with the documented request ID, and reports the captured amount', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    const done = await provider.completePayment(ctx, p.ref, 'k');
    expect([done.status, done.amount.amountMinor]).toEqual(['succeeded', 1500n]);
    expect((await provider.completePayment(ctx, p.ref, 'k')).status).toBe('succeeded');
    expect(fake.captureExecutions).toBe(1);
    const cap = fake.requests.find((r) => r.url.endsWith('/capture'))!;
    expect(cap.headers['paypal-request-id']).toMatch(new RegExp(`^mt-capture:${p.ref}:[0-9a-f]{16}$`));
  });

  it('a declined instrument stays payable; no new capture until a new approval (A7)', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'decline');
    const d = await provider.completePayment(ctx, p.ref, 'k');
    expect([d.status, d.failureCode, d.nextAction?.type]).toEqual(['requires_action', 'instrument_declined', 'redirect']);
    await provider.completePayment(ctx, p.ref, 'k');
    await provider.completePayment(ctx, p.ref, 'k');
    expect(fake.captureExecutions).toBe(1);
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    expect((await provider.completePayment(ctx, p.ref, 'k')).status).toBe('succeeded');
    expect(fake.captureExecutions).toBe(2);
  });

  it('risk decline is failed and terminal; a pending capture is pending', async () => {
    const { provider, ctx, input, fake } = world();
    const a = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, a.ref, 'risk');
    expect((await provider.completePayment(ctx, a.ref, 'k')).status).toBe('failed');
    expect(() => fake.approve(ctx.credentials.clientId!, a.ref, 'good')).toThrow();
    const b = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, b.ref, 'pending');
    expect((await provider.completePayment(ctx, b.ref, 'k')).status).toBe('pending');
    fake.settleCapture(ctx.credentials.clientId!, b.ref, 'COMPLETED');
    expect((await provider.retrievePayment(ctx, { ref: b.ref }))?.status).toBe('succeeded');
  });

  it('a lost capture answer: the next call finds the capture done', async () => {
    const { fake, ctx, input } = world();
    let lose = true;
    const provider = new PayPalProvider({
      now: () => fake.now(), certificates: fake.trust,
      transport: async (req) => {
        const res = await fake.transport(req);
        if (lose && req.url.endsWith('/capture')) {
          lose = false;
          throw new ProviderError('provider_timeout', true);
        }
        return res;
      },
    });
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    expect(await code(provider.completePayment(ctx, p.ref, 'k'))).toEqual(['provider_timeout', true]);
    expect((await provider.completePayment(ctx, p.ref, 'k')).status).toBe('succeeded');
    expect(fake.captureExecutions).toBe(1);
  });

  it('amounts of collected payments come from the captures (review point 9)', () => {
    const order = {
      id: 'ORDER1', status: 'COMPLETED',
      purchase_units: [{ custom_id: customId('o', randomUUID(), 'k'), amount: { currency_code: 'AUD', value: '15.00' }, payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'AUD', value: '14.00' } }] } }],
    };
    const ev = parsePayPalEvent({ id: 'WH-1', event_type: 'CHECKOUT.ORDER.APPROVED', create_time: new Date().toISOString(), resource: order }, 'https://www.sandbox.paypal.com');
    expect(ev?.payment?.amount.amountMinor).toBe(1400n);
  });
});

describe('cancel (plan 5.4, review point 2)', () => {
  it('CREATED: marked, cancelled, and reads say cancelled', async () => {
    const { provider, ctx, input } = world();
    const p = await provider.createPayment(ctx, input());
    expect((await provider.cancelPayment(ctx, p.ref, 'k')).status).toBe('cancelled');
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('cancelled');
  });

  it('PAYER_ACTION_REQUIRED (PATCH refused by PayPal): still cancelled, nobody captures it (A8)', async () => {
    const { provider, ctx, fake } = world();
    // An order created with payment_source, as PayPal does: PATCH is refused in that state.
    const token = JSON.parse((await fake.transport({ method: 'POST', url: 'https://api-m.sandbox.paypal.com/v1/oauth2/token', body: 'grant_type=client_credentials', headers: { authorization: `Basic ${Buffer.from(`${ctx.credentials.clientId}:${ctx.credentials.clientSecret}`).toString('base64')}` } })).body).access_token as string;
    const created = await fake.transport({
      method: 'POST', url: 'https://api-m.sandbox.paypal.com/v2/checkout/orders', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ custom_id: customId('o', randomUUID(), 'k2'), amount: { currency_code: 'AUD', value: '15.00' } }], payment_source: { paypal: {} } }),
    });
    const id = JSON.parse(created.body).id as string;
    expect(fake.order(ctx.credentials.clientId!, id)?.status).toBe('PAYER_ACTION_REQUIRED');
    expect((await provider.cancelPayment(ctx, id, 'k')).status).toBe('cancelled');
    expect((await provider.retrievePayment(ctx, { ref: id }))?.status).toBe('requires_action');
  });

  it('completed: reported as it is, no PATCH; unknown: not found', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    await provider.completePayment(ctx, p.ref, 'k');
    expect((await provider.cancelPayment(ctx, p.ref, 'k')).status).toBe('succeeded');
    expect(fake.requests.some((r) => r.method === 'PATCH')).toBe(false);
    expect(await code(provider.cancelPayment(ctx, 'NOSUCHORDER1', 'k'))).toEqual(['provider_not_found', false]);
  });

  it('an order PayPal forgot (three hours) reads as null', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    fake.advance(3 * 3_600_000 + 1000);
    expect(await provider.retrievePayment(ctx, { ref: p.ref })).toBeNull();
  });
});

describe('lookup by key: the probe (plan 5.5, review point 5, A9)', () => {
  it('finds the order of the key, never creates one, says null when none', async () => {
    const { provider, ctx, input, fake } = world();
    const i = input();
    const p = await provider.createPayment(ctx, i);
    expect((await provider.retrievePayment(ctx, { idempotencyKey: i.idempotencyKey, createdAt: i.createdAt }))?.ref).toBe(p.ref);
    const before = fake.requests.length;
    expect(await provider.retrievePayment(ctx, { idempotencyKey: 'booking:none:attempt:1', createdAt: new Date() })).toBeNull();
    expect(fake.requests.length).toBe(before + 2);
  });

  it('PAYPAL_REQUEST_ID_PREVIOUSLY_USED: retryable, never null', async () => {
    const { provider, ctx, input } = world({ idempotency: 'previously_used' });
    const i = input();
    await provider.createPayment(ctx, i);
    expect(await code(provider.retrievePayment(ctx, { idempotencyKey: i.idempotencyKey, createdAt: i.createdAt }))).toEqual(['provider_busy', true]);
  });

  it('a key poisoned by a probe: the create is a definitive refusal, the lookup null, nothing captured', async () => {
    const { provider, ctx, input, fake } = world();
    const i = input();
    expect(await provider.retrievePayment(ctx, { idempotencyKey: i.idempotencyKey, createdAt: i.createdAt })).toBeNull();
    expect(await code(provider.createPayment(ctx, i))).toEqual(['provider_rejected', false]);
    expect(await provider.retrievePayment(ctx, { idempotencyKey: i.idempotencyKey, createdAt: i.createdAt })).toBeNull();
    expect(fake.captureExecutions).toBe(0);
  });

  it('an order under the key that is not ours is "unknown"', async () => {
    const { fake, ctx, input } = world();
    const provider = new PayPalProvider({
      transport: async (req) => {
        const res = await fake.transport(req);
        if (req.url.endsWith('/v2/checkout/orders') && req.body?.includes('"purchase_units":[]')) {
          return { status: 201, body: JSON.stringify({ id: 'OTHER1', status: 'CREATED', purchase_units: [{ custom_id: customId('o', randomUUID(), 'other'), amount: { currency_code: 'AUD', value: '1.00' } }] }) };
        }
        return res;
      },
    });
    const i = input();
    expect(await code(provider.retrievePayment(ctx, { idempotencyKey: i.idempotencyKey, createdAt: i.createdAt }))).toEqual(['provider_unavailable', true]);
  });
});

describe('refunds (plan 6)', () => {
  it('refusals without a request, partial then rest, capture refs', async () => {
    const { provider, ctx, input, fake } = world();
    const unpaid = await provider.createPayment(ctx, input());
    const refund = (ref: string, amountMinor: bigint, currency = 'AUD') => provider.createRefund(ctx, { paymentRef: ref, amount: { amountMinor, currency }, idempotencyKey: `r:${randomUUID()}`, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() });
    expect(await code(refund(unpaid.ref, 100n))).toEqual(['provider_rejected', false]);
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    await provider.completePayment(ctx, p.ref, 'k');
    const refundPosts = () => fake.requests.filter((r) => r.url.endsWith('/refund')).length;
    for (const [amount, currency] of [[0n, 'AUD'], [1501n, 'AUD'], [100n, 'USD']] as const) expect(await code(refund(p.ref, amount, currency))).toEqual(['provider_rejected', false]);
    expect(refundPosts()).toBe(0);
    const a = await refund(p.ref, 500n);
    expect([a.status, a.amount.amountMinor, a.paymentRef.startsWith('capture:')]).toEqual(['succeeded', 500n, true]);
    expect((await provider.retrievePayment(ctx, { ref: a.paymentRef }))?.ref).toBe(p.ref);
    await refund(p.ref, 1000n);
    expect(await code(refund(p.ref, 1n))).toEqual(['provider_rejected', false]);
    expect(await code(refund('not-an-id', 1n))).toEqual(['provider_not_found', false]);
  });
});

describe('webhooks: signatures (plan 7.2)', () => {
  async function signedEvent() {
    const w = world();
    const p = await w.provider.createPayment(w.ctx, w.input());
    const at = w.fake.now();
    const e = w.fake.event(w.ctx.credentials.clientId!, w.ctx.webhookSecret, p.ref, at);
    await w.provider.prepareWebhook(w.ctx, e.headers);
    return { ...w, e, at };
  }

  it('CRC-32 and the signed message', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const body = randomBytes(1000);
    expect(crc32(body)).toBe(zlibCrc32(body) >>> 0);
    expect(signedMessage('t-1', '2026-11-19T00:00:00Z', 'WEBHOOK1', Buffer.from('123456789')).toString()).toBe(`t-1|2026-11-19T00:00:00Z|WEBHOOK1|${0xcbf43926}`);
  });

  it('valid; tampered; other webhook ID; other algorithm; missing or oversized headers', async () => {
    const { provider, ctx, e, at } = await signedEvent();
    expect(provider.verifyWebhook(ctx, e.body, e.headers, at).ok).toBe(true);
    const t = Buffer.from(e.body);
    t[10] = t[10]! ^ 1;
    expect(provider.verifyWebhook(ctx, t, e.headers, at)).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(provider.verifyWebhook({ ...ctx, webhookSecret: 'OTHERWEBHOOK12345' }, e.body, e.headers, at)).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(provider.verifyWebhook(ctx, e.body, { ...e.headers, [PAYPAL_HEADERS.authAlgo]: 'SHA1withRSA' }, at)).toMatchObject({ ok: false, code: 'bad_signature' });
    for (const name of Object.values(PAYPAL_HEADERS)) {
      const without = { ...e.headers };
      delete without[name];
      expect(provider.verifyWebhook(ctx, e.body, without, at).ok, name).toBe(false);
      expect(provider.verifyWebhook(ctx, e.body, { ...e.headers, [name]: 'x'.repeat(2000) }, at).ok, name).toBe(false);
    }
    for (const time of ['2026-11-19 00:00:00', '2026-11-19T00:00:00+00:00', 'yesterday']) expect(provider.verifyWebhook(ctx, e.body, { ...e.headers, [PAYPAL_HEADERS.transmissionTime]: time }, at).ok).toBe(false);
  });

  it('±299 s accepted, ±301 s and an hour stale', async () => {
    const { provider, ctx, e, at } = await signedEvent();
    for (const d of [299_000, -299_000]) expect(provider.verifyWebhook(ctx, e.body, e.headers, new Date(at.getTime() + d)).ok).toBe(true);
    for (const d of [301_000, -301_000, 3_600_000, -3_600_000]) expect(provider.verifyWebhook(ctx, e.body, e.headers, new Date(at.getTime() + d))).toMatchObject({ ok: false, code: 'stale_timestamp' });
  });

  it('certificate URLs: only the mode hosts and path', () => {
    const good = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270';
    expect(certUrlAllowed(good, 'test')).toBe(true);
    expect(certUrlAllowed(good.replace('api.', 'api-m.'), 'test')).toBe(true);
    expect(certUrlAllowed(good, 'live')).toBe(false);
    expect(certUrlAllowed(good.replace('.sandbox', ''), 'test')).toBe(false);
    for (const bad of [
      good.replace('https', 'http'), good.replace('api.sandbox.paypal.com', 'evilpaypal.com'), good.replace('paypal.com', 'paypal.com.evil.com'),
      good.replace('https://', 'https://user@'), good.replace('.com/', '.com:8443/'), `${good}?x=1`, `${good}#x`, good.replace('/certs/', '/certs/../'),
      good.replace('api.sandbox.paypal.com', 'api.sandbox.paypal.com@evil.com'),
    ]) expect(certUrlAllowed(bad, 'test'), bad).toBe(false);
  });

  it('not prepared: refused without any request; prepare downloads only allowlisted URLs', async () => {
    const w = world();
    const p = await w.provider.createPayment(w.ctx, w.input());
    const e = w.fake.event(w.ctx.credentials.clientId!, w.ctx.webhookSecret, p.ref, w.fake.now());
    expect(w.provider.verifyWebhook(w.ctx, e.body, e.headers, w.fake.now())).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(w.fake.certDownloads).toBe(0);
    await w.provider.prepareWebhook(w.ctx, { ...e.headers, [PAYPAL_HEADERS.certUrl]: 'https://evil.example.com/cert.pem' });
    expect(w.fake.certDownloads).toBe(0);
  });

  it('the registered adapter (default trust) refuses the fake CA', async () => {
    const w = world();
    const real = new PayPalProvider({ transport: w.fake.transport, certificates: { ...w.fake.trust, roots: [] } });
    const p = await w.provider.createPayment(w.ctx, w.input());
    const e = w.fake.event(w.ctx.credentials.clientId!, w.ctx.webhookSecret, p.ref, w.fake.now());
    await real.prepareWebhook(w.ctx, e.headers);
    expect(real.verifyWebhook(w.ctx, e.body, e.headers, w.fake.now()).ok).toBe(false);
    // And Node's own store: the fake root is not in it.
    const defaultReal = new PayPalProvider();
    expect(defaultReal.verifyWebhook(w.ctx, e.body, e.headers, w.fake.now()).ok).toBe(false);
  });

  it('garbage never throws', async () => {
    const { provider, ctx, e } = await signedEvent();
    for (const body of [Buffer.alloc(0), Buffer.from('null'), Buffer.from('[]'), Buffer.from([0xff, 0xfe]), Buffer.alloc(256 * 1024, 0x7b)]) {
      expect(provider.verifyWebhook(ctx, body, e.headers, new Date()).ok).toBe(false);
      expect(provider.parseEvent(body)).toBeNull();
    }
  });
});

describe('certificates (plan 7.3, review points 7 and 8)', () => {
  const name = PAYPAL_LEAF_NAMES.test;

  it('chain rules: name, validity, CA flags and key usage, anchor', () => {
    const c = paypalTestChain();
    const now = Date.now();
    expect(signingKeyOf(c.chainPem, [c.root.cert], name, now)).not.toBeNull();
    expect(signingKeyOf(c.chainPem, [c.root.cert], PAYPAL_LEAF_NAMES.live, now)).toBeNull();
    expect(signingKeyOf(c.chainPem, [], name, now)).toBeNull();
    expect(signingKeyOf(c.chainPem, [c.root.cert], name, now + 400 * DAY)).toBeNull();
    expect(signingKeyOf(c.chainPem, [c.root.cert], name, now - 2 * DAY)).toBeNull();
    expect(signingKeyOf(c.leaf.pem, [c.root.cert], name, now), 'no intermediate').toBeNull();
    const window = { notBefore: new Date(now - DAY), notAfter: new Date(now + DAY) };
    // A non-CA certificate used as an intermediate.
    const notCa = issue({ cn: 'Not a CA', ca: false, usage: [0, 5], ...window }, c.root);
    const leafUnderNotCa = issue({ cn: name, dns: name, ca: false, usage: [0], ...window }, notCa);
    expect(signingKeyOf(`${leafUnderNotCa.pem}\n${notCa.pem}`, [c.root.cert], name, now)).toBeNull();
    // A CA without keyCertSign.
    const noSign = issue({ cn: 'CA without keyCertSign', ca: true, usage: [0], ...window }, c.root);
    const leafUnderNoSign = issue({ cn: name, dns: name, ca: false, usage: [0], ...window }, noSign);
    expect(signingKeyOf(`${leafUnderNoSign.pem}\n${noSign.pem}`, [c.root.cert], name, now)).toBeNull();
    // A leaf that may not sign.
    const leafNoSig = issue({ cn: name, dns: name, ca: false, usage: [5], ...window }, c.intermediate);
    expect(signingKeyOf(`${leafNoSig.pem}\n${c.intermediate.pem}`, [c.root.cert], name, now)).toBeNull();
    expect(signingKeyOf('not a pem', [c.root.cert], name, now)).toBeNull();
  });

  it('negative cache, single flight and a download cap', async () => {
    const c = paypalTestChain();
    let downloads = 0;
    const gates: Array<() => void> = [];
    let fail = true;
    let now = new Date();
    const store = new CertificateStore({
      roots: [c.root.pem], leafNames: PAYPAL_LEAF_NAMES,
      fetch: async () => {
        downloads++;
        await new Promise<void>((r) => gates.push(r));
        if (fail) throw new Error('down');
        return c.chainPem;
      },
    }, () => now);
    const url = (n: number) => `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-${n}`;
    const a = [store.prepare(url(1), 'test'), store.prepare(url(1), 'test'), store.prepare(url(1), 'test')];
    const b = store.prepare(url(2), 'test');
    const capped = store.prepare(url(3), 'test');
    await capped;
    expect(downloads, 'one per URL, at most two at once').toBe(2);
    gates.splice(0).forEach((g) => g());
    await Promise.all([...a, b]);
    await store.prepare(url(1), 'test');
    expect(downloads, 'a failure is remembered for a minute').toBe(2);
    fail = false;
    now = new Date(now.getTime() + 61_000);
    const again = store.prepare(url(1), 'test');
    await new Promise((r) => setTimeout(r, 0));
    gates.splice(0).forEach((g) => g());
    await again;
    expect(downloads).toBe(3);
    expect(store.key(url(1), now)).not.toBeNull();
  });
});

describe('events (plan 7.1, review point 3)', () => {
  const at = new Date().toISOString();
  const capture = (status: string) => ({ id: 'CAP1', status, amount: { currency_code: 'AUD', value: '15.00' }, custom_id: customId('o', randomUUID(), 'k'), supplementary_data: { related_ids: { order_id: 'ORDER1' } } });

  it('a declined capture in a webhook is requires_action: the read decides', () => {
    expect(captureToPayment(capture('DECLINED'))?.status).toBe('requires_action');
    expect(parsePayPalEvent({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.DECLINED', create_time: at, resource: capture('DECLINED') }, 'https://www.sandbox.paypal.com')?.payment?.status).toBe('requires_action');
    expect(captureToPayment(capture('COMPLETED'))?.status).toBe('succeeded');
    expect(captureToPayment(capture('PENDING'))?.status).toBe('pending');
  });

  it('unsupported, unreadable and foreign', () => {
    const origin = 'https://www.sandbox.paypal.com';
    for (const type of ['PAYMENT.CAPTURE.REVERSED', 'CUSTOMER.DISPUTE.CREATED', 'BILLING.SUBSCRIPTION.CREATED']) expect(parsePayPalEvent({ id: 'WH-1', event_type: type, create_time: at, resource: {} }, origin)?.kind).toBe('unsupported');
    const { supplementary_data: _gone, ...noOrder } = capture('COMPLETED');
    expect(parsePayPalEvent({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: at, resource: noOrder }, origin)).toBeNull();
    expect(captureToPayment({ ...capture('COMPLETED'), custom_id: 'someone-else' })?.ourPaymentId).toBeUndefined();
    expect(parsePayPalEvent({ id: 'not-wh', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: at, resource: capture('COMPLETED') }, origin)).toBeNull();
  });
});

describe('review round on PR #76', () => {
  it('M1: an unknown 422 on capture is a definitive refusal of the adapter (the core then leaves the read)', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    fake.captureIssue = 'PAYEE_ACCOUNT_RESTRICTED';
    expect(await code(provider.completePayment(ctx, p.ref, 'k'))).toEqual(['provider_rejected', false]);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
  });

  it('L3: an approval link outside the checkout origin is refused', async () => {
    const { fake, ctx, input } = world();
    const provider = new PayPalProvider({
      transport: async (req) => {
        const res = await fake.transport(req);
        return req.url.endsWith('/v2/checkout/orders') ? { ...res, body: res.body.replace('https://www.sandbox.paypal.com/checkoutnow', 'https://evil.example.com/checkoutnow') } : res;
      },
    });
    expect(await code(provider.createPayment(ctx, input()))).toEqual(['provider_unavailable', true]);
  });

  it('L4: no download for a delivery that fails the cheap checks; at most ten new downloads a minute', async () => {
    const w = world();
    const p = await w.provider.createPayment(w.ctx, w.input());
    const old = w.fake.event(w.ctx.credentials.clientId!, w.ctx.webhookSecret, p.ref, new Date(w.fake.now().getTime() - 301_000));
    await w.provider.prepareWebhook(w.ctx, old.headers);
    await w.provider.prepareWebhook(w.ctx, { ...old.headers, [PAYPAL_HEADERS.transmissionTime]: w.fake.now().toISOString(), [PAYPAL_HEADERS.authAlgo]: 'SHA1withRSA' });
    expect(w.fake.certDownloads).toBe(0);
    let downloads = 0;
    const store = new CertificateStore({ roots: [], leafNames: PAYPAL_LEAF_NAMES, fetch: async () => (downloads++, 'not a pem') }, () => new Date());
    for (let i = 0; i < 15; i++) await store.prepare(`https://api.sandbox.paypal.com/v1/notifications/certs/CERT-l4-${i}`, 'test');
    expect(downloads).toBe(10);
  });

  it('L6: the seventeenth certificate evicts the least recently used', async () => {
    const c = paypalTestChain();
    let now = new Date();
    const store = new CertificateStore({ roots: [c.root.pem], leafNames: PAYPAL_LEAF_NAMES, fetch: async () => c.chainPem }, () => now);
    const url = (n: number) => `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-lru-${n}`;
    for (let i = 1; i <= 17; i++) {
      await store.prepare(url(i), 'test');
      now = new Date(now.getTime() + 7_000);
    }
    expect(store.key(url(1), now)).toBeNull();
    expect(store.key(url(2), now)).not.toBeNull();
    expect(store.key(url(17), now)).not.toBeNull();
  });

  it('L6: the default download refuses redirects and oversized bodies', async () => {
    const { createServer } = await import('node:http');
    const { defaultCertificateFetch } = await import('../../../src/modules/payments/adapters/paypal/webhook');
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/pem' });
        res.end();
      } else if (req.url === '/big') {
        res.writeHead(200);
        res.end('x'.repeat(70 * 1024));
      } else {
        res.writeHead(200);
        res.end('hello');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(defaultCertificateFetch(`http://127.0.0.1:${port}/redirect`)).rejects.toThrow();
      await expect(defaultCertificateFetch(`http://127.0.0.1:${port}/big`)).rejects.toThrow();
      // Not a PEM: downloaded, then refused by the chain check.
      const text = await defaultCertificateFetch(`http://127.0.0.1:${port}/pem`);
      expect(signingKeyOf(text, [], PAYPAL_LEAF_NAMES.test, Date.now())).toBeNull();
    } finally {
      server.close();
    }
  });

  it('L6: a retry under the same key for more than is left returns the refund already made', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    await provider.completePayment(ctx, p.ref, 'k');
    const r = { paymentRef: p.ref, amount: { amountMinor: 1000n, currency: 'AUD' }, idempotencyKey: `r:${randomUUID()}`, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() };
    const first = await provider.createRefund(ctx, r);
    const again = await provider.createRefund(ctx, r);
    expect(again.ref).toBe(first.ref);
    expect(fake.requests.filter((x) => x.url.endsWith('/refund'))).toHaveLength(1);
  });

  it('L6: more than twenty refunds make a lookup by key "unknown"', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    await provider.completePayment(ctx, p.ref, 'k');
    for (let i = 0; i < 21; i++) fake.dashboardRefund(ctx.credentials.clientId!, p.ref, 1n);
    expect(await code(provider.retrieveRefund(ctx, { idempotencyKey: 'r:x', paymentRef: p.ref, createdAt: new Date() }))).toEqual(['provider_unavailable', true]);
  });

  it('L6: two concurrent completePayment capture once', async () => {
    const { provider, ctx, input, fake } = world();
    const p = await provider.createPayment(ctx, input());
    fake.approve(ctx.credentials.clientId!, p.ref, 'good');
    const [a, b] = await Promise.all([provider.completePayment(ctx, p.ref, 'k'), provider.completePayment(ctx, p.ref, 'k')]);
    expect([a.status, b.status]).toEqual(['succeeded', 'succeeded']);
    expect(fake.captureExecutions).toBe(1);
  });

  it('M2: reversals and opened disputes are flagged for review', () => {
    const at = new Date().toISOString();
    expect(parsePayPalEvent({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.REVERSED', create_time: at, resource: {} }, 'https://www.sandbox.paypal.com')).toMatchObject({ kind: 'unsupported', review: 'reversal' });
    expect(parsePayPalEvent({ id: 'WH-1', event_type: 'CUSTOMER.DISPUTE.CREATED', create_time: at, resource: {} }, 'https://www.sandbox.paypal.com')).toMatchObject({ kind: 'unsupported', review: 'dispute' });
    expect(parsePayPalEvent({ id: 'WH-1', event_type: 'CUSTOMER.DISPUTE.UPDATED', create_time: at, resource: {} }, 'https://www.sandbox.paypal.com')?.review).toBeUndefined();
  });
});
