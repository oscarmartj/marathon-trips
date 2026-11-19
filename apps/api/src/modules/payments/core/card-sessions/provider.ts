// CardSessionProvider (plan docs/plans/4.4-au-card-gateway.md, sections 4, 6, 7 and 18): the PaymentProvider of a
// gateway whose card is tokenised by its hosted fields on our own card page (Pin Payments). Before the customer submits a
// card there is nothing at the gateway, so the session lives here, in a store; one card submission makes at most one
// charge, ever. Refund intents stand in for the idempotency keys and metadata the gateway does not have. Everything that
// needs the truth reads the gateway and brings the store up to date; webhooks never write the store (section 8.3).
import type { CardSessionFailure } from '@mt/shared';
import {
  CARD_SESSION_REF, ProviderError,
} from '../provider';
import type {
  AdapterManifest, CardChargeOutcome, CardTokenGateway, CreatePaymentInput, CreateRefundInput, GatewayCharge, GatewayRefund, NormalisedEvent, PaymentLookup,
  PaymentProvider, ProviderContext, ProviderPayment, ProviderRefund, RefundLookup, WebhookVerification,
} from '../provider';
import type { CardRefundIntent, CardSession, CardSessionChange, CardSessionStore } from './store';

const CHARGE_TOKEN = /^ch_[A-Za-z0-9_-]{10,40}$/;
const MAX_AMOUNT = 999_999_999n;
/** A gateway refund made up to this long before our intent can still be the one of a timed-out request. */
const REFUND_CANDIDATE_SKEW_MS = 120_000;
/** ...and no later than this after it: a refund made days later on the dashboard is never taken for ours (review m1). */
const REFUND_CANDIDATE_LATE_MS = 10 * 60_000;

/**
 * Whether a gateway refund can be the answer to the one request a submitting intent has outstanding: made around the
 * moment that request was sent (the intent's last change to `submitting`), never around its first creation, since a
 * request refused unprocessed (429, credentials) is sent again later (review round 2).
 */
function withinRequestWindow(r: GatewayRefund, i: CardRefundIntent): boolean {
  const sent = i.updatedAt.getTime();
  return r.createdAt.getTime() >= sent - REFUND_CANDIDATE_SKEW_MS && r.createdAt.getTime() <= sent + REFUND_CANDIDATE_LATE_MS;
}
export const CARD_PAGE_PATH = '/pay/card';
export const AUTHENTICATED_PATH = '/api/payments/card-sessions';
/** At most this many 3-D Secure verify calls per session (plan 4.4, section 10.1). */
export const MAX_VERIFY_CALLS = 3;

export interface CardSessionProviderOptions {
  /** Where the card page is served: WEB_ORIGIN, or an inert origin outside test environments if it is not plain https. */
  cardPageOrigin: string;
  /** False with an inert origin: no session is created, so no customer is sent to a page that does not exist. */
  usable: boolean;
}

/** What a card submission gave the card page. */
export interface SubmitResult {
  session: CardSession;
  next: { kind: 'redirect'; url: string } | { kind: 'wait' } | { kind: 'not_open' };
}

const failureOfCharge = (c: GatewayCharge): CardSessionFailure => c.failureCode ?? 'card_declined';

export class CardSessionProvider implements PaymentProvider {
  readonly manifest: AdapterManifest;
  readonly signatureHeaders: readonly string[];

  constructor(
    readonly gateway: CardTokenGateway,
    private readonly store: CardSessionStore,
    private readonly opts: CardSessionProviderOptions,
  ) {
    const m = gateway.manifest;
    // Plan 4.4, 18 M1: only this class declares preCardSession; the registry checks the pairing both ways.
    this.manifest = { ...m, checkoutOrigin: opts.cardPageOrigin, capabilities: { ...m.capabilities, preCardSession: true, ...(gateway.refundEventsCarryOurId ? {} : { refundEventOurId: 'via_retrieve' as const }) } };
    this.signatureHeaders = gateway.signatureHeaders;
  }

  // ---- mapping ----

  cardPageUrl(ref: string): string {
    return `${this.opts.cardPageOrigin}${CARD_PAGE_PATH}/${ref}`;
  }

  callbackUrl(ref: string): string {
    return `${this.opts.cardPageOrigin}${AUTHENTICATED_PATH}/${ref}/authenticated`;
  }

  private isExpired(s: CardSession): boolean {
    return this.store.now().getTime() >= s.expiresAt.getTime();
  }

  /** The session as the core sees it (plan 4.4, section 6.5): only transitions the core's machine allows. */
  view(s: CardSession): ProviderPayment {
    const base = { ref: s.ref, amount: { amountMinor: s.amountMinor, currency: s.currency }, ourPaymentId: s.paymentId };
    switch (s.status) {
      case 'open':
        return this.isExpired(s) ? { ...base, status: 'cancelled' } : { ...base, status: 'requires_action', nextAction: { type: 'redirect', url: this.cardPageUrl(s.ref) } };
      case 'submitting':
        return { ...base, status: 'requires_action', nextAction: { type: 'redirect', url: this.cardPageUrl(s.ref) } };
      case 'authenticating':
        return { ...base, status: 'pending' };
      case 'succeeded':
        return { ...base, status: 'succeeded', amount: { amountMinor: s.chargedMinor ?? s.amountMinor, currency: s.currency } };
      case 'failed':
        return { ...base, status: 'failed', failureCode: s.failureCode ?? 'card_declined' };
      case 'cancelled':
        return { ...base, status: 'cancelled' };
    }
  }

  private async change(s: CardSession, change: CardSessionChange): Promise<CardSession> {
    const next = await this.store.update(s, change);
    if (next) return next;
    // Another change came first: the caller works from the stored truth.
    const now = await this.store.byRef(s.accountId, s.ref);
    if (!now) throw new ProviderError('provider_unavailable', true);
    return now;
  }

  /** Applies a charge the gateway reports for this session, only forward (plan 4.4, section 6.3 table and 18 M2). */
  private async applyCharge(s: CardSession, c: GatewayCharge): Promise<CardSession> {
    await this.store.recordCharge(s, { chargeRef: c.token, success: c.success && c.captured, amountMinor: c.amount.amountMinor, currency: c.amount.currency });
    if (s.chargeRef !== null && s.chargeRef !== c.token) {
      await this.store.openTask('extra_charge', s.accountId, c.token);
      return s;
    }
    const collected = c.success && c.captured;
    if (collected) {
      if (s.status === 'submitting' || s.status === 'authenticating' || (s.status === 'failed' && s.chargeRef === null && (s.failureCode === 'outcome_unknown' || s.failureCode === 'provider_busy'))) {
        return this.change(s, { status: 'succeeded', chargeRef: c.token, chargedMinor: c.amount.amountMinor });
      }
      if (s.status !== 'succeeded') await this.store.openTask('extra_charge', s.accountId, c.token);
      return s;
    }
    if (c.pending) {
      if (s.status === 'submitting') return this.change(s, { status: 'authenticating', chargeRef: c.token });
      return s;
    }
    // Failed only when the gateway says so explicitly (review M1); anything else leaves the session as it is.
    if (c.failed && (s.status === 'submitting' || s.status === 'authenticating')) return this.change(s, { status: 'failed', chargeRef: c.token, failureCode: failureOfCharge(c) });
    return s;
  }

  /**
   * Brings a session up to date with the gateway (plan 4.4, sections 6.3 step 5, 6.5, 18 M2): an expired open session is
   * cancelled; an unknown submission is looked up by our reference; a 3-D Secure charge is read; a session that failed
   * with an unknown outcome is searched again, so late money is seen.
   */
  private async settle(ctx: ProviderContext, s: CardSession): Promise<CardSession> {
    if (s.status === 'open') return this.isExpired(s) ? this.change(s, { status: 'cancelled', failureCode: 'expired' }) : s;
    if (s.status === 'authenticating' && s.chargeRef) {
      const c = await this.gateway.retrieveCharge(ctx, s.chargeRef);
      return c ? this.applyCharge(s, c) : s;
    }
    const unknownEnd = s.status === 'failed' && s.chargeRef === null && (s.failureCode === 'outcome_unknown' || s.failureCode === 'provider_busy');
    if (s.status === 'submitting' || unknownEnd) {
      const charges = await this.gateway.chargesOfSession(ctx, s.ref);
      if (charges.length > 0) {
        // One POST per session: a second charge cannot come from us, but it is never lost (plan 4.4, 6.3 step 5).
        const bound = charges.find((c) => c.success && c.captured) ?? charges[0]!;
        let current = await this.applyCharge(s, bound);
        for (const c of charges) {
          if (c.token === bound.token) continue;
          await this.store.recordCharge(current, { chargeRef: c.token, success: c.success && c.captured, amountMinor: c.amount.amountMinor, currency: c.amount.currency });
          await this.store.openTask('extra_charge', s.accountId, c.token);
        }
        current = (await this.store.byRef(s.accountId, s.ref)) ?? current;
        return current;
      }
      if (s.status === 'submitting' && this.isExpired(s)) return this.change(s, { status: 'failed', failureCode: 'outcome_unknown' });
    }
    return s;
  }

  /** The session of a reference: ours (`cs_…`), or the gateway's charge of one of our sessions (plan 4.4, 18 M3). */
  private async sessionOf(ctx: ProviderContext, ref: string): Promise<{ session: CardSession } | { charge: GatewayCharge } | null> {
    if (CARD_SESSION_REF.test(ref)) {
      const s = await this.store.byRef(ctx.accountId, ref);
      return s ? { session: s } : null;
    }
    if (!CHARGE_TOKEN.test(ref)) return null;
    const linked = await this.store.byChargeRef(ctx.accountId, ref);
    if (linked) return { session: linked };
    const c = await this.gateway.retrieveCharge(ctx, ref);
    if (!c) return null;
    if (c.sessionRef) {
      const s = await this.store.byRef(ctx.accountId, c.sessionRef);
      if (s && s.chargeRef === null) {
        // A charge of a session whose submission never got its answer: link it now.
        const settled = await this.settle(ctx, s);
        if (settled.chargeRef === c.token) return { session: settled };
        return { session: await this.applyCharge(settled, c) };
      }
      if (s && s.chargeRef === c.token) return { session: s };
      if (s) {
        await this.store.recordCharge(s, { chargeRef: c.token, success: c.success && c.captured, amountMinor: c.amount.amountMinor, currency: c.amount.currency });
        await this.store.openTask('extra_charge', ctx.accountId, c.token);
      }
    }
    return { charge: c };
  }

  private chargeView(c: GatewayCharge): ProviderPayment {
    const status = c.success && c.captured ? 'succeeded' : c.failed ? 'failed' : 'pending';
    return { ref: c.token, status, amount: c.amount, ...(c.ourPaymentId ? { ourPaymentId: c.ourPaymentId } : {}), ...(status === 'failed' ? { failureCode: c.failureCode ?? 'card_declined' } : {}) };
  }

  // ---- PaymentProvider ----

  async testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }> {
    return this.gateway.testConnection(ctx);
  }

  async createPayment(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment> {
    const { amountMinor, currency } = input.amount;
    if (!this.manifest.currencies.includes(currency) || amountMinor < 1n || amountMinor > MAX_AMOUNT || !this.manifest.methods.includes(input.method)) {
      throw new ProviderError('provider_rejected', false);
    }
    if (!this.opts.usable) throw new ProviderError('provider_rejected', false);
    await this.gateway.probe(ctx);
    const s = await this.store.createOrGet({
      accountId: ctx.accountId, mode: ctx.mode, idempotencyKey: input.idempotencyKey, paymentId: input.metadata.paymentId, bookingId: input.metadata.bookingId,
      amountMinor, currency, returnUrl: input.returnUrl, createdAt: input.createdAt,
    });
    // Plan 4.4, 18 m5: the session's state, whatever it is now.
    return this.view(await this.settle(ctx, s));
  }

  async retrievePayment(ctx: ProviderContext, by: PaymentLookup): Promise<ProviderPayment | null> {
    await this.gateway.probe(ctx);
    if ('idempotencyKey' in by) {
      const s = await this.store.byKey(ctx.accountId, by.idempotencyKey);
      return s ? this.view(await this.settle(ctx, s)) : null;
    }
    const found = await this.sessionOf(ctx, by.ref);
    if (!found) return null;
    if ('charge' in found) return this.chargeView(found.charge);
    return this.view(await this.settle(ctx, found.session));
  }

  async cancelPayment(ctx: ProviderContext, ref: string, _idempotencyKey?: string): Promise<ProviderPayment> {
    await this.gateway.probe(ctx);
    const found = await this.sessionOf(ctx, ref);
    if (!found) throw new ProviderError('provider_not_found', false);
    if ('charge' in found) return this.chargeView(found.charge);
    let s = await this.settle(ctx, found.session);
    if (s.status === 'open') s = await this.change(s, { status: 'cancelled', failureCode: null });
    // Submitting with no answer yet: not cancelled, so the core never replaces it (P2); authenticating: as the charge is.
    return this.view(s);
  }

  // ---- the card page (called by the card-session service only) ----

  /** The session and the key the gateway designs for the browser (D4), read from this call's credentials. */
  async cardPage(ctx: ProviderContext, ref: string): Promise<{ session: CardSession; publishableKey: string | null } | null> {
    const s = await this.store.byRef(ctx.accountId, ref);
    if (!s) return null;
    const settled = s.status === 'open' ? await this.settle(ctx, s) : s;
    const field = this.manifest.account.fields.find((f) => f.exposure === 'card_page');
    const key = field ? ctx.credentials[field.key] ?? null : null;
    return { session: settled, publishableKey: key && new RegExp(field!.pattern).test(key) ? key : null };
  }

  /** A task for staff about this account's card sessions (the decline spike of plan 4.4, section 10.1). */
  openTask(kind: 'declines_spike', accountId: string, subject: string): Promise<void> {
    return this.store.openTask(kind, accountId, subject);
  }

  /** The session of a reference without the gateway (the service checks the attempt before submitting). */
  async session(accountId: string, ref: string): Promise<CardSession | null> {
    return CARD_SESSION_REF.test(ref) ? this.store.byRef(accountId, ref) : null;
  }

  /**
   * The one charge of a session (plan 4.4, section 6.3): only from `open`, and `submittedAt` is set once, so no second
   * POST can ever happen for it. An unknown outcome leaves it `submitting`.
   */
  async submitCard(ctx: ProviderContext, ref: string, cardToken: string, payer: { email: string; ipAddress: string }): Promise<SubmitResult> {
    const s = await this.store.byRef(ctx.accountId, ref);
    if (!s) throw new ProviderError('provider_not_found', false);
    if (s.status !== 'open' || this.isExpired(s)) return { session: s, next: { kind: 'not_open' } };
    const started = await this.store.update(s, { status: 'submitting', submittedAt: this.store.now() });
    if (!started) return { session: (await this.store.byRef(ctx.accountId, ref)) ?? s, next: { kind: 'not_open' } };
    let outcome: CardChargeOutcome;
    try {
      outcome = await this.gateway.charge(ctx, { amount: { amountMinor: s.amountMinor, currency: s.currency }, cardToken, payer, sessionRef: s.ref, paymentId: s.paymentId, callbackUrl: this.callbackUrl(s.ref) });
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) {
        return { session: await this.change(started, { status: 'failed', failureCode: err.code === 'provider_auth_failed' ? 'provider_auth_failed' : 'provider_rejected' }), next: { kind: 'redirect', url: s.returnUrl } };
      }
      // Unknown: the charge may exist. The session stays `submitting` until a read finds it or it expires.
      return { session: started, next: { kind: 'wait' } };
    }
    switch (outcome.kind) {
      case 'charged': {
        const done = await this.applyCharge(started, outcome.charge);
        return { session: done, next: { kind: 'redirect', url: s.returnUrl } };
      }
      case 'challenge': {
        const waiting = await this.applyCharge(started, { ...outcome.charge, pending: !(outcome.charge.success && outcome.charge.captured) });
        const allowed = this.manifest.cardFields?.challengeOrigins[ctx.mode] ?? [];
        const url = outcome.redirectUrl;
        let origin: string | null = null;
        try {
          origin = url ? new URL(url).origin : null;
        } catch {
          origin = null;
        }
        // A11: only a challenge host of this mode is followed; otherwise the charge ends at the gateway and a read finds it.
        if (url && origin && url.startsWith(`${origin}/`) && allowed.includes(origin)) return { session: waiting, next: { kind: 'redirect', url } };
        // A challenge we will not follow (A11), or a charge still in progress without one: back to the return page, which
        // shows the payment as in progress (review m3).
        return { session: waiting, next: { kind: 'redirect', url: s.returnUrl } };
      }
      case 'declined': {
        if (outcome.chargeToken) await this.store.recordCharge(started, { chargeRef: outcome.chargeToken, success: false, amountMinor: s.amountMinor, currency: s.currency });
        const ended = await this.change(started, { status: 'failed', failureCode: outcome.code, ...(outcome.chargeToken ? { chargeRef: outcome.chargeToken } : {}) });
        return { session: ended, next: { kind: 'redirect', url: s.returnUrl } };
      }
      case 'refused':
        return { session: await this.change(started, { status: 'failed', failureCode: outcome.code }), next: { kind: 'redirect', url: s.returnUrl } };
    }
  }

  /** The customer is back from 3-D Secure (plan 4.4, section 6.4). Reads only; never charges. */
  async finishAuthentication(ctx: ProviderContext, ref: string, sessionToken: string): Promise<CardSession | null> {
    const s = await this.store.byRef(ctx.accountId, ref);
    if (!s || s.status !== 'authenticating' || s.verifyCalls >= MAX_VERIFY_CALLS) return s;
    const counted = await this.store.update(s, { verifyCalls: s.verifyCalls + 1 });
    if (!counted) return this.store.byRef(ctx.accountId, ref);
    const c = await this.gateway.verifyAuthentication(ctx, sessionToken);
    if (!c) return counted;
    if (c.token !== counted.chargeRef) {
      await this.store.openTask('reference_mismatch', ctx.accountId, c.token);
      return counted;
    }
    return this.applyCharge(counted, c);
  }

  // ---- refunds (plan 4.4, section 7) ----

  private static refundView(r: GatewayRefund, intent: CardRefundIntent | null): ProviderRefund {
    return { ref: r.token, status: r.status, amount: r.amount, paymentRef: r.chargeToken, ...(intent ? { ourRefundId: intent.refundId } : {}), ...(r.failureCode ? { failureCode: r.failureCode } : {}) };
  }

  /**
   * The charge a refund of `paymentRef` is made against, as the gateway says now: a session with a charge is never
   * judged by its stored state (review M1), so money that came in after a session ended can still be refunded.
   */
  private async collectedCharge(ctx: ProviderContext, paymentRef: string): Promise<string | null> {
    const found = await this.sessionOf(ctx, paymentRef);
    if (!found) return null;
    if ('charge' in found) return found.charge.success && found.charge.captured ? found.charge.token : null;
    const s = await this.settle(ctx, found.session);
    if (!s.chargeRef) return null;
    const c = await this.gateway.retrieveCharge(ctx, s.chargeRef);
    return c && c.success && c.captured ? c.token : null;
  }

  /** Binds a submitting intent to the one gateway refund it can be; null if none yet, an error if several. */
  private async bindCandidate(ctx: ProviderContext, i: CardRefundIntent, list?: GatewayRefund[]): Promise<CardRefundIntent | null> {
    const refunds = list ?? (await this.gateway.listRefunds(ctx, i.chargeRef));
    const candidates: GatewayRefund[] = [];
    for (const r of refunds) {
      if (r.amount.amountMinor !== i.amountMinor || r.amount.currency !== i.currency) continue;
      if (!withinRequestWindow(r, i)) continue;
      if (await this.store.intentByRefundRef(ctx.accountId, r.token)) continue;
      candidates.push(r);
    }
    if (candidates.length > 1) {
      await this.store.openTask('refund_candidates', ctx.accountId, i.id);
      throw new ProviderError('provider_unavailable', true);
    }
    if (candidates.length === 0) return null;
    return this.bind(ctx, i, candidates[0]!.token);
  }

  /** Binds an intent to a refund reference; never rebinds (plan 4.4, 18 m7). */
  private async bind(ctx: ProviderContext, i: CardRefundIntent, refundRef: string): Promise<CardRefundIntent> {
    const bound = await this.store.updateIntent(i, { status: 'bound', refundRef });
    if (bound) return bound;
    const now = await this.store.intentByKey(ctx.accountId, i.idempotencyKey);
    if (now?.status === 'bound' && now.refundRef === refundRef) return now;
    await this.store.openTask('refund_conflict', ctx.accountId, i.id);
    throw new ProviderError('provider_unavailable', true);
  }

  private async post(ctx: ProviderContext, i: CardRefundIntent): Promise<ProviderRefund> {
    const started = await this.store.updateIntent(i, { status: 'submitting' });
    if (!started) return this.existing(ctx, (await this.store.intentByKey(ctx.accountId, i.idempotencyKey))!);
    let outcome;
    try {
      outcome = await this.gateway.createRefund(ctx, i.chargeRef, { amountMinor: i.amountMinor, currency: i.currency });
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'provider_auth_failed') {
        await this.store.updateIntent(started, { status: 'new', lastAnswer: 'auth_failed' });
        throw err;
      }
      // Unknown: never posted again; a later read binds it (plan 4.4, D8).
      throw err instanceof ProviderError ? err : new ProviderError('provider_unavailable', true);
    }
    if (outcome.kind === 'rate_limited') {
      await this.store.updateIntent(started, { status: 'new', lastAnswer: 'rate_limited' });
      throw new ProviderError('provider_busy', true);
    }
    if (outcome.kind === 'refused') {
      await this.store.updateIntent(started, { status: 'refused' });
      throw new ProviderError('provider_rejected', false);
    }
    const bound = await this.bind(ctx, started, outcome.refund.token);
    return CardSessionProvider.refundView(outcome.refund, bound);
  }

  private async existing(ctx: ProviderContext, i: CardRefundIntent): Promise<ProviderRefund> {
    if (i.status === 'refused') throw new ProviderError('provider_rejected', false);
    if (i.status === 'new') return this.post(ctx, i);
    let bound: CardRefundIntent | null = i;
    if (i.status === 'submitting') bound = await this.bindCandidate(ctx, i);
    if (!bound || !bound.refundRef) throw new ProviderError('provider_unavailable', true);
    const r = await this.gateway.retrieveRefund(ctx, bound.refundRef);
    if (!r) throw new ProviderError('provider_unavailable', true);
    return CardSessionProvider.refundView(r, bound);
  }

  async createRefund(ctx: ProviderContext, input: CreateRefundInput): Promise<ProviderRefund> {
    const { amountMinor, currency } = input.amount;
    if (!this.manifest.currencies.includes(currency) || amountMinor < 1n || amountMinor > MAX_AMOUNT) throw new ProviderError('provider_rejected', false);
    await this.gateway.probe(ctx);
    const prior = await this.store.intentByKey(ctx.accountId, input.idempotencyKey);
    if (prior) return this.existing(ctx, prior);
    const chargeRef = await this.collectedCharge(ctx, input.paymentRef);
    if (!chargeRef) throw new ProviderError('provider_rejected', false);
    const state = await this.gateway.refundState(ctx, chargeRef);
    if (!state || !(state.charge.success && state.charge.captured) || state.charge.amount.currency !== currency) throw new ProviderError('provider_rejected', false);
    if (amountMinor > state.charge.amount.amountMinor - state.refunded) throw new ProviderError('provider_rejected', false);
    const i = await this.store.createIntent({ accountId: ctx.accountId, mode: ctx.mode, idempotencyKey: input.idempotencyKey, refundId: input.metadata.refundId, chargeRef, amountMinor, currency });
    return i.status === 'new' ? this.post(ctx, i) : this.existing(ctx, i);
  }

  async retrieveRefund(ctx: ProviderContext, by: RefundLookup): Promise<ProviderRefund | null> {
    await this.gateway.probe(ctx);
    if ('idempotencyKey' in by) {
      const i = await this.store.intentByKey(ctx.accountId, by.idempotencyKey);
      if (!i || i.status === 'refused' || i.status === 'new') return null;
      let bound: CardRefundIntent | null = i;
      if (i.status === 'submitting') bound = await this.bindCandidate(ctx, i);
      // Unknown, never "none" (plan 4.4, 18 m7).
      if (!bound?.refundRef) throw new ProviderError('provider_unavailable', true);
      const r = await this.gateway.retrieveRefund(ctx, bound.refundRef);
      return r ? CardSessionProvider.refundView(r, bound) : null;
    }
    const r = await this.gateway.retrieveRefund(ctx, by.ref);
    if (!r) return null;
    let intent = await this.store.intentByRefundRef(ctx.accountId, r.token);
    if (!intent) {
      // A refund event processed before our POST's answer (plan 4.4, section 7): the one submitting intent it can be.
      const waiting = (await this.store.submittingIntents(ctx.accountId, r.chargeToken)).filter((i) => i.amountMinor === r.amount.amountMinor && i.currency === r.amount.currency && withinRequestWindow(r, i));
      if (waiting.length > 1) throw new ProviderError('provider_unavailable', true);
      if (waiting.length === 1) intent = await this.bind(ctx, waiting[0]!, r.token);
    }
    return CardSessionProvider.refundView(r, intent);
  }

  // ---- webhooks: the gateway's, unchanged ----

  verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification {
    return this.gateway.verifyWebhook(ctx, rawBody, headers, now);
  }

  parseEvent(rawBody: Buffer): NormalisedEvent | null {
    return this.gateway.parseEvent(rawBody);
  }
}
