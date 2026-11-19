// An in-memory PayPal (plan docs/plans/4.3-paypal-adapter.md, section 10), for the local contract subject and the API
// tests. It follows the documented behaviour cited in the plan, and models the assumptions A1, A7, A8 and A9 so that
// both of their outcomes can be tested. It does not replace a sandbox run.
import { randomBytes, randomUUID, sign } from 'node:crypto';
import type { PayPalRequest, PayPalResponse, PayPalTransport } from '../../../src/modules/payments/adapters/paypal/paypal';
import { PAYPAL_CHECKOUT_ORIGIN } from '../../../src/modules/payments/adapters/paypal/paypal';
import { PAYPAL_HEADERS, PAYPAL_LEAF_NAMES, signedMessage } from '../../../src/modules/payments/adapters/paypal/webhook';
import type { CertificateTrust } from '../../../src/modules/payments/adapters/paypal/webhook';
import { REQUIRED_EVENT_TYPES } from '../../../src/modules/payments/adapters/paypal/mapping';
import { paypalTestChain } from './paypal-certs';

type Obj = Record<string, unknown>;
export type Instrument = 'good' | 'decline' | 'risk' | 'pending';
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const pid = (n = 17) => Array.from(randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join('');
const HOURS_3 = 3 * 3_600_000;
const VALUE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{2})?$/;
const minor = (v: string) => {
  const [u, f = '00'] = v.split('.');
  return BigInt(u!) * 100n + BigInt(f.padEnd(2, '0'));
};
const value = (m: bigint) => `${m / 100n}.${(m % 100n).toString().padStart(2, '0')}`;

interface Capture { id: string; orderId: string; status: string; amount: bigint; currency: string; customId?: string; refunded: bigint; createTime: string }
interface Refund { id: string; captureId: string; status: string; amount: bigint; currency: string; customId?: string; createTime: string }
interface Order {
  id: string; status: string; amount: bigint; currency: string; customId?: string; createdAt: number; createTime: string; updateTime: string;
  instrument?: Instrument; captureId?: string; refundIds: string[];
}
interface Stored { bodyText: string; reply: () => PayPalResponse }
interface Account { clientId: string; secret: string; webhookId: string; tokens: Set<string>; orders: Map<string, Order>; captures: Map<string, Capture>; refunds: Map<string, Refund>; idem: Map<string, Stored> }

export interface FakePayPalOptions {
  /** A9: how a request ID already used answers another body. `first_wins` (default): the stored answer, also a 4xx. */
  idempotency?: 'first_wins' | 'previously_used';
}

const json = (status: number, body: unknown): PayPalResponse => ({ status, body: body === undefined ? '' : JSON.stringify(body) });
const issue = (status: number, name: string, issueName?: string) => json(status, { name, message: 'fake', debug_id: 'fake', details: issueName ? [{ issue: issueName }] : [] });

export class FakePayPal {
  private readonly accounts = new Map<string, Account>();
  private readonly byToken = new Map<string, Account>();
  private offsetMs = 0;
  private tick = 0;
  readonly chain = paypalTestChain();
  readonly certUrl = `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-fake-${pid(8)}`;
  /** Captures actually executed (not replays), for A7. */
  captureExecutions = 0;
  /** Every request the adapter sent, for host and header checks. */
  readonly requests: PayPalRequest[] = [];
  /** How many certificate downloads were asked of the fake. */
  certDownloads = 0;
  /** A test sets this to make the certificate download fail. */
  certDown = false;

  constructor(private readonly opts: FakePayPalOptions = {}) {}

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  private stamp(): string {
    // Strictly increasing, so an approval always changes update_time.
    this.tick++;
    return new Date(this.now().getTime() + this.tick).toISOString();
  }

  /** A sandbox app: its client ID, secret and webhook ID (shapes like PayPal's, never real ones). */
  newAccount(): { clientId: string; clientSecret: string; webhookId: string } {
    const acc: Account = {
      clientId: `A${randomBytes(30).toString('base64url')}`, secret: `E${randomBytes(30).toString('base64url')}`, webhookId: pid(17),
      tokens: new Set(), orders: new Map(), captures: new Map(), refunds: new Map(), idem: new Map(),
    };
    this.accounts.set(acc.clientId, acc);
    return { clientId: acc.clientId, clientSecret: acc.secret, webhookId: acc.webhookId };
  }

  /** What prepareWebhook downloads: the fake's chain, only at its URL. */
  readonly trust: CertificateTrust = {
    roots: [this.chain.root.pem],
    leafNames: PAYPAL_LEAF_NAMES,
    fetch: async (url) => {
      this.certDownloads++;
      if (this.certDown || url !== this.certUrl) throw new Error('fake paypal: no certificate');
      return this.chain.chainPem;
    },
  };

  private account(clientId: string): Account {
    const a = this.accounts.get(clientId);
    if (!a) throw new Error('fake paypal: unknown account');
    return a;
  }

  private liveOrder(a: Account, id: string): Order | undefined {
    const o = a.orders.get(id);
    if (!o) return undefined;
    // PayPal forgets an order it never completed three hours after creating it (whats-an-order; community 404).
    if (o.status !== 'COMPLETED' && this.now().getTime() - o.createdAt > HOURS_3) return undefined;
    return o;
  }

  // ---- representations ----

  private captureRepr(c: Capture): Obj {
    return {
      id: c.id, status: c.status, amount: { currency_code: c.currency, value: value(c.amount) }, final_capture: true,
      ...(c.customId ? { custom_id: c.customId } : {}),
      supplementary_data: { related_ids: { order_id: c.orderId } }, create_time: c.createTime, update_time: c.createTime,
      links: [{ rel: 'self', href: `https://api.sandbox.paypal.com/v2/payments/captures/${c.id}`, method: 'GET' }],
    };
  }

  private refundRepr(r: Refund): Obj {
    return {
      id: r.id, status: r.status, amount: { currency_code: r.currency, value: value(r.amount) }, ...(r.customId ? { custom_id: r.customId } : {}),
      create_time: r.createTime, update_time: r.createTime,
      links: [
        { rel: 'self', href: `https://api.sandbox.paypal.com/v2/payments/refunds/${r.id}`, method: 'GET' },
        { rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${r.captureId}`, method: 'GET' },
      ],
    };
  }

  private orderRepr(a: Account, o: Order): Obj {
    const cap = o.captureId ? a.captures.get(o.captureId) : undefined;
    const payments = cap ? { payments: { captures: [this.captureRepr(cap)], refunds: o.refundIds.map((id) => this.refundRepr(a.refunds.get(id)!)) } } : {};
    const links: Obj[] = [{ rel: 'self', href: `https://api.sandbox.paypal.com/v2/checkout/orders/${o.id}`, method: 'GET' }];
    if (o.status !== 'COMPLETED') {
      links.push({ rel: o.status === 'PAYER_ACTION_REQUIRED' ? 'payer-action' : 'approve', href: `${PAYPAL_CHECKOUT_ORIGIN}/checkoutnow?token=${o.id}`, method: 'GET' });
      links.push({ rel: 'update', href: `https://api.sandbox.paypal.com/v2/checkout/orders/${o.id}`, method: 'PATCH' });
    }
    return {
      id: o.id, intent: 'CAPTURE', status: o.status, create_time: o.createTime, update_time: o.updateTime,
      purchase_units: [{ reference_id: 'default', ...(o.customId ? { custom_id: o.customId } : {}), description: 'Booking payment', amount: { currency_code: o.currency, value: value(o.amount) }, ...payments }],
      links,
    };
  }

  // ---- the payer and the dashboard ----

  /** The payer approves on PayPal's page with an instrument. Throws if PayPal would not show the page. */
  approve(clientId: string, orderId: string, instrument: Instrument): void {
    const a = this.account(clientId);
    const o = this.liveOrder(a, orderId);
    if (!o || o.status === 'COMPLETED' || o.status === 'VOIDED') throw new Error('fake paypal: this order cannot be approved');
    o.status = 'APPROVED';
    o.instrument = instrument;
    o.updateTime = this.stamp();
  }

  /** A refund made on PayPal's dashboard: no custom_id of ours. */
  dashboardRefund(clientId: string, orderId: string, amountMinor: bigint): Refund {
    const a = this.account(clientId);
    const o = a.orders.get(orderId);
    const c = o?.captureId ? a.captures.get(o.captureId) : undefined;
    if (!o || !c || c.amount - c.refunded < amountMinor) throw new Error('fake paypal: cannot refund');
    return this.refund(a, o, c, amountMinor, undefined);
  }

  private refund(a: Account, o: Order, c: Capture, amount: bigint, customId: string | undefined): Refund {
    const r: Refund = { id: pid(), captureId: c.id, status: 'COMPLETED', amount, currency: c.currency, customId, createTime: this.stamp() };
    a.refunds.set(r.id, r);
    o.refundIds.push(r.id);
    c.refunded += amount;
    c.status = c.refunded === c.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    return r;
  }

  /** The event PayPal would send now for an order or refund, signed at `at` for `webhookId`. */
  event(clientId: string, webhookId: string, ref: string, at: Date, opts: { eventId?: string; type?: string } = {}): { body: Buffer; headers: Record<string, string>; eventId: string } {
    const a = this.account(clientId);
    const o = a.orders.get(ref);
    const r = a.refunds.get(ref);
    let type: string;
    let resource: Obj;
    if (o) {
      const cap = o.captureId ? a.captures.get(o.captureId) : undefined;
      if (cap) {
        type = cap.status === 'PENDING' ? 'PAYMENT.CAPTURE.PENDING' : cap.status === 'DECLINED' || cap.status === 'FAILED' ? 'PAYMENT.CAPTURE.DECLINED' : 'PAYMENT.CAPTURE.COMPLETED';
        resource = this.captureRepr(cap);
      } else {
        type = 'CHECKOUT.ORDER.APPROVED';
        resource = this.orderRepr(a, o);
      }
    } else if (r) {
      type = r.status === 'PENDING' ? 'PAYMENT.REFUND.PENDING' : r.status === 'FAILED' ? 'PAYMENT.REFUND.FAILED' : 'PAYMENT.CAPTURE.REFUNDED';
      resource = this.refundRepr(r);
    } else throw new Error('fake paypal: unknown object');
    const eventId = opts.eventId ?? `WH-${pid(17)}-${pid(17)}`;
    const body = Buffer.from(JSON.stringify({
      id: eventId, event_version: '1.0', create_time: at.toISOString(), resource_type: 'fake', resource_version: '2.0',
      event_type: opts.type ?? type, summary: 'fake', resource, links: [],
    }));
    return { body, eventId, headers: this.sign(webhookId, body, at) };
  }

  /** PayPal's signature headers over `body` for `webhookId`, transmitted at `at`. */
  sign(webhookId: string, body: Buffer, at: Date): Record<string, string> {
    const transmissionId = randomUUID();
    const time = at.toISOString();
    const sig = sign('sha256', signedMessage(transmissionId, time, webhookId, body), this.chain.leaf.key).toString('base64');
    return {
      'content-type': 'application/json',
      [PAYPAL_HEADERS.transmissionId]: transmissionId, [PAYPAL_HEADERS.transmissionTime]: time, [PAYPAL_HEADERS.transmissionSig]: sig,
      [PAYPAL_HEADERS.certUrl]: this.certUrl, [PAYPAL_HEADERS.authAlgo]: 'SHA256withRSA',
    };
  }

  /** Test access to an order's state. */
  order(clientId: string, orderId: string): Order | undefined {
    return this.account(clientId).orders.get(orderId);
  }

  // ---- the API ----

  readonly transport: PayPalTransport = async (req) => {
    this.requests.push(req);
    const url = new URL(req.url);
    if (url.origin !== 'https://api-m.sandbox.paypal.com') throw new Error(`fake paypal: request to ${url.origin}`);
    const path = url.pathname;
    if (req.method === 'POST' && path === '/v1/oauth2/token') return this.token(req);
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const a = auth ? this.byToken.get(auth[1]!) : undefined;
    if (!a) return json(401, { name: 'AUTHENTICATION_FAILURE', message: 'fake' });
    const body = (() => {
      try {
        return req.body ? (JSON.parse(req.body) as unknown) : undefined;
      } catch {
        return undefined;
      }
    })();
    const requestId = req.headers['paypal-request-id'];
    let m: RegExpExecArray | null;
    if (req.method === 'POST' && path === '/v2/checkout/orders') return this.idempotent(a, 'orders.create', requestId, req.body ?? '', () => this.createOrder(a, body));
    if ((m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(path))) {
      const o = this.liveOrder(a, m[1]!);
      if (!o) return issue(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
      if (req.method === 'GET') return json(200, this.orderRepr(a, o));
      if (req.method === 'PATCH') return this.patch(o, body);
    }
    if (req.method === 'POST' && (m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(path))) {
      const id = m[1]!;
      return this.idempotent(a, 'orders.capture', requestId, req.body ?? '', () => this.capture(a, id));
    }
    if (req.method === 'GET' && (m = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(path))) {
      const c = a.captures.get(m[1]!);
      return c ? json(200, this.captureRepr(c)) : issue(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    }
    if (req.method === 'POST' && (m = /^\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/.exec(path))) {
      const id = m[1]!;
      return this.idempotent(a, 'captures.refund', requestId, req.body ?? '', () => this.refundCall(a, id, body));
    }
    if (req.method === 'GET' && (m = /^\/v2\/payments\/refunds\/([A-Z0-9]+)$/.exec(path))) {
      const r = a.refunds.get(m[1]!);
      return r ? json(200, this.refundRepr(r)) : issue(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    }
    if (req.method === 'GET' && (m = /^\/v1\/notifications\/webhooks\/([A-Za-z0-9]+)$/.exec(path))) {
      if (m[1] !== a.webhookId) return issue(404, 'INVALID_RESOURCE_ID');
      return json(200, { id: a.webhookId, url: 'https://example.com/api/payments/webhooks/x', event_types: REQUIRED_EVENT_TYPES.map((name) => ({ name })) });
    }
    return issue(404, 'NOT_FOUND');
  };

  private token(req: PayPalRequest): PayPalResponse {
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    const [id, secret] = basic ? Buffer.from(basic[1]!, 'base64').toString('utf8').split(':') : [];
    const a = id ? this.accounts.get(id) : undefined;
    if (!a || a.secret !== secret || req.body !== 'grant_type=client_credentials') return json(401, { error: 'invalid_client', error_description: 'fake' });
    const t = `A21AA${randomBytes(24).toString('base64url')}`;
    a.tokens.add(t);
    this.byToken.set(t, a);
    return json(200, { scope: 'https://uri.paypal.com/services/payments', access_token: t, token_type: 'Bearer', app_id: 'APP-FAKE', expires_in: 32400, nonce: 'fake' });
  }

  /** PayPal-Request-Id (idempotency.md): a repeat answers with the current state of the first request's object (A1). */
  private idempotent(a: Account, api: string, requestId: string | undefined, bodyText: string, run: () => PayPalResponse): PayPalResponse {
    if (!requestId) return run();
    const key = `${api}:${requestId}`;
    const stored = a.idem.get(key);
    if (stored) {
      if (this.opts.idempotency === 'previously_used' && stored.bodyText !== bodyText) return issue(422, 'UNPROCESSABLE_ENTITY', 'PAYPAL_REQUEST_ID_PREVIOUSLY_USED');
      return stored.reply();
    }
    const first = run();
    const objectId = first.status < 300 ? (JSON.parse(first.body) as Obj).id : undefined;
    const reply = (): PayPalResponse => {
      if (typeof objectId !== 'string') return first;
      const o = a.orders.get(objectId);
      if (o) return json(first.status, this.orderRepr(a, o));
      const r = a.refunds.get(objectId);
      return r ? json(first.status, this.refundRepr(r)) : first;
    };
    // An order answer is the order (capture answers too); keep the order id for capture replays.
    a.idem.set(key, { bodyText, reply });
    return first;
  }

  private createOrder(a: Account, body: unknown): PayPalResponse {
    const b = body as Obj | undefined;
    const units = Array.isArray(b?.purchase_units) ? (b!.purchase_units as Obj[]) : [];
    const amount = units[0]?.amount as Obj | undefined;
    if (b?.intent !== 'CAPTURE' || units.length !== 1 || !amount || typeof amount.value !== 'string' || !VALUE.test(amount.value) || typeof amount.currency_code !== 'string') {
      return issue(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER');
    }
    const t = this.stamp();
    const o: Order = {
      id: pid(), status: b.payment_source ? 'PAYER_ACTION_REQUIRED' : 'CREATED', amount: minor(amount.value), currency: amount.currency_code,
      customId: typeof units[0]!.custom_id === 'string' ? (units[0]!.custom_id as string) : undefined,
      createdAt: this.now().getTime(), createTime: t, updateTime: t, refundIds: [],
    };
    a.orders.set(o.id, o);
    return json(201, this.orderRepr(a, o));
  }

  private patch(o: Order, body: unknown): PayPalResponse {
    // Orders v2 PATCH: CREATED or APPROVED only (orders-patch).
    if (o.status !== 'CREATED' && o.status !== 'APPROVED') return issue(422, 'UNPROCESSABLE_ENTITY', 'ORDER_CANNOT_BE_PATCHED');
    const ops = Array.isArray(body) ? (body as Obj[]) : [];
    for (const op of ops) {
      if (op.op !== 'replace' || op.path !== "/purchase_units/@reference_id=='default'/custom_id" || typeof op.value !== 'string') return issue(422, 'UNPROCESSABLE_ENTITY', 'INVALID_PATCH_OPERATION');
      o.customId = op.value;
    }
    o.updateTime = this.stamp();
    return { status: 204, body: '' };
  }

  private capture(a: Account, id: string): PayPalResponse {
    const o = this.liveOrder(a, id);
    if (!o) return issue(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    if (o.status === 'COMPLETED') return issue(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED');
    if (o.status !== 'APPROVED') return issue(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED');
    this.captureExecutions++;
    // A7: a declined instrument leaves the order approved and update_time unchanged; the payer must approve again.
    if (o.instrument === 'decline') return issue(422, 'UNPROCESSABLE_ENTITY', 'INSTRUMENT_DECLINED');
    const status = o.instrument === 'risk' ? 'DECLINED' : o.instrument === 'pending' ? 'PENDING' : 'COMPLETED';
    const c: Capture = { id: pid(), orderId: o.id, status, amount: o.amount, currency: o.currency, customId: o.customId, refunded: 0n, createTime: this.stamp() };
    a.captures.set(c.id, c);
    o.captureId = c.id;
    o.status = 'COMPLETED';
    o.updateTime = c.createTime;
    return json(201, this.orderRepr(a, o));
  }

  /** Test helper: a pending capture settles at PayPal. */
  settleCapture(clientId: string, orderId: string, to: 'COMPLETED' | 'DECLINED'): void {
    const a = this.account(clientId);
    const c = a.captures.get(a.orders.get(orderId)!.captureId!)!;
    c.status = to;
  }

  private refundCall(a: Account, captureId: string, body: unknown): PayPalResponse {
    const c = a.captures.get(captureId);
    if (!c) return issue(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    const o = a.orders.get(c.orderId)!;
    if (c.status !== 'COMPLETED' && c.status !== 'PARTIALLY_REFUNDED') return issue(422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_FULLY_REFUNDED');
    const b = (body ?? {}) as Obj;
    const amt = b.amount as Obj | undefined;
    const amount = amt ? (typeof amt.value === 'string' && VALUE.test(amt.value) ? minor(amt.value) : -1n) : c.amount - c.refunded;
    if (amount <= 0n || (amt && amt.currency_code !== c.currency)) return issue(422, 'UNPROCESSABLE_ENTITY', 'REFUND_AMOUNT_EXCEEDED');
    if (amount > c.amount - c.refunded) return issue(422, 'UNPROCESSABLE_ENTITY', 'REFUND_AMOUNT_EXCEEDED');
    const r = this.refund(a, o, c, amount, typeof b.custom_id === 'string' ? b.custom_id : undefined);
    return json(201, this.refundRepr(r));
  }
}
