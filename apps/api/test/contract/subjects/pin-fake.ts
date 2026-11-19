// A Pin Payments double in memory (plan docs/plans/4.4-au-card-gateway.md, section 12.1): only the documented resources
// and shapes (charges with 3-D Secure, search, verify, refunds, balance, webhook endpoints, signed events). Answers are
// wrapped in `response` as Pin's examples show. Switches model the failure paths the tests need.
import { randomBytes } from 'node:crypto';
import type { PinRequest, PinResponse, PinTransport } from '../../../src/modules/payments/adapters/pin_payments/pin';
import { PIN_SIGNATURE_HEADER, pinSignature } from '../../../src/modules/payments/adapters/pin_payments/webhook';
import { ProviderError } from '../../../src/modules/payments/core/provider';

type Outcome = 'pay' | 'decline' | 'pay_frictionless';

interface FakeCharge {
  token: string; success: boolean; captured: boolean; status_message: 'Success' | 'Pending' | 'Failed'; amount: number; currency: string;
  amount_refunded: number; metadata: Record<string, string>; created_at: string; error_message: string | null;
  challengeOutcome?: 'pay' | 'decline'; sessionToken?: string;
}
interface FakeRefund { token: string; charge: string; amount: number; currency: string; status_message: 'Pending' | 'Success' | 'Failed'; success: boolean | null; error_message: string | null; created_at: string }
interface FakeAccount { secretKey: string; publishableKey: string; webhookKey: string; charges: Map<string, FakeCharge>; refunds: Map<string, FakeRefund>; tokens: Map<string, Outcome> }

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x')}`;
const json = (status: number, body: unknown): PinResponse => ({ status, body: JSON.stringify(body) });

export interface FakePinSwitches {
  /** The next charge POST: Pin makes the charge, but the answer is lost (timeout after). */
  loseNextChargeAnswer?: boolean;
  /** The next charge POST fails before reaching Pin. */
  failNextChargeBefore?: boolean;
  /** The next charge POST answers this status (429, 409, 500...) without making a charge. */
  nextChargeStatus?: number;
  /** A decline also creates a failed charge and names it in the error (A17). */
  declineCreatesCharge?: boolean;
  /** Search does not show charges yet (A8). */
  searchHidden?: boolean;
  /** The next refund POST: Pin makes the refund, but the answer is lost (A10). */
  loseNextRefundAnswer?: boolean;
  /** The next refund POST answers this status without making a refund. */
  nextRefundStatus?: number;
  /** The 3-D Secure redirect goes to this origin (A11). */
  challengeOrigin?: string;
}

export class FakePin {
  private readonly bySecret = new Map<string, FakeAccount>();
  private readonly byPublishable = new Map<string, FakeAccount>();
  readonly switches: FakePinSwitches = {};
  /** Every request, for tests that check hosts and bodies. */
  readonly requests: PinRequest[] = [];

  newAccount(): { secretKey: string; publishableKey: string; webhookKey: string } {
    const acc: FakeAccount = {
      secretKey: `sk${randomBytes(18).toString('hex')}`, publishableKey: `pk${randomBytes(18).toString('hex')}`, webhookKey: randomBytes(16).toString('base64url').slice(0, 22),
      charges: new Map(), refunds: new Map(), tokens: new Map(),
    };
    this.bySecret.set(acc.secretKey, acc);
    this.byPublishable.set(acc.publishableKey, acc);
    return { secretKey: acc.secretKey, publishableKey: acc.publishableKey, webhookKey: acc.webhookKey };
  }

  /** What Pin's hosted fields give the page for a card: a single-use token (no card data exists in this fake). */
  tokenise(publishableKey: string, outcome: Outcome): string {
    const acc = this.byPublishable.get(publishableKey);
    if (!acc) throw new Error('fake pin: unknown publishable key');
    const token = id('card');
    acc.tokens.set(token, outcome);
    return token;
  }

  private account(secretKey: string): FakeAccount {
    const acc = this.bySecret.get(secretKey);
    if (!acc) throw new Error('fake pin: unknown account');
    return acc;
  }

  charge(secretKey: string, token: string): FakeCharge | undefined {
    return this.account(secretKey).charges.get(token);
  }

  chargesWith(secretKey: string, sessionRef: string): FakeCharge[] {
    return [...this.account(secretKey).charges.values()].filter((c) => c.metadata.mt_session === sessionRef);
  }

  /** The customer finishes (or fails) the bank's 3-D Secure page; returns the session_token Pin appends to the callback. */
  finishChallenge(secretKey: string, chargeToken: string, outcome: 'pay' | 'decline' = 'pay'): string {
    const c = this.account(secretKey).charges.get(chargeToken);
    if (!c || c.status_message !== 'Pending') throw new Error('fake pin: no challenge open for that charge');
    c.success = outcome === 'pay';
    c.captured = c.success;
    c.status_message = c.success ? 'Success' : 'Failed';
    c.error_message = c.success ? null : 'Authentication failed';
    c.sessionToken = id('se');
    return c.sessionToken;
  }

  /** A charge made outside our code under a session's reference (only for the extra-charge test). */
  extraCharge(secretKey: string, sessionRef: string, amount: number): string {
    const acc = this.account(secretKey);
    const c: FakeCharge = { token: id('ch'), success: true, captured: true, status_message: 'Success', amount, currency: 'AUD', amount_refunded: 0, metadata: { mt_session: sessionRef }, created_at: new Date().toISOString(), error_message: null };
    acc.charges.set(c.token, c);
    return c.token;
  }

  dashboardRefund(secretKey: string, chargeToken: string, amount: number): string {
    return this.makeRefund(this.account(secretKey), chargeToken, amount).token;
  }

  settleRefund(secretKey: string, refundToken: string): void {
    const acc = this.account(secretKey);
    const r = acc.refunds.get(refundToken);
    if (!r || r.status_message !== 'Pending') return;
    r.status_message = 'Success';
    r.success = true;
    acc.charges.get(r.charge)!.amount_refunded += r.amount;
  }

  private makeRefund(acc: FakeAccount, chargeToken: string, amount: number): FakeRefund {
    const r: FakeRefund = { token: id('rf'), charge: chargeToken, amount, currency: 'AUD', status_message: 'Pending', success: null, error_message: null, created_at: new Date().toISOString() };
    acc.refunds.set(r.token, r);
    return r;
  }

  /** A signed event as Pin would deliver it (plan 4.4, A1 to A3). */
  event(secretKey: string, type: string, data: unknown, at: Date): { body: Buffer; headers: Record<string, string> } {
    const acc = this.account(secretKey);
    const body = Buffer.from(JSON.stringify({ token: id('evt'), type, data, created_at: at.toISOString() }));
    const t = String(Math.floor(at.getTime() / 1000));
    return { body, headers: { 'content-type': 'application/json', [PIN_SIGNATURE_HEADER]: `t=${t},v1=${pinSignature(acc.webhookKey, t, body)}` } };
  }

  chargeEvent(secretKey: string, chargeToken: string, at: Date) {
    const c = this.account(secretKey).charges.get(chargeToken)!;
    return this.event(secretKey, c.success ? 'charge.captured' : 'charge.failed', c, at);
  }

  refundEvent(secretKey: string, refundToken: string, at: Date) {
    const r = this.account(secretKey).refunds.get(refundToken)!;
    const type = r.status_message === 'Success' ? 'refund.succeeded' : r.status_message === 'Failed' ? 'refund.failed' : 'refund.created';
    return this.event(secretKey, type, r, at);
  }

  readonly transport: PinTransport = async (req) => {
    this.requests.push(req);
    const url = new URL(req.url);
    if (url.origin !== 'https://test-api.pinpayments.com' || !url.pathname.startsWith('/1/')) throw new Error(`fake pin: unexpected host ${url.origin}`);
    const auth = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    const secret = auth ? Buffer.from(auth[1]!, 'base64').toString('utf8').replace(/:$/, '') : '';
    const acc = this.bySecret.get(secret);
    if (!acc) return json(401, { error: 'unauthenticated', error_description: 'Not authorised' });
    const path = url.pathname.slice(2);
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};

    if (req.method === 'GET' && path === '/balance') return json(200, { response: { available: [{ amount: 0, currency: 'AUD' }], pending: [] } });
    if (req.method === 'GET' && path === '/webhook_endpoints') {
      return json(200, { response: [{ token: 'whe_contract', key: acc.webhookKey, url: 'https://example.com/webhook', created_at: new Date().toISOString() }], pagination: { current: 1, pages: 1, count: 1 } });
    }
    if (req.method === 'POST' && path === '/charges') return this.postCharge(acc, body);
    if (req.method === 'GET' && path === '/charges/search') {
      const q = url.searchParams.get('query') ?? '';
      const found = this.switches.searchHidden ? [] : [...acc.charges.values()].filter((c) => c.token === q || Object.values(c.metadata).includes(q));
      return json(200, { response: found, count: found.length, pagination: { current: 1, pages: 1, count: found.length } });
    }
    if (req.method === 'GET' && path === '/charges/verify') {
      const st = url.searchParams.get('session_token');
      const c = [...acc.charges.values()].find((x) => x.sessionToken !== undefined && x.sessionToken === st);
      return c ? json(200, { response: c }) : json(404, { error: 'not_found', error_description: 'Not found' });
    }
    let m = /^\/charges\/(ch_[A-Za-z0-9_-]+)\/refunds$/.exec(path);
    if (m) {
      const c = acc.charges.get(m[1]!);
      if (!c) return json(404, { error: 'resource_not_found' });
      if (req.method === 'GET') {
        const list = [...acc.refunds.values()].filter((r) => r.charge === c.token);
        return json(200, { response: list, count: list.length, pagination: { current: 1, pages: 1, count: list.length } });
      }
      if (this.switches.nextRefundStatus) {
        const s = this.switches.nextRefundStatus;
        this.switches.nextRefundStatus = undefined;
        return json(s, { error: s === 429 ? 'too_many_requests' : 'error' });
      }
      const amount = typeof body.amount === 'number' ? body.amount : c.amount;
      const held = [...acc.refunds.values()].filter((r) => r.charge === c.token && r.status_message !== 'Failed').reduce((s, r) => s + r.amount, 0);
      if (!c.success || amount + held > c.amount) return json(422, { error: 'invalid_resource', error_description: 'Refund amount is more than the charge' });
      const r = this.makeRefund(acc, c.token, amount);
      if (this.switches.loseNextRefundAnswer) {
        this.switches.loseNextRefundAnswer = false;
        throw new ProviderError('provider_timeout', true);
      }
      return json(201, { response: r });
    }
    m = /^\/charges\/(ch_[A-Za-z0-9_-]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const c = acc.charges.get(m[1]!);
      return c ? json(200, { response: c }) : json(404, { error: 'resource_not_found' });
    }
    m = /^\/refunds\/(rf_[A-Za-z0-9_-]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const r = acc.refunds.get(m[1]!);
      return r ? json(200, { response: r }) : json(404, { error: 'resource_not_found' });
    }
    return json(404, { error: 'resource_not_found' });
  };

  private postCharge(acc: FakeAccount, body: Record<string, unknown>): PinResponse {
    if (this.switches.failNextChargeBefore) {
      this.switches.failNextChargeBefore = false;
      throw new ProviderError('provider_timeout', true);
    }
    if (this.switches.nextChargeStatus) {
      const s = this.switches.nextChargeStatus;
      this.switches.nextChargeStatus = undefined;
      return json(s, { error: s === 429 ? 'too_many_requests' : 'error' });
    }
    const token = typeof body.card_token === 'string' ? body.card_token : '';
    const outcome = acc.tokens.get(token);
    if (!outcome) return json(400, { error: 'token_already_used', error_description: 'Token already used' });
    acc.tokens.delete(token);
    if (typeof body.email !== 'string' || typeof body.ip_address !== 'string' || typeof body.description !== 'string' || body.description === '') return json(422, { error: 'invalid_resource' });
    const tds = body.three_d_secure as { enabled?: boolean; callback_url?: string } | undefined;
    const metadata = (body.metadata ?? {}) as Record<string, string>;
    const base = { amount: body.amount as number, currency: (body.currency as string) ?? 'AUD', amount_refunded: 0, metadata, created_at: new Date().toISOString() };
    if (outcome === 'decline') {
      if (this.switches.declineCreatesCharge) {
        const c: FakeCharge = { ...base, token: id('ch'), success: false, captured: false, status_message: 'Failed', error_message: 'Declined' };
        acc.charges.set(c.token, c);
        return json(400, { error: 'card_declined', error_description: 'The card was declined', charge_token: c.token });
      }
      return json(400, { error: 'card_declined', error_description: 'The card was declined' });
    }
    const lose = this.switches.loseNextChargeAnswer;
    this.switches.loseNextChargeAnswer = false;
    if (outcome === 'pay_frictionless' || !tds?.enabled) {
      const c: FakeCharge = { ...base, token: id('ch'), success: true, captured: true, status_message: 'Success', error_message: null };
      acc.charges.set(c.token, c);
      if (lose) throw new ProviderError('provider_timeout', true);
      return json(201, { response: c });
    }
    const c: FakeCharge = { ...base, token: id('ch'), success: false, captured: false, status_message: 'Pending', error_message: null };
    acc.charges.set(c.token, c);
    if (lose) throw new ProviderError('provider_timeout', true);
    const origin = this.switches.challengeOrigin ?? 'https://sandbox.checkout.com';
    return json(202, { response: { ...c, redirect_url: `${origin}/api2/v2/3ds/acs/sid_${randomBytes(10).toString('hex')}` } });
  }
}
