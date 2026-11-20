// The eWAY Rapid adapter (plan docs/plans/9.1-eway.md): eWAY Secure Fields on our own page, 3-D Secure 2 before the one
// charge (Direct Connection), refunds, and no events: eWAY sends nothing server to server, so every state is read
// (`gatewayEvents: 'none'`). It implements the narrow CardTokenGateway; the core's CardSessionProvider keeps the state
// before the charge and is what the registry holds. `experimental`, and it cannot become `verified` without
// reconciliation and disputes (registry, plan 20 M6). Everything eWAY-specific is UNVERIFIED (plan section 20): proven
// only against the fake of test/contract/subjects/eway-fake.ts. Test mode talks only to api.sandbox.ewaypayments.com;
// it reads no environment and never logs.
import { randomBytes } from 'node:crypto';
import { EWAY_CARD_FIELDS } from '@mt/shared';
import type { PaymentMethod } from '@mt/shared';
import {
  NOT_UNIQUE, ProviderError,
} from '../../core/provider';
import type {
  AdapterManifest, AuthenticationPayer, AuthenticationResult, AuthenticationStart, CardChargeOutcome, CardChargeRequest, CardTokenGateway, GatewayCharge, GatewayRefund,
  GatewayRefundOutcome, Money, NormalisedEvent, PaymentModeName, ProviderContext, WebhookVerification,
} from '../../core/provider';
import {
  ACCESS_CODE, CHARGE_REF, DUPLICATE, INTENT_INVOICE_REF, NOT_FOUND_ERRORS, NOT_UNIQUE_ERRORS, REFUND_REF, SECURE_FIELD_CODE, SESSION_INVOICE_REF, UNKNOWN_STATE,
  chargeOf, codesOf, declineOf, idOf, invoiceRefOf, isObj, minorOf, refundOf,
} from './mapping';

export const EWAY_KEY = 'eway';
/** Fixed in code by mode (plan 9.1, section 5.3): no option or variable changes them. */
export const EWAY_API_BASE: Record<PaymentModeName, string> = { test: 'https://api.sandbox.ewaypayments.com', live: 'https://api.ewaypayments.com' };
const API_KEY = /^[A-Za-z0-9+/=]{20,200}$/;
const API_PASSWORD = /^[A-Za-z0-9!#$%&*+./=?@^_~-]{8,64}$/;
const PUBLIC_KEY = /^epk-[A-Za-z0-9-]{20,60}$/;
const FETCH_TIMEOUT_MS = 4_500;
/** The one charge: still inside the gateway wrapper's 10 s. */
const CHARGE_TIMEOUT_MS = 8_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_AMOUNT = 999_999_999n;
/** 3-D Secure statuses that count as authenticated (UNVERIFIED: `Y` or `A`). */
const AUTHENTICATED = ['Y', 'A'];

export interface EwayRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}
export interface EwayResponse {
  status: number;
  body: string;
}
/** One HTTP exchange with eWAY. Tests inject the fake; the API always uses fetch to the host of the context's mode. */
export type EwayTransport = (req: EwayRequest) => Promise<EwayResponse>;

export const fetchTransport: EwayTransport = async (req) => {
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

const fill = (c: string, n: number) => c.repeat(n);

export function ewayManifest(): AdapterManifest {
  return {
    key: EWAY_KEY,
    displayName: 'eWAY',
    status: 'experimental',
    testOnly: false,
    cardDataHandling: 'hosted_only',
    // Apple Pay and Google Pay through eWAY need domain verification first (plan 9.1, section 16).
    methods: ['card'] satisfies PaymentMethod[],
    currencies: ['AUD'],
    countries: 'any',
    // The card page is ours: CardSessionProvider replaces this with WEB_ORIGIN. Here, the origin of eWAY's fields.
    checkoutOrigin: EWAY_CARD_FIELDS.frameOrigins[0],
    cardFields: {
      driver: 'eway_secure_fields', scriptUrl: EWAY_CARD_FIELDS.scriptUrl, frameOrigins: [...EWAY_CARD_FIELDS.frameOrigins],
      challengeOrigins: { test: [...EWAY_CARD_FIELDS.challengeOrigins.test], live: [] },
    },
    // eWAY keys carry no documented test or live marker: a test account only ever calls the sandbox host (A8).
    account: {
      fields: [
        {
          key: 'apiKey', label: 'API key (eWAY sandbox account)', pattern: API_KEY.source,
          samples: { valid: `K${fill('a', 39)}`, rejected: [fill('a', 19), fill('a', 201), `${fill('a', 20)} x`, `${fill('a', 20)}:x`, `${fill('a', 20)}.x`] },
        },
        {
          key: 'apiPassword', label: 'API password (eWAY sandbox account)', pattern: API_PASSWORD.source,
          samples: { valid: `P${fill('b', 15)}`, rejected: [fill('b', 7), fill('b', 65), `${fill('b', 10)} x`, `${fill('b', 10)}:x`] },
        },
        {
          key: 'publicApiKey', label: 'Public API key (eWAY sandbox account)', pattern: PUBLIC_KEY.source, exposure: 'card_page',
          samples: { valid: `epk-${fill('C', 8)}-${fill('d', 4)}-${fill('e', 4)}-${fill('f', 4)}-${fill('a', 12)}`, rejected: ['epk-short', `pk-${fill('a', 30)}`, `epk-${fill('a', 30)} x`, `epk-${fill('a', 30)}.x`] },
        },
      ],
      // Plan D7: eWAY sends no webhooks; the secret is the server's own and every delivery is refused.
      webhookSecret: { source: 'generated' },
    },
    // One charge per session, so a decline ends it. No disputes or reconciliation (plan 9.1, section 9): with no events,
    // the registry refuses `verified` until both exist (plan 20 M6).
    capabilities: { refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'failed', gatewayEvents: 'none' },
  };
}

export interface EwayOptions {
  /** Only tests pass one (the fake). */
  transport?: EwayTransport;
}

type Answer = { status: number; body: unknown };

export class EwayGateway implements CardTokenGateway {
  readonly manifest = ewayManifest();
  readonly signatureHeaders = [] as const;
  /** No events at all (plan 9.1, 4.2): there is no refund event to carry an id. */
  readonly refundEventsCarryOurId = false;
  readonly authentication = 'before_charge' as const;
  readonly chargeRefPattern = CHARGE_REF;
  readonly refundRefPattern = REFUND_REF;
  private readonly transport: EwayTransport;

  constructor(opts: EwayOptions = {}) {
    this.transport = opts.transport ?? fetchTransport;
  }

  // ---- HTTP ----

  private auth(ctx: ProviderContext): string {
    const key = ctx.credentials.apiKey ?? '';
    const password = ctx.credentials.apiPassword ?? '';
    if (!API_KEY.test(key) || !API_PASSWORD.test(password)) throw new ProviderError('provider_auth_failed', false);
    return `Basic ${Buffer.from(`${key}:${password}`).toString('base64')}`;
  }

  private async exchange(ctx: ProviderContext, method: EwayRequest['method'], path: string, body?: unknown, timeoutMs = FETCH_TIMEOUT_MS): Promise<Answer> {
    const headers: Record<string, string> = { authorization: this.auth(ctx), accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: EwayResponse;
    try {
      res = await this.transport({ method, url: `${EWAY_API_BASE[ctx.mode]}${path}`, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
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

  /** The error of an answer we cannot use, from the status only. 404 is the caller's. */
  private fail(status: number): never {
    if (status === 401 || status === 403) throw new ProviderError('provider_auth_failed', false);
    if (status === 429 || status === 409) throw new ProviderError('provider_busy', true);
    if (status >= 500 || status < 400) throw new ProviderError('provider_unavailable', true);
    throw new ProviderError('provider_rejected', false);
  }

  private obj(a: Answer): Record<string, unknown> {
    if (!isObj(a.body)) throw new ProviderError('provider_unavailable', true);
    return a.body;
  }

  /**
   * A transaction query (by id or by our invoice reference): the transactions found; [] is a definitive "none" (A4:
   * an empty list or the not-found code); NOT_UNIQUE when eWAY refuses the reference as not unique; else unknown.
   * A 404 is "none" only with eWAY's not-found code in its body; a bare 404 (a balancer, a moved route, maintenance)
   * is unknown (code review, finding 2).
   */
  private async query(ctx: ProviderContext, path: string): Promise<Record<string, unknown>[] | typeof NOT_UNIQUE> {
    const a = await this.exchange(ctx, 'GET', path);
    if (a.status === 404) {
      if (isObj(a.body) && codesOf(a.body.Errors).some((e) => NOT_FOUND_ERRORS.includes(e))) return [];
      throw new ProviderError('provider_unavailable', true);
    }
    if (!(a.status >= 200 && a.status < 300)) return this.fail(a.status);
    const body = this.obj(a);
    const errors = codesOf(body.Errors);
    if (errors.some((e) => NOT_UNIQUE_ERRORS.includes(e))) return NOT_UNIQUE;
    if (errors.some((e) => NOT_FOUND_ERRORS.includes(e))) return [];
    if (errors.length > 0) throw new ProviderError('provider_unavailable', true);
    if (!Array.isArray(body.Transactions)) throw new ProviderError('provider_unavailable', true);
    if (body.Transactions.length > 50 || !body.Transactions.every(isObj)) throw new ProviderError('provider_unavailable', true);
    return body.Transactions as Record<string, unknown>[];
  }

  private static charge(t: unknown): GatewayCharge {
    const c = chargeOf(t);
    if (!c) throw new ProviderError('provider_unavailable', true);
    return c;
  }

  // ---- CardTokenGateway ----

  /** A9 (UNVERIFIED): a search for a reference that cannot exist answers "none" and moves nothing. */
  async probe(ctx: ProviderContext): Promise<void> {
    const found = await this.query(ctx, `/Transaction/InvoiceRef/mt_probe_${randomBytes(8).toString('hex')}`);
    if (found === NOT_UNIQUE || found.length > 0) throw new ProviderError('provider_unavailable', true);
  }

  async testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }> {
    try {
      await this.probe(ctx);
      if (!PUBLIC_KEY.test(ctx.credentials.publicApiKey ?? '')) return { ok: false, code: 'provider_rejected' };
      return { ok: true };
    } catch (err) {
      return { ok: false, code: err instanceof ProviderError ? err.code : 'provider_unavailable' };
    }
  }

  async beginAuthentication(ctx: ProviderContext, req: { amount: Money; cardToken: string; payer: AuthenticationPayer }): Promise<AuthenticationStart> {
    const { amountMinor, currency } = req.amount;
    if (currency !== 'AUD' || amountMinor < 1n || amountMinor > MAX_AMOUNT || !SECURE_FIELD_CODE.test(req.cardToken)) return { kind: 'refused', code: 'provider_rejected' };
    const body = {
      Customer: { FirstName: req.payer.givenName.slice(0, 50), LastName: req.payer.familyName.slice(0, 50), Email: req.payer.email.slice(0, 50), Phone: req.payer.phone.slice(0, 32) },
      Payment: { TotalAmount: Number(amountMinor), CurrencyCode: currency },
      SecuredCardData: req.cardToken,
    };
    const a = await this.exchange(ctx, 'POST', '/3dsenrol', body);
    if (a.status === 401 || a.status === 403) return { kind: 'refused', code: 'provider_auth_failed' };
    if (a.status >= 500 || a.status === 429 || a.status === 409) throw new ProviderError(a.status === 429 ? 'provider_busy' : 'provider_unavailable', true);
    const v = this.obj(a);
    const errors = codesOf(v.Errors);
    if (typeof v.AccessCode === 'string' && ACCESS_CODE.test(v.AccessCode) && errors.length === 0 && a.status >= 200 && a.status < 300) return { kind: 'challenge', authRef: v.AccessCode };
    const decline = declineOf(errors);
    if (decline) return { kind: 'declined', code: decline };
    // A validation code (V6…: an expired or invalid card code, a missing field): nothing was started.
    if (errors.length > 0 || (a.status >= 400 && a.status < 500)) return { kind: 'refused', code: 'provider_rejected' };
    throw new ProviderError('provider_unavailable', true);
  }

  async completeAuthentication(ctx: ProviderContext, authRef: string): Promise<AuthenticationResult> {
    if (!ACCESS_CODE.test(authRef)) return { authenticated: false };
    const a = await this.exchange(ctx, 'POST', '/3dsverify', { AccessCode: authRef });
    if (!(a.status >= 200 && a.status < 300)) return this.fail(a.status === 404 ? 503 : a.status);
    const v = this.obj(a);
    if (codesOf(v.Errors).length > 0) return { authenticated: false };
    if (v.Enrolled !== true) {
      if (v.Enrolled === false) return { authenticated: false };
      throw new ProviderError('provider_unavailable', true);
    }
    const t = v.ThreeDSecureAuth;
    if (!isObj(t) || typeof t.AuthStatus !== 'string') throw new ProviderError('provider_unavailable', true);
    if (!AUTHENTICATED.includes(t.AuthStatus)) return { authenticated: false };
    const opaque: Record<string, string> = {};
    for (const k of ['Cryptogram', 'ECI', 'XID', 'AuthStatus', 'Version', 'dsTransactionId']) if (typeof t[k] === 'string' && (t[k] as string).length <= 256) opaque[k] = t[k] as string;
    return { authenticated: true, proof: { opaque } };
  }

  async charge(ctx: ProviderContext, req: CardChargeRequest): Promise<CardChargeOutcome> {
    const { amountMinor, currency } = req.amount;
    if (currency !== 'AUD' || amountMinor < 1n || amountMinor > MAX_AMOUNT || !SECURE_FIELD_CODE.test(req.cardToken) || !SESSION_INVOICE_REF.test(req.sessionRef) || !req.authentication) {
      return { kind: 'refused', code: 'provider_rejected' };
    }
    const body = {
      Method: 'ProcessPayment', TransactionType: 'Purchase', SecuredCardData: req.cardToken, CustomerIP: req.payer.ipAddress,
      Payment: { TotalAmount: Number(amountMinor), CurrencyCode: currency, InvoiceReference: req.sessionRef },
      PaymentInstrument: { ThreeDSecureAuth: { ...req.authentication.opaque } },
    };
    const a = await this.exchange(ctx, 'POST', '/Transaction', body, CHARGE_TIMEOUT_MS);
    if (a.status === 401 || a.status === 403) return { kind: 'refused', code: 'provider_auth_failed' };
    // 429: not processed (as Pin's A18, UNVERIFIED for eWAY). 409, 5xx and anything unreadable: the charge may exist.
    if (a.status === 429) return { kind: 'refused', code: 'provider_busy' };
    if (!(a.status >= 200 && a.status < 300)) {
      if (a.status >= 400 && a.status < 500 && a.status !== 409 && isObj(a.body) && idOf(a.body.TransactionID) === undefined && codesOf(a.body.Errors).length > 0) return { kind: 'refused', code: 'provider_rejected' };
      throw new ProviderError('provider_unavailable', true);
    }
    const v = this.obj(a);
    const codes = codesOf(v.ResponseMessage);
    if (codes.includes(DUPLICATE)) return { kind: 'duplicate' };
    if (codes.includes(UNKNOWN_STATE)) throw new ProviderError('provider_unavailable', true);
    if (v.TransactionStatus === true) return { kind: 'charged', charge: EwayGateway.charge(v) };
    const id = idOf(v.TransactionID);
    const decline = declineOf(codes);
    if (v.TransactionStatus === false && decline) return { kind: 'declined', code: decline, ...(id ? { chargeToken: `ewt_${id}` } : {}) };
    // A validation refusal: no transaction was made.
    if (v.TransactionStatus === false && !id && codesOf(v.Errors).length > 0) return { kind: 'refused', code: 'provider_rejected' };
    throw new ProviderError('provider_unavailable', true);
  }

  /** Pin's after-charge return; eWAY authenticates before the charge. */
  async verifyAuthentication(): Promise<GatewayCharge | null> {
    return null;
  }

  async retrieveCharge(ctx: ProviderContext, token: string): Promise<GatewayCharge | null> {
    if (!CHARGE_REF.test(token)) return null;
    const found = await this.query(ctx, `/Transaction/${token.slice(4)}`);
    if (found === NOT_UNIQUE || found.length > 1) throw new ProviderError('provider_unavailable', true);
    return found.length === 0 ? null : EwayGateway.charge(found[0]);
  }

  async chargesOfSession(ctx: ProviderContext, sessionRef: string): Promise<GatewayCharge[] | typeof NOT_UNIQUE> {
    if (!SESSION_INVOICE_REF.test(sessionRef)) return [];
    const found = await this.query(ctx, `/Transaction/InvoiceRef/${sessionRef}`);
    if (found === NOT_UNIQUE) return NOT_UNIQUE;
    // Every transaction eWAY returns for our reference must carry it, readable and exact. One that does not (unreadable,
    // missing or another reference) makes the answer unknown, never "none": a real charge is never dropped (code
    // review, finding 1).
    const charges = found.map((t) => EwayGateway.charge(t));
    if (charges.some((c) => c.sessionRef !== sessionRef)) throw new ProviderError('provider_unavailable', true);
    return charges;
  }

  /** A7 (UNVERIFIED): MaxRefund is what can still be refunded, so refunds made in MYeWAY count too. */
  async refundState(ctx: ProviderContext, chargeToken: string): Promise<{ charge: GatewayCharge; refunded: bigint } | null> {
    if (!CHARGE_REF.test(chargeToken)) return null;
    const found = await this.query(ctx, `/Transaction/${chargeToken.slice(4)}`);
    if (found === NOT_UNIQUE || found.length > 1) throw new ProviderError('provider_unavailable', true);
    if (found.length === 0) return null;
    const charge = EwayGateway.charge(found[0]);
    const max = minorOf(found[0]!.MaxRefund);
    if (max === undefined || max > charge.amount.amountMinor) throw new ProviderError('provider_unavailable', true);
    return { charge, refunded: charge.amount.amountMinor - max };
  }

  async createRefund(ctx: ProviderContext, chargeToken: string, amount: Money, intentRef?: string): Promise<GatewayRefundOutcome> {
    if (!CHARGE_REF.test(chargeToken) || !intentRef || !INTENT_INVOICE_REF.test(intentRef) || amount.currency !== 'AUD' || amount.amountMinor < 1n || amount.amountMinor > MAX_AMOUNT) return { kind: 'refused' };
    const a = await this.exchange(ctx, 'POST', `/Transaction/${chargeToken.slice(4)}/Refund`, { Refund: { TotalAmount: Number(amount.amountMinor), CurrencyCode: amount.currency, InvoiceReference: intentRef } });
    if (a.status === 429) return { kind: 'rate_limited' };
    if (a.status === 401 || a.status === 403) throw new ProviderError('provider_auth_failed', false);
    if (a.status >= 200 && a.status < 300) {
      const v = this.obj(a);
      const errors = codesOf(v.Errors);
      // V6150 "Invalid Refund Amount", V6151 "greater than original transaction", any other validation: refused.
      if (errors.length > 0 && !idOf(v.TransactionID)) return { kind: 'refused' };
      if (codesOf(v.ResponseMessage).includes(UNKNOWN_STATE)) throw new ProviderError('provider_unavailable', true);
      const r = refundOf(v, chargeToken);
      if (!r) throw new ProviderError('provider_unavailable', true);
      return { kind: 'created', refund: r };
    }
    if (a.status === 400 || a.status === 404 || a.status === 422) return { kind: 'refused' };
    throw new ProviderError('provider_unavailable', true);
  }

  async retrieveRefund(ctx: ProviderContext, token: string): Promise<GatewayRefund | null> {
    if (!REFUND_REF.test(token)) return null;
    const found = await this.query(ctx, `/Transaction/${token.slice(4)}`);
    if (found === NOT_UNIQUE || found.length > 1) throw new ProviderError('provider_unavailable', true);
    if (found.length === 0) return null;
    const r = refundOf(found[0]);
    if (r) return r;
    // A refund we cannot read is unknown; a transaction that is not a refund is no refund by this name.
    if (idOf(found[0]!.OriginalTransactionId)) throw new ProviderError('provider_unavailable', true);
    return null;
  }

  /** eWAY documents no list of a transaction's refunds: refunds bind by our reference (refundByOurRef). */
  async listRefunds(): Promise<GatewayRefund[]> {
    return [];
  }

  /** A5 (UNVERIFIED): a refund's InvoiceReference is found by the same query as a charge's. */
  async refundByOurRef(ctx: ProviderContext, intentRef: string, chargeToken: string): Promise<GatewayRefund | null> {
    if (!INTENT_INVOICE_REF.test(intentRef)) return null;
    const found = await this.query(ctx, `/Transaction/InvoiceRef/${intentRef}`);
    if (found === NOT_UNIQUE || found.length > 1) throw new ProviderError('provider_unavailable', true);
    if (found.length === 0) return null;
    const r = refundOf(found[0]);
    // Our reference on a refund of another charge, or a refund that does not carry our reference, cannot be bound:
    // unknown, never bound.
    if (!r || r.chargeToken !== chargeToken || invoiceRefOf(found[0]!) !== intentRef) throw new ProviderError('provider_unavailable', true);
    return r;
  }

  /** eWAY sends no events (plan 9.1, 4.2): every delivery is refused, without reading it. Never throws. */
  verifyWebhook(_ctx: ProviderContext, _rawBody: Buffer, _headers: Readonly<Record<string, string>>, _now: Date): WebhookVerification {
    return { ok: false, code: 'malformed' };
  }

  parseEvent(_rawBody: Buffer): NormalisedEvent | null {
    return null;
  }
}
