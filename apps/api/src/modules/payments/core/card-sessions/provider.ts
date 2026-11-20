// CardSessionProvider (plan docs/plans/4.4-au-card-gateway.md, sections 4, 6, 7 and 18): the PaymentProvider of a
// gateway whose card is tokenised by its hosted fields on our own card page (Pin Payments). Before the customer submits a
// card there is nothing at the gateway, so the session lives here, in a store; one card submission makes at most one
// charge, ever. Refund intents stand in for the idempotency keys and metadata the gateway does not have. Everything that
// needs the truth reads the gateway and brings the store up to date; webhooks never write the store (section 8.3).
import type { CardSessionFailure } from '@mt/shared';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CARD_SESSION_REF, NOT_UNIQUE, ProviderError,
} from '../provider';
import type {
  AdapterManifest, AuthenticationPayer, CardChargeOutcome, CardTokenGateway, CreatePaymentInput, CreateRefundInput, GatewayCharge, GatewayRefund, NormalisedEvent, PaymentLookup,
  PaymentProvider, ProviderContext, ProviderPayment, ProviderRefund, RefundLookup, WebhookVerification,
} from '../provider';
import type { CardRefundIntent, CardSession, CardSessionChange, CardSessionStore } from './store';

/**
 * Task 9.1 (plan docs/plans/9.1-eway.md, 20 M5): for a gateway with no events, a charge whose answer was lost is taken
 * as never made only on a definitive "none" at least this long after it was sent (and past the session's expiry).
 */
export const NOT_FOUND_GRACE_MS = 15 * 60_000;

/** Task 9.1: our reference for a refund intent at the gateway (eWAY's InvoiceReference): `mtr_` + the intent id's hex. */
export const intentRefOf = (i: { id: string }): string => `mtr_${i.id.replace(/-/g, '').toLowerCase()}`;

/** sha256 hex of a card token: what a before_charge session keeps of the card it authenticated (never the token). */
export const cardTokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
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
/** Task 9.1: eWAY Secure Fields are served on their own path, with their own CSP (plan 9.1, section 10.3). */
export const SECURE_FIELDS_PAGE_PATH = '/pay/secure-fields';
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
  next: { kind: 'redirect'; url: string } | { kind: 'wait' } | { kind: 'not_open' } | { kind: 'authenticate'; authRef: string };
}

/** The payer as a card submission carries it: email and IP always; name and phone for before_charge gateways. */
export interface CardPayer {
  email: string;
  ipAddress: string;
  givenName?: string;
  familyName?: string;
  phone?: string;
}

const failureOfCharge = (c: GatewayCharge): CardSessionFailure => c.failureCode ?? 'card_declined';

/** Equal strings, compared in constant time (a mismatch of length is simply unequal). */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

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
    // Task 9.1: a gateway with no events has no refund events whose id needs a retrieve.
    const viaRetrieve = !gateway.refundEventsCarryOurId && m.capabilities.gatewayEvents !== 'none';
    this.manifest = { ...m, checkoutOrigin: opts.cardPageOrigin, capabilities: { ...m.capabilities, preCardSession: true, ...(viaRetrieve ? { refundEventOurId: 'via_retrieve' as const } : {}) } };
    this.signatureHeaders = gateway.signatureHeaders;
  }

  // ---- mapping ----

  get beforeCharge(): boolean {
    return this.gateway.authentication === 'before_charge';
  }

  private get eventless(): boolean {
    return this.manifest.capabilities.gatewayEvents === 'none';
  }

  cardPageUrl(ref: string): string {
    const path = this.manifest.cardFields?.driver === 'eway_secure_fields' ? SECURE_FIELDS_PAGE_PATH : CARD_PAGE_PATH;
    return `${this.opts.cardPageOrigin}${path}/${ref}`;
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
        // Task 9.1: before its one charge a before_charge session still waits for the customer; nothing can move money.
        if (s.flow === 'before_charge' && s.submittedAt === null) {
          return this.isExpired(s) ? { ...base, status: 'cancelled' } : { ...base, status: 'requires_action', nextAction: { type: 'redirect', url: this.cardPageUrl(s.ref) } };
        }
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
    // Task 9.1: an abandoned before_charge authentication ends without money (its charge was never sent).
    if (s.status === 'authenticating' && s.flow === 'before_charge' && s.submittedAt === null) {
      return this.isExpired(s) ? this.change(s, { status: 'cancelled', failureCode: 'expired' }) : s;
    }
    if (s.status === 'authenticating' && s.chargeRef) {
      const c = await this.gateway.retrieveCharge(ctx, s.chargeRef);
      return c ? this.applyCharge(s, c) : s;
    }
    const unknownEnd = s.status === 'failed' && s.chargeRef === null && (s.failureCode === 'outcome_unknown' || s.failureCode === 'provider_busy');
    if (s.status === 'submitting' || unknownEnd) {
      const charges = await this.gateway.chargesOfSession(ctx, s.ref);
      if (charges === NOT_UNIQUE) {
        // Plan 9.1, 20 m10: the gateway cannot tell which: staff bind it (payments:card-session-bind).
        await this.store.openTask('reference_not_unique', s.accountId, s.ref);
        throw new ProviderError('provider_unavailable', true);
      }
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
      // Plan 9.1, 20 M5: without events nothing else would ever read it again, so only after a grace period too.
      const graceOver = !this.eventless || (s.submittedAt !== null && this.store.now().getTime() - s.submittedAt.getTime() >= NOT_FOUND_GRACE_MS);
      if (s.status === 'submitting' && this.isExpired(s) && graceOver) return this.change(s, { status: 'failed', failureCode: 'outcome_unknown' });
    }
    return s;
  }

  /** The session of a reference: ours (`cs_…`), or the gateway's charge of one of our sessions (plan 4.4, 18 M3). */
  private async sessionOf(ctx: ProviderContext, ref: string): Promise<{ session: CardSession } | { charge: GatewayCharge } | null> {
    if (CARD_SESSION_REF.test(ref)) {
      const s = await this.store.byRef(ctx.accountId, ref);
      return s ? { session: s } : null;
    }
    if (!this.gateway.chargeRefPattern.test(ref)) return null;
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
      accountId: ctx.accountId, mode: ctx.mode, flow: this.gateway.authentication, idempotencyKey: input.idempotencyKey, paymentId: input.metadata.paymentId, bookingId: input.metadata.bookingId,
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
    // Task 9.1: a before_charge session whose charge was never sent can be cancelled for good (plan 9.1, 4.1).
    else if (s.status === 'authenticating' && s.flow === 'before_charge' && s.submittedAt === null) s = await this.change(s, { status: 'cancelled', failureCode: null });
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
  async submitCard(ctx: ProviderContext, ref: string, cardToken: string, payer: CardPayer): Promise<SubmitResult> {
    const s = await this.store.byRef(ctx.accountId, ref);
    if (!s) throw new ProviderError('provider_not_found', false);
    if (s.status !== 'open' || this.isExpired(s)) return { session: s, next: { kind: 'not_open' } };
    if (s.flow === 'before_charge') return this.beginAuthentication(ctx, s, cardToken, payer);
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
      case 'duplicate':
        return { session: await this.duplicate(ctx, started), next: { kind: 'redirect', url: s.returnUrl } };
    }
  }

  /**
   * Task 9.1 (plan 9.1, 20 M4): the gateway refused this charge as a duplicate of one it already processed. Not "no
   * money": an earlier session of this booking may have charged unseen, so each is searched again, and staff get a task.
   */
  private async duplicate(ctx: ProviderContext, s: CardSession): Promise<CardSession> {
    const ended = await this.change(s, { status: 'failed', failureCode: 'provider_rejected' });
    await this.store.openTask('duplicate_transaction', s.accountId, s.ref);
    for (const other of await this.store.unresolvedOfBooking(s.accountId, s.bookingId)) {
      if (other.id === s.id) continue;
      try {
        await this.settle(ctx, other);
      } catch {
        // Unknown for now: the task stands, and the next read of that session tries again.
      }
    }
    return ended;
  }

  // ---- before_charge gateways (task 9.1, plan docs/plans/9.1-eway.md, sections 4.1, 6.3 and 6.4) ----

  /** Starts 3-D Secure for the card: no money can move here. The session waits for the customer's challenge. */
  private async beginAuthentication(ctx: ProviderContext, s: CardSession, cardToken: string, payer: CardPayer): Promise<SubmitResult> {
    if (!this.gateway.beginAuthentication || !payer.givenName || !payer.familyName || !payer.phone) throw new ProviderError('provider_rejected', false);
    const started = await this.store.update(s, { status: 'authenticating', authCardHash: cardTokenHash(cardToken) });
    if (!started) return { session: (await this.store.byRef(ctx.accountId, s.ref)) ?? s, next: { kind: 'not_open' } };
    let outcome;
    try {
      outcome = await this.gateway.beginAuthentication(ctx, {
        amount: { amountMinor: s.amountMinor, currency: s.currency }, cardToken,
        payer: { givenName: payer.givenName, familyName: payer.familyName, email: payer.email, phone: payer.phone },
      });
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) {
        return { session: await this.change(started, { status: 'failed', failureCode: err.code === 'provider_auth_failed' ? 'provider_auth_failed' : 'provider_rejected' }), next: { kind: 'redirect', url: s.returnUrl } };
      }
      // Unknown: nothing that moves money was sent, and this session can no longer be authorised (no authRef); it
      // expires as cancelled. The customer starts a new attempt.
      return { session: started, next: { kind: 'wait' } };
    }
    switch (outcome.kind) {
      case 'challenge': {
        const waiting = await this.change(started, { authRef: outcome.authRef });
        return { session: waiting, next: { kind: 'authenticate', authRef: outcome.authRef } };
      }
      case 'declined':
        return { session: await this.change(started, { status: 'failed', failureCode: outcome.code }), next: { kind: 'redirect', url: s.returnUrl } };
      case 'refused':
        return { session: await this.change(started, { status: 'failed', failureCode: outcome.code }), next: { kind: 'redirect', url: s.returnUrl } };
    }
  }

  /**
   * The customer finished the challenge (task 9.1, plan 9.1 section 6.4): the authentication is read, then the one charge
   * is sent, exactly once (`submittedAt` is set by compare-and-set before it). The challenge must be this session's and
   * the card the one it authenticated; otherwise nothing changes.
   */
  async authoriseCard(ctx: ProviderContext, ref: string, authRef: string, cardToken: string, ipAddress: string): Promise<SubmitResult> {
    const s = await this.store.byRef(ctx.accountId, ref);
    if (!s) throw new ProviderError('provider_not_found', false);
    if (s.flow !== 'before_charge' || s.status !== 'authenticating' || s.submittedAt !== null || this.isExpired(s) || s.authRef === null || s.authCardHash === null) {
      return { session: s, next: { kind: 'not_open' } };
    }
    if (!sameText(s.authRef, authRef) || !sameText(s.authCardHash, cardTokenHash(cardToken))) {
      await this.store.openTask('reference_mismatch', ctx.accountId, s.ref);
      return { session: s, next: { kind: 'not_open' } };
    }
    if (s.verifyCalls >= MAX_VERIFY_CALLS || !this.gateway.completeAuthentication) {
      return { session: await this.change(s, { status: 'failed', failureCode: 'too_many_attempts' }), next: { kind: 'redirect', url: s.returnUrl } };
    }
    const counted = await this.store.update(s, { verifyCalls: s.verifyCalls + 1 });
    if (!counted) return { session: (await this.store.byRef(ctx.accountId, ref)) ?? s, next: { kind: 'not_open' } };
    // Unknown: thrown, the session unchanged; the page may try again within the verify limit.
    const auth = await this.gateway.completeAuthentication(ctx, s.authRef);
    if (!auth.authenticated) {
      return { session: await this.change(counted, { status: 'failed', failureCode: 'card_not_authenticated' }), next: { kind: 'redirect', url: s.returnUrl } };
    }
    const sending = await this.store.update(counted, { status: 'submitting', submittedAt: this.store.now() });
    if (!sending) return { session: (await this.store.byRef(ctx.accountId, ref)) ?? counted, next: { kind: 'not_open' } };
    let outcome: CardChargeOutcome;
    try {
      outcome = await this.gateway.charge(ctx, {
        amount: { amountMinor: s.amountMinor, currency: s.currency }, cardToken, payer: { email: '', ipAddress }, sessionRef: s.ref, paymentId: s.paymentId,
        callbackUrl: this.callbackUrl(s.ref), authentication: auth.proof,
      });
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) {
        return { session: await this.change(sending, { status: 'failed', failureCode: err.code === 'provider_auth_failed' ? 'provider_auth_failed' : 'provider_rejected' }), next: { kind: 'redirect', url: s.returnUrl } };
      }
      // Unknown: never sent again; a read finds it by our reference (plan 9.1, 6.4 and 20 M5).
      return { session: sending, next: { kind: 'wait' } };
    }
    switch (outcome.kind) {
      case 'charged':
        return { session: await this.applyCharge(sending, outcome.charge), next: { kind: 'redirect', url: s.returnUrl } };
      case 'challenge':
        // A before_charge gateway never challenges after the charge: unknown, read later.
        return { session: sending, next: { kind: 'wait' } };
      case 'declined': {
        if (outcome.chargeToken) await this.store.recordCharge(sending, { chargeRef: outcome.chargeToken, success: false, amountMinor: s.amountMinor, currency: s.currency });
        const ended = await this.change(sending, { status: 'failed', failureCode: outcome.code, ...(outcome.chargeToken ? { chargeRef: outcome.chargeToken } : {}) });
        return { session: ended, next: { kind: 'redirect', url: s.returnUrl } };
      }
      case 'refused':
        return { session: await this.change(sending, { status: 'failed', failureCode: outcome.code }), next: { kind: 'redirect', url: s.returnUrl } };
      case 'duplicate':
        return { session: await this.duplicate(ctx, sending), next: { kind: 'redirect', url: s.returnUrl } };
    }
  }

  /**
   * Task 9.1 (plan 9.1, 20 m10): staff bind a session the gateway cannot search (a reference on several transactions) to
   * the transaction they found. Only a transaction that carries this session's reference, amount and currency.
   */
  async bindByStaff(ctx: ProviderContext, ref: string, chargeRef: string): Promise<CardSession> {
    const s = await this.store.byRef(ctx.accountId, ref);
    if (!s) throw new ProviderError('provider_not_found', false);
    const unresolved = s.status === 'submitting' || (s.status === 'failed' && s.chargeRef === null && s.submittedAt !== null && (s.failureCode === 'outcome_unknown' || s.failureCode === 'provider_busy'));
    if (!unresolved || !this.gateway.chargeRefPattern.test(chargeRef)) throw new ProviderError('provider_rejected', false);
    const c = await this.gateway.retrieveCharge(ctx, chargeRef);
    if (!c || c.sessionRef !== s.ref || c.amount.currency !== s.currency || c.amount.amountMinor !== s.amountMinor) throw new ProviderError('provider_rejected', false);
    return this.applyCharge(s, c);
  }

  /** The customer is back from 3-D Secure (plan 4.4, section 6.4). Reads only; never charges. */
  async finishAuthentication(ctx: ProviderContext, ref: string, sessionToken: string): Promise<CardSession | null> {
    const s = await this.store.byRef(ctx.accountId, ref);
    if (!s || s.flow !== 'after_charge' || s.status !== 'authenticating' || s.verifyCalls >= MAX_VERIFY_CALLS) return s;
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
    // Task 9.1 (plan 9.1, section 7): a gateway that keeps our reference binds by exact match, never by the window.
    if (this.gateway.refundByOurRef) {
      const mine = await this.gateway.refundByOurRef(ctx, intentRefOf(i), i.chargeRef);
      if (!mine) return null;
      if (mine.chargeToken !== i.chargeRef || mine.amount.amountMinor !== i.amountMinor || mine.amount.currency !== i.currency) {
        await this.store.openTask('refund_conflict', ctx.accountId, i.id);
        throw new ProviderError('provider_unavailable', true);
      }
      return this.bind(ctx, i, mine.token);
    }
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
      outcome = await this.gateway.createRefund(ctx, i.chargeRef, { amountMinor: i.amountMinor, currency: i.currency }, intentRefOf(i));
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
      // Task 9.1: with our reference at the gateway, only the intent it names.
      if (this.gateway.refundByOurRef) {
        for (const i of await this.store.submittingIntents(ctx.accountId, r.chargeToken)) {
          const mine = await this.gateway.refundByOurRef(ctx, intentRefOf(i), i.chargeRef);
          if (mine?.token === r.token) intent = await this.bind(ctx, i, r.token);
        }
        return CardSessionProvider.refundView(r, intent);
      }
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
