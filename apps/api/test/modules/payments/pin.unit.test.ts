// The Pin Payments adapter and the card session provider without a database (plan docs/plans/4.4-au-card-gateway.md,
// section 13): signature parsing and window, hosts, errors, amounts, tokens in URLs, statuses, the event table, 429 and
// 409, the registry's structural rules for preCardSession (18 M1), and the session and refund paths on the memory store.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PIN_API_BASE, PinPaymentsGateway, pinManifest } from '../../../src/modules/payments/adapters/pin_payments/pin';
import type { PinRequest } from '../../../src/modules/payments/adapters/pin_payments/pin';
import { parsePinEvent, refundOf } from '../../../src/modules/payments/adapters/pin_payments/mapping';
import { parseSignatureHeader, pinSignature, verifyPinWebhook } from '../../../src/modules/payments/adapters/pin_payments/webhook';
import { MemoryCardSessionStore } from '../../../src/modules/payments/core/card-sessions/memory-store';
import { CardSessionProvider } from '../../../src/modules/payments/core/card-sessions/provider';
import { sessionTransitionProblem } from '../../../src/modules/payments/core/card-sessions/store';
import type { CardSession } from '../../../src/modules/payments/core/card-sessions/store';
import { ProviderError } from '../../../src/modules/payments/core/provider';
import type { ProviderContext } from '../../../src/modules/payments/core/provider';
import { PaymentAdapterRegistry, cardFieldsProblems, preCardSessionProblems } from '../../../src/modules/payments/core/registry';
import { createAdapters, adapterOptions, INERT_CARD_PAGE_ORIGIN } from '../../../src/modules/payments/adapters';
import { CARD_PAGE_FRAME_ORIGINS, PIN_CARD_FIELDS } from '@mt/shared';
import { FakePin } from '../../contract/subjects/pin-fake';
import { expiringStore, payOnCardPage } from '../../contract/subjects/pin';

const KEY = 'K'.repeat(22);
const body = Buffer.from(JSON.stringify({ token: 'evt_aaaaaaaaaaaa', type: 'charge.captured', created_at: '2026-11-20T01:02:03Z', data: { token: 'ch_aaaaaaaaaaaa', success: true, captured: true, amount: 1500, currency: 'AUD', metadata: { mt_session: `cs_${'a'.repeat(32)}`, mt_payment: randomUUID() } } }));
const signed = (at: Date, key = KEY, b = body) => {
  const t = String(Math.floor(at.getTime() / 1000));
  return { 'pin-signature': `t=${t},v1=${pinSignature(key, t, b)}` };
};

function world() {
  const fake = new FakePin();
  const keys = fake.newAccount();
  const store = expiringStore(new MemoryCardSessionStore());
  const provider = new CardSessionProvider(new PinPaymentsGateway({ transport: fake.transport }), store, { cardPageOrigin: 'http://localhost:3000', usable: true });
  const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { secretKey: keys.secretKey, publishableKey: keys.publishableKey }, webhookSecret: keys.webhookKey };
  const input = () => ({ amount: { amountMinor: 1500n, currency: 'AUD' }, method: 'card' as const, idempotencyKey: `k:${randomUUID()}`, metadata: { paymentId: randomUUID(), bookingId: randomUUID() }, returnUrl: 'https://example.com/r', customerCountry: 'AU', createdAt: new Date() });
  return { fake, keys, store, provider, ctx, input };
}
const PAYER = { email: 'payer@example.test', ipAddress: '203.0.113.10' };

describe('Pin webhook signature (plan 4.4, section 8.1)', () => {
  it('pin_signature_parsing_and_rejections', () => {
    expect(parseSignatureHeader(`t=1,v1=${'a'.repeat(64)}`)).toEqual({ t: '1', v1: ['a'.repeat(64)] });
    for (const bad of [undefined, '', 't=1', `v1=${'a'.repeat(64)}`, `t=1,t=2,v1=${'a'.repeat(64)}`, `t=1,v1=${'A'.repeat(64)}`, `t=1,v2=${'a'.repeat(64)}`,
      `t=1,${Array.from({ length: 5 }, () => `v1=${'a'.repeat(64)}`).join(',')}`, `t=1,v1=${'a'.repeat(63)}`, `t=1 ,v1=${'a'.repeat(64)}`, `t=1,v1=${'a'.repeat(64)}é`, 'x'.repeat(513)]) {
      expect(parseSignatureHeader(bad), String(bad)).toBeNull();
    }
  });

  it('pin_signature_hmac_over_t_dot_raw_body and pin_stale_window_299_301', () => {
    const at = new Date('2026-11-20T01:02:03Z');
    expect(verifyPinWebhook(KEY, body, signed(at), at).ok).toBe(true);
    expect(verifyPinWebhook(KEY, body, signed(at), new Date(at.getTime() + 299_000)).ok).toBe(true);
    expect(verifyPinWebhook(KEY, body, signed(at), new Date(at.getTime() + 301_000))).toMatchObject({ ok: false, code: 'stale_timestamp' });
    expect(verifyPinWebhook(KEY, body, signed(at), new Date(at.getTime() - 301_000))).toMatchObject({ ok: false, code: 'stale_timestamp' });
    expect(verifyPinWebhook('L'.repeat(22), body, signed(at), at)).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(verifyPinWebhook('', body, signed(at, ''), at)).toMatchObject({ ok: false, code: 'bad_signature' });
    // Stale only after the signature: a forged old delivery is a bad signature.
    expect(verifyPinWebhook('L'.repeat(22), body, signed(at), new Date(at.getTime() + 3_600_000))).toMatchObject({ ok: false, code: 'bad_signature' });
    // Several v1 values: any match is accepted.
    const t = String(Math.floor(at.getTime() / 1000));
    expect(verifyPinWebhook(KEY, body, { 'Pin-Signature': `t=${t},v1=${'0'.repeat(64)},v1=${pinSignature(KEY, t, body)}` }, at).ok).toBe(true);
  });

  it('pin_never_throws_on_garbage', () => {
    const at = new Date();
    for (const b of [Buffer.alloc(0), Buffer.from('null'), Buffer.from('[]'), Buffer.from([0xff, 0xfe]), Buffer.from('{"token":"evt_aaaaaaaaaaaa"}')]) {
      const v = verifyPinWebhook(KEY, b, signed(at, KEY, b), at);
      expect(v.ok).toBe(false);
    }
    expect(verifyPinWebhook(KEY, Buffer.from('{"token":"evt_aaaaaaaaaaaa"}'), signed(at, KEY, Buffer.from('{"token":"evt_aaaaaaaaaaaa"}')), at)).toMatchObject({ ok: false, code: 'malformed', claimedEventId: 'evt_aaaaaaaaaaaa' });
  });

  it('pin_event_mapping_table: statuses from data, not from the name; disputes for review; the rest unsupported', () => {
    const ch = { token: 'ch_aaaaaaaaaaaa', success: true, captured: true, amount: 1500, currency: 'AUD', metadata: { mt_session: `cs_${'b'.repeat(32)}` } };
    const ev = (type: string, data: unknown) => parsePinEvent({ token: 'evt_bbbbbbbbbbbb', type, created_at: '2026-11-20T01:02:03Z', data });
    expect(ev('charge.captured', ch)).toMatchObject({ kind: 'payment', payment: { ref: `cs_${'b'.repeat(32)}`, status: 'succeeded' } });
    expect(ev('charge.failed', { ...ch, success: false, captured: false, status_message: 'Failed' })).toMatchObject({ kind: 'payment', payment: { status: 'failed' } });
    expect(ev('charge.captured', { ...ch, metadata: {} })).toMatchObject({ payment: { ref: 'ch_aaaaaaaaaaaa' } });
    expect(ev('refund.succeeded', { token: 'rf_aaaaaaaaaaaa', charge: 'ch_aaaaaaaaaaaa', amount: 100, currency: 'AUD', status_message: 'Pending', created_at: '2026-11-20T01:02:03Z' })).toMatchObject({ kind: 'refund', refund: { status: 'pending', paymentRef: 'ch_aaaaaaaaaaaa' } });
    expect(ev('refund.succeeded', { token: 'rf_aaaaaaaaaaaa', charge: 'ch_aaaaaaaaaaaa', amount: 100, currency: 'AUD', status_message: 'Pending', created_at: '2026-11-20T01:02:03Z' })?.refund?.ourRefundId).toBeUndefined();
    expect(ev('dispute.evidence_required', { token: 'dis_x' })).toMatchObject({ kind: 'unsupported', review: 'dispute' });
    expect(ev('customer.created', {})).toMatchObject({ kind: 'unsupported' });
    expect(ev('charge.captured', { ...ch, amount: 15.5 })).toBeNull();
    expect(ev('charge.captured', { ...ch, amount: Number.MAX_SAFE_INTEGER + 2 })).toBeNull();
  });

  it('pin_refund_status_unknown_is_unavailable', () => {
    const base = { token: 'rf_aaaaaaaaaaaa', charge: 'ch_aaaaaaaaaaaa', amount: 100, currency: 'AUD', created_at: '2026-11-20T01:02:03Z' };
    expect(refundOf({ ...base, status_message: 'Success' })?.status).toBe('succeeded');
    expect(refundOf({ ...base, status_message: 'Failed' })?.status).toBe('failed');
    expect(refundOf({ ...base, status_message: 'Weird' })).toBeUndefined();
  });
});

describe('Pin HTTP layer (plan 4.4, section 5.3)', () => {
  it('pin_test_mode_only_reaches_test_host and pin_malformed_tokens_never_in_urls', async () => {
    const seen: PinRequest[] = [];
    const g = new PinPaymentsGateway({ transport: async (r) => {
      seen.push(r);
      return { status: 404, body: '{"error":"not_found"}' };
    } });
    const ctx: ProviderContext = { accountId: randomUUID(), mode: 'test', credentials: { secretKey: 's'.repeat(32) }, webhookSecret: '' };
    expect(await g.retrieveCharge(ctx, 'ch_../../balance')).toBeNull();
    expect(await g.retrieveRefund(ctx, 'rf_?x=1')).toBeNull();
    expect(await g.verifyAuthentication(ctx, 'se_../x')).toBeNull();
    expect(seen).toHaveLength(0);
    await g.retrieveCharge(ctx, 'ch_aaaaaaaaaaaa');
    expect(seen.every((r) => r.url.startsWith(`${PIN_API_BASE.test}/`))).toBe(true);
    expect(PIN_API_BASE.test).toBe('https://test-api.pinpayments.com/1');
    // A malformed key never leaves: auth failed before any request.
    await expect(g.probe({ ...ctx, credentials: { secretKey: 'short' } })).rejects.toMatchObject({ code: 'provider_auth_failed', retryable: false });
  });

  it('pin_errors_never_echo_pin_text_or_secrets', async () => {
    const secret = 's'.repeat(32);
    const g = new PinPaymentsGateway({ transport: async () => ({ status: 500, body: JSON.stringify({ error: 'boom', error_description: `secret ${secret} payer@example.test` }) }) });
    const err = await g.probe({ accountId: randomUUID(), mode: 'test', credentials: { secretKey: secret }, webhookSecret: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const text = `${(err as Error).message} ${JSON.stringify(err)}`;
    expect(text.includes(secret) || text.includes('payer@example.test') || text.includes('boom')).toBe(false);
  });

  it('pin_429_is_not_created_409_is_unknown, for charges and refunds', async () => {
    const { fake, provider, ctx, input, store } = world();
    const a = await provider.createPayment(ctx, input());
    fake.switches.nextChargeStatus = 429;
    const r429 = await provider.submitCard(ctx, a.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay_frictionless'), PAYER);
    expect([r429.session.status, r429.session.failureCode]).toEqual(['failed', 'provider_busy']);
    const b = await provider.createPayment(ctx, input());
    fake.switches.nextChargeStatus = 409;
    const r409 = await provider.submitCard(ctx, b.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay_frictionless'), PAYER);
    expect([r409.session.status, r409.next.kind]).toEqual(['submitting', 'wait']);
    // Refunds: 429 posts again on the retry (nothing was created); a timeout never does.
    const c = await provider.createPayment(ctx, input());
    await payOnCardPage(fake, provider, ctx, c.ref, 'pay_frictionless');
    const refund = (key: string) => provider.createRefund(ctx, { paymentRef: c.ref, amount: { amountMinor: 100n, currency: 'AUD' }, idempotencyKey: key, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() });
    fake.switches.nextRefundStatus = 429;
    await expect(refund('r1')).rejects.toMatchObject({ code: 'provider_busy', retryable: true });
    const charge = (await store.byRef(ctx.accountId, c.ref))!.chargeRef!;
    expect(fake.refundsOf(ctx.credentials.secretKey!, charge)).toHaveLength(0);
    expect((await refund('r1')).status).toBe('pending');
    expect(fake.refundsOf(ctx.credentials.secretKey!, charge)).toHaveLength(1);
  });

  it('pin_amount_bigint_bounds_and_no_floats (static)', () => {
    const dir = join(__dirname, '../../../src/modules/payments/adapters/pin_payments');
    for (const f of readdirSync(dir)) {
      const code = readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
      expect(/parseFloat|toFixed|Math\./.test(code), f).toBe(false);
    }
  });
});

describe('card sessions on the memory store (plan 4.4, sections 6 and 7)', () => {
  it('unknown_submit_never_reopens; expired_unknown_session_reads_failed_then_late_success', async () => {
    const { fake, provider, ctx, input, store } = world();
    const p = await provider.createPayment(ctx, input());
    fake.switches.loseNextChargeAnswer = true;
    fake.switches.searchHidden = true;
    expect((await provider.submitCard(ctx, p.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay_frictionless'), PAYER)).next.kind).toBe('wait');
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('requires_action');
    expect((await provider.cancelPayment(ctx, p.ref, 'k')).status).toBe('requires_action');
    store.expire(p.ref);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))).toMatchObject({ status: 'failed', failureCode: 'outcome_unknown' });
    fake.switches.searchHidden = false;
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('succeeded');
  });

  it('unknown_submit_after_declines_resolves: a decline that left a charge is bound, failed, and never reopened', async () => {
    const { fake, provider, ctx, input, store } = world();
    fake.switches.declineCreatesCharge = true;
    const p = await provider.createPayment(ctx, input());
    await expect(payOnCardPage(fake, provider, ctx, p.ref, 'decline')).resolves.toBeUndefined();
    const s = (await store.byRef(ctx.accountId, p.ref))!;
    expect([s.status, s.chargeRef !== null]).toEqual(['failed', true]);
    expect((await provider.retrievePayment(ctx, { ref: p.ref }))?.status).toBe('failed');
    await expect(payOnCardPage(fake, provider, ctx, p.ref, 'pay')).rejects.toThrow();
  });

  it('cancel_while_authenticating_reads_charge; finish_authentication_rejects_other_charge; session_token_shape_checked_before_call', async () => {
    const { fake, provider, ctx, input, store } = world();
    const p = await provider.createPayment(ctx, input());
    const r = await provider.submitCard(ctx, p.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay'), PAYER);
    expect(r.next).toMatchObject({ kind: 'redirect' });
    expect((await provider.cancelPayment(ctx, p.ref, 'k')).status).toBe('pending');
    const other = await provider.createPayment(ctx, input());
    await provider.submitCard(ctx, other.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay'), PAYER);
    const otherCharge = (await store.byRef(ctx.accountId, other.ref))!.chargeRef!;
    const st = fake.finishChallenge(ctx.credentials.secretKey!, otherCharge, 'pay');
    await provider.finishAuthentication(ctx, p.ref, st);
    expect((await store.byRef(ctx.accountId, p.ref))!.status).toBe('authenticating');
    const before = fake.requests.length;
    await provider.finishAuthentication(ctx, p.ref, 'se_../../charges');
    expect(fake.requests.slice(before).some((x) => x.url.includes('/charges/verify'))).toBe(false);
    // The other charge did pass its challenge: a cancel reads it and reports the money.
    expect((await provider.cancelPayment(ctx, other.ref, 'k')).status).toBe('succeeded');
  });

  it('pin_challenge_host_allowlist_by_mode: another host is never followed', async () => {
    const { fake, provider, ctx, input } = world();
    fake.switches.challengeOrigin = 'https://evil.example';
    const p = await provider.createPayment(ctx, input());
    const r = await provider.submitCard(ctx, p.ref, fake.tokenise(ctx.credentials.publishableKey!, 'pay'), PAYER);
    expect(r.next.kind).toBe('wait');
    expect(r.session.status).toBe('authenticating');
  });

  it('refund_intent_binds_single_candidate_else_unavailable; refund_never_posted_twice_after_timeout; refund_over_remaining_refused_without_call', async () => {
    const { fake, provider, ctx, input, store } = world();
    const p = await provider.createPayment(ctx, input());
    await payOnCardPage(fake, provider, ctx, p.ref, 'pay_frictionless');
    const charge = (await store.byRef(ctx.accountId, p.ref))!.chargeRef!;
    const refund = (key: string, amountMinor = 100n) => provider.createRefund(ctx, { paymentRef: p.ref, amount: { amountMinor, currency: 'AUD' }, idempotencyKey: key, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() });
    fake.switches.loseNextRefundAnswer = true;
    await expect(refund('a')).rejects.toMatchObject({ retryable: true });
    // Another refund of the same amount made on the dashboard: two candidates, unknown, never posted again.
    fake.dashboardRefund(ctx.credentials.secretKey!, charge, 100);
    await expect(refund('a')).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    await expect(provider.retrieveRefund(ctx, { idempotencyKey: 'a', paymentRef: p.ref, createdAt: new Date() })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fake.refundsOf(ctx.credentials.secretKey!, charge)).toHaveLength(2);
    // Beyond what is left: refused before any call.
    const posts = fake.requests.filter((r) => r.method === 'POST').length;
    await expect(refund('b', 2000n)).rejects.toMatchObject({ code: 'provider_rejected', retryable: false });
    expect(fake.requests.filter((r) => r.method === 'POST').length).toBe(posts);
  });

  it('session_transition_rules: forward only, no way back to open, late success only for an unknown end without a charge', () => {
    const s = { status: 'failed', failureCode: 'outcome_unknown', chargeRef: null, submittedAt: new Date(), verifyCalls: 0 } as unknown as CardSession;
    expect(sessionTransitionProblem(s, { status: 'succeeded', chargeRef: 'ch_aaaaaaaaaaaa', chargedMinor: 1n })).toBeNull();
    expect(sessionTransitionProblem({ ...s, failureCode: 'card_declined' }, { status: 'succeeded', chargeRef: 'ch_aaaaaaaaaaaa' })).not.toBeNull();
    expect(sessionTransitionProblem({ ...s, chargeRef: 'ch_bbbbbbbbbbbb' }, { status: 'succeeded' })).not.toBeNull();
    expect(sessionTransitionProblem({ ...s, status: 'submitting' }, { status: 'open' } as never)).not.toBeNull();
    expect(sessionTransitionProblem({ ...s, status: 'open', submittedAt: null }, { status: 'submitting' })).not.toBeNull();
  });
});

describe('registry rules for card sessions (plan 4.4, 18 M1)', () => {
  it('pre_card_session_capability_only_for_card_session_providers, and the reverse', () => {
    const pin = createAdapters({ webOrigin: 'http://localhost:3000' }).find((a) => a.manifest.key === 'pin_payments')!;
    expect(pin).toBeInstanceOf(CardSessionProvider);
    expect(pin.manifest.capabilities.preCardSession).toBe(true);
    expect(preCardSessionProblems(pin)).toEqual([]);
    expect((pin as CardSessionProvider).gateway.manifest.capabilities.preCardSession).toBeUndefined();
    // Any other provider claiming it is refused at start.
    const impostor = { ...pin, manifest: { ...pin.manifest, key: 'impostor' } } as never;
    expect(preCardSessionProblems(impostor)).toEqual(['impostor: preCardSession without CardSessionProvider']);
    expect(() => new PaymentAdapterRegistry([impostor])).toThrow(/preCardSession without CardSessionProvider/);
    // The gateway's own manifest has no marker; with one, the pairing is refused.
    const gw = new PinPaymentsGateway();
    (gw as { manifest: ReturnType<typeof pinManifest> }).manifest = { ...pinManifest(), capabilities: { ...pinManifest().capabilities, preCardSession: true } };
    const wrapped = new CardSessionProvider(gw, new MemoryCardSessionStore(), { cardPageOrigin: 'http://localhost:3000', usable: true });
    expect(preCardSessionProblems(wrapped)).toEqual(['pin_payments: a gateway manifest declares preCardSession']);
  });

  it('card fields, the browser-exposed key and refundEventOurId need their pairing', () => {
    const m = pinManifest();
    expect(cardFieldsProblems(m)).toEqual([]);
    expect(cardFieldsProblems({ ...m, cardFields: undefined })).toContain('pin_payments: a browser-exposed key needs card fields');
    expect(cardFieldsProblems({ ...m, capabilities: { ...m.capabilities, refundEventOurId: 'via_retrieve' } })).toContain('pin_payments: refundEventOurId needs preCardSession');
    expect(cardFieldsProblems({ ...m, cardFields: { ...m.cardFields!, frameOrigins: ['http://cdn.example'] } }).length).toBeGreaterThan(0);
    expect(cardFieldsProblems({ ...m, cardFields: { ...m.cardFields!, scriptUrl: 'https://evil.example/x.js' } })).toContain('pin_payments: card field script must be served from a frame origin');
    const twoExposed = { ...m, account: { ...m.account, fields: m.account.fields.map((f) => ({ ...f, exposure: 'card_page' as const })) } };
    expect(cardFieldsProblems(twoExposed)).toContain('pin_payments: at most one browser-exposed key');
  });

  it('csp_card_route_origins_match_manifest and the inert card page origin outside test environments', () => {
    expect(pinManifest().cardFields!.frameOrigins).toEqual([...CARD_PAGE_FRAME_ORIGINS]);
    expect(pinManifest().cardFields!.scriptUrl).toBe(PIN_CARD_FIELDS.scriptUrl);
    expect(adapterOptions('production', 'https://shop.example').cardPageOrigin).toBe('https://shop.example');
    expect(adapterOptions('production', 'https://shop.example:8443').cardPageOrigin).toBe(INERT_CARD_PAGE_ORIGIN);
    expect(adapterOptions('staging', 'http://intranet').cardPageOrigin).toBe(INERT_CARD_PAGE_ORIGIN);
    expect(adapterOptions('test', 'http://localhost:3000').cardPageOrigin).toBe('http://localhost:3000');
  });

  it('an inert card page origin creates no session', async () => {
    const { ctx, input } = world();
    const fake = new FakePin();
    const inert = new CardSessionProvider(new PinPaymentsGateway({ transport: fake.transport }), new MemoryCardSessionStore(), { cardPageOrigin: INERT_CARD_PAGE_ORIGIN, usable: false });
    await expect(inert.createPayment(ctx, input())).rejects.toMatchObject({ code: 'provider_rejected', retryable: false });
  });
});
