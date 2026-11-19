// An in-process fake of the part of the Stripe API the adapter uses (plan docs/plans/3.3-stripe-adapter-ledger.md, 6.1):
// Checkout Sessions, PaymentIntents, refunds and events, with Stripe's idempotency (replay with Idempotent-Replayed,
// idempotency_error for other parameters, 400s not saved), keys, list filters and pagination. Built from Stripe's
// documentation; the real API is only checked by `test:sandbox` (blocked: no sandbox keys). No network.
import { createHash, randomBytes } from 'node:crypto';
import { signStripe } from '../../../src/modules/payments/adapters/stripe/mapping';
import type { StripeRequest, StripeResponse, StripeTransport } from '../../../src/modules/payments/adapters/stripe/stripe';

type Obj = Record<string, unknown>;

interface Session extends Obj {
  id: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'unpaid' | 'paid';
  amount_total: number;
  currency: string;
  payment_intent: string | null;
  metadata: Record<string, string>;
  created: number;
  expires_at: number;
}

interface Intent extends Obj {
  id: string;
  status: 'succeeded' | 'requires_payment_method' | 'processing' | 'canceled';
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

interface Refund extends Obj {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action';
  amount: number;
  currency: string;
  payment_intent: string;
  metadata: Record<string, string>;
  created: number;
}

class FakeAccount {
  readonly sessions = new Map<string, Session>();
  readonly intents = new Map<string, Intent>();
  readonly refunds = new Map<string, Refund>();
  /** Idempotency-Key → hash of the request and the saved answer. */
  readonly saved = new Map<string, { hash: string; res: StripeResponse }>();
  /** Status codes the next requests answer with (a 500 is saved under its key, as Stripe does). */
  readonly faults: number[] = [];
  readonly nextRefund: Array<Refund['status']> = [];
  createCalls = 0;
}

const id = (prefix: string) => `${prefix}_test_${randomBytes(12).toString('hex')}`;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): StripeResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const error = (status: number, type: string, code?: string) => json(status, { error: { type, ...(code ? { code } : {}), message: 'fake stripe error' } });

/** Parses Stripe's bracket notation (a[b][c]=v) into nested objects; arrays as objects with numeric keys. */
function nest(pairs: ReadonlyArray<[string, string]>): Obj {
  const out: Obj = {};
  for (const [k, v] of pairs) {
    const parts = k.replace(/\]/g, '').split('[');
    let o = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) o[p] = v;
      else o = (o[p] ??= {}) as Obj;
    });
  }
  return out;
}

export class FakeStripe {
  private readonly accounts = new Map<string, FakeAccount>();
  /** The clock of the fake; tests move it to make sessions expire or a retry come late. */
  now: () => Date = () => new Date();

  /** A new account: its secret key. Unknown keys get 401. */
  newAccount(): string {
    const key = `sk_test_${randomBytes(16).toString('hex')}`;
    this.accounts.set(key, new FakeAccount());
    return key;
  }

  account(key: string): FakeAccount {
    const a = this.accounts.get(key);
    if (!a) throw new Error('fake stripe: unknown account');
    return a;
  }

  readonly transport: StripeTransport = async (req) => this.handle(req);

  private seconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  private handle(req: StripeRequest): StripeResponse {
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const acc = key ? this.accounts.get(key) : undefined;
    if (!acc) return error(401, 'invalid_request_error');
    if (req.headers['stripe-version'] !== '2026-10-28.endive') return error(400, 'invalid_request_error', 'api_version_invalid');
    const ik = req.headers['idempotency-key'];
    const hash = createHash('sha256').update(JSON.stringify([req.method, req.path, req.form ?? []])).digest('hex');
    if (req.method === 'POST' && ik) {
      const prior = acc.saved.get(ik);
      if (prior) return prior.hash === hash ? { ...prior.res, headers: { ...prior.res.headers, 'idempotent-replayed': 'true' } } : error(400, 'idempotency_error');
    }
    const fault = acc.faults.shift();
    const res = fault ? error(fault, fault >= 500 ? 'api_error' : 'invalid_request_error') : this.route(acc, req);
    // Stripe saves what started executing (2xx and 5xx), not a validation 400.
    if (req.method === 'POST' && ik && (res.status < 300 || res.status >= 500)) acc.saved.set(ik, { hash, res });
    return res;
  }

  private route(acc: FakeAccount, req: StripeRequest): StripeResponse {
    const q = new Map(req.query ?? []);
    const expandPi = (req.query ?? []).some(([k, v]) => k === 'expand[]' && (v === 'payment_intent' || v === 'data.payment_intent'));
    let m: RegExpExecArray | null;
    if (req.method === 'POST' && req.path === '/v1/checkout/sessions') return this.createSession(acc, nest(req.form ?? []));
    if (req.method === 'GET' && req.path === '/v1/checkout/sessions') return this.listSessions(acc, q, expandPi);
    if ((m = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(req.path)) && req.method === 'POST') {
      const s = acc.sessions.get(decodeURIComponent(m[1]!));
      if (!s) return error(404, 'invalid_request_error', 'resource_missing');
      if (s.status !== 'open') return error(400, 'invalid_request_error');
      s.status = 'expired';
      return json(200, this.view(acc, s, false));
    }
    if ((m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(req.path)) && req.method === 'GET') {
      const s = acc.sessions.get(decodeURIComponent(m[1]!));
      return s ? json(200, this.view(acc, s, expandPi)) : error(404, 'invalid_request_error', 'resource_missing');
    }
    if (req.method === 'POST' && req.path === '/v1/refunds') return this.createRefund(acc, nest(req.form ?? []));
    if (req.method === 'GET' && req.path === '/v1/refunds') {
      const pi = q.get('payment_intent');
      const data = [...acc.refunds.values()].filter((r) => !pi || r.payment_intent === pi).reverse();
      return json(200, { object: 'list', data, has_more: false });
    }
    if ((m = /^\/v1\/refunds\/([^/]+)$/.exec(req.path)) && req.method === 'GET') {
      const r = acc.refunds.get(decodeURIComponent(m[1]!));
      return r ? json(200, r) : error(404, 'invalid_request_error', 'resource_missing');
    }
    return error(404, 'invalid_request_error');
  }

  private view(acc: FakeAccount, s: Session, expandPi: boolean): Obj {
    this.expireIfDue(s);
    const { pi_metadata: _hidden, ...out } = s;
    return { ...out, payment_intent: expandPi && s.payment_intent ? acc.intents.get(s.payment_intent) ?? s.payment_intent : s.payment_intent };
  }

  private expireIfDue(s: Session): void {
    if (s.status === 'open' && s.expires_at <= this.seconds()) s.status = 'expired';
  }

  private createSession(acc: FakeAccount, f: Obj): StripeResponse {
    acc.createCalls += 1;
    const item = ((f.line_items as Obj | undefined)?.['0'] as Obj | undefined) ?? {};
    const price = (item.price_data as Obj | undefined) ?? {};
    const amount = Number(price.unit_amount);
    const currency = String(price.currency ?? '');
    const expiresAt = Number(f.expires_at);
    const now = this.seconds();
    if (f.mode !== 'payment' || currency !== 'aud' || !Number.isSafeInteger(amount) || amount < 50 || amount > 99_999_999) return error(400, 'invalid_request_error');
    if (!Number.isSafeInteger(expiresAt) || expiresAt < now + 30 * 60 || expiresAt > now + 24 * 3600) return error(400, 'invalid_request_error', 'parameter_invalid_integer');
    if (typeof f.success_url !== 'string' || typeof f.cancel_url !== 'string') return error(400, 'invalid_request_error');
    const s: Session = {
      id: id('cs'), object: 'checkout.session', status: 'open', payment_status: 'unpaid', amount_total: amount, currency, payment_intent: null,
      metadata: { ...((f.metadata as Record<string, string>) ?? {}) }, client_reference_id: f.client_reference_id ?? null, created: now, expires_at: expiresAt,
      livemode: false, mode: 'payment', success_url: f.success_url, url: '',
      pi_metadata: { ...(((f.payment_intent_data as Obj | undefined)?.metadata as Record<string, string>) ?? {}) },
    };
    s.url = `https://checkout.stripe.com/c/pay/${s.id}`;
    acc.sessions.set(s.id, s);
    return json(200, this.view(acc, s, false));
  }

  private listSessions(acc: FakeAccount, q: Map<string, string>, expandPi: boolean): StripeResponse {
    const gte = q.has('created[gte]') ? Number(q.get('created[gte]')) : -Infinity;
    const lte = q.has('created[lte]') ? Number(q.get('created[lte]')) : Infinity;
    const limit = Math.min(Number(q.get('limit') ?? 10), 100);
    const pi = q.get('payment_intent');
    let all = [...acc.sessions.values()].filter((s) => s.created >= gte && s.created <= lte && (!pi || s.payment_intent === pi)).reverse();
    const after = q.get('starting_after');
    if (after) all = all.slice(all.findIndex((s) => s.id === after) + 1);
    return json(200, { object: 'list', data: all.slice(0, limit).map((s) => this.view(acc, s, expandPi)), has_more: all.length > limit });
  }

  private createRefund(acc: FakeAccount, f: Obj): StripeResponse {
    const pi = acc.intents.get(String(f.payment_intent ?? ''));
    if (!pi) return error(404, 'invalid_request_error', 'resource_missing');
    if (pi.status !== 'succeeded') return error(400, 'invalid_request_error', 'charge_not_refundable');
    const amount = f.amount === undefined ? this.left(acc, pi) : Number(f.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > this.left(acc, pi)) return error(400, 'invalid_request_error', 'amount_too_large');
    const r: Refund = { id: id('re'), object: 'refund', status: acc.nextRefund.shift() ?? 'succeeded', amount, currency: pi.currency, payment_intent: pi.id, metadata: { ...((f.metadata as Record<string, string>) ?? {}) }, created: this.seconds() };
    acc.refunds.set(r.id, r);
    return json(200, r);
  }

  private left(acc: FakeAccount, pi: Intent): number {
    let left = pi.amount;
    for (const r of acc.refunds.values()) if (r.payment_intent === pi.id && r.status !== 'failed' && r.status !== 'canceled') left -= r.amount;
    return left;
  }

  // ---- What the customer or the dashboard does ----

  private openSession(key: string, sessionId: string): Session {
    const s = this.account(key).sessions.get(sessionId);
    if (!s) throw new Error('fake stripe: unknown session');
    this.expireIfDue(s);
    if (s.status !== 'open') throw new Error('fake stripe: the session is not open');
    return s;
  }

  /** The customer pays with Stripe's test card 4242…: a PaymentIntent that succeeded, the session complete and paid. */
  pay(key: string, sessionId: string): void {
    const s = this.openSession(key, sessionId);
    const pi: Intent = { id: id('pi'), object: 'payment_intent', status: 'succeeded', amount: s.amount_total, currency: s.currency, metadata: { ...(s.pi_metadata as Record<string, string>) }, livemode: false };
    this.account(key).intents.set(pi.id, pi);
    Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi.id });
  }

  /** A declined card (4000 0000 0000 0002): Checkout shows the error and the session stays open. */
  decline(key: string, sessionId: string): void {
    this.openSession(key, sessionId);
  }

  /** The session reaches its expires_at (or is expired from the dashboard). */
  expire(key: string, sessionId: string): void {
    this.openSession(key, sessionId).status = 'expired';
  }

  /** An asynchronous method that failed after the customer finished (BECS-like). */
  asyncFail(key: string, sessionId: string): void {
    const s = this.openSession(key, sessionId);
    const pi: Intent = { id: id('pi'), object: 'payment_intent', status: 'requires_payment_method', amount: s.amount_total, currency: s.currency, metadata: {}, livemode: false, last_payment_error: { code: 'debit_not_authorized' } };
    this.account(key).intents.set(pi.id, pi);
    Object.assign(s, { status: 'complete', payment_status: 'unpaid', payment_intent: pi.id });
  }

  /** A refund made on the Stripe dashboard: no metadata of ours. */
  dashboardRefund(key: string, sessionId: string, amount: number, status: Refund['status'] = 'succeeded'): Refund {
    const acc = this.account(key);
    const s = acc.sessions.get(sessionId);
    const pi = s?.payment_intent ? acc.intents.get(s.payment_intent) : undefined;
    if (!pi || pi.status !== 'succeeded' || amount <= 0 || amount > this.left(acc, pi)) throw new Error('fake stripe: refund refused');
    const r: Refund = { id: id('re'), object: 'refund', status, amount, currency: pi.currency, payment_intent: pi.id, metadata: {}, created: this.seconds() };
    acc.refunds.set(r.id, r);
    return r;
  }

  setRefundStatus(key: string, refundId: string, status: Refund['status']): void {
    const r = this.account(key).refunds.get(refundId);
    if (!r) throw new Error('fake stripe: unknown refund');
    r.status = status;
  }

  /** The event Stripe would send now for a session or a refund, as raw bytes and its signature header. */
  event(key: string, webhookSecret: string, objectId: string, at: Date, opts: { type?: string; eventId?: string } = {}): { body: Buffer; headers: Record<string, string>; eventId: string } {
    const acc = this.account(key);
    const s = acc.sessions.get(objectId);
    const r = acc.refunds.get(objectId);
    if (!s && !r) throw new Error('fake stripe: unknown object');
    if (s) this.expireIfDue(s);
    const type = opts.type ?? (s ? (s.status === 'expired' ? 'checkout.session.expired' : 'checkout.session.completed') : r!.status === 'failed' ? 'refund.failed' : 'refund.updated');
    const object = s ? { ...s } : { ...r };
    delete (object as Obj).pi_metadata;
    const eventId = opts.eventId ?? id('evt');
    const body = Buffer.from(JSON.stringify({ id: eventId, object: 'event', api_version: '2026-10-28.endive', type, created: Math.floor(at.getTime() / 1000), livemode: false, data: { object } }));
    return { body, eventId, headers: { 'content-type': 'application/json', 'stripe-signature': signStripe(webhookSecret, body, at) } };
  }
}
