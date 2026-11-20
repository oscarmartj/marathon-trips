// The Pin Payments adapter (plan docs/plans/4.4-au-card-gateway.md): charges of card tokens from Pin's hosted fields
// with 3-D Secure always on, refunds, and webhooks signed with the endpoint's key. It implements the narrow
// CardTokenGateway; the core's CardSessionProvider keeps the state before a card is submitted and is what the registry
// holds. `experimental`: written from Pin's documentation and proven only against the fake of
// test/contract/subjects/pin-fake.ts until `test:sandbox` runs. Test mode talks only to test-api.pinpayments.com; it
// reads no environment and never logs.
import { timingSafeEqual } from 'node:crypto';
import { PIN_CARD_FIELDS } from '@mt/shared';
import type { PaymentMethod } from '@mt/shared';
import {
  AdapterManifest, CardChargeOutcome, CardChargeRequest, CardTokenGateway, GatewayCharge, GatewayRefund, GatewayRefundOutcome, Money, NormalisedEvent,
  PaymentModeName, ProviderContext, ProviderError, WebhookVerification,
} from '../../core/provider';
import { CHARGE_TOKEN, META_PAYMENT, META_SESSION, REFUND_TOKEN, SESSION_TOKEN, amountForPin, chargeOf, declineCodeOf, isObj, minorOf, parsePinEvent, pinError, refundOf, responseOf } from './mapping';
import { PIN_SIGNATURE_HEADER, verifyPinWebhook } from './webhook';

export const PIN_KEY = 'pin_payments';
/** Fixed in code by mode (plan 4.4, section 5.3): no option or variable changes them. */
export const PIN_API_BASE: Record<PaymentModeName, string> = { test: 'https://test-api.pinpayments.com/1', live: 'https://api.pinpayments.com/1' };
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const WEBHOOK_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const FETCH_TIMEOUT_MS = 4_500;
/** "May be a long-running request" (Pin): still inside the gateway wrapper's 10 s. */
const CHARGE_TIMEOUT_MS = 8_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_AMOUNT = 999_999_999n;
/** A search that does not fit one page is "unknown", never "none" (plan 4.4, section 6.3 step 5). */
const PAGE_SIZE = 25;

export interface PinRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface PinResponse {
  status: number;
  body: string;
}
/** One HTTP exchange with Pin. Tests inject the fake; the API always uses fetch to the host of the context's mode. */
export type PinTransport = (req: PinRequest) => Promise<PinResponse>;

export const fetchTransport: PinTransport = async (req) => {
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs), redirect: 'error' });
  } catch (err) {
    throw new ProviderError((err as { name?: string })?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable', true);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > RESPONSE_MAX_BYTES) throw new ProviderError('provider_unavailable', true);
  return { status: res.status, body: buf.toString('utf8') };
};

const fill = (n: number) => 'x'.repeat(n);

export function pinManifest(): AdapterManifest {
  return {
    key: PIN_KEY,
    displayName: 'Pin Payments',
    status: 'experimental',
    testOnly: false,
    cardDataHandling: 'hosted_only',
    // Plan D13: Apple Pay and Google Pay through Pin need domain verification first.
    methods: ['card'] satisfies PaymentMethod[],
    currencies: ['AUD'],
    countries: 'any',
    // The card page is ours: CardSessionProvider replaces this with WEB_ORIGIN. Here, the origin of Pin's fields.
    checkoutOrigin: PIN_CARD_FIELDS.frameOrigins[0],
    cardFields: { driver: 'pin_hosted_fields', scriptUrl: PIN_CARD_FIELDS.scriptUrl, frameOrigins: [...PIN_CARD_FIELDS.frameOrigins], challengeOrigins: { test: [...PIN_CARD_FIELDS.challengeOrigins.test], live: [] } },
    // Plan 5.2: Pin keys carry no documented test or live marker; a test account only ever calls the test host (A4).
    account: {
      fields: [
        {
          key: 'secretKey', label: 'Secret API key (Pin Payments test account)', pattern: KEY.source,
          samples: { valid: `s${fill(31)}`, rejected: [fill(15), fill(129), `${fill(20)} x`, `${fill(20)}.x`, `${fill(20)}:x`, `${fill(20)}=`] },
        },
        {
          key: 'publishableKey', label: 'Publishable API key (Pin Payments test account)', pattern: KEY.source, exposure: 'card_page',
          samples: { valid: `p${fill(31)}`, rejected: [fill(15), fill(129), `${fill(20)} x`, `${fill(20)}.x`] },
        },
      ],
      webhookSecret: {
        source: 'entered', label: 'Signing key of the Pin webhook endpoint', pattern: WEBHOOK_KEY.source,
        samples: { valid: 'K'.repeat(22), rejected: ['K'.repeat(15), 'K'.repeat(65), `${'K'.repeat(20)} x`, `${'K'.repeat(20)}.x`] },
      },
    },
    // Plan D7: one charge per session, so a decline ends it. No disputes, reconciliation or fees in 4.4 (section 9).
    capabilities: { refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'failed' },
  };
}

export interface PinOptions {
  /** Only tests pass one (the fake). */
  transport?: PinTransport;
}

type Answer = { status: number; body: unknown };

export class PinPaymentsGateway implements CardTokenGateway {
  readonly manifest = pinManifest();
  readonly signatureHeaders = [PIN_SIGNATURE_HEADER] as const;
  /** Task 9.1: Pin's charge starts 3-D Secure (plan 4.4, section 6.4), as before. */
  readonly authentication = 'after_charge' as const;
  readonly chargeRefPattern = CHARGE_TOKEN;
  readonly refundRefPattern = REFUND_TOKEN;
  /** Pin documents no refund metadata (A9). */
  readonly refundEventsCarryOurId = false;
  private readonly transport: PinTransport;

  constructor(opts: PinOptions = {}) {
    this.transport = opts.transport ?? fetchTransport;
  }

  // ---- HTTP ----

  private secretKey(ctx: ProviderContext): string {
    const key = ctx.credentials.secretKey ?? '';
    if (!KEY.test(key)) throw new ProviderError('provider_auth_failed', false);
    return key;
  }

  private async exchange(ctx: ProviderContext, method: PinRequest['method'], path: string, body?: unknown, timeoutMs = FETCH_TIMEOUT_MS): Promise<Answer> {
    const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`${this.secretKey(ctx)}:`).toString('base64')}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: PinResponse;
    try {
      res = await this.transport({ method, url: `${PIN_API_BASE[ctx.mode]}${path}`, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('provider_unavailable', true);
    }
    let parsed: unknown;
    try {
      parsed = res.body === '' ? {} : JSON.parse(res.body);
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  }

  /** The error of a non-success answer, from the status only (plan 4.4, section 5.3). 404 is the caller's. */
  private fail(status: number): never {
    if (status === 401 || status === 403) throw new ProviderError('provider_auth_failed', false);
    if (status === 429 || status === 409) throw new ProviderError('provider_busy', true);
    if (status >= 500 || status < 400) throw new ProviderError('provider_unavailable', true);
    throw new ProviderError('provider_rejected', false);
  }

  /** A success answer's object; an unreadable one is "unknown" (retryable). */
  private ok(a: Answer): unknown {
    const v = responseOf(a.body);
    if (v === undefined) throw new ProviderError('provider_unavailable', true);
    return v;
  }

  private async get(ctx: ProviderContext, path: string): Promise<unknown | null> {
    const a = await this.exchange(ctx, 'GET', path);
    if (a.status >= 200 && a.status < 300) return this.ok(a);
    if (a.status === 404) return null;
    return this.fail(a.status);
  }

  /** A charge we can read; a state we cannot read is "unknown" (retryable), never a decline (review M1). */
  private static charge(v: unknown): GatewayCharge {
    const c = chargeOf(v);
    if (!c || c.unknown) throw new ProviderError('provider_unavailable', true);
    const { unknown: _unknown, ...charge } = c;
    return charge;
  }

  // ---- CardTokenGateway ----

  async probe(ctx: ProviderContext): Promise<void> {
    const a = await this.exchange(ctx, 'GET', '/balance');
    if (a.status >= 200 && a.status < 300) return;
    this.fail(a.status === 404 ? 503 : a.status);
  }

  async testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }> {
    try {
      await this.probe(ctx);
      if (ctx.webhookSecret.length === 0) return { ok: false, code: 'webhook_secret_missing' };
      if (!WEBHOOK_KEY.test(ctx.webhookSecret)) return { ok: false, code: 'provider_rejected' };
      const list = await this.get(ctx, '/webhook_endpoints');
      if (!Array.isArray(list) || list.length > 5) return { ok: false, code: 'provider_unavailable' };
      const mine = Buffer.from(ctx.webhookSecret);
      let found = false;
      for (const e of list) {
        const key = isObj(e) && typeof e.key === 'string' ? Buffer.from(e.key) : undefined;
        if (key && key.length === mine.length && timingSafeEqual(key, mine)) found = true;
      }
      return found ? { ok: true } : { ok: false, code: 'provider_rejected' };
    } catch (err) {
      return { ok: false, code: err instanceof ProviderError ? err.code : 'provider_unavailable' };
    }
  }

  async charge(ctx: ProviderContext, req: CardChargeRequest): Promise<CardChargeOutcome> {
    const { amountMinor, currency } = req.amount;
    if (currency !== 'AUD' || amountMinor < 1n || amountMinor > MAX_AMOUNT) return { kind: 'refused', code: 'provider_rejected' };
    const body = {
      amount: amountForPin(amountMinor), currency, description: 'Booking payment', email: req.payer.email, ip_address: req.payer.ipAddress,
      card_token: req.cardToken, capture: true, metadata: { [META_SESSION]: req.sessionRef, [META_PAYMENT]: req.paymentId },
      // Plan D6: 3-D Secure always, no fallback for cards that are not enrolled (A15).
      three_d_secure: { enabled: true, fallback_ok: false, callback_url: req.callbackUrl },
    };
    const a = await this.exchange(ctx, 'POST', '/charges', body, CHARGE_TIMEOUT_MS);
    if (a.status === 201 || a.status === 200) {
      const c = PinPaymentsGateway.charge(this.ok(a));
      if (c.success && c.captured) return { kind: 'charged', charge: c };
      if (c.failed) return { kind: 'declined', code: c.failureCode ?? 'card_declined', chargeToken: c.token };
      return { kind: 'challenge', charge: c };
    }
    if (a.status === 202) {
      const v = this.ok(a);
      const c = PinPaymentsGateway.charge(v);
      const url = isObj(v) && typeof v.redirect_url === 'string' && v.redirect_url.length <= 2048 ? v.redirect_url : undefined;
      return { kind: 'challenge', charge: c, ...(url ? { redirectUrl: url } : {}) };
    }
    const { error, chargeToken } = pinError(a.body);
    if (a.status === 400) {
      const code = declineCodeOf(error);
      if (code) return { kind: 'declined', code, ...(chargeToken ? { chargeToken } : {}) };
      return { kind: 'refused', code: 'provider_rejected' };
    }
    if (a.status === 422) {
      const code = declineCodeOf(error);
      return code ? { kind: 'declined', code } : { kind: 'refused', code: 'provider_rejected' };
    }
    if (a.status === 401 || a.status === 403) return { kind: 'refused', code: 'provider_auth_failed' };
    // A18: a 429 was not processed. 409, 5xx and anything else: the charge may exist.
    if (a.status === 429) return { kind: 'refused', code: 'provider_busy' };
    throw new ProviderError(a.status >= 500 ? 'provider_unavailable' : 'provider_busy', true);
  }

  async verifyAuthentication(ctx: ProviderContext, sessionToken: string): Promise<GatewayCharge | null> {
    if (!SESSION_TOKEN.test(sessionToken)) return null;
    const a = await this.exchange(ctx, 'GET', `/charges/verify?session_token=${sessionToken}`);
    if (a.status >= 200 && a.status < 300) return PinPaymentsGateway.charge(this.ok(a));
    if (a.status === 403 || a.status === 404 || a.status === 422) return null;
    return this.fail(a.status);
  }

  async retrieveCharge(ctx: ProviderContext, token: string): Promise<GatewayCharge | null> {
    if (!CHARGE_TOKEN.test(token)) return null;
    const v = await this.get(ctx, `/charges/${token}`);
    return v === null ? null : PinPaymentsGateway.charge(v);
  }

  async chargesOfSession(ctx: ProviderContext, sessionRef: string): Promise<GatewayCharge[]> {
    const a = await this.exchange(ctx, 'GET', `/charges/search?query=${encodeURIComponent(sessionRef)}&per_page=${PAGE_SIZE}`);
    if (!(a.status >= 200 && a.status < 300)) return this.fail(a.status);
    const list = this.ok(a);
    const pagination = isObj(a.body) && isObj(a.body.pagination) ? a.body.pagination : {};
    if (!Array.isArray(list) || (typeof pagination.pages === 'number' && pagination.pages > 1)) throw new ProviderError('provider_unavailable', true);
    // The search matches any metadata value (and other fields): only an exact mt_session counts.
    // An unreadable charge of this session makes the answer "unknown", never "none" (review M1).
    return list.filter((v) => chargeOf(v)?.sessionRef === sessionRef).map((v) => PinPaymentsGateway.charge(v));
  }

  async refundState(ctx: ProviderContext, chargeToken: string): Promise<{ charge: GatewayCharge; refunded: bigint } | null> {
    if (!CHARGE_TOKEN.test(chargeToken)) return null;
    const v = await this.get(ctx, `/charges/${chargeToken}`);
    if (v === null) return null;
    const charge = PinPaymentsGateway.charge(v);
    const refunded = isObj(v) ? minorOf(v.amount_refunded) : undefined;
    if (refunded === undefined) throw new ProviderError('provider_unavailable', true);
    // Pending refunds count too: Pin's total may not include them yet (plan 4.4, section 7; counted twice at worst,
    // which only refuses a refund).
    const pending = (await this.listRefunds(ctx, chargeToken)).filter((r) => r.status === 'pending').reduce((s, r) => s + r.amount.amountMinor, 0n);
    return { charge, refunded: refunded + pending };
  }

  async createRefund(ctx: ProviderContext, chargeToken: string, amount: Money): Promise<GatewayRefundOutcome> {
    if (!CHARGE_TOKEN.test(chargeToken) || amount.amountMinor < 1n || amount.amountMinor > MAX_AMOUNT) return { kind: 'refused' };
    // Always the amount: the empty body would mean "everything".
    const a = await this.exchange(ctx, 'POST', `/charges/${chargeToken}/refunds`, { amount: amountForPin(amount.amountMinor) });
    if (a.status >= 200 && a.status < 300) {
      const r = refundOf(this.ok(a));
      if (!r) throw new ProviderError('provider_unavailable', true);
      return { kind: 'created', refund: r };
    }
    if (a.status === 429) return { kind: 'rate_limited' };
    if (a.status === 401 || a.status === 403) throw new ProviderError('provider_auth_failed', false);
    if (a.status === 400 || a.status === 402 || a.status === 404 || a.status === 422) return { kind: 'refused' };
    throw new ProviderError(a.status >= 500 ? 'provider_unavailable' : 'provider_busy', true);
  }

  async retrieveRefund(ctx: ProviderContext, token: string): Promise<GatewayRefund | null> {
    if (!REFUND_TOKEN.test(token)) return null;
    const v = await this.get(ctx, `/refunds/${token}`);
    if (v === null) return null;
    const r = refundOf(v);
    if (!r) throw new ProviderError('provider_unavailable', true);
    return r;
  }

  async listRefunds(ctx: ProviderContext, chargeToken: string): Promise<GatewayRefund[]> {
    if (!CHARGE_TOKEN.test(chargeToken)) return [];
    const a = await this.exchange(ctx, 'GET', `/charges/${chargeToken}/refunds?per_page=${PAGE_SIZE}`);
    if (a.status === 404) return [];
    if (!(a.status >= 200 && a.status < 300)) return this.fail(a.status);
    const list = this.ok(a);
    const pagination = isObj(a.body) && isObj(a.body.pagination) ? a.body.pagination : {};
    if (!Array.isArray(list) || (typeof pagination.pages === 'number' && pagination.pages > 1)) throw new ProviderError('provider_unavailable', true);
    const out: GatewayRefund[] = [];
    for (const v of list) {
      const r = refundOf(v);
      if (!r) throw new ProviderError('provider_unavailable', true);
      out.push(r);
    }
    return out;
  }

  verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification {
    return verifyPinWebhook(ctx.webhookSecret, rawBody, headers, now);
  }

  parseEvent(rawBody: Buffer): NormalisedEvent | null {
    try {
      return parsePinEvent(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return null;
    }
  }
}
