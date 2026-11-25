// The Airwallex adapter (plan docs/plans/9.2-airwallex.md): Checkout Sessions on Airwallex's hosted page, refunds and
// signed webhooks. `experimental`: written from Airwallex's documentation, read through a summarising tool, so every
// Airwallex fact is UNVERIFIED (plan §3) and proven only against test/contract/subjects/airwallex-fake.ts until
// `test:sandbox` runs. Test accounts only reach https://api.sandbox.airwallex.com. It reads no environment and never logs.
//
// Our payment reference is the order id we give Airwallex (`mt-<payment id>-<createdAt>`, plan 4, D3): the session and
// its PaymentIntent both carry it, so events match with no network. Every list Airwallex returns is checked item by item
// (plan 19.2): a filter only shortens a list, it never proves an item is ours.
import { createHash, randomUUID } from 'node:crypto';
import type { PaymentMethod } from '@mt/shared';
import { ProviderError } from '../../core/provider';
import type {
  AdapterManifest, CreatePaymentInput, CreateRefundInput, NormalisedEvent, PaymentLookup, PaymentProvider, ProviderContext, ProviderPayment, ProviderRefund, RefundLookup,
  WebhookVerification,
} from '../../core/provider';
import { API_KEY, AirwallexApi, CLIENT_ID, errorFor, fetchTransport } from './http';
import type { AirwallexTransport } from './http';
import {
  AIRWALLEX_REF, AIRWALLEX_SIGNATURE_HEADER, AIRWALLEX_TIMESTAMP_HEADER, INTENT_ID, MONEY_INTENT_STATUSES, OPEN_INTENT_STATUSES, PATH_ID, claimedEventId, intentView, isObj,
  parseAirwallexEvent, parseRef, paymentOf, refFor, refundOut, refundView, sessionView, verifySignature,
} from './mapping';
import type { IntentView, Obj, RefundView, SessionView } from './mapping';
import { DecimalLiteral } from './money';

export const AIRWALLEX_KEY = 'airwallex';
/** A8 (UNVERIFIED): the sandbox hosted page's origin. A wrong guess only stops the redirect; no money moves. */
export const AIRWALLEX_CHECKOUT_ORIGIN = 'https://checkout.sandbox.airwallex.com';
/** Plan 6.2 and D7: after this, no session is created for a key (one that exists is still found). */
export const CREATE_HORIZON_S = 6 * 3600;
/** Clock skew allowed around every window. */
const SKEW_S = 5 * 60;
/** An intent is created when its session completes, at most an hour after the session (plan 20.3). */
const SESSION_LIFE_S = 3600;
const PAGE_SIZE = '100';
/** Plan D7: past this many pages of one window, the answer is "unknown", never "none". */
export const MAX_PAGES = 20;
/**
 * Plan 20.3 (A25): whether a GET of a session or intent is known to return our order fields. Until the sandbox run
 * confirms it, an item without them is "unknown", never "not ours". Turning it on is a one-line reviewed change.
 */
export const GET_RETURNS_ORDER_FIELDS = false;

const unavailable = (): ProviderError => new ProviderError('provider_unavailable', true);
const rejected = (): ProviderError => new ProviderError('provider_rejected', false);
const notFound = (): ProviderError => new ProviderError('provider_not_found', false);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const iso = (s: number): string => new Date(s * 1000).toISOString();
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Filler for the descriptor's samples: shapes only, never a credential. */
const fill = (n: number) => 'x'.repeat(n);

export function airwallexManifest(): AdapterManifest {
  return {
    key: AIRWALLEX_KEY,
    displayName: 'Airwallex',
    status: 'experimental',
    testOnly: false,
    cardDataHandling: 'hosted_only',
    // D4: cards only; the session asks for `payment_method_types: ['card']`, so no pay-later method is ever offered.
    methods: ['card'] satisfies PaymentMethod[],
    currencies: ['AUD'],
    countries: 'any',
    checkoutOrigin: AIRWALLEX_CHECKOUT_ORIGIN,
    // A15: Airwallex keys carry no documented test or live marker; a test account only ever calls the sandbox host.
    account: {
      fields: [
        {
          key: 'clientId', label: 'Client ID (Airwallex sandbox API key)', pattern: CLIENT_ID.source,
          samples: { valid: `C${fill(21)}`, rejected: [fill(7), `C${fill(10)} x`, `C${fill(10)}.x`, `C${fill(10)}:x`, `C${fill(64)}`] },
        },
        {
          key: 'apiKey', label: 'API key (Airwallex sandbox)', pattern: API_KEY.source,
          samples: { valid: `a${fill(63)}`, rejected: [fill(31), `a${fill(40)} x`, `a${fill(40)}.x`, `a${fill(40)}=`] },
        },
      ],
      webhookSecret: {
        source: 'entered', label: 'Webhook secret (from the sandbox webhook subscription)', pattern: '^[A-Za-z0-9_+/=-]{16,256}$',
        samples: { valid: `whsec_${fill(32)}`, rejected: [fill(15), `${fill(20)} x`, `${fill(20)}.x`, `${fill(20)}:x`] },
      },
    },
    capabilities: { refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'stays_payable' },
  };
}

export interface AirwallexOptions {
  /** Only tests pass one (the fake). */
  transport?: AirwallexTransport;
  /** Only tests pass one. */
  now?: () => Date;
  /** Only tests pass one: GET_RETURNS_ORDER_FIELDS as if the sandbox had confirmed it (plan 20.3). */
  getReturnsOrderFields?: boolean;
}

type Match = 'ours' | 'not_ours' | 'incomplete';

export class AirwallexProvider implements PaymentProvider {
  readonly manifest = airwallexManifest();
  readonly signatureHeaders = [AIRWALLEX_SIGNATURE_HEADER, AIRWALLEX_TIMESTAMP_HEADER] as const;
  private readonly transport: AirwallexTransport;
  private readonly now: () => Date;
  private readonly getReturnsOrderFields: boolean;

  constructor(opts: AirwallexOptions = {}) {
    this.transport = opts.transport ?? fetchTransport;
    this.now = opts.now ?? (() => new Date());
    this.getReturnsOrderFields = opts.getReturnsOrderFields ?? GET_RETURNS_ORDER_FIELDS;
  }

  private open(ctx: ProviderContext): Promise<AirwallexApi> {
    return AirwallexApi.open(this.transport, ctx);
  }

  // ---- Lists, checked item by item (plan 19.2, 19.5, 20.3) ----

  /** Every item of a list, page by page (`page_after`, or `has_more` with `page_num`); past MAX_PAGES: unknown. */
  private async listAll(api: AirwallexApi, path: string, query: ReadonlyArray<[string, string]>): Promise<Obj[]> {
    const items: Obj[] = [];
    let cursor: [string, string] | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await api.must('GET', path, { query: [...query, ['page_size', PAGE_SIZE], ...(cursor ? [cursor] : [])] });
      if (!Array.isArray(body.items)) throw unavailable();
      for (const it of body.items) {
        if (!isObj(it)) throw unavailable();
        items.push(it);
      }
      if (typeof body.page_after === 'string' && body.page_after.length > 0) cursor = ['page', body.page_after];
      else if (body.has_more === true && body.items.length > 0) cursor = ['page_num', String(page + 1)];
      else return items;
    }
    throw unavailable();
  }

  /** The window of a ref's (or a key's) session: from the attempt row's createdAt to past the creation horizon. */
  private static sessionWindow(t: number): [number, number] {
    return [t - SKEW_S, t + CREATE_HORIZON_S + SKEW_S];
  }

  /** Whether a session item is the one we look for; `incomplete` when the fields that say so are not in it. */
  private static matchSession(o: Obj, want: { ref: string } | { keyHash: string }): Match {
    const meta = isObj(o.metadata) ? o.metadata : undefined;
    const moid = isObj(o.payment_intent_data) ? str(o.payment_intent_data.merchant_order_id) : undefined;
    const mtRef = str(meta?.mt_ref);
    if ('ref' in want) {
      if ((mtRef !== undefined && mtRef !== want.ref) || (moid !== undefined && moid !== want.ref)) return 'not_ours';
      return mtRef === want.ref && moid === want.ref ? 'ours' : 'incomplete';
    }
    const mtKey = str(meta?.mt_key);
    if (mtKey !== undefined && mtKey !== want.keyHash) return 'not_ours';
    if (moid !== undefined && !AIRWALLEX_REF.test(moid)) return 'not_ours';
    if (mtKey === want.keyHash && mtRef !== undefined && AIRWALLEX_REF.test(mtRef) && moid === mtRef) return 'ours';
    return 'incomplete';
  }

  /** An item with no sign of ours at all (no mt_ metadata, no order id of our shape): foreign only once A25 is confirmed. */
  private foreignOrUnknown(o: Obj): 'not_ours' {
    const meta = isObj(o.metadata) ? o.metadata : undefined;
    const moid = isObj(o.payment_intent_data) ? str(o.payment_intent_data.merchant_order_id) : str(o.merchant_order_id);
    const signOfOurs = str(meta?.mt_ref) !== undefined || str(meta?.mt_key) !== undefined || (moid !== undefined && AIRWALLEX_REF.test(moid));
    if (!signOfOurs && this.getReturnsOrderFields) return 'not_ours';
    throw unavailable();
  }

  /** The one session of a ref or a key in its window; null after the whole window was read and none is ours. */
  private async findSession(api: AirwallexApi, want: { ref: string } | { keyHash: string }, t: number): Promise<SessionView | null> {
    const [from, to] = AirwallexProvider.sessionWindow(t);
    const items = await this.listAll(api, '/api/v1/checkout/checkout_sessions', [['from_created_at', iso(from)], ['to_created_at', iso(to)]]);
    const ours: Obj[] = [];
    for (const listed of items) {
      const created = typeof listed.created_at === 'string' ? Date.parse(listed.created_at) : NaN;
      if (Number.isNaN(created)) throw unavailable();
      // Outside the window: a filter Airwallex ignored, not ours.
      if (created < from * 1000 || created > to * 1000) continue;
      let o = listed;
      let m = AirwallexProvider.matchSession(o, want);
      if (m === 'incomplete') {
        const id = str(o.id);
        if (!id || !PATH_ID.test(id)) throw unavailable();
        const a = await api.request('GET', `/api/v1/checkout/checkout_sessions/${id}`);
        if (!a.ok) throw a.status === 404 ? unavailable() : errorFor(a);
        o = a.body;
        m = AirwallexProvider.matchSession(o, want);
        if (m === 'incomplete') m = this.foreignOrUnknown(o);
      }
      if (m === 'ours') ours.push(o);
    }
    if (ours.length > 1) throw unavailable();
    if (ours.length === 0) return null;
    const view = sessionView(ours[0]);
    if (!view) throw unavailable();
    return view;
  }

  /** The intent whose own merchant_order_id is this ref; null after its whole window was read and none is. */
  private async findIntent(api: AirwallexApi, ref: string): Promise<IntentView | null> {
    const t = parseRef(ref)!.createdAtS;
    const query: Array<[string, string]> = [['merchant_order_id', ref], ['from_created_at', iso(t - SKEW_S)], ['to_created_at', iso(t + CREATE_HORIZON_S + SESSION_LIFE_S + SKEW_S)]];
    const items = await this.listAll(api, '/api/v1/pa/payment_intents', query);
    const ours: IntentView[] = [];
    for (const listed of items) {
      let o = listed;
      if (str(o.merchant_order_id) === undefined) {
        const id = str(o.id);
        if (!id || !INTENT_ID.test(id)) throw unavailable();
        const a = await api.request('GET', `/api/v1/pa/payment_intents/${id}`);
        if (!a.ok) throw a.status === 404 ? unavailable() : errorFor(a);
        o = a.body;
        if (str(o.merchant_order_id) === undefined) {
          this.foreignOrUnknown(o);
          continue;
        }
      }
      if (str(o.merchant_order_id) !== ref) continue;
      const view = intentView(o);
      if (!view || view.ref !== ref) throw unavailable();
      ours.push(view);
    }
    if (ours.length > 1) throw unavailable();
    return ours[0] ?? null;
  }

  /** Our view of a ref (plan 20.1); null: no intent and no session in the fully read windows. */
  private async read(api: AirwallexApi, ref: string): Promise<ProviderPayment | null> {
    const intent = await this.findIntent(api, ref);
    if (intent && MONEY_INTENT_STATUSES.includes(intent.status)) return paymentOf(null, intent);
    const session = await this.findSession(api, { ref }, parseRef(ref)!.createdAtS);
    const p = paymentOf(session, intent);
    if (p) return p;
    if (!intent && !session) return null;
    throw unavailable();
  }

  /** An intent by its id, if it is ours (its own order id has our shape); null if Airwallex does not know it. */
  private async intentById(api: AirwallexApi, id: string): Promise<IntentView | null> {
    if (!INTENT_ID.test(id)) return null;
    const a = await api.request('GET', `/api/v1/pa/payment_intents/${id}`);
    if (!a.ok) {
      if (a.status === 404) return null;
      throw errorFor(a);
    }
    const moid = str(a.body.merchant_order_id);
    if (moid === undefined || !AIRWALLEX_REF.test(moid)) return null;
    const view = intentView(a.body);
    if (!view) throw unavailable();
    return view;
  }

  // ---- PaymentProvider ----

  async testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }> {
    try {
      const api = await this.open(ctx);
      await api.must('GET', '/api/v1/checkout/checkout_sessions', { query: [['page_size', '1']] });
      return ctx.webhookSecret.length >= 16 ? { ok: true } : { ok: false, code: 'webhook_secret_missing' };
    } catch (err) {
      return { ok: false, code: err instanceof ProviderError ? err.code : 'provider_unavailable' };
    }
  }

  async createPayment(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment> {
    const amount = DecimalLiteral.of(input.amount.amountMinor, input.amount.currency);
    const ref = refFor(input.metadata.paymentId, input.createdAt);
    if (input.method !== 'card' || !amount || !ref) {
      // Refused before any request: no object exists, none ever will under this key. Credentials still checked first.
      await this.open(ctx);
      throw rejected();
    }
    const api = await this.open(ctx);
    // One session per ref (plan 6.3): look first, every time.
    const existing = await this.read(api, ref);
    if (existing) return existing;
    if (this.now().getTime() - input.createdAt.getTime() > CREATE_HORIZON_S * 1000) throw rejected();
    const a = await api.request('POST', '/api/v1/checkout/checkout_sessions/create', {
      body: {
        request_id: ref,
        mode: 'PAYMENT',
        currency: input.amount.currency,
        line_items: [{ quantity: 1, price: { currency: input.amount.currency, unit_amount: amount.text, product: { name: 'Booking payment' } } }],
        success_url: input.returnUrl,
        back_url: input.returnUrl,
        payment_intent_data: { merchant_order_id: ref },
        payment_options: { payment_method_types: ['card'], auto_capture: true },
        metadata: {
          mt_ref: ref, mt_payment_id: input.metadata.paymentId, mt_booking_id: input.metadata.bookingId,
          mt_key: sha256(input.idempotencyKey), mt_amount_minor: input.amount.amountMinor.toString(),
        },
      },
    });
    if (a.ok) {
      const s = sessionView(a.body);
      // A session we cannot read is still there: the retry finds it by its ref.
      if (!s || s.ref !== ref) throw unavailable();
      return paymentOf(s, null) ?? (() => { throw unavailable(); })();
    }
    if (a.status === 400 && a.code === 'duplicate_request_id') {
      const again = await this.read(api, ref);
      if (again) return again;
      throw new ProviderError('provider_busy', true);
    }
    // Only a refusal that says nothing was created is definitive (plan 11); anything else may be in flight.
    if (a.status === 401 || a.status === 403) throw new ProviderError('provider_auth_failed', false);
    if (a.status === 400 && a.code === 'validation_error') throw rejected();
    if (a.status === 429) throw new ProviderError('provider_busy', true);
    throw unavailable();
  }

  async retrievePayment(ctx: ProviderContext, by: PaymentLookup): Promise<ProviderPayment | null> {
    const api = await this.open(ctx);
    if ('ref' in by) {
      if (AIRWALLEX_REF.test(by.ref)) return this.read(api, by.ref);
      // A refund made in the web app names the intent (plan 6.4): resolved through its own order id.
      const intent = await this.intentById(api, by.ref);
      return intent ? this.read(api, intent.ref) : null;
    }
    const s = await this.findSession(api, { keyHash: sha256(by.idempotencyKey) }, Math.floor(by.createdAt.getTime() / 1000));
    return s ? this.read(api, s.ref) : null;
  }

  async cancelPayment(ctx: ProviderContext, ref: string, _idempotencyKey: string): Promise<ProviderPayment> {
    const api = await this.open(ctx);
    if (!AIRWALLEX_REF.test(ref)) throw notFound();
    const intent = await this.findIntent(api, ref);
    if (intent && MONEY_INTENT_STATUSES.includes(intent.status)) return paymentOf(null, intent)!;
    // An open intent is cancelled every time one is seen, whatever its session says (plan 20.1).
    if (intent && OPEN_INTENT_STATUSES.includes(intent.status)) await this.cancelObject(api, `/api/v1/pa/payment_intents/${intent.id}/cancel`, { request_id: `mtc-${randomUUID()}`, cancellation_reason: 'Payment attempt ended' });
    const session = await this.findSession(api, { ref }, parseRef(ref)!.createdAtS);
    if (session?.status === 'ACTIVE') await this.cancelObject(api, `/api/v1/checkout/checkout_sessions/${session.id}/cancel`);
    const after = await this.read(api, ref);
    if (!after) throw notFound();
    // A cancel never answers "still waiting": read again later.
    if (after.status === 'requires_action') throw unavailable();
    return after;
  }

  /** A cancel call: a refusal or a 404 is left to the next read; credentials and transient errors throw. */
  private async cancelObject(api: AirwallexApi, path: string, body?: { request_id: string; cancellation_reason: string }): Promise<void> {
    const a = await api.request('POST', path, body ? { body } : {});
    if (a.ok || a.status === 400 || a.status === 404 || a.status === 409) return;
    throw errorFor(a);
  }

  /** The intent behind a payment reference (ours, or an intent id); null if Airwallex has none. */
  private async intentOf(api: AirwallexApi, paymentRef: string): Promise<IntentView | null> {
    if (AIRWALLEX_REF.test(paymentRef)) return this.findIntent(api, paymentRef);
    return this.intentById(api, paymentRef);
  }

  /** Every refund of an intent, each checked to be of that intent (plan 19.2). */
  private async refundsOf(api: AirwallexApi, intentId: string): Promise<RefundView[]> {
    const items = await this.listAll(api, '/api/v1/pa/refunds', [['payment_intent_id', intentId]]);
    const out: RefundView[] = [];
    for (const o of items) {
      if (str(o.payment_intent_id) !== intentId) continue;
      const r = refundView(o);
      if (!r) throw unavailable();
      out.push(r);
    }
    return out;
  }

  async createRefund(ctx: ProviderContext, input: CreateRefundInput): Promise<ProviderRefund> {
    const api = await this.open(ctx);
    if (!AIRWALLEX_REF.test(input.paymentRef) && !INTENT_ID.test(input.paymentRef)) throw notFound();
    const amount = DecimalLiteral.of(input.amount.amountMinor, input.amount.currency);
    if (!amount) throw rejected();
    const intent = await this.intentOf(api, input.paymentRef);
    if (!intent) {
      if (AIRWALLEX_REF.test(input.paymentRef) && (await this.read(api, input.paymentRef))) throw rejected();
      throw notFound();
    }
    if (intent.status !== 'SUCCEEDED' || intent.currency !== input.amount.currency) throw rejected();
    const keyHash = sha256(input.idempotencyKey);
    const existing = await this.refundsOf(api, intent.id);
    const hit = existing.find((r) => r.keyHash === keyHash);
    if (hit) return refundOut(hit, intent.ref);
    // What is left: pending refunds count, so no over-refund slips in while one settles (plan 8.1, 8.2).
    const used = existing.filter((r) => r.status !== 'failed').reduce((sum, r) => sum + r.amount.amountMinor, 0n);
    if (used + input.amount.amountMinor > intent.amountMinor) throw rejected();
    const a = await api.request('POST', '/api/v1/pa/refunds/create', {
      body: {
        request_id: `mtr-${input.metadata.refundId}`.slice(0, 64), payment_intent_id: intent.id, amount, reason: 'requested_by_customer',
        metadata: { mt_refund_id: input.metadata.refundId, mt_refund_key: keyHash, mt_ref: intent.ref },
      },
    });
    if (a.ok) {
      const r = refundView(a.body);
      if (!r || r.intentId !== intent.id || r.keyHash !== keyHash) throw unavailable();
      return refundOut(r, intent.ref);
    }
    if (a.status === 400 && a.code === 'duplicate_request_id') {
      const found = (await this.refundsOf(api, intent.id)).find((r) => r.keyHash === keyHash);
      if (found) return refundOut(found, intent.ref);
      throw new ProviderError('provider_busy', true);
    }
    if (a.status === 401 || a.status === 403) throw new ProviderError('provider_auth_failed', false);
    if (a.status === 400 && a.code === 'validation_error') throw rejected();
    if (a.status === 429) throw new ProviderError('provider_busy', true);
    throw unavailable();
  }

  async retrieveRefund(ctx: ProviderContext, by: RefundLookup): Promise<ProviderRefund | null> {
    const api = await this.open(ctx);
    if ('ref' in by) {
      if (!PATH_ID.test(by.ref)) return null;
      const a = await api.request('GET', `/api/v1/pa/refunds/${by.ref}`);
      if (!a.ok) {
        if (a.status === 404) return null;
        throw errorFor(a);
      }
      const r = refundView(a.body);
      if (!r) throw unavailable();
      const intent = await this.intentById(api, r.intentId);
      return refundOut(r, intent?.ref ?? null);
    }
    if (!AIRWALLEX_REF.test(by.paymentRef) && !INTENT_ID.test(by.paymentRef)) return null;
    const intent = await this.intentOf(api, by.paymentRef);
    if (!intent) return null;
    const keyHash = sha256(by.idempotencyKey);
    const hit = (await this.refundsOf(api, intent.id)).find((r) => r.keyHash === keyHash);
    return hit ? refundOut(hit, intent.ref) : null;
  }

  verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification {
    try {
      const claimed = claimedEventId(rawBody);
      const withClaim = claimed ? { claimedEventId: claimed } : {};
      const sig = verifySignature(ctx.webhookSecret, rawBody, headers, now);
      if (!sig.ok) return { ok: false, code: sig.code, ...withClaim };
      const event = parseAirwallexEvent(rawBody);
      return event ? { ok: true, event } : { ok: false, code: 'malformed', ...withClaim };
    } catch {
      return { ok: false, code: 'malformed' };
    }
  }

  parseEvent(rawBody: Buffer): NormalisedEvent | null {
    try {
      return parseAirwallexEvent(rawBody);
    } catch {
      return null;
    }
  }
}
