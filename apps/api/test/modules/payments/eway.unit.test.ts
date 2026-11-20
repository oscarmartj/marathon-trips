// The eWAY adapter and the before_charge card session flow without a database (plan docs/plans/9.1-eway.md, sections
// 4, 5, 6, 7, 15 and 20): hosts and errors, the mapping of eWAY's codes, approvals, unknown states and duplicates, the
// single-use card code, refunds whose answer is lost, the registry rules for gatewayEvents: 'none', the store's edges,
// and the catalogue's capabilities.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EWAY_API_BASE, EwayGateway, ewayManifest } from '../../../src/modules/payments/adapters/eway/eway';
import type { EwayRequest } from '../../../src/modules/payments/adapters/eway/eway';
import { chargeOf, codesOf, declineOf, refundOf } from '../../../src/modules/payments/adapters/eway/mapping';
import { createAdapters } from '../../../src/modules/payments/adapters';
import { PLANNED_ADAPTERS } from '../../../src/modules/payments/adapters/planned';
import { catalogueCapabilities } from '../../../src/modules/payments/core/account-admin.service';
import { MemoryCardSessionStore } from '../../../src/modules/payments/core/card-sessions/memory-store';
import { CardSessionProvider, NOT_FOUND_GRACE_MS } from '../../../src/modules/payments/core/card-sessions/provider';
import { sessionTransitionProblem } from '../../../src/modules/payments/core/card-sessions/store';
import type { CardSession } from '../../../src/modules/payments/core/card-sessions/store';
import { EVENTLESS_ADAPTER_KEYS, ProviderError } from '../../../src/modules/payments/core/provider';
import type { AdapterManifest, ProviderContext } from '../../../src/modules/payments/core/provider';
import { eventlessManifestProblems, eventlessProviderProblems, manifestProblems } from '../../../src/modules/payments/core/registry';
import { CLAUSE_IMPLS, Harness, NO_GATEWAY_EVENT } from '../../contract/payment-provider.contract';
import { FakeEway } from '../../contract/subjects/eway-fake';
import { EWAY_PAYER, payWithSecureFields } from '../../contract/subjects/eway';
import { expiringStore } from '../../contract/subjects/pin';
import { simulatorLocalSubject } from '../../contract/subjects/simulator';

function world() {
  const fake = new FakeEway();
  const keys = fake.newAccount();
  const inner = new MemoryCardSessionStore();
  const store = expiringStore(inner);
  const provider = new CardSessionProvider(new EwayGateway({ transport: fake.transport }), store, { cardPageOrigin: 'http://localhost:3000', usable: true });
  const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { ...keys }, webhookSecret: 'x'.repeat(64) };
  const input = (bookingId = randomUUID()) => ({ amount: { amountMinor: 1500n, currency: 'AUD' }, method: 'card' as const, idempotencyKey: `k:${randomUUID()}`, metadata: { paymentId: randomUUID(), bookingId }, returnUrl: 'https://example.com/r', customerCountry: 'AU', createdAt: new Date() });
  const refundInput = (paymentRef: string, key: string, amountMinor = 500n) => ({ paymentRef, amount: { amountMinor, currency: 'AUD' }, idempotencyKey: key, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() });
  return { fake, keys, inner, store, provider, ctx, input, refundInput };
}

describe('eWAY HTTP, errors and mapping (plan 9.1, section 5.3; all eWAY shapes UNVERIFIED)', () => {
  it('fixed_host_per_mode: a test context only ever reaches the sandbox host', async () => {
    expect(EWAY_API_BASE.test).toBe('https://api.sandbox.ewaypayments.com');
    const seen: string[] = [];
    const fake = new FakeEway();
    const keys = fake.newAccount();
    const g = new EwayGateway({ transport: async (r: EwayRequest) => { seen.push(new URL(r.url).origin); return fake.transport(r); } });
    const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { ...keys }, webhookSecret: '' };
    await g.probe(ctx);
    await g.chargesOfSession(ctx, `cs_${'a'.repeat(32)}`);
    expect(new Set(seen)).toEqual(new Set(['https://api.sandbox.ewaypayments.com']));
  });

  it('bad credentials are auth_failed and never echo a secret; malformed refs never reach eWAY', async () => {
    const { provider, ctx, fake } = world();
    const bad = { ...ctx, credentials: { ...ctx.credentials, apiPassword: 'wrongpassword1' } };
    const e = await provider.retrievePayment(bad, { ref: 'ewt_1' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).code).toBe('provider_auth_failed');
    expect(JSON.stringify(e) + String((e as Error).message)).not.toContain('wrongpassword1');
    const g = new EwayGateway({ transport: fake.transport });
    expect(await g.retrieveCharge(ctx, 'ewt_1/../x')).toBeNull();
    expect(await g.retrieveRefund(ctx, 'rf_abc')).toBeNull();
    expect(await g.chargesOfSession(ctx, 'cs_short')).toEqual([]);
  });

  it('mapping: TransactionStatus true is a charge whatever the approval code; known declines fail; S5666 and unknown codes are unreadable', () => {
    for (const code of ['A2000', 'A2008', 'A2010', 'A2011', 'A2016']) {
      expect(chargeOf({ TransactionID: 123, TransactionStatus: true, TotalAmount: 900, InvoiceReference: `cs_${'b'.repeat(32)}`, ResponseMessage: code }), code).toMatchObject({ token: 'ewt_123', success: true, captured: true, failed: false, amount: { amountMinor: 900n } });
    }
    expect(chargeOf({ TransactionID: 1, TransactionStatus: false, TotalAmount: 1, ResponseMessage: 'D4405' })?.failureCode).toBe('card_declined');
    expect(chargeOf({ TransactionID: 1, TransactionStatus: false, TotalAmount: 1, ResponseMessage: 'D4451' })?.failureCode).toBe('insufficient_funds');
    expect(chargeOf({ TransactionID: 1, TransactionStatus: false, TotalAmount: 1, ResponseMessage: 'F7000' })?.failureCode).toBe('suspected_fraud');
    expect(chargeOf({ TransactionID: 1, TransactionStatus: false, TotalAmount: 1, ResponseMessage: 'S5666' })).toBeNull();
    expect(chargeOf({ TransactionID: 1, TransactionStatus: false, TotalAmount: 1, ResponseMessage: 'X1234' })).toBeNull();
    expect(chargeOf({ TransactionID: 1, TotalAmount: 1 })).toBeNull();
    expect(chargeOf({ TransactionID: 'abc', TransactionStatus: true, TotalAmount: 1 })).toBeNull();
    expect(chargeOf({ TransactionID: 1, TransactionStatus: true, TotalAmount: 1.5 })).toBeNull();
    expect(declineOf(['D4494'])).toBeUndefined();
    expect(codesOf('D4405, F7003')).toEqual(['D4405', 'F7003']);
    expect(codesOf('<script>')).toEqual([]);
    expect(refundOf({ TransactionID: 9, TransactionStatus: true, TotalAmount: 5, OriginalTransactionId: 7 })).toMatchObject({ token: 'ewr_9', chargeToken: 'ewt_7', status: 'succeeded' });
    expect(refundOf({ TransactionID: 9, TransactionStatus: true, TotalAmount: 5 })).toBeNull();
  });

  it('verifyWebhook refuses everything and parseEvent reads nothing (no events)', () => {
    const g = new EwayGateway();
    expect(g.verifyWebhook({ accountId: 'a', mode: 'test', credentials: {}, webhookSecret: 'x' }, Buffer.from('{"TransactionID":1}'), { 'webhook-signature': 'x' }, new Date())).toEqual({ ok: false, code: 'malformed' });
    expect(g.parseEvent(Buffer.from('{"TransactionID":1}'))).toBeNull();
    expect(g.signatureHeaders).toEqual([]);
  });
});

describe('before_charge sessions on the memory store (plan 9.1, sections 4.1, 6 and 20)', () => {
  it('unknown state (S5666) is never a decline: the session waits and a read finds the charge', async () => {
    const { fake, provider, ctx, input, store } = world();
    const p = await provider.createPayment(ctx, input());
    fake.next.response = 'S5666';
    await payWithSecureFields(fake, provider, ctx, p.ref, 'pay');
    expect((await store.byRef(ctx.accountId, p.ref))?.status).toBe('submitting');
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
  });

  it('a code consumed by 3-D Secure enrolment (A1 false) fails the session without money', async () => {
    const { fake, provider, ctx, input, store, keys } = world();
    const p = await provider.createPayment(ctx, input());
    fake.next.enrolConsumesCode = true;
    await payWithSecureFields(fake, provider, ctx, p.ref, 'pay');
    const s = (await store.byRef(ctx.accountId, p.ref))!;
    expect([s.status, s.failureCode]).toEqual(['failed', 'provider_rejected']);
    expect(fake.transactionsWith(keys.apiKey, p.ref)).toHaveLength(0);
  });

  it('a lost enrolment answer: the session can never be authorised and expires as cancelled', async () => {
    const { fake, provider, ctx, input, store } = world();
    const p = await provider.createPayment(ctx, input());
    fake.next.timeoutBefore = 'enrol';
    const code = fake.tokenise(ctx.credentials.publicApiKey!, 'pay');
    const r = await provider.submitCard(ctx, p.ref, code, EWAY_PAYER);
    expect(r.next.kind).toBe('wait');
    const s = (await store.byRef(ctx.accountId, p.ref))!;
    expect([s.status, s.authRef, s.submittedAt]).toEqual(['authenticating', null, null]);
    expect((await provider.authoriseCard(ctx, p.ref, `AC${'1'.repeat(20)}`, code, '203.0.113.1')).next.kind).toBe('not_open');
    store.expire(p.ref);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('cancelled');
  });

  it('missing payer details refuse before anything is sent', async () => {
    const { provider, ctx, input, fake, store } = world();
    const p = await provider.createPayment(ctx, input());
    await expect(provider.submitCard(ctx, p.ref, fake.tokenise(ctx.credentials.publicApiKey!, 'pay'), { email: 'a@example.test', ipAddress: '203.0.113.1' })).rejects.toMatchObject({ code: 'provider_rejected' });
    expect((await store.byRef(ctx.accountId, p.ref))?.status).toBe('open');
  });

  it('eventless grace: a definitive "none" only ends a sent charge after the grace and the expiry (20 M5)', async () => {
    expect(NOT_FOUND_GRACE_MS).toBe(15 * 60_000);
    const { fake, provider, ctx, input, store, inner } = world();
    const p = await provider.createPayment(ctx, input());
    fake.next.timeoutBefore = 'charge';
    await payWithSecureFields(fake, provider, ctx, p.ref, 'pay');
    store.expire(p.ref);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    inner.advance(NOT_FOUND_GRACE_MS + 1000);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('failed');
  });

  it('refunds: a lost answer binds by our reference and is never sent again; with A5 false it stays unknown, still never sent again', async () => {
    const { fake, provider, ctx, input, store, refundInput, keys } = world();
    const p = await provider.createPayment(ctx, input());
    await payWithSecureFields(fake, provider, ctx, p.ref, 'pay');
    const charge = Number((await store.byRef(ctx.accountId, p.ref))!.chargeRef!.slice(4));
    fake.next.lose = 'refund';
    await expect(provider.createRefund(ctx, refundInput(p.ref, 'a'))).rejects.toMatchObject({ retryable: true });
    const found = await provider.retrieveRefund(ctx, { idempotencyKey: 'a', paymentRef: p.ref, createdAt: new Date() });
    expect(found?.status).toBe('succeeded');
    expect((await provider.createRefund(ctx, refundInput(p.ref, 'a'))).ref).toBe(found!.ref);
    expect(fake.refundPosts(keys.apiKey, charge)).toBe(1);

    fake.refundRefsHidden = true;
    fake.next.lose = 'refund';
    await expect(provider.createRefund(ctx, refundInput(p.ref, 'b'))).rejects.toMatchObject({ retryable: true });
    await expect(provider.createRefund(ctx, refundInput(p.ref, 'b'))).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    await expect(provider.retrieveRefund(ctx, { idempotencyKey: 'b', paymentRef: p.ref, createdAt: new Date() })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fake.refundPosts(keys.apiKey, charge)).toBe(2);
  });

  it('refund_over_max_refund_refused, including after a dashboard refund, without a call', async () => {
    const { fake, provider, ctx, input, store, refundInput, keys } = world();
    const p = await provider.createPayment(ctx, input());
    await payWithSecureFields(fake, provider, ctx, p.ref, 'pay');
    const charge = Number((await store.byRef(ctx.accountId, p.ref))!.chargeRef!.slice(4));
    fake.dashboardRefund(keys.apiKey, charge, 1200);
    await expect(provider.createRefund(ctx, refundInput(p.ref, 'c', 400n))).rejects.toMatchObject({ code: 'provider_rejected', retryable: false });
    expect(fake.refundPosts(keys.apiKey, charge)).toBe(0);
    expect((await provider.createRefund(ctx, refundInput(p.ref, 'd', 300n))).status).toBe('succeeded');
  });

  it('store edges of a before_charge session (20 M2): pre-charge failures only; never succeeded without a charge sent', () => {
    const base: CardSession = {
      id: 'i', ref: `cs_${'c'.repeat(32)}`, accountId: 'a', mode: 'test', flow: 'before_charge', idempotencyKey: 'k', paymentId: 'p', bookingId: 'b', amountMinor: 1n, currency: 'AUD',
      returnUrl: 'https://x', status: 'open', authRef: null, authCardHash: null, chargeRef: null, chargedMinor: null, failureCode: null, submittedAt: null, verifyCalls: 0,
      createdAt: new Date(), expiresAt: new Date(), version: 1,
    };
    expect(sessionTransitionProblem(base, { status: 'submitting', submittedAt: new Date() })).not.toBeNull();
    expect(sessionTransitionProblem(base, { status: 'authenticating' })).toBe('card_session_auth_card_required');
    const auth = { ...base, status: 'authenticating' as const, authCardHash: 'h' };
    expect(sessionTransitionProblem(auth, { status: 'submitting', submittedAt: new Date() })).toBe('card_session_auth_ref_required');
    expect(sessionTransitionProblem(auth, { status: 'failed', failureCode: 'outcome_unknown' })).toBe('card_session_pre_charge_failure');
    expect(sessionTransitionProblem(auth, { status: 'failed', failureCode: 'card_not_authenticated' })).toBeNull();
    expect(sessionTransitionProblem(auth, { status: 'succeeded', chargeRef: 'ewt_1' })).not.toBeNull();
    expect(sessionTransitionProblem(auth, { status: 'cancelled' })).toBeNull();
    expect(sessionTransitionProblem({ ...auth, authRef: 'A'.repeat(12) }, { authRef: 'B'.repeat(12) })).toBe('card_session_auth_fixed');
    expect(sessionTransitionProblem({ ...base, flow: 'after_charge' }, { authCardHash: 'h' })).toBe('card_session_flow');
    const failedPre = { ...auth, status: 'failed' as const, failureCode: 'card_not_authenticated' as const };
    expect(sessionTransitionProblem(failedPre, { status: 'succeeded', chargeRef: 'ewt_1', chargedMinor: 1n })).not.toBeNull();
  });
});

describe('registry rules for gatewayEvents: none (plan 9.1, sections 4.2 and 20 M1, M6)', () => {
  const m = () => new CardSessionProvider(new EwayGateway(), new MemoryCardSessionStore(), { cardPageOrigin: 'http://localhost:3000', usable: true }).manifest;
  it('the closed list, the generated secret, no refund-event ids, and never verified without reconciliation and disputes', () => {
    expect(EVENTLESS_ADAPTER_KEYS).toEqual(['eway']);
    expect(eventlessManifestProblems(m())).toEqual([]);
    expect(eventlessManifestProblems({ ...m(), key: 'stripe' })).toContain('stripe: gatewayEvents none is not allowed for this adapter');
    expect(eventlessManifestProblems({ ...m(), capabilities: { ...m().capabilities, refundEventOurId: 'via_retrieve' } })).toContain('eway: refundEventOurId without events');
    const verified: AdapterManifest = { ...m(), status: 'verified', evidence: 'docs/done/9.1.md' };
    expect(eventlessManifestProblems(verified)).toContain('eway: verified without events needs reconciliation and disputes');
    expect(eventlessManifestProblems({ ...verified, capabilities: { ...verified.capabilities, reconciliation: { activity: false, settlements: true } } })).toContain('eway: verified without events needs reconciliation and disputes');
    expect(eventlessManifestProblems({ ...verified, capabilities: { ...verified.capabilities, reconciliation: { activity: false, settlements: true }, disputes: 'events' } })).toEqual([]);
    expect(manifestProblems([m()])).toEqual([]);
  });

  it('signature headers only without the capability; the manual adapter is not touched (20 M1)', () => {
    const adapters = createAdapters({ webOrigin: 'http://localhost:3000' });
    for (const a of adapters) expect(eventlessProviderProblems(a), a.manifest.key).toEqual([]);
    const eway = adapters.find((a) => a.manifest.key === 'eway')!;
    expect(eway.manifest.capabilities.gatewayEvents).toBe('none');
    expect(eway.manifest.capabilities.refundEventOurId).toBeUndefined();
    const fakeWithHeaders = Object.assign(Object.create(Object.getPrototypeOf(eway)) as object, eway, { signatureHeaders: ['x-sig'] });
    expect(eventlessProviderProblems(fakeWithHeaders as typeof eway)).toContain('eway: signature headers without events');
    for (const a of adapters.filter((x) => x.manifest.key !== 'eway')) expect(a.manifest.capabilities.gatewayEvents, a.manifest.key).toBeUndefined();
  });

  it('no_gateway_event_requires_capability: a provider with events answering NO_GATEWAY_EVENT after payment fails', async () => {
    const h = new Harness({ ...simulatorLocalSubject(), webhookFor: async () => NO_GATEWAY_EVENT });
    await expect(CLAUSE_IMPLS.webhook_verifies_and_matches_retrieve(h)).rejects.toThrow(/gateway event/);
  });

  it('an eventless subject without the read hooks fails the replacement clauses (20 M7)', async () => {
    const fake = new FakeEway();
    const provider = new CardSessionProvider(new EwayGateway({ transport: fake.transport }), expiringStore(new MemoryCardSessionStore()), { cardPageOrigin: 'http://localhost:3000', usable: true });
    const keys = fake.newAccount();
    const h = new Harness({ ...simulatorLocalSubject(), provider, context: async () => ({ accountId: randomUUID(), mode: 'test', credentials: { ...keys }, webhookSecret: '' }), webhookFor: async () => NO_GATEWAY_EVENT, customerCompletes: async (ctx, p) => payWithSecureFields(fake, provider, ctx, p.ref, 'pay') });
    await expect(CLAUSE_IMPLS.webhook_verifies_and_matches_retrieve(h)).rejects.toThrow(/loseNextAnswer/);
  });
});

describe('the catalogue (plan 9.1, section 13)', () => {
  it('shows status and capabilities for every installed adapter; eWAY is no longer planned', () => {
    const adapters = createAdapters({ webOrigin: 'http://localhost:3000' });
    const caps = Object.fromEntries(adapters.map((a) => [a.manifest.key, catalogueCapabilities(a.manifest)]));
    expect(caps.eway).toEqual({ refunds: 'partial', deferredCapture: false, disputes: false, reconciliation: null, gatewayEvents: 'none', cardEntry: 'card_fields' });
    expect(caps.pin_payments).toMatchObject({ gatewayEvents: 'signed', cardEntry: 'card_fields' });
    expect(caps.stripe).toMatchObject({ gatewayEvents: 'signed', cardEntry: 'gateway_page' });
    expect(caps.simulator).toMatchObject({ cardEntry: 'simulated' });
    expect(PLANNED_ADAPTERS.map((p) => p.key)).not.toContain('eway');
    expect(ewayManifest().status).toBe('experimental');
  });
});
