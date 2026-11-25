// The Airwallex adapter without a database (plan docs/plans/9.2-airwallex.md, sections 13, 19 and 20): money both ways,
// references, signatures, event parsing, error mapping, the item-by-item searches, cancel and refunds against the
// fake Airwallex. Every Airwallex fact behind the fake is UNVERIFIED until the sandbox run.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAdapters } from '../../../src/modules/payments/adapters';
import { AIRWALLEX_CHECKOUT_ORIGIN, AirwallexProvider, CREATE_HORIZON_S, GET_RETURNS_ORDER_FIELDS, airwallexManifest } from '../../../src/modules/payments/adapters/airwallex/airwallex';
import { AIRWALLEX_API_BASE, errorFor } from '../../../src/modules/payments/adapters/airwallex/http';
import type { AirwallexTransport } from '../../../src/modules/payments/adapters/airwallex/http';
import { parseExact, writeExact } from '../../../src/modules/payments/adapters/airwallex/json';
import { parseAirwallexEvent, parseRef, refFor, signAirwallex } from '../../../src/modules/payments/adapters/airwallex/mapping';
import { DecimalLiteral, fromAirwallexAmount } from '../../../src/modules/payments/adapters/airwallex/money';
import { catalogueCapabilities } from '../../../src/modules/payments/core/account-admin.service';
import { EVENTLESS_ADAPTER_KEYS, ProviderError } from '../../../src/modules/payments/core/provider';
import type { CreatePaymentInput, ProviderContext } from '../../../src/modules/payments/core/provider';
import { manifestProblems } from '../../../src/modules/payments/core/registry';
import { FakeAirwallex, RawNumber, signedDelivery } from '../../contract/subjects/airwallex-fake';

const fakeWith = (opts: { getReturnsOrderFields?: boolean } = {}) => {
  const fake = new FakeAirwallex();
  const provider = new AirwallexProvider({ transport: fake.transport, now: () => fake.now(), ...opts });
  const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { ...fake.newAccount() }, webhookSecret: `whsec_${randomBytes(24).toString('hex')}` };
  return { fake, provider, ctx, id: ctx.credentials.clientId! };
};

const input = (over: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
  amount: { amountMinor: 1250n, currency: 'AUD' }, method: 'card', idempotencyKey: `booking:${randomUUID()}:attempt:1`,
  metadata: { paymentId: randomUUID(), bookingId: randomUUID() }, returnUrl: 'https://example.com/payments/return', customerCountry: 'AU', createdAt: new Date(), ...over,
});

async function providerError(fn: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('expected a ProviderError');
}

const posts = (fake: FakeAirwallex, path: string) => fake.log.filter((l) => l.method === 'POST' && l.path === path).length;
const CREATE = '/api/v1/checkout/checkout_sessions/create';
const REFUND = '/api/v1/pa/refunds/create';

describe('money (plan 5, 19.6, 20.7)', () => {
  it('minor units to decimals and back, exactly, AUD only', () => {
    for (const [m, d] of [[1n, '0.01'], [99n, '0.99'], [100n, '1.00'], [101n, '1.01'], [1250n, '12.50'], [999_999_999n, '9999999.99']] as const) {
      expect(DecimalLiteral.of(m, 'AUD')?.text).toBe(d);
      expect(fromAirwallexAmount(d, 'AUD')).toBe(m);
    }
    for (const m of [0n, -1n, 1_000_000_000n]) expect(DecimalLiteral.of(m, 'AUD')).toBeNull();
    expect(DecimalLiteral.of(1250n, 'USD')).toBeNull();
    expect(DecimalLiteral.of(1250n, 'JPY')).toBeNull();
  });

  it('reads only plain decimals with at most two places; foreign currencies are unreadable, never multiplied', () => {
    expect(fromAirwallexAmount('10.50', 'AUD')).toBe(1050n);
    expect(fromAirwallexAmount('10.5', 'AUD')).toBe(1050n);
    expect(fromAirwallexAmount('0.00', 'AUD')).toBe(0n);
    expect(fromAirwallexAmount('12345678901234567.99', 'AUD')).toBeNull();
    for (const bad of ['1.', '.5', '01.00', '1E2', '1e2', '-1', '1.001', ' 1.00', '1.00 ', '+1', 'NaN', '']) expect(fromAirwallexAmount(bad, 'AUD'), bad).toBeNull();
    expect(fromAirwallexAmount(12.5, 'AUD')).toBeNull();
    expect(fromAirwallexAmount('1250', 'JPY')).toBeNull();
    expect(fromAirwallexAmount('12.500', 'KWD')).toBeNull();
  });

  it('JSON numbers keep their source text; a body writes the literal exactly, never through Number()', () => {
    expect(parseExact('{"a":100.10,"b":[1,2.5],"c":"x","d":17.999999999999999}')).toEqual({ a: '100.10', b: ['1', '2.5'], c: 'x', d: '17.999999999999999' });
    const lit = DecimalLiteral.of(1250n, 'AUD')!;
    expect(writeExact({ amount: lit, unit_amount: lit.text, quantity: 1, ok: true, list: ['card'] })).toBe('{"amount":12.50,"unit_amount":"12.50","quantity":1,"ok":true,"list":["card"]}');
    expect(() => writeExact({ x: 0.1 })).toThrow();
  });

  it('the bodies sent: the session carries "unit_amount":"12.50" and the refund "amount":12.50', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const i = input();
    const p = await provider.createPayment(ctx, i);
    fake.pay(id, p.ref);
    await provider.createRefund(ctx, { paymentRef: p.ref, amount: { amountMinor: 1250n, currency: 'AUD' }, idempotencyKey: randomUUID(), metadata: { refundId: randomUUID(), paymentId: i.metadata.paymentId, bookingId: i.metadata.bookingId }, createdAt: new Date() });
    expect(fake.log.find((l) => l.path === CREATE)?.body).toContain('"unit_amount":"12.50"');
    expect(fake.log.find((l) => l.path === REFUND)?.body).toContain('"amount":12.50,');
  });
});

describe('references, manifest and catalogue (plan 4, 6.1, 12)', () => {
  it('the ref is our payment id and the attempt time; anything else is refused', () => {
    const id = randomUUID();
    const ref = refFor(id, new Date(1_800_000_000_000))!;
    expect(ref).toBe(`mt-${id}-1800000000`);
    expect(ref.length).toBeLessThanOrEqual(64);
    expect(parseRef(ref)).toEqual({ paymentId: id, createdAtS: 1_800_000_000 });
    expect(refFor('not-a-uuid', new Date())).toBeNull();
    for (const bad of [`mt-${id}-18000000000`, `mt-${id}`, `mt-${id.toUpperCase()}-1800000000`, `x${ref}`, `${ref}x`]) expect(parseRef(bad)).toBeNull();
  });

  it('manifest: experimental, cards in AUD, gateway page, signed events, no capability added; others unchanged', () => {
    const m = airwallexManifest();
    expect(manifestProblems([m])).toEqual([]);
    expect([m.status, m.testOnly, m.methods, m.currencies, m.checkoutOrigin]).toEqual(['experimental', false, ['card'], ['AUD'], AIRWALLEX_CHECKOUT_ORIGIN]);
    expect(m.capabilities).toEqual({ refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'stays_payable' });
    expect(EVENTLESS_ADAPTER_KEYS).toEqual(['eway']);
    expect(GET_RETURNS_ORDER_FIELDS).toBe(false);
    const adapters = createAdapters({ webOrigin: 'http://localhost:3000' });
    expect(adapters.map((a) => a.manifest.key)).toEqual(['simulator', 'stripe', 'paypal', 'pin_payments', 'eway', 'airwallex']);
    expect(catalogueCapabilities(adapters.find((a) => a.manifest.key === 'airwallex')!.manifest)).toEqual({ refunds: 'partial', deferredCapture: false, disputes: false, reconciliation: null, gatewayEvents: 'signed', cardEntry: 'gateway_page' });
  });

  it('existing_manifests_unchanged: the other adapters are as they were before task 9.2', () => {
    const adapters = createAdapters({ webOrigin: 'http://localhost:3000' }).filter((a) => a.manifest.key !== 'airwallex');
    const hash = createHash('sha256').update(JSON.stringify(adapters.map((a) => [a.manifest, [...a.signatureHeaders]]))).digest('hex');
    expect(hash).toBe(MANIFESTS_BEFORE_9_2);
  });
});

/** sha256 of the other adapters' manifests and signature headers on main before 9.2 (c912422). */
const MANIFESTS_BEFORE_9_2 = '5ca2eebbfa70a819f00cadcdff9b9b1b975e23e86988e0874f928de2c2fe5a4e';

describe('webhook signatures (plan 7, 19.7, 20.4, 20.6)', () => {
  const secret = 'whsec_0123456789abcdef0123';
  const body = Buffer.from('{"id":"evt_1","name":"refund.settled","created_at":"2026-11-25T00:00:00Z","data":{"object":{}}}');
  const at = new Date('2026-11-25T00:00:00.000Z');
  const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: {}, webhookSecret: secret };
  const p = new AirwallexProvider({ transport: async () => ({ status: 500, body: '' }) });
  const headers = (ts: string, sig = signAirwallex(secret, ts, body)) => ({ 'x-timestamp': ts, 'x-signature': sig });

  it('valid in milliseconds or seconds, either hex case; 299 s yes, 301 s and an hour no, both ways', () => {
    expect(p.verifyWebhook(ctx, body, headers(String(at.getTime())), at).ok).toBe(true);
    expect(p.verifyWebhook(ctx, body, headers(String(at.getTime() / 1000)), at).ok).toBe(true);
    expect(p.verifyWebhook(ctx, body, headers(String(at.getTime()), signAirwallex(secret, String(at.getTime()), body).toUpperCase()), at).ok).toBe(true);
    const ts = String(at.getTime());
    expect(p.verifyWebhook(ctx, body, headers(ts), new Date(at.getTime() + 299_000)).ok).toBe(true);
    for (const d of [301_000, -301_000, 3_600_000, -3_600_000]) expect(p.verifyWebhook(ctx, body, headers(ts), new Date(at.getTime() + d))).toMatchObject({ ok: false, code: 'stale_timestamp', claimedEventId: 'evt_1' });
  });

  it('refusals: bad signature names the event; empty secret; malformed headers; never throws', () => {
    const ts = String(at.getTime());
    expect(p.verifyWebhook(ctx, body, headers(ts, 'a'.repeat(64)), at)).toEqual({ ok: false, code: 'bad_signature', claimedEventId: 'evt_1' });
    expect(p.verifyWebhook({ ...ctx, webhookSecret: '' }, body, headers(ts), at)).toMatchObject({ ok: false, code: 'bad_signature' });
    for (const h of [{}, { 'x-timestamp': ts }, { 'x-signature': 'a'.repeat(64) }, headers('12345678901'), headers('abc'), headers(ts, 'z'.repeat(64)), headers(ts, 'a'.repeat(63)), headers('x'.repeat(10_000))]) {
      expect(p.verifyWebhook(ctx, body, h as Record<string, string>, at).ok).toBe(false);
    }
    expect(p.verifyWebhook(ctx, Buffer.from([0xff, 0x00]), headers(ts), at).ok).toBe(false);
  });
});

describe('events (plan 7, 19.1, 19.4, 20.7)', () => {
  const ref = refFor(randomUUID(), new Date())!;
  const ev = (name: string, object: unknown) => Buffer.from(JSON.stringify({ id: `evt_${randomBytes(4).toString('hex')}`, name, created_at: new Date().toISOString(), data: { object } }).replace(/"__NUM__(.*?)"/g, '$1'));
  const intent = (status: string, extra: object = {}) => ({ id: 'int_abc123', status, amount: '__NUM__12.50', currency: 'AUD', merchant_order_id: ref, ...extra });
  const session = (status: string) => ({ id: 'cs_1', status, currency: 'AUD', url: `${AIRWALLEX_CHECKOUT_ORIGIN}/pay?s=1`, metadata: { mt_ref: ref, mt_amount_minor: '1250' }, payment_intent_data: { merchant_order_id: ref } });

  it('intent events carry ref, status, amount and our id; open intents wait; cancelled intents are left to the pulls', () => {
    const table: Array<[string, string | null]> = [['SUCCEEDED', 'succeeded'], ['PENDING', 'pending'], ['PENDING_REVIEW', 'pending'], ['REQUIRES_CAPTURE', 'pending'], ['REQUIRES_PAYMENT_METHOD', 'requires_action'], ['REQUIRES_CUSTOMER_ACTION', 'requires_action']];
    for (const [status, ours] of table) {
      const e = parseAirwallexEvent(ev(`payment_intent.${status.toLowerCase()}`, intent(status)))!;
      expect([e.kind, e.payment?.status, e.payment?.ref, e.payment?.amount.amountMinor, e.payment?.ourPaymentId], status).toEqual(['payment', ours, ref, 1250n, parseRef(ref)!.paymentId]);
    }
    expect(parseAirwallexEvent(ev('payment_intent.cancelled', intent('CANCELLED')))?.kind).toBe('unsupported');
    expect(parseAirwallexEvent(ev('payment_intent.succeeded', intent('SOMETHING_NEW')))).toBeNull();
    expect(parseAirwallexEvent(ev('payment_intent.succeeded', intent('SUCCEEDED', { merchant_order_id: 'order-42' })))?.kind).toBe('unsupported');
    expect(parseAirwallexEvent(ev('payment_intent.succeeded', intent('SUCCEEDED', { currency: 'JPY', amount: '1250' })))).toBeNull();
  });

  it('session events: created waits, cancelled ends unpaid, completed says nothing; no redirect in an event', () => {
    const created = parseAirwallexEvent(ev('checkout_session.created', session('ACTIVE')))!;
    expect([created.kind, created.payment?.status, created.payment?.ref, created.payment?.nextAction]).toEqual(['payment', 'requires_action', ref, undefined]);
    expect(parseAirwallexEvent(ev('checkout_session.cancelled', session('CANCELLED')))?.payment?.status).toBe('cancelled');
    expect(parseAirwallexEvent(ev('checkout_session.completed', session('COMPLETED')))?.kind).toBe('unsupported');
  });

  it('disputes, chargebacks and reversals open a review, known names or not; unreadable refunds too', () => {
    expect(parseAirwallexEvent(ev('payment_dispute.unknown_new_state', {}))).toMatchObject({ kind: 'unsupported', review: 'dispute' });
    expect(parseAirwallexEvent(ev('payment_dispute.created', {}))).toMatchObject({ review: 'dispute' });
    expect(parseAirwallexEvent(ev('chargeback.opened', {}))).toMatchObject({ review: 'dispute' });
    expect(parseAirwallexEvent(ev('payment_attempt.reversal', {}))).toMatchObject({ review: 'reversal' });
    expect(parseAirwallexEvent(ev('refund.settled', { id: 'rfd_1', status: 'SETTLED', amount: '__NUM__1250', currency: 'JPY', payment_intent_id: 'int_abc123' }))).toMatchObject({ kind: 'unsupported', review: 'reversal' });
    expect(parseAirwallexEvent(ev('payment_attempt.authorized', {}))).toMatchObject({ kind: 'unsupported' });
    expect(parseAirwallexEvent(ev('payment_attempt.authorized', {}))?.review).toBeUndefined();
  });

  it('refund statuses (D5): received and accepted are pending, settled succeeded, failed failed', () => {
    const refund = (status: string) => parseAirwallexEvent(ev(`refund.${status.toLowerCase()}`, { id: 'rfd_1', status, amount: '__NUM__5.00', currency: 'AUD', payment_intent_id: 'int_abc123', metadata: { mt_ref: ref, mt_refund_id: randomUUID() } }))!;
    expect(['RECEIVED', 'ACCEPTED', 'SETTLED', 'FAILED'].map((s) => refund(s).refund?.status)).toEqual(['pending', 'pending', 'succeeded', 'failed']);
    expect([refund('SETTLED').refund?.paymentRef, refund('SETTLED').refund?.amount.amountMinor]).toEqual([ref, 500n]);
  });
});

describe('HTTP: host, version, errors (plan 11)', () => {
  it('a fixed host per mode and the API version on every request', async () => {
    const seen: string[] = [];
    const transport: AirwallexTransport = async (req) => {
      seen.push(`${new URL(req.url).origin} ${req.headers['x-api-version']}`);
      return { status: 401, body: '{"code":"unauthorized"}' };
    };
    const p = new AirwallexProvider({ transport });
    const creds = { clientId: `C${'x'.repeat(20)}`, apiKey: 'a'.repeat(64) };
    expect((await p.testConnection({ accountId: randomUUID(), mode: 'test', credentials: creds, webhookSecret: '' })).ok).toBe(false);
    expect((await p.testConnection({ accountId: randomUUID(), mode: 'live', credentials: creds, webhookSecret: '' })).ok).toBe(false);
    expect(seen).toEqual([`${AIRWALLEX_API_BASE.test} 2026-05-29`, `${AIRWALLEX_API_BASE.live} 2026-05-29`]);
  });

  it('error mapping: only auth and validation_error are definitive', () => {
    const code = (status: number, c?: string) => { const e = errorFor({ status, code: c }); return [e.code, e.retryable]; };
    expect(code(401)).toEqual(['provider_auth_failed', false]);
    expect(code(403)).toEqual(['provider_auth_failed', false]);
    expect(code(400, 'validation_error')).toEqual(['provider_rejected', false]);
    expect(code(400, 'duplicate_request_id')).toEqual(['provider_busy', true]);
    expect(code(400, 'something_else')).toEqual(['provider_unavailable', true]);
    expect(code(429)).toEqual(['provider_busy', true]);
    expect(code(500)).toEqual(['provider_unavailable', true]);
    expect(code(404)).toEqual(['provider_not_found', false]);
  });

  it('create: validation_error is definitive; a 404, a 409 or a 500 on create is not', async () => {
    for (const [status, c, expected] of [[400, 'validation_error', ['provider_rejected', false]], [404, undefined, ['provider_unavailable', true]], [409, undefined, ['provider_unavailable', true]], [500, undefined, ['provider_unavailable', true]], [429, undefined, ['provider_busy', true]]] as const) {
      const { fake, provider, ctx } = fakeWith();
      fake.failNext((r) => r.url.endsWith(CREATE), status, c);
      const e = await providerError(() => provider.createPayment(ctx, input()));
      expect([e.code, e.retryable], `${status}`).toEqual(expected);
    }
  });

  it('no credential, token or secret in any error', async () => {
    const { fake, provider, ctx } = fakeWith();
    fake.failNext((r) => r.url.endsWith(CREATE), 500);
    const e = await providerError(() => provider.createPayment(ctx, input()));
    const text = `${e.message} ${e.stack} ${JSON.stringify(e)}`;
    for (const v of [ctx.credentials.clientId!, ctx.credentials.apiKey!, ctx.webhookSecret]) expect(text.includes(v)).toBe(false);
  });
});

describe('one session per ref, and searches checked item by item (plan 6.3, 19.2, 19.5, 20.3)', () => {
  it('lost_create_answer_finds_the_session_and_never_creates_a_second', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const i = input();
    fake.loseNext((r) => r.url.endsWith(CREATE));
    expect((await providerError(() => provider.createPayment(ctx, i))).retryable).toBe(true);
    const p = await provider.createPayment(ctx, i);
    expect(p.status).toBe('requires_action');
    expect(p.nextAction?.url.startsWith(`${AIRWALLEX_CHECKOUT_ORIGIN}/`)).toBe(true);
    expect(fake.sessionPosts(id, p.ref)).toBe(1);
  });

  it('duplicate_request_id_after_lost_answer_returns_existing_session (two creates at once)', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const i = input();
    const [a, b] = await Promise.all([provider.createPayment(ctx, i), provider.createPayment(ctx, i)]);
    expect(a.ref).toBe(b.ref);
    expect(fake.sessionPosts(id, a.ref)).toBe(1);
  });

  it('CREATE_HORIZON: no session after it, refused without a create; a lost earlier session is still found', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const old = new Date(Date.now() - (CREATE_HORIZON_S + 60) * 1000);
    const e = await providerError(() => provider.createPayment(ctx, input({ createdAt: old })));
    expect([e.code, e.retryable]).toEqual(['provider_rejected', false]);
    expect(posts(fake, CREATE)).toBe(0);
    // The session was created at the time (answer lost), and found once past the horizon.
    let t = old.getTime();
    fake.setClock(() => new Date(t));
    const i = input({ createdAt: old });
    fake.loseNext((r) => r.url.endsWith(CREATE));
    await providerError(() => provider.createPayment(ctx, i));
    t = Date.now();
    const p = await provider.createPayment(ctx, i);
    expect([p.status, fake.sessionPosts(id, p.ref)]).toEqual(['cancelled', 1]);
  });

  it('ignored_filter_never_matches_foreign_intent (same fixed deposit amount)', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    fake.ignoreFilters = true;
    const p = await provider.createPayment(ctx, input());
    fake.foreignIntent(id, '12.50', refFor(randomUUID(), new Date())!);
    fake.foreignIntent(id, '12.50', 'someone-elses-order');
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    // Another session of ours in the window is not this one either.
    const other = await provider.createPayment(ctx, input());
    fake.pay(id, other.ref);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    expect((await provider.retrievePayment(ctx, { ref: other.ref }))?.status).toBe('succeeded');
  });

  it('ignored refund filter: refunds of another intent never count or match', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    fake.ignoreFilters = true;
    const a = await provider.createPayment(ctx, input());
    const b = await provider.createPayment(ctx, input());
    fake.pay(id, a.ref);
    fake.pay(id, b.ref);
    const key = randomUUID();
    const refund = { amount: { amountMinor: 1250n, currency: 'AUD' }, idempotencyKey: key, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() };
    await provider.createRefund(ctx, { ...refund, paymentRef: a.ref });
    // The same amount left on b, and a's refund under the same key is not b's.
    expect(await provider.retrieveRefund(ctx, { idempotencyKey: key, paymentRef: b.ref, createdAt: new Date() })).toBeNull();
    expect((await provider.createRefund(ctx, { ...refund, paymentRef: b.ref, metadata: { ...refund.metadata, refundId: randomUUID() } })).amount.amountMinor).toBe(1250n);
  });

  it('foreign_session_without_metadata_in_window: unknown until A25 is confirmed, then not ours', async () => {
    const strict = fakeWith();
    strict.fake.foreignSession(strict.id);
    const e = await providerError(() => strict.provider.createPayment(strict.ctx, input()));
    expect([e.code, e.retryable]).toEqual(['provider_unavailable', true]);
    expect(posts(strict.fake, CREATE)).toBe(0);
    const confirmed = fakeWith({ getReturnsOrderFields: true });
    confirmed.fake.foreignSession(confirmed.id);
    expect((await confirmed.provider.createPayment(confirmed.ctx, input())).status).toBe('requires_action');
  });

  it('session_without_order_id_is_unknown_not_absent (also past the horizon); a GET with the fields decides', async () => {
    const { fake, provider, ctx } = fakeWith();
    const old = new Date(Date.now() - (CREATE_HORIZON_S - 60) * 1000);
    fake.setClock(() => old);
    const i = input({ createdAt: old });
    const p = await provider.createPayment(ctx, i);
    fake.setClock(() => new Date(old.getTime() + 30 * 60_000));
    fake.listsWithoutOrderFields = true;
    // The list lacks the fields, the GET has them: found.
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    fake.getsWithoutOrderFields = true;
    fake.setClock(() => new Date());
    expect((await providerError(() => provider.retrievePayment(ctx, { ref: p.ref }))).retryable).toBe(true);
    const e = await providerError(() => provider.createPayment(ctx, i));
    expect([e.code, e.retryable]).toEqual(['provider_unavailable', true]);
  });

  it('two sessions for one ref, or a window longer than the page cap: unknown, never one or none', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const i = input();
    const p = await provider.createPayment(ctx, i);
    const s = fake.sessionOfRef(id, p.ref);
    fake.account(id).sessions.set('cs_copy', { ...s, id: 'cs_copy' });
    expect((await providerError(() => provider.retrievePayment(ctx, { ref: p.ref }))).code).toBe('provider_unavailable');
    let pages = 0;
    const endless = new AirwallexProvider({ transport: async (req) => {
      if (req.url.includes('/checkout_sessions?')) {
        pages++;
        return { status: 200, body: '{"items":[],"page_after":"next"}' };
      }
      return fake.transport(req);
    } });
    const e = await providerError(() => endless.retrievePayment(ctx, { idempotencyKey: i.idempotencyKey, createdAt: i.createdAt }));
    expect([e.code, e.retryable, pages]).toEqual(['provider_unavailable', true, 20]);
  });
});

describe('statuses and cancel (plan 6.5, 6.6, 20.1)', () => {
  it('paid_while_pending_review_waits_then_succeeds; a cancelled intent after checkout is failed', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const p = await provider.createPayment(ctx, input());
    const intent = fake.pay(id, p.ref, 'PENDING_REVIEW');
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('pending');
    fake.setIntentStatus(id, intent.id, 'SUCCEEDED');
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('succeeded');
    const q = await provider.createPayment(ctx, input());
    const i2 = fake.pay(id, q.ref, 'PENDING_REVIEW');
    fake.setIntentStatus(id, i2.id, 'CANCELLED');
    expect(await provider.retrievePayment(ctx, { ref: q.ref })).toMatchObject({ status: 'failed', failureCode: 'provider_cancelled' });
  });

  it('expired_session_with_intent_in_3ds_reads_requires_action_then_cancel_ends_the_intent (case B)', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const p = await provider.createPayment(ctx, input());
    const intent = fake.pay(id, p.ref, 'REQUIRES_CUSTOMER_ACTION');
    fake.expire(id, p.ref);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    expect((await provider.cancelPayment(ctx, p.ref, randomUUID())).status).toBe('cancelled');
    expect(fake.account(id).intents.get(intent.id)!.status).toBe('CANCELLED');
    // The customer finishing 3-D Secure now cannot pay: the intent is cancelled at Airwallex.
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('cancelled');
  });

  it('cancel_retry_after_intent_cancel_timeout_cancels_the_intent (case A)', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const p = await provider.createPayment(ctx, input());
    const intent = fake.pay(id, p.ref, 'REQUIRES_PAYMENT_METHOD');
    // The session is cancelled first by someone (or an earlier try); the intent cancel times out.
    fake.account(id).sessions.get(fake.sessionOfRef(id, p.ref).id)!.status = 'CANCELLED';
    fake.failNext((r) => r.url.endsWith(`/payment_intents/${intent.id}/cancel`), 500);
    expect((await providerError(() => provider.cancelPayment(ctx, p.ref, randomUUID()))).retryable).toBe(true);
    expect(fake.account(id).intents.get(intent.id)!.status).toBe('REQUIRES_PAYMENT_METHOD');
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    expect((await provider.cancelPayment(ctx, p.ref, randomUUID())).status).toBe('cancelled');
    expect(fake.account(id).intents.get(intent.id)!.status).toBe('CANCELLED');
  });

  it('cancel never answers requires_action; a paid payment says what it is', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const p = await provider.createPayment(ctx, input());
    fake.failNext((r) => r.url.includes('/checkout_sessions/') && r.url.endsWith('/cancel'), 500);
    expect((await providerError(() => provider.cancelPayment(ctx, p.ref, randomUUID()))).retryable).toBe(true);
    const q = await provider.createPayment(ctx, input());
    fake.pay(id, q.ref);
    expect((await provider.cancelPayment(ctx, q.ref, randomUUID())).status).toBe('succeeded');
  });
});

describe('refunds (plan 8)', () => {
  const refundOf = (ref: string, amountMinor: bigint, key = randomUUID()) => ({ paymentRef: ref, amount: { amountMinor, currency: 'AUD' }, idempotencyKey: key, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() });

  it('refund_accepted_stays_pending_until_settled', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    fake.refundOutcome = 'ACCEPTED';
    const p = await provider.createPayment(ctx, input());
    fake.pay(id, p.ref);
    const r = await provider.createRefund(ctx, refundOf(p.ref, 500n));
    expect(r.status).toBe('pending');
    fake.setRefundStatus(id, r.ref, 'SETTLED');
    expect((await provider.retrieveRefund(ctx, { ref: r.ref }))?.status).toBe('succeeded');
  });

  it('refund_over_what_is_left_refused_without_post, also after a web-app refund; pending refunds count', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    fake.refundOutcome = 'RECEIVED';
    const p = await provider.createPayment(ctx, input());
    fake.pay(id, p.ref);
    fake.dashboardRefund(id, p.ref, 300n);
    await provider.createRefund(ctx, refundOf(p.ref, 500n));
    const before = posts(fake, REFUND);
    const e = await providerError(() => provider.createRefund(ctx, refundOf(p.ref, 451n)));
    expect([e.code, e.retryable, posts(fake, REFUND) - before]).toEqual(['provider_rejected', false, 0]);
    expect((await provider.createRefund(ctx, refundOf(p.ref, 450n))).amount.amountMinor).toBe(450n);
  });

  it('lost_refund_answer_found_by_key_never_reposted; concurrent_refunds_same_key_one_post', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const p = await provider.createPayment(ctx, input());
    const intent = fake.pay(id, p.ref);
    const r = refundOf(p.ref, 500n);
    fake.loseNext((q) => q.url.endsWith(REFUND));
    expect((await providerError(() => provider.createRefund(ctx, r))).retryable).toBe(true);
    const again = await provider.createRefund(ctx, r);
    expect((await provider.retrieveRefund(ctx, { idempotencyKey: r.idempotencyKey, paymentRef: p.ref, createdAt: r.createdAt }))?.ref).toBe(again.ref);
    expect(fake.refundPosts(id, intent.id)).toBe(1);
    const s = refundOf(p.ref, 100n);
    const [x, y] = await Promise.all([provider.createRefund(ctx, s), provider.createRefund(ctx, s)]);
    expect(x.ref).toBe(y.ref);
    expect(fake.refundPosts(id, intent.id)).toBe(2);
  });

  it('a web-app refund resolves to our payment through its intent; our refunds carry our id and ref', async () => {
    const { fake, provider, ctx, id } = fakeWith();
    const p = await provider.createPayment(ctx, input());
    fake.pay(id, p.ref);
    const dash = fake.dashboardRefund(id, p.ref, 200n);
    const read = (await provider.retrieveRefund(ctx, { ref: dash.id }))!;
    expect(read.ourRefundId).toBeUndefined();
    expect(read.paymentRef.startsWith('int_')).toBe(true);
    expect((await provider.retrievePayment(ctx, { ref: read.paymentRef }))?.ref).toBe(p.ref);
    const ours = refundOf(p.ref, 100n);
    const made = await provider.createRefund(ctx, ours);
    const w = signedDelivery(ctx.webhookSecret, fake.refundEvent(id, made.ref, new Date()), new Date());
    const v = provider.verifyWebhook(ctx, w.body, w.headers, new Date());
    expect(v.ok && [v.event.refund?.paymentRef, v.event.refund?.ourRefundId]).toEqual([p.ref, ours.metadata.refundId]);
  });

  it('the fake writes amounts as numbers (A21): RawNumber stays exact through the adapter', () => {
    expect(new RawNumber('12.50').text).toBe('12.50');
  });
});
