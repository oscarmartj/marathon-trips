// The PayPal adapter (plan docs/plans/4.3-paypal-adapter.md): Orders v2 on PayPal's hosted approval page, capture only
// when the core asks (completePayment), refunds, and webhooks verified offline with PayPal's certificate. `experimental`:
// written from PayPal's documentation and proven only against the fake of test/contract/subjects/paypal-fake.ts until
// `test:sandbox` runs with Oscar's sandbox app. Test mode talks only to api-m.sandbox.paypal.com; it reads no
// environment and never logs.
import type { PaymentMethod } from '@mt/shared';
import {
  AdapterManifest, CreatePaymentInput, CreateRefundInput, NormalisedEvent, PaymentLookup, PaymentModeName, PaymentProvider, ProviderContext,
  ProviderError, ProviderPayment, ProviderRefund, RefundLookup, WebhookVerification,
} from '../../core/provider';
import {
  CAPTURE_REF, PAYER_RETRY_ISSUES, PAYPAL_ID, REQUIRED_EVENT_TYPES, captureOrderId, customId, isObj, keyDigest, orderToPayment, parseMarker,
  parsePayPalEvent, paypalError, paypalIssue, purchaseUnit, refundToProvider,
} from './mapping';
import type { PayPalIssue } from './mapping';
import { TWO_DECIMAL_CURRENCIES, fromPayPalValue, toPayPalValue } from './money';
import { CertificateStore, PAYPAL_HEADERS, defaultTrust, verifyPayPalSignature, worthPreparing } from './webhook';
import type { CertificateTrust } from './webhook';

export const PAYPAL_KEY = 'paypal';
/** Fixed in code by mode (plan 4): no option or variable changes them. */
export const PAYPAL_API_BASE: Record<PaymentModeName, string> = { test: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };
/** The approval page origin of the sandbox (plan D8: live needs a mode-aware origin first). */
export const PAYPAL_CHECKOUT_ORIGIN = 'https://www.sandbox.paypal.com';
const CREDENTIAL = /^(?!(?:sk|rk|pk|whsec)_)[A-Za-z0-9_-]{20,128}$/;
const WEBHOOK_ID = /^[A-Z0-9]{10,32}$/;
const REFUND_LOOKUP_MAX = 20;
const FETCH_TIMEOUT_MS = 4_500;
const RESPONSE_MAX_BYTES = 1024 * 1024;

export interface PayPalRequest {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface PayPalResponse {
  status: number;
  body: string;
}
/** One HTTP exchange with PayPal. Tests inject the fake; the API always uses fetch to the host of the context's mode. */
export type PayPalTransport = (req: PayPalRequest) => Promise<PayPalResponse>;

export const fetchTransport: PayPalTransport = async (req) => {
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
  } catch (err) {
    throw new ProviderError((err as { name?: string })?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable', true);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > RESPONSE_MAX_BYTES) throw new ProviderError('provider_unavailable', true);
  return { status: res.status, body: buf.toString('utf8') };
};

/** Filler for the descriptor's samples (plan 3): shapes only, never a credential. */
const fill = (n: number) => 'x'.repeat(n);

export function paypalManifest(): AdapterManifest {
  return {
    key: PAYPAL_KEY,
    displayName: 'PayPal',
    status: 'experimental',
    testOnly: false,
    cardDataHandling: 'hosted_only',
    // Plan D1: PayPal's page takes the wallet and cards as a guest; a `paypal` method would be an irreversible enum value.
    methods: ['card'] satisfies PaymentMethod[],
    currencies: ['AUD'],
    countries: 'any',
    checkoutOrigin: PAYPAL_CHECKOUT_ORIGIN,
    // Plan 3: no test or live marker exists in PayPal credentials; a test account only ever calls the sandbox host,
    // where a live credential fails. The webhook ID binds deliveries to our subscription and is entered after creation.
    account: {
      fields: [
        {
          key: 'clientId', label: 'Client ID (PayPal sandbox REST app)', pattern: CREDENTIAL.source,
          samples: { valid: `A${fill(79)}`, rejected: [`sk_live_${fill(24)}`, `sk_test_${fill(24)}`, `pk_test_${fill(24)}`, `whsec_${fill(24)}`, fill(19), `A${fill(30)} x`, `A${fill(30)}.x`, `A${fill(30)}=`, `A${fill(30)}:x`] },
        },
        {
          key: 'clientSecret', label: 'Secret (PayPal sandbox REST app)', pattern: CREDENTIAL.source,
          samples: { valid: `E${fill(79)}`, rejected: [`sk_live_${fill(24)}`, `whsec_${fill(24)}`, fill(19), `E${fill(30)} x`, `E${fill(30)}.x`] },
        },
      ],
      webhookSecret: {
        source: 'entered', label: 'Webhook ID (from the sandbox app webhook settings)', pattern: WEBHOOK_ID.source,
        samples: { valid: 'X'.repeat(17), rejected: ['x'.repeat(17), 'X'.repeat(9), 'X'.repeat(33), `WH-${'X'.repeat(17)}`] },
      },
    },
    capabilities: { refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'stays_payable' },
  };
}

export interface PayPalOptions {
  /** Only tests pass one (the fake). */
  transport?: PayPalTransport;
  /** Only tests pass one. */
  now?: () => Date;
  /** Only tests pass one: the fake's CA and certificate download. */
  certificates?: CertificateTrust;
}

type Obj = Record<string, unknown>;
type Answer = { ok: true; status: number; body: Obj } | { ok: false; status: number; issue: PayPalIssue | undefined };

export class PayPalProvider implements PaymentProvider {
  readonly manifest = paypalManifest();
  readonly signatureHeaders = [PAYPAL_HEADERS.transmissionSig] as const;
  private readonly transport: PayPalTransport;
  private readonly now: () => Date;
  /** Public signing certificates only (plan 7.3). */
  readonly certificates: CertificateStore;

  constructor(opts: PayPalOptions = {}) {
    this.transport = opts.transport ?? fetchTransport;
    this.now = opts.now ?? (() => new Date());
    this.certificates = new CertificateStore(opts.certificates ?? defaultTrust(), this.now);
  }

  // ---- HTTP ----

  private credentials(ctx: ProviderContext): { id: string; secret: string } {
    const id = ctx.credentials.clientId ?? '';
    const secret = ctx.credentials.clientSecret ?? '';
    if (!CREDENTIAL.test(id) || !CREDENTIAL.test(secret)) throw new ProviderError('provider_auth_failed', false);
    return { id, secret };
  }

  private async exchange(req: PayPalRequest): Promise<{ status: number; body: unknown }> {
    let res: PayPalResponse;
    try {
      res = await this.transport(req);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('provider_unavailable', true);
    }
    let body: unknown;
    try {
      body = res.body === '' ? {} : JSON.parse(res.body);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }

  /** A bearer token for this one operation (plan D7: no cache). */
  private async token(ctx: ProviderContext): Promise<string> {
    const { id, secret } = this.credentials(ctx);
    const r = await this.exchange({
      method: 'POST', url: `${PAYPAL_API_BASE[ctx.mode]}/v1/oauth2/token`, body: 'grant_type=client_credentials',
      headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    });
    if (r.status >= 200 && r.status < 300) {
      const t = isObj(r.body) ? r.body.access_token : undefined;
      if (typeof t !== 'string' || t.length === 0 || t.length > 4096) throw new ProviderError('provider_unavailable', true);
      return t;
    }
    const e = paypalError(r.status, paypalIssue(r.body));
    // A refused token is always a credentials problem, whatever the status.
    if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new ProviderError('provider_auth_failed', false);
    throw new ProviderError(e.code, e.retryable);
  }

  private async api(ctx: ProviderContext, token: string, method: PayPalRequest['method'], path: string, opts: { body?: unknown; requestId?: string } = {}): Promise<Answer> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', prefer: 'return=representation' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.requestId) headers['paypal-request-id'] = opts.requestId;
    const r = await this.exchange({ method, url: `${PAYPAL_API_BASE[ctx.mode]}${path}`, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    if (r.status >= 200 && r.status < 300) {
      if (r.status === 204) return { ok: true, status: r.status, body: {} };
      if (!isObj(r.body)) throw new ProviderError('provider_unavailable', true);
      return { ok: true, status: r.status, body: r.body };
    }
    return { ok: false, status: r.status, issue: paypalIssue(r.body) };
  }

  private fail(a: Extract<Answer, { ok: false }>): never {
    const e = paypalError(a.status, a.issue);
    throw new ProviderError(e.code, e.retryable);
  }

  private toPayment(o: unknown): ProviderPayment {
    const p = orderToPayment(o, this.manifest.checkoutOrigin);
    if (!p) throw new ProviderError('provider_unavailable', true);
    return p;
  }

  /** The order, or null when PayPal does not know it (404). */
  private async getOrder(ctx: ProviderContext, token: string, id: string): Promise<Obj | null> {
    const r = await this.api(ctx, token, 'GET', `/v2/checkout/orders/${id}`);
    if (r.ok) return r.body;
    if (r.status === 404) return null;
    return this.fail(r);
  }

  /** The order a `capture:` reference belongs to, or null. */
  private async orderOfCapture(ctx: ProviderContext, token: string, captureId: string): Promise<Obj | null> {
    const r = await this.api(ctx, token, 'GET', `/v2/payments/captures/${captureId}`);
    if (!r.ok) {
      if (r.status === 404) return null;
      return this.fail(r);
    }
    const orderId = captureOrderId(r.body);
    if (!orderId) throw new ProviderError('provider_unavailable', true);
    return this.getOrder(ctx, token, orderId);
  }

  /** The order a payment reference names (an order ID or `capture:<id>`), or null; malformed refs never reach a URL. */
  private async orderOfRef(ctx: ProviderContext, token: string, ref: string): Promise<Obj | null> {
    const cap = CAPTURE_REF.exec(ref);
    if (cap) return this.orderOfCapture(ctx, token, cap[1]!);
    return PAYPAL_ID.test(ref) ? this.getOrder(ctx, token, ref) : null;
  }

  // ---- PaymentProvider ----

  async testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }> {
    try {
      const token = await this.token(ctx);
      if (ctx.webhookSecret.length === 0) return { ok: false, code: 'webhook_secret_missing' };
      if (!WEBHOOK_ID.test(ctx.webhookSecret)) return { ok: false, code: 'provider_rejected' };
      const r = await this.api(ctx, token, 'GET', `/v1/notifications/webhooks/${ctx.webhookSecret}`);
      if (!r.ok) return { ok: false, code: r.status === 404 ? 'provider_rejected' : paypalError(r.status, r.issue).code };
      const names = Array.isArray(r.body.event_types) ? r.body.event_types.filter(isObj).map((e) => e.name) : [];
      const all = names.includes('*') || REQUIRED_EVENT_TYPES.every((t) => names.includes(t));
      return all ? { ok: true } : { ok: false, code: 'provider_rejected' };
    } catch (err) {
      return { ok: false, code: err instanceof ProviderError ? err.code : 'provider_unavailable' };
    }
  }

  async createPayment(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment> {
    this.credentials(ctx);
    const body = orderBody(input);
    if (!body) throw new ProviderError('provider_rejected', false);
    const token = await this.token(ctx);
    const r = await this.api(ctx, token, 'POST', '/v2/checkout/orders', { body, requestId: input.idempotencyKey });
    if (!r.ok) return this.fail(r);
    const p = this.toPayment(r.body);
    if (p.status === 'requires_action' && !p.nextAction) throw new ProviderError('provider_unavailable', true);
    return p;
  }

  async retrievePayment(ctx: ProviderContext, by: PaymentLookup): Promise<ProviderPayment | null> {
    const token = await this.token(ctx);
    if ('ref' in by) {
      const o = await this.orderOfRef(ctx, token, by.ref);
      return o ? this.toPayment(o) : null;
    }
    return this.probe(ctx, token, by.idempotencyKey);
  }

  /**
   * Lookup by key (plan 5.5): the create replayed under our key with a body PayPal must refuse if it processed it, so
   * no order is ever created. Only a schema refusal is "none"; anything uncertain is retryable.
   */
  private async probe(ctx: ProviderContext, token: string, key: string): Promise<ProviderPayment | null> {
    const r = await this.api(ctx, token, 'POST', '/v2/checkout/orders', { body: { intent: 'CAPTURE', purchase_units: [] }, requestId: key });
    if (r.ok) {
      const unit = purchaseUnit(r.body)?.unit;
      const marker = parseMarker(unit?.custom_id);
      if (!marker || marker.kind === 'r' || marker.digest !== keyDigest(key)) throw new ProviderError('provider_unavailable', true);
      return this.toPayment(r.body);
    }
    if (r.status === 400 && r.issue !== 'invalid_client') return null;
    if (r.status === 404) return null;
    const e = paypalError(r.status, r.issue);
    // A refusal we cannot read as "none" is never "none".
    throw new ProviderError(e.code === 'provider_rejected' ? 'provider_unavailable' : e.code, e.code === 'provider_rejected' ? true : e.retryable);
  }

  /**
   * Captures an order the payer approved (plan 5.3). Called by the core only for a live attempt of a payable booking on
   * an active account. A cancelled order (our marker) is never captured.
   */
  async completePayment(ctx: ProviderContext, ref: string, _idempotencyKey: string): Promise<ProviderPayment> {
    const token = await this.token(ctx);
    if (!PAYPAL_ID.test(ref)) throw new ProviderError('provider_not_found', false);
    const o = await this.getOrder(ctx, token, ref);
    if (!o) throw new ProviderError('provider_not_found', false);
    const marker = parseMarker(purchaseUnit(o)?.unit.custom_id);
    if (o.status !== 'APPROVED' || marker?.kind !== 'o') return this.toPayment(o);
    const stamp = keyDigest(`update_time:${typeof o.update_time === 'string' ? o.update_time : ''}`).slice(0, 16);
    const r = await this.api(ctx, token, 'POST', `/v2/checkout/orders/${ref}/capture`, { body: {}, requestId: `mt-capture:${ref}:${stamp}` });
    if (r.ok) {
      const p = orderToPayment(r.body, this.manifest.checkoutOrigin);
      if (p) return p;
      const again = await this.getOrder(ctx, token, ref);
      if (!again) throw new ProviderError('provider_unavailable', true);
      return this.toPayment(again);
    }
    if (r.status === 422 && (r.issue === 'ORDER_ALREADY_CAPTURED' || (r.issue && PAYER_RETRY_ISSUES.includes(r.issue)))) {
      const again = await this.getOrder(ctx, token, ref);
      if (!again) throw new ProviderError('provider_unavailable', true);
      const p = this.toPayment(again);
      // PayPal says it is captured but the read is late: never let the core treat it as unpaid (and cancel it).
      if (r.issue === 'ORDER_ALREADY_CAPTURED' && p.status === 'requires_action') throw new ProviderError('provider_unavailable', true);
      if (p.status === 'requires_action') return { ...p, failureCode: r.issue!.toLowerCase() };
      return p;
    }
    return this.fail(r);
  }

  /** Plan 5.4: anything not COMPLETED is cancelled (nobody will capture it); the marker is written where PayPal allows. */
  async cancelPayment(ctx: ProviderContext, ref: string, _idempotencyKey: string): Promise<ProviderPayment> {
    const token = await this.token(ctx);
    if (!PAYPAL_ID.test(ref)) throw new ProviderError('provider_not_found', false);
    const o = await this.getOrder(ctx, token, ref);
    if (!o) throw new ProviderError('provider_not_found', false);
    if (o.status === 'COMPLETED') return this.toPayment(o);
    const marker = parseMarker(purchaseUnit(o)?.unit.custom_id);
    if ((o.status === 'CREATED' || o.status === 'APPROVED') && marker?.kind === 'o') {
      const patch = [{ op: 'replace', path: "/purchase_units/@reference_id=='default'/custom_id", value: `mt1:c:${marker.ourId}:${marker.digest}` }];
      const r = await this.api(ctx, token, 'PATCH', `/v2/checkout/orders/${ref}`, { body: patch });
      if (!r.ok && r.status === 401) this.fail(r);
      // The marker did not land on an order PayPal allows to patch: it may be captured by now and the read be late.
      // Never say "cancelled" then; the next try reads it again.
      if (!r.ok) throw new ProviderError('provider_unavailable', true);
    }
    const now = await this.getOrder(ctx, token, ref);
    if (!now) throw new ProviderError('provider_not_found', false);
    const p = this.toPayment(now);
    if (p.status === 'succeeded' || p.status === 'pending' || p.status === 'failed') return p;
    return { ref: p.ref, status: 'cancelled', amount: p.amount, ...(p.ourPaymentId ? { ourPaymentId: p.ourPaymentId } : {}) };
  }

  async createRefund(ctx: ProviderContext, input: CreateRefundInput): Promise<ProviderRefund> {
    const token = await this.token(ctx);
    const o = await this.orderOfRef(ctx, token, input.paymentRef);
    if (!o) throw new ProviderError('provider_not_found', false);
    const payment = this.toPayment(o);
    const pu = purchaseUnit(o)!;
    const capture = pu.captures.find((c) => c.status === 'COMPLETED' || c.status === 'PARTIALLY_REFUNDED' || c.status === 'REFUNDED');
    const captureId = capture && typeof capture.id === 'string' && PAYPAL_ID.test(capture.id) ? capture.id : undefined;
    if (payment.status !== 'succeeded' || !capture || !captureId || input.amount.currency !== payment.amount.currency || input.amount.amountMinor <= 0n) throw new ProviderError('provider_rejected', false);
    const captured = isObj(capture.amount) ? fromPayPalValue(capture.amount.value, capture.amount.currency_code) : null;
    if (captured === null) throw new ProviderError('provider_unavailable', true);
    let refunded = 0n;
    for (const rf of pu.refunds) {
      if (rf.status !== 'COMPLETED' && rf.status !== 'PENDING') continue;
      const v = isObj(rf.amount) ? fromPayPalValue(rf.amount.value, rf.amount.currency_code) : null;
      if (v === null) throw new ProviderError('provider_unavailable', true);
      refunded += v;
    }
    const value = toPayPalValue(input.amount.amountMinor, input.amount.currency);
    if (!value || input.amount.amountMinor > captured - refunded) {
      // A retry of a refund already made under this key is that refund, not a refusal.
      const done = await this.refundByKey(ctx, token, o, input.idempotencyKey);
      if (done) return done;
      throw new ProviderError('provider_rejected', false);
    }
    const body = { amount: { currency_code: input.amount.currency, value }, custom_id: customId('r', input.metadata.refundId, input.idempotencyKey) };
    const r = await this.api(ctx, token, 'POST', `/v2/payments/captures/${captureId}/refund`, { body, requestId: input.idempotencyKey });
    if (!r.ok) return this.fail(r);
    const refund = refundToProvider(r.body, captureId);
    if (!refund) throw new ProviderError('provider_unavailable', true);
    return refund;
  }

  async retrieveRefund(ctx: ProviderContext, by: RefundLookup): Promise<ProviderRefund | null> {
    const token = await this.token(ctx);
    if ('ref' in by) return PAYPAL_ID.test(by.ref) ? this.getRefund(ctx, token, by.ref) : null;
    const o = await this.orderOfRef(ctx, token, by.paymentRef);
    return o ? this.refundByKey(ctx, token, o, by.idempotencyKey) : null;
  }

  /** The refund of this order made under our key (its custom_id digest), or null; more than 20 refunds is "unknown". */
  private async refundByKey(ctx: ProviderContext, token: string, o: Obj, idempotencyKey: string): Promise<ProviderRefund | null> {
    const refunds = purchaseUnit(o)?.refunds ?? [];
    if (refunds.length > REFUND_LOOKUP_MAX) throw new ProviderError('provider_unavailable', true);
    const digest = keyDigest(idempotencyKey);
    for (const rf of refunds) {
      const id = typeof rf.id === 'string' && PAYPAL_ID.test(rf.id) ? rf.id : undefined;
      if (!id) throw new ProviderError('provider_unavailable', true);
      const r = await this.api(ctx, token, 'GET', `/v2/payments/refunds/${id}`);
      if (!r.ok) {
        if (r.status === 404) continue;
        return this.fail(r);
      }
      const marker = parseMarker(r.body.custom_id);
      if (marker?.kind !== 'r' || marker.digest !== digest) continue;
      const refund = refundToProvider(r.body);
      if (!refund) throw new ProviderError('provider_unavailable', true);
      return refund;
    }
    return null;
  }

  private async getRefund(ctx: ProviderContext, token: string, id: string): Promise<ProviderRefund | null> {
    const r = await this.api(ctx, token, 'GET', `/v2/payments/refunds/${id}`);
    if (!r.ok) {
      if (r.status === 404) return null;
      return this.fail(r);
    }
    const refund = refundToProvider(r.body);
    if (!refund) throw new ProviderError('provider_unavailable', true);
    return refund;
  }

  /** Plan 7.3: fetches PayPal's signing certificate for this delivery before verifyWebhook. Never throws. */
  async prepareWebhook(ctx: ProviderContext, headers: Readonly<Record<string, string>>): Promise<void> {
    try {
      if (!worthPreparing(ctx.mode, headers, this.now())) return;
      await this.certificates.prepare(headers[PAYPAL_HEADERS.certUrl], ctx.mode);
    } catch {
      // Verification then fails closed.
    }
  }

  verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification {
    let parsed: unknown;
    let claimedEventId: string | undefined;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
      const id = isObj(parsed) ? parsed.id : undefined;
      if (typeof id === 'string' && /^WH-[A-Za-z0-9-]{1,100}$/.test(id)) claimedEventId = id;
    } catch {
      parsed = undefined;
    }
    const claimed = claimedEventId ? { claimedEventId } : {};
    let sig: ReturnType<typeof verifyPayPalSignature>;
    try {
      sig = verifyPayPalSignature(this.certificates, ctx.mode, ctx.webhookSecret, rawBody, headers, now);
    } catch {
      sig = { ok: false, code: 'bad_signature' };
    }
    if (!sig.ok) return { ok: false, code: sig.code, ...claimed };
    const event = parsePayPalEvent(parsed, this.manifest.checkoutOrigin);
    return event ? { ok: true, event } : { ok: false, code: 'malformed', ...claimed };
  }

  parseEvent(rawBody: Buffer): NormalisedEvent | null {
    try {
      return parsePayPalEvent(JSON.parse(rawBody.toString('utf8')), this.manifest.checkoutOrigin);
    } catch {
      return null;
    }
  }
}

/** The create body (plan 5.2): all from the attempt row, byte-identical on every retry of its key. Null if refused. */
export function orderBody(input: CreatePaymentInput): Obj | null {
  if (!TWO_DECIMAL_CURRENCIES.includes(input.amount.currency)) return null;
  const value = toPayPalValue(input.amount.amountMinor, input.amount.currency);
  if (!value) return null;
  return {
    intent: 'CAPTURE',
    purchase_units: [{ custom_id: customId('o', input.metadata.paymentId, input.idempotencyKey), description: 'Booking payment', amount: { currency_code: input.amount.currency, value } }],
    application_context: { return_url: input.returnUrl, cancel_url: input.returnUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', locale: 'en-AU' },
  };
}
