// The Stripe adapter (plan docs/plans/3.3-stripe-adapter-ledger.md, section 5): Checkout Sessions on Stripe's hosted
// page, refunds and signed webhooks. `experimental`: written from Stripe's documentation and proven only against the fake
// of test/contract/subjects/stripe-fake.ts until `test:sandbox` runs with Oscar's sandbox keys. It talks only to
// https://api.stripe.com (no option or variable changes that), reads no environment and never logs.
import type { PaymentMethod } from '@mt/shared';
import {
  AdapterManifest, CreatePaymentInput, CreateRefundInput, NormalisedEvent, PaymentLookup, PaymentProvider, ProviderContext, ProviderDispute, ProviderError, ProviderPayment,
  ProviderRefund, RefundLookup, WebhookVerification,
} from '../../core/provider';
import {
  STRIPE_SIGNATURE_HEADER, disputeToProvider, parseStripeEvent, refundToProvider, sessionPaymentIntentId, sessionToPayment, stripeError, verifyStripeSignature,
} from './mapping';

export const STRIPE_KEY = 'stripe';
/** Pinned (docs.stripe.com/api-versions, 2026-11-19). The webhook endpoint must be pinned to the same version. */
export const STRIPE_API_VERSION = '2026-10-28.endive';
export const STRIPE_API_BASE = 'https://api.stripe.com';
/** Stripe's smallest AUD charge and the largest amount its API takes (eight digits). */
export const STRIPE_MIN_AMOUNT = 50n;
export const STRIPE_MAX_AMOUNT = 99_999_999n;
/** The session lives this long after our attempt row was created: under the attempt's 60 minutes (plan 3.3, 5.2). */
export const SESSION_LIFETIME_SECONDS = 45 * 60;
/** Stripe wants expires_at at least 30 minutes after the call: past this age, a create only looks up (plan 3.3, 12.5). */
export const LATE_CREATE_AFTER_MS = 14 * 60_000;
/** The window searched by key around the row's createdAt, and how many pages of 100. */
const LOOKUP_BEFORE_S = 5 * 60;
const LOOKUP_AFTER_S = 15 * 60;
const LOOKUP_PAGES = 10;

export interface StripeRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: ReadonlyArray<[string, string]>;
  form?: ReadonlyArray<[string, string]>;
  headers: Record<string, string>;
}
export interface StripeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
/** One HTTP exchange with Stripe. Tests inject the fake; the API always uses fetch to api.stripe.com. */
export type StripeTransport = (req: StripeRequest) => Promise<StripeResponse>;

const FETCH_TIMEOUT_MS = 9_000;

export const fetchTransport: StripeTransport = async (req) => {
  const qs = req.query?.length ? `?${new URLSearchParams(req.query as Array<[string, string]>).toString()}` : '';
  let res: Response;
  try {
    res = await fetch(`${STRIPE_API_BASE}${req.path}${qs}`, {
      method: req.method,
      headers: { ...req.headers, ...(req.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: req.form ? new URLSearchParams(req.form as Array<[string, string]>).toString() : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    throw new ProviderError((err as { name?: string })?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable', true);
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, body: await res.text() };
};

/** Filler for the descriptor's samples (plan 4.1, section 2): shapes only, never a key. */
const SAMPLE = 'x'.repeat(24);

export function stripeManifest(): AdapterManifest {
  return {
    key: STRIPE_KEY,
    displayName: 'Stripe',
    status: 'experimental',
    testOnly: false,
    cardDataHandling: 'hosted_only',
    // Apple Pay and Google Pay are offered by Checkout's card method.
    methods: ['card', 'apple_pay', 'google_pay'] satisfies PaymentMethod[],
    currencies: ['AUD'],
    countries: 'any',
    checkoutOrigin: 'https://checkout.stripe.com',
    // Task 4.1: the secret key is typed in the panel; the webhook signing secret is issued by Stripe once the account's
    // webhook URL is registered, so it is entered afterwards. Test-mode patterns only.
    account: {
      fields: [{
        key: 'secretKey', label: 'Secret key (test mode, sk_test_… or rk_test_…)', pattern: '^(sk|rk)_test_[A-Za-z0-9]{10,250}$',
        samples: { valid: `sk_test_${SAMPLE}`, rejected: [`sk_live_${SAMPLE}`, `rk_live_${SAMPLE}`, `pk_test_${SAMPLE}`, `pk_live_${SAMPLE}`, `whsec_${SAMPLE}`] },
      }],
      webhookSecret: {
        source: 'entered', label: 'Webhook signing secret (whsec_…)', pattern: '^whsec_[A-Za-z0-9]{10,250}$',
        samples: { valid: `whsec_${SAMPLE}`, rejected: [`sk_test_${SAMPLE}`, `sk_live_${SAMPLE}`, `whsec_${SAMPLE}-x`, 'whsec_'] },
      },
    },
    capabilities: { refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'stays_payable', disputes: 'events' },
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface StripeOptions {
  /** Only tests pass one (the fake). */
  transport?: StripeTransport;
  /** Only tests pass one. */
  now?: () => Date;
}

export class StripeProvider implements PaymentProvider {
  readonly manifest = stripeManifest();
  readonly signatureHeaders = [STRIPE_SIGNATURE_HEADER] as const;
  private readonly transport: StripeTransport;
  protected readonly now: () => Date;

  constructor(opts: StripeOptions = {}) {
    this.transport = opts.transport ?? fetchTransport;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- HTTP ----

  /** The secret key of the account, refused before any call if it is not a key of the account's mode. */
  protected key(ctx: ProviderContext): string {
    const k = ctx.credentials.secretKey ?? '';
    const re = ctx.mode === 'live' ? /^(sk|rk)_live_[A-Za-z0-9]{10,250}$/ : /^(sk|rk)_test_[A-Za-z0-9]{10,250}$/;
    if (!re.test(k)) throw new ProviderError('provider_auth_failed', false);
    return k;
  }

  protected async call(ctx: ProviderContext, req: Omit<StripeRequest, 'headers'>, idempotencyKey?: string): Promise<{ ok: true; body: Obj; replayed: boolean } | { ok: false; error: ReturnType<typeof stripeError> }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key(ctx)}`, 'stripe-version': STRIPE_API_VERSION };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let res: StripeResponse;
    try {
      res = await this.transport({ ...req, headers });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('provider_unavailable', true);
    }
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      body = undefined;
    }
    if (res.status >= 200 && res.status < 300) {
      if (!isObj(body)) throw new ProviderError('provider_unavailable', true);
      // A live object in a test account means a live key slipped in: refuse it (plan 3.3, 5.2).
      if (ctx.mode === 'test' && body.livemode === true) throw new ProviderError('provider_auth_failed', false);
      return { ok: true, body, replayed: res.headers['idempotent-replayed'] === 'true' };
    }
    return { ok: false, error: stripeError(res.status, body) };
  }

  protected async must(ctx: ProviderContext, req: Omit<StripeRequest, 'headers'>, idempotencyKey?: string): Promise<Obj> {
    const r = await this.call(ctx, req, idempotencyKey);
    if (r.ok) return r.body;
    if (r.error === 'idempotency_error') throw new ProviderError('provider_rejected', false);
    throw new ProviderError(r.error.code, r.error.retryable);
  }

  protected async getSession(ctx: ProviderContext, id: string): Promise<Obj | null> {
    const r = await this.call(ctx, { method: 'GET', path: `/v1/checkout/sessions/${encodeURIComponent(id)}`, query: [['expand[]', 'payment_intent']] });
    if (r.ok) return r.body;
    if (r.error !== 'idempotency_error' && r.error.code === 'provider_not_found') return null;
    if (r.error === 'idempotency_error') throw new ProviderError('provider_rejected', false);
    throw new ProviderError(r.error.code, r.error.retryable);
  }

  protected toPayment(o: unknown): ProviderPayment {
    const p = sessionToPayment(o);
    if (!p) throw new ProviderError('provider_unavailable', true);
    return p;
  }

  /** Task 9.3 (plan 9.3, section 4.1): the session's parameters; the pay-later adapter changes only its methods. */
  protected sessionParams(input: CreatePaymentInput): Array<[string, string]> {
    return sessionParams(input);
  }

  // ---- PaymentProvider ----

  async testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }> {
    try {
      await this.must(ctx, { method: 'GET', path: '/v1/checkout/sessions', query: [['limit', '1']] });
      return ctx.webhookSecret.length >= 16 ? { ok: true } : { ok: false, code: 'webhook_secret_missing' };
    } catch (err) {
      return { ok: false, code: err instanceof ProviderError ? err.code : 'provider_unavailable' };
    }
  }

  async createPayment(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment> {
    this.key(ctx);
    const amount = input.amount.amountMinor;
    if (!this.manifest.currencies.includes(input.amount.currency) || amount < STRIPE_MIN_AMOUNT || amount > STRIPE_MAX_AMOUNT) throw new ProviderError('provider_rejected', false);
    const lookup = { idempotencyKey: input.idempotencyKey, createdAt: input.createdAt };
    // Too late for a valid expires_at: never create, only look up (plan 3.3, 12.5).
    if (this.now().getTime() - input.createdAt.getTime() > LATE_CREATE_AFTER_MS) {
      const found = await this.retrievePayment(ctx, lookup);
      if (found) return found;
      throw new ProviderError('provider_rejected', false);
    }
    const r = await this.call(ctx, { method: 'POST', path: '/v1/checkout/sessions', form: this.sessionParams(input) }, input.idempotencyKey);
    if (!r.ok) {
      // Another request under this key exists (other parameters): the object is that one, looked up (plan 3.3, 12.5).
      if (r.error === 'idempotency_error') {
        const found = await this.retrievePayment(ctx, lookup);
        if (found) return found;
        throw new ProviderError('provider_rejected', false);
      }
      throw new ProviderError(r.error.code, r.error.retryable);
    }
    // A replay returns the session as it was created, not as it is: read it again.
    if (r.replayed) {
      const now = await this.getSession(ctx, String(r.body.id));
      if (!now) throw new ProviderError('provider_unavailable', true);
      return this.toPayment(now);
    }
    return this.toPayment(r.body);
  }

  async retrievePayment(ctx: ProviderContext, by: PaymentLookup): Promise<ProviderPayment | null> {
    this.key(ctx);
    if ('ref' in by) {
      // A refund event names the PaymentIntent: find its session.
      if (by.ref.startsWith('pi_')) {
        const list = await this.must(ctx, { method: 'GET', path: '/v1/checkout/sessions', query: [['payment_intent', by.ref], ['limit', '1'], ['expand[]', 'data.payment_intent']] });
        const first = Array.isArray(list.data) ? list.data[0] : undefined;
        return first ? this.toPayment(first) : null;
      }
      const s = await this.getSession(ctx, by.ref);
      return s ? this.toPayment(s) : null;
    }
    const s = await this.findSessionByKey(ctx, by.idempotencyKey, by.createdAt);
    return s ? this.toPayment(s) : null;
  }

  /** Read-only search of the window around createdAt for the session carrying our key (Stripe has no lookup by key). */
  private async findSessionByKey(ctx: ProviderContext, key: string, createdAt: Date): Promise<Obj | null> {
    const t = Math.floor(createdAt.getTime() / 1000);
    let after: string | undefined;
    for (let page = 0; page < LOOKUP_PAGES; page++) {
      const query: Array<[string, string]> = [['created[gte]', String(t - LOOKUP_BEFORE_S)], ['created[lte]', String(t + LOOKUP_AFTER_S)], ['limit', '100'], ['expand[]', 'data.payment_intent']];
      if (after) query.push(['starting_after', after]);
      const list = await this.must(ctx, { method: 'GET', path: '/v1/checkout/sessions', query });
      const data = Array.isArray(list.data) ? list.data.filter(isObj) : [];
      const hit = data.find((s) => isObj(s.metadata) && s.metadata.mt_idempotency_key === key);
      if (hit) return hit;
      if (list.has_more !== true || data.length === 0) return null;
      after = String(data[data.length - 1]!.id);
    }
    // More sessions in ten minutes than ten pages: say "unknown", never "none".
    throw new ProviderError('provider_unavailable', true);
  }

  async cancelPayment(ctx: ProviderContext, ref: string, idempotencyKey: string): Promise<ProviderPayment> {
    this.key(ctx);
    const s = await this.getSession(ctx, ref);
    if (!s) throw new ProviderError('provider_not_found', false);
    if (s.status !== 'open') return this.toPayment(s);
    const r = await this.call(ctx, { method: 'POST', path: `/v1/checkout/sessions/${encodeURIComponent(ref)}/expire` }, idempotencyKey);
    // Not open any more (paid meanwhile): say what it is now.
    const now = await this.getSession(ctx, ref);
    if (!now) throw new ProviderError('provider_not_found', false);
    if (!r.ok && r.error !== 'idempotency_error' && r.error.retryable) throw new ProviderError(r.error.code, true);
    return this.toPayment(now);
  }

  async createRefund(ctx: ProviderContext, input: CreateRefundInput): Promise<ProviderRefund> {
    this.key(ctx);
    const s = await this.getSession(ctx, input.paymentRef);
    if (!s) throw new ProviderError('provider_not_found', false);
    const payment = this.toPayment(s);
    const pi = sessionPaymentIntentId(s);
    if (payment.status !== 'succeeded' || !pi || input.amount.currency !== payment.amount.currency || input.amount.amountMinor <= 0n) throw new ProviderError('provider_rejected', false);
    const form: Array<[string, string]> = [
      ['payment_intent', pi], ['amount', input.amount.amountMinor.toString()],
      ['metadata[mt_refund_id]', input.metadata.refundId], ['metadata[mt_payment_id]', input.metadata.paymentId],
      ['metadata[mt_booking_id]', input.metadata.bookingId], ['metadata[mt_idempotency_key]', input.idempotencyKey],
    ];
    const r = await this.call(ctx, { method: 'POST', path: '/v1/refunds', form }, input.idempotencyKey);
    if (!r.ok) {
      if (r.error === 'idempotency_error') {
        const found = await this.retrieveRefund(ctx, { idempotencyKey: input.idempotencyKey, paymentRef: input.paymentRef, createdAt: input.createdAt });
        if (found) return found;
        throw new ProviderError('provider_rejected', false);
      }
      throw new ProviderError(r.error.code, r.error.retryable);
    }
    const body = r.replayed ? await this.must(ctx, { method: 'GET', path: `/v1/refunds/${encodeURIComponent(String(r.body.id))}` }) : r.body;
    const refund = refundToProvider(body);
    if (!refund) throw new ProviderError('provider_unavailable', true);
    return refund;
  }

  async retrieveRefund(ctx: ProviderContext, by: RefundLookup): Promise<ProviderRefund | null> {
    this.key(ctx);
    if ('ref' in by) {
      const r = await this.call(ctx, { method: 'GET', path: `/v1/refunds/${encodeURIComponent(by.ref)}` });
      if (!r.ok) {
        if (r.error !== 'idempotency_error' && r.error.code === 'provider_not_found') return null;
        throw r.error === 'idempotency_error' ? new ProviderError('provider_rejected', false) : new ProviderError(r.error.code, r.error.retryable);
      }
      const refund = refundToProvider(r.body);
      if (!refund) throw new ProviderError('provider_unavailable', true);
      return refund;
    }
    const pi = by.paymentRef.startsWith('pi_') ? by.paymentRef : sessionPaymentIntentId(await this.getSession(ctx, by.paymentRef));
    if (!pi) return null;
    const list = await this.must(ctx, { method: 'GET', path: '/v1/refunds', query: [['payment_intent', pi], ['limit', '100']] });
    const data = Array.isArray(list.data) ? list.data.filter(isObj) : [];
    const hit = data.find((x) => isObj(x.metadata) && x.metadata.mt_idempotency_key === by.idempotencyKey);
    return hit ? refundToProvider(hit) : null;
  }

  /** Task 4.5: a dispute as Stripe holds it now (GET /v1/disputes/:id); null if Stripe does not know it. */
  async retrieveDispute(ctx: ProviderContext, ref: string): Promise<ProviderDispute | null> {
    this.key(ctx);
    const r = await this.call(ctx, { method: 'GET', path: `/v1/disputes/${encodeURIComponent(ref)}` });
    if (!r.ok) {
      if (r.error !== 'idempotency_error' && r.error.code === 'provider_not_found') return null;
      throw r.error === 'idempotency_error' ? new ProviderError('provider_rejected', false) : new ProviderError(r.error.code, r.error.retryable);
    }
    const dispute = disputeToProvider(r.body);
    if (!dispute) throw new ProviderError('provider_unavailable', true);
    return dispute;
  }

  verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification {
    let parsed: unknown;
    let claimedEventId: string | undefined;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
      const id = isObj(parsed) ? parsed.id : undefined;
      if (typeof id === 'string' && /^[A-Za-z0-9_]{1,255}$/.test(id)) claimedEventId = id;
    } catch {
      parsed = undefined;
    }
    const claimed = claimedEventId ? { claimedEventId } : {};
    const sig = verifyStripeSignature(headers[STRIPE_SIGNATURE_HEADER], rawBody, ctx.webhookSecret, now);
    if (!sig.ok) return { ok: false, code: sig.code, ...claimed };
    // An event of the other mode is not this account's (a test endpoint never takes a live event).
    if (!isObj(parsed) || parsed.livemode !== (ctx.mode === 'live')) return { ok: false, code: 'malformed', ...claimed };
    const event = parseStripeEvent(parsed);
    return event ? { ok: true, event } : { ok: false, code: 'malformed', ...claimed };
  }

  parseEvent(rawBody: Buffer): NormalisedEvent | null {
    try {
      return parseStripeEvent(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return null;
    }
  }
}

/** The parameters of a Checkout Session: all derived from the attempt row, the same on every retry of its key. */
export function sessionParams(input: CreatePaymentInput): Array<[string, string]> {
  const meta: Array<[string, string]> = [['mt_payment_id', input.metadata.paymentId], ['mt_booking_id', input.metadata.bookingId], ['mt_idempotency_key', input.idempotencyKey]];
  return [
    ['mode', 'payment'],
    ['line_items[0][quantity]', '1'],
    ['line_items[0][price_data][currency]', input.amount.currency.toLowerCase()],
    ['line_items[0][price_data][unit_amount]', input.amount.amountMinor.toString()],
    ['line_items[0][price_data][product_data][name]', 'Booking payment'],
    ['payment_method_types[0]', 'card'],
    ['success_url', input.returnUrl],
    ['cancel_url', input.returnUrl],
    ['client_reference_id', input.metadata.paymentId],
    ['expires_at', String(Math.floor(input.createdAt.getTime() / 1000) + SESSION_LIFETIME_SECONDS)],
    ...meta.map(([k, v]): [string, string] => [`metadata[${k}]`, v]),
    ...meta.map(([k, v]): [string, string] => [`payment_intent_data[metadata][${k}]`, v]),
  ];
}
