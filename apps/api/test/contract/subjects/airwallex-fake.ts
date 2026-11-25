// An in-process fake of the part of Airwallex's API the adapter uses (plan docs/plans/9.2-airwallex.md, sections 2, 13,
// 19 and 20): login, Checkout Sessions (create, read, list, cancel, one-hour expiry), PaymentIntents (created only when
// a checkout completes; read, list, cancel), refunds (create, read, list) and signed events. Built from Airwallex's
// documentation as read through a summarising tool, so it is UNVERIFIED: only `test:sandbox` checks the real API. It
// emits only the event names the plan lists (checkout_session.created/.cancelled/.completed, payment_intent.*,
// refund.*); it never emits a payment_intent event before a payment. No network.
import { randomBytes } from 'node:crypto';
import type { AirwallexRequest, AirwallexResponse, AirwallexTransport } from '../../../src/modules/payments/adapters/airwallex/http';
import { signAirwallex } from '../../../src/modules/payments/adapters/airwallex/mapping';
import { ProviderError } from '../../../src/modules/payments/core/provider';

type Obj = Record<string, unknown>;

export const FAKE_CHECKOUT_ORIGIN = 'https://checkout.sandbox.airwallex.com';
const HOUR_MS = 3_600_000;

interface Session {
  id: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
  url: string;
  created: number;
  expires: number;
  currency: string;
  unitAmount: string;
  merchantOrderId: string;
  metadata: Record<string, string>;
  paymentIntentId: string | null;
}

interface Intent {
  id: string;
  status: string;
  amount: string;
  currency: string;
  merchantOrderId: string | undefined;
  created: number;
}

interface Refund {
  id: string;
  status: 'RECEIVED' | 'ACCEPTED' | 'SETTLED' | 'FAILED';
  amount: string;
  currency: string;
  paymentIntentId: string;
  metadata: Record<string, string>;
  created: number;
}

class FakeAccount {
  readonly sessions = new Map<string, Session>();
  readonly intents = new Map<string, Intent>();
  readonly refunds = new Map<string, Refund>();
  readonly requestIds = new Set<string>();
  /** Money requests received, by our ref (sessions created) or intent id (refunds). */
  readonly posts = { session: new Map<string, number>(), refund: new Map<string, number>() };
  constructor(readonly clientId: string, readonly apiKey: string) {}
}

const minor = (decimal: string): bigint => {
  const [u, f = ''] = decimal.split('.');
  return BigInt(u!) * 100n + BigInt(f.padEnd(2, '0'));
};
const decimal = (m: bigint): string => `${m / 100n}.${(m % 100n).toString().padStart(2, '0')}`;

export class FakeAirwallex {
  private readonly accounts = new Map<string, FakeAccount>();
  private readonly tokens = new Map<string, FakeAccount>();
  private clock: (() => Date) | undefined;
  /** Plan 19.2: when set, every list ignores its query filters (all objects of the account, still paged). */
  ignoreFilters = false;
  /** Plan 19.5 and 20.3: when set, list items of sessions and intents come without metadata and order ids. */
  listsWithoutOrderFields = false;
  /** When set, a GET of one session or intent also omits them. */
  getsWithoutOrderFields = false;
  /** Code review 9.2, point 1: refund list items (and, if set, a GET of one refund) come without their metadata object. */
  refundListsWithoutMetadata = false;
  refundGetsWithoutMetadata = false;
  /** Code review 9.2, point 1: when false, a repeated request_id is not recognised (A24 false): a second object is made. */
  rememberRequestIds = true;
  /** Refunds settle at once (SETTLED) unless set to stay RECEIVED or to go ACCEPTED. */
  refundOutcome: 'SETTLED' | 'RECEIVED' | 'ACCEPTED' | 'FAILED' = 'SETTLED';
  /** Every request, for tests that count them. */
  readonly log: Array<{ method: string; path: string; body?: string }> = [];
  /** Tests set these: the next matching request is processed, then its answer is lost (a timeout). */
  private lose: Array<(req: AirwallexRequest) => boolean> = [];
  /** Tests set these: something happens at Airwallex just before the next matching request is handled. */
  private before: Array<{ match: (req: AirwallexRequest) => boolean; run: () => void }> = [];
  /** Tests set these: the next matching request fails with this status before doing anything. */
  private fail: Array<{ match: (req: AirwallexRequest) => boolean; status: number; code?: string }> = [];

  now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  setClock(clock: () => Date): void {
    this.clock = clock;
  }

  newAccount(): { clientId: string; apiKey: string } {
    const a = new FakeAccount(`C${randomBytes(12).toString('hex')}`, randomBytes(32).toString('hex'));
    this.accounts.set(a.clientId, a);
    return { clientId: a.clientId, apiKey: a.apiKey };
  }

  account(clientId: string): FakeAccount {
    const a = this.accounts.get(clientId);
    if (!a) throw new Error('fake airwallex: unknown account');
    return a;
  }

  loseNext(match: (req: AirwallexRequest) => boolean): void {
    this.lose.push(match);
  }

  beforeNext(match: (req: AirwallexRequest) => boolean, run: () => void): void {
    this.before.push({ match, run });
  }

  failNext(match: (req: AirwallexRequest) => boolean, status: number, code?: string): void {
    this.fail.push({ match, status, code });
  }

  readonly transport: AirwallexTransport = async (req) => {
    const u = new URL(req.url);
    if (u.origin !== 'https://api.sandbox.airwallex.com') throw new Error(`fake airwallex: unexpected host ${u.origin}`);
    this.log.push({ method: req.method, path: u.pathname, ...(req.body ? { body: req.body } : {}) });
    const b = this.before.findIndex((x) => x.match(req));
    if (b >= 0) this.before.splice(b, 1)[0]!.run();
    const f = this.fail.findIndex((x) => x.match(req));
    if (f >= 0) {
      const [x] = this.fail.splice(f, 1);
      return json(x!.status, x!.code ? { code: x!.code, message: 'fake' } : {});
    }
    const res = this.handle(req, u);
    const l = this.lose.findIndex((m) => m(req));
    if (l >= 0) {
      this.lose.splice(l, 1);
      throw new ProviderError('provider_timeout', true);
    }
    return res;
  };

  private handle(req: AirwallexRequest, u: URL): AirwallexResponse {
    const path = u.pathname;
    if (req.headers['x-api-version'] !== '2026-05-29') return json(400, { code: 'validation_error', message: 'api version' });
    if (path === '/api/v1/authentication/login' && req.method === 'POST') {
      const a = this.accounts.get(req.headers['x-client-id'] ?? '');
      if (!a || a.apiKey !== req.headers['x-api-key']) return json(401, { code: 'unauthorized', message: 'bad credentials' });
      const token = randomBytes(24).toString('hex');
      this.tokens.set(token, a);
      return json(201, { token, expires_at: new Date(this.now().getTime() + 30 * 60_000).toISOString() });
    }
    const a = this.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (!a) return json(401, { code: 'unauthorized', message: 'no token' });
    this.expireDue(a);
    const q = u.searchParams;
    const body = req.body ? (JSON.parse(req.body) as Obj) : {};
    let m: RegExpExecArray | null;
    if (path === '/api/v1/checkout/checkout_sessions/create' && req.method === 'POST') return this.createSession(a, body);
    if (path === '/api/v1/checkout/checkout_sessions' && req.method === 'GET') {
      return this.list(q, [...a.sessions.values()].filter((s) => this.ignoreFilters || this.inWindow(q, s.created)).map((s) => this.sessionJson(s, this.listsWithoutOrderFields)));
    }
    if ((m = /^\/api\/v1\/checkout\/checkout_sessions\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const s = a.sessions.get(m[1]!);
      return s ? json(200, this.sessionJson(s, this.getsWithoutOrderFields)) : json(404, { code: 'resource_not_found', message: 'no session' });
    }
    if ((m = /^\/api\/v1\/checkout\/checkout_sessions\/([^/]+)\/cancel$/.exec(path)) && req.method === 'POST') {
      const s = a.sessions.get(m[1]!);
      if (!s) return json(404, { code: 'resource_not_found', message: 'no session' });
      if (s.status !== 'ACTIVE') return json(400, { code: 'validation_error', message: 'only ACTIVE sessions can be cancelled' });
      s.status = 'CANCELLED';
      return json(200, this.sessionJson(s, false));
    }
    if (path === '/api/v1/pa/payment_intents' && req.method === 'GET') {
      const moid = q.get('merchant_order_id');
      return this.list(q, [...a.intents.values()].filter((i) => this.ignoreFilters || ((!moid || i.merchantOrderId === moid) && this.inWindow(q, i.created))).map((i) => this.intentJson(i, this.listsWithoutOrderFields)));
    }
    if ((m = /^\/api\/v1\/pa\/payment_intents\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const i = a.intents.get(m[1]!);
      return i ? json(200, this.intentJson(i, this.getsWithoutOrderFields)) : json(404, { code: 'resource_not_found', message: 'no intent' });
    }
    if ((m = /^\/api\/v1\/pa\/payment_intents\/([^/]+)\/cancel$/.exec(path)) && req.method === 'POST') {
      const i = a.intents.get(m[1]!);
      if (!i) return json(404, { code: 'resource_not_found', message: 'no intent' });
      if (!['REQUIRES_PAYMENT_METHOD', 'REQUIRES_CUSTOMER_ACTION', 'REQUIRES_CAPTURE'].includes(i.status)) return json(400, { code: 'validation_error', message: 'cannot cancel' });
      i.status = 'CANCELLED';
      return json(200, this.intentJson(i, false));
    }
    if (path === '/api/v1/pa/refunds/create' && req.method === 'POST') return this.createRefund(a, body, req.body ?? '');
    if (path === '/api/v1/pa/refunds' && req.method === 'GET') {
      const pi = q.get('payment_intent_id');
      return this.list(q, [...a.refunds.values()].filter((r) => this.ignoreFilters || !pi || r.paymentIntentId === pi).map((r) => this.refundJson(r, this.refundListsWithoutMetadata)));
    }
    if ((m = /^\/api\/v1\/pa\/refunds\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const r = a.refunds.get(m[1]!);
      return r ? json(200, this.refundJson(r, this.refundGetsWithoutMetadata)) : json(404, { code: 'resource_not_found', message: 'no refund' });
    }
    return json(404, { code: 'resource_not_found', message: `no route ${req.method} ${path}` });
  }

  private inWindow(q: URLSearchParams, created: number): boolean {
    const from = q.get('from_created_at');
    const to = q.get('to_created_at');
    return (!from || created >= Date.parse(from)) && (!to || created <= Date.parse(to));
  }

  /** Pages of `page_size` with a `page_after` cursor (an index), as the checkout sessions list documents. */
  private list(q: URLSearchParams, all: Obj[]): AirwallexResponse {
    const size = Math.min(Number(q.get('page_size') ?? '20'), 100);
    const start = Number(q.get('page') ?? '0');
    const items = all.slice(start, start + size);
    return json(200, { items, ...(start + size < all.length ? { page_after: String(start + size) } : {}) });
  }

  private expireDue(a: FakeAccount): void {
    const t = this.now().getTime();
    for (const s of a.sessions.values()) if (s.status === 'ACTIVE' && t >= s.expires) s.status = 'EXPIRED';
  }

  private createSession(a: FakeAccount, b: Obj): AirwallexResponse {
    const requestId = String(b.request_id ?? '');
    if (!requestId || requestId.length > 64) return json(400, { code: 'validation_error', message: 'request_id' });
    if (this.rememberRequestIds && a.requestIds.has(requestId)) return json(400, { code: 'duplicate_request_id', message: 'duplicate' });
    const items = b.line_items as Array<{ quantity: number; price: { currency: string; unit_amount: string } }> | undefined;
    const pio = b.payment_intent_data as { merchant_order_id?: string } | undefined;
    const po = b.payment_options as { payment_method_types?: string[]; auto_capture?: boolean } | undefined;
    if (b.mode !== 'PAYMENT' || b.currency !== 'AUD' || !Array.isArray(items) || items.length !== 1 || items[0]!.quantity !== 1 || typeof items[0]!.price.unit_amount !== 'string') return json(400, { code: 'validation_error', message: 'body' });
    // bnpl_never_offered: a session that does not restrict the methods to cards is refused here.
    if (JSON.stringify(po?.payment_method_types) !== '["card"]' || po?.auto_capture !== true) return json(400, { code: 'validation_error', message: 'payment options' });
    if (!pio?.merchant_order_id || pio.merchant_order_id.length > 64) return json(400, { code: 'validation_error', message: 'merchant_order_id' });
    a.requestIds.add(requestId);
    const id = `cs_${randomBytes(10).toString('hex')}`;
    const created = this.now().getTime();
    const s: Session = {
      id, status: 'ACTIVE', url: `${FAKE_CHECKOUT_ORIGIN}/pay?s=${randomBytes(16).toString('hex')}`, created, expires: created + HOUR_MS,
      currency: 'AUD', unitAmount: items[0]!.price.unit_amount, merchantOrderId: pio.merchant_order_id, metadata: { ...(b.metadata as Record<string, string>) }, paymentIntentId: null,
    };
    a.sessions.set(id, s);
    a.posts.session.set(s.merchantOrderId, (a.posts.session.get(s.merchantOrderId) ?? 0) + 1);
    return json(201, this.sessionJson(s, false));
  }

  private createRefund(a: FakeAccount, b: Obj, raw: string): AirwallexResponse {
    const requestId = String(b.request_id ?? '');
    if (!requestId || requestId.length > 64) return json(400, { code: 'validation_error', message: 'request_id' });
    if (this.rememberRequestIds && a.requestIds.has(requestId)) return json(400, { code: 'duplicate_request_id', message: 'duplicate' });
    const i = a.intents.get(String(b.payment_intent_id ?? ''));
    if (!i) return json(404, { code: 'resource_not_found', message: 'no intent' });
    // The amount must be a JSON number written as a decimal literal (A21): read it from the raw text.
    const amountText = /"amount":([0-9]+(?:\.[0-9]{1,2})?)[,}]/.exec(raw)?.[1];
    if (!amountText || i.status !== 'SUCCEEDED') return json(400, { code: 'validation_error', message: 'amount or intent' });
    const used = [...a.refunds.values()].filter((r) => r.paymentIntentId === i.id && r.status !== 'FAILED').reduce((s, r) => s + minor(r.amount), 0n);
    if (minor(amountText) <= 0n || used + minor(amountText) > minor(i.amount)) return json(400, { code: 'validation_error', message: 'over the refundable amount' });
    a.requestIds.add(requestId);
    const r: Refund = { id: `rfd_${randomBytes(10).toString('hex')}`, status: this.refundOutcome, amount: amountText, currency: i.currency, paymentIntentId: i.id, metadata: { ...((b.metadata as Record<string, string>) ?? {}) }, created: this.now().getTime() };
    a.refunds.set(r.id, r);
    a.posts.refund.set(i.id, (a.posts.refund.get(i.id) ?? 0) + 1);
    return json(201, this.refundJson(r));
  }

  sessionJson(s: Session, withoutOrderFields: boolean): Obj {
    return {
      id: s.id, status: s.status, mode: 'PAYMENT', ui_mode: 'HOSTED', currency: s.currency, created_at: new Date(s.created).toISOString(), expires_at: new Date(s.expires).toISOString(),
      ...(s.status === 'ACTIVE' ? { url: s.url } : {}), line_items: [{ price_id: `pri_${s.id.slice(3)}`, quantity: 1 }],
      ...(s.paymentIntentId ? { payment_intent_id: s.paymentIntentId } : {}),
      ...(withoutOrderFields || s.merchantOrderId === '' ? {} : { metadata: s.metadata, payment_intent_data: { merchant_order_id: s.merchantOrderId } }),
    };
  }

  intentJson(i: Intent, withoutOrderFields: boolean): Obj {
    return { id: i.id, status: i.status, amount: new RawNumber(i.amount), currency: i.currency, created_at: new Date(i.created).toISOString(), ...(withoutOrderFields || i.merchantOrderId === undefined ? {} : { merchant_order_id: i.merchantOrderId }), captured_amount: new RawNumber(i.status === 'SUCCEEDED' ? i.amount : '0') };
  }

  refundJson(r: Refund, withoutMetadata = false): Obj {
    return { id: r.id, status: r.status, amount: new RawNumber(r.amount), currency: r.currency, payment_intent_id: r.paymentIntentId, ...(withoutMetadata ? {} : { metadata: r.metadata }), created_at: new Date(r.created).toISOString() };
  }

  // ---- What the customer, the gateway and staff do ----

  sessionOfRef(clientId: string, ref: string): Session {
    const s = [...this.account(clientId).sessions.values()].find((x) => x.merchantOrderId === ref);
    if (!s) throw new Error('fake airwallex: no session for that ref');
    return s;
  }

  /** The customer pays on the hosted page: the checkout completes and its intent is created, SUCCEEDED (or as told). */
  pay(clientId: string, ref: string, status = 'SUCCEEDED'): Intent {
    const a = this.account(clientId);
    this.expireDue(a);
    const s = this.sessionOfRef(clientId, ref);
    if (s.status !== 'ACTIVE') throw new Error(`fake airwallex: the session is ${s.status}`);
    const i: Intent = { id: `int_${randomBytes(10).toString('hex')}`, status, amount: s.unitAmount, currency: s.currency, merchantOrderId: s.merchantOrderId, created: this.now().getTime() };
    a.intents.set(i.id, i);
    s.paymentIntentId = i.id;
    if (status !== 'REQUIRES_CUSTOMER_ACTION' && status !== 'REQUIRES_PAYMENT_METHOD') s.status = 'COMPLETED';
    return i;
  }

  /** A declined card: the checkout stays ACTIVE (stays_payable), nothing is created (A3). */
  decline(clientId: string, ref: string): void {
    const s = this.sessionOfRef(clientId, ref);
    if (s.status !== 'ACTIVE') throw new Error(`fake airwallex: the session is ${s.status}`);
  }

  /** Airwallex ends an unpaid session: its one-hour expiry. */
  expire(clientId: string, ref: string): void {
    const s = this.sessionOfRef(clientId, ref);
    if (s.status === 'ACTIVE') s.status = 'EXPIRED';
  }

  setIntentStatus(clientId: string, intentId: string, status: string): void {
    this.account(clientId).intents.get(intentId)!.status = status;
  }

  intentOfRef(clientId: string, ref: string): Intent | undefined {
    return [...this.account(clientId).intents.values()].find((i) => i.merchantOrderId === ref);
  }

  /** A session made in the web app or by another integration: no metadata of ours, no order id. */
  foreignSession(clientId: string): Session {
    const a = this.account(clientId);
    const created = this.now().getTime();
    const s: Session = { id: `cs_${randomBytes(10).toString('hex')}`, status: 'ACTIVE', url: `${FAKE_CHECKOUT_ORIGIN}/pay?s=x`, created, expires: created + HOUR_MS, currency: 'AUD', unitAmount: '15.00', merchantOrderId: '', metadata: {}, paymentIntentId: null };
    a.sessions.set(s.id, s);
    return s;
  }

  /** Someone else's intent (another customer's payment of the same amount): its own order id. */
  foreignIntent(clientId: string, amount: string, merchantOrderId?: string): Intent {
    const a = this.account(clientId);
    const i: Intent = { id: `int_${randomBytes(10).toString('hex')}`, status: 'SUCCEEDED', amount, currency: 'AUD', merchantOrderId, created: this.now().getTime() };
    a.intents.set(i.id, i);
    return i;
  }

  /** A refund made in Airwallex's web app: no metadata of ours. */
  dashboardRefund(clientId: string, ref: string, amountMinor: bigint): Refund {
    const a = this.account(clientId);
    const i = this.intentOfRef(clientId, ref);
    if (!i) throw new Error('fake airwallex: nothing to refund');
    const r: Refund = { id: `rfd_${randomBytes(10).toString('hex')}`, status: 'SETTLED', amount: decimal(amountMinor), currency: i.currency, paymentIntentId: i.id, metadata: {}, created: this.now().getTime() };
    a.refunds.set(r.id, r);
    return r;
  }

  setRefundStatus(clientId: string, refundId: string, status: Refund['status']): void {
    this.account(clientId).refunds.get(refundId)!.status = status;
  }

  sessionPosts(clientId: string, ref: string): number {
    return this.account(clientId).posts.session.get(ref) ?? 0;
  }

  refundPosts(clientId: string, intentId: string): number {
    return this.account(clientId).posts.refund.get(intentId) ?? 0;
  }

  // ---- Events ----

  /** The event Airwallex would send now for a payment: its intent's if it has one, else its session's. */
  paymentEvent(clientId: string, ref: string, at: Date): Obj {
    const a = this.account(clientId);
    this.expireDue(a);
    const i = this.intentOfRef(clientId, ref);
    if (i) return envelope(`payment_intent.${i.status.toLowerCase()}`, this.intentJson(i, false), at);
    const s = this.sessionOfRef(clientId, ref);
    return envelope(s.status === 'CANCELLED' ? 'checkout_session.cancelled' : 'checkout_session.created', this.sessionJson(s, false), at);
  }

  refundEvent(clientId: string, refundId: string, at: Date): Obj {
    const r = this.account(clientId).refunds.get(refundId);
    if (!r) throw new Error('fake airwallex: no refund');
    return envelope(`refund.${r.status.toLowerCase()}`, this.refundJson(r), at);
  }
}

/** A JSON number written exactly as its decimal text (Airwallex sends amounts as numbers). */
export class RawNumber {
  constructor(readonly text: string) {}
}

function write(v: unknown): string {
  if (v instanceof RawNumber) return v.text;
  if (Array.isArray(v)) return `[${v.map(write).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}:${write(x)}`).join(',')}}`;
  return JSON.stringify(v);
}

function json(status: number, body: Obj): AirwallexResponse {
  return { status, body: write(body) };
}

function envelope(name: string, object: Obj, at: Date): Obj {
  return { id: `evt_${randomBytes(10).toString('hex')}`, name, account_id: 'acct_fake', created_at: at.toISOString(), data: { object } };
}

/** A signed delivery of an event, as Airwallex sends it: x-timestamp (ms) and x-signature over timestamp + body. */
export function signedDelivery(secret: string, event: Obj, at: Date): { body: Buffer; headers: Record<string, string> } {
  const body = Buffer.from(write(event));
  const ts = String(at.getTime());
  return { body, headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': signAirwallex(secret, ts, body) } };
}
