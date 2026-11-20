// An in-memory eWAY Rapid (plan docs/plans/9.1-eway.md, section 12): the transport the eWAY adapter gets in tests. It
// follows the shapes the plan assumes from the Rapid v3 reference (all UNVERIFIED until `test:sandbox` runs): Basic auth
// with the API key and password; Secure Fields codes that are single-use; 3-D Secure enrol and verify; Direct Connection
// purchases keyed by InvoiceReference; transaction queries by id and by InvoiceReference; refunds with MaxRefund.
// Switches cover the failure paths. Never any network.
import { randomBytes } from 'node:crypto';
import type { EwayRequest, EwayResponse } from '../../../src/modules/payments/adapters/eway/eway';

export type CardOutcome = 'pay' | 'decline' | 'pay_frictionless';

interface Tx {
  TransactionID: number;
  TransactionStatus: boolean;
  TotalAmount: number;
  InvoiceReference: string;
  ResponseMessage: string;
  MaxRefund: number;
  OriginalTransactionId?: number;
}
interface Code { outcome: CardOutcome; uses: number; expiresAt: number }
interface Access { code: string; status: 'pending' | 'Y' | 'N'; enrolled: boolean }
interface Account {
  apiKey: string;
  apiPassword: string;
  publicApiKey: string;
  codes: Map<string, Code>;
  access: Map<string, Access>;
  tx: Map<number, Tx>;
  chargePosts: Map<number | string, number>;
  refundPosts: Map<number, number>;
}

const json = (status: number, body: unknown): EwayResponse => ({ status, body: JSON.stringify(body) });

export class FakeEway {
  private readonly accounts = new Map<string, Account>();
  private nextId = 10_000_000 + Math.floor(Math.random() * 1_000_000);
  /** Failure switches, each consumed by the next matching request. */
  readonly next: {
    lose?: 'charge' | 'refund';
    timeoutBefore?: 'charge' | 'refund' | 'enrol' | 'verify' | 'query';
    status?: { path: RegExp; status: number };
    approval?: string;
    chargedAmount?: number;
    response?: string;
    enrolConsumesCode?: boolean;
    notEnrolled?: boolean;
    queryHides?: number;
    /** The next query answers this 404 (code review, finding 2). */
    raw404?: 'empty' | 'html' | 'coded' | 'contradict';
    /** The next query by reference answers the not-found code together with the transactions it holds (note a). */
    contradict?: boolean;
    /** The next 3-D Secure enrolment is refused with this code (a decline before any charge; finding 3). */
    enrolDecline?: string;
  } = {};
  /** Queries return transactions without their InvoiceReference (code review, finding 1). */
  omitInvoiceRef = false;
  /** When set, every query by invoice reference refuses as not unique (V6170). */
  notUnique = new Set<string>();
  /** References whose refunds cannot be found by InvoiceReference (A5 false). */
  refundRefsHidden = false;

  newAccount(): { apiKey: string; apiPassword: string; publicApiKey: string } {
    const a: Account = {
      apiKey: `K${randomBytes(24).toString('hex')}`, apiPassword: `P${randomBytes(8).toString('hex')}`, publicApiKey: `epk-${randomBytes(4).toString('hex').toUpperCase()}-aaaa-bbbb-cccc-${randomBytes(6).toString('hex')}`,
      codes: new Map(), access: new Map(), tx: new Map(), chargePosts: new Map(), refundPosts: new Map(),
    };
    this.accounts.set(a.apiKey, a);
    return { apiKey: a.apiKey, apiPassword: a.apiPassword, publicApiKey: a.publicApiKey };
  }

  private acc(apiKey: string): Account {
    const a = this.accounts.get(apiKey);
    if (!a) throw new Error('fake eway: no such account');
    return a;
  }

  /** eWAY's Secure Fields in the browser: a single-use code for a card that will pay or decline. */
  tokenise(publicApiKey: string, outcome: CardOutcome): string {
    const a = [...this.accounts.values()].find((x) => x.publicApiKey === publicApiKey);
    if (!a) throw new Error('fake eway: unknown public key');
    const code = `sfc_${randomBytes(16).toString('hex')}`;
    a.codes.set(code, { outcome, uses: 0, expiresAt: Date.now() + 30 * 60_000 });
    return code;
  }

  /** The bank's 3-D Secure challenge (Cerberus on our page). */
  challenge(apiKey: string, accessCode: string, pass: boolean): void {
    const x = this.acc(apiKey).access.get(accessCode);
    if (!x) throw new Error('fake eway: no such access code');
    x.status = pass ? 'Y' : 'N';
  }

  /** A refund made in MYeWAY: no InvoiceReference of ours. */
  dashboardRefund(apiKey: string, chargeId: number, amount: number): number {
    const a = this.acc(apiKey);
    const t = a.tx.get(chargeId);
    if (!t || amount > t.MaxRefund) throw new Error('fake eway: cannot refund');
    t.MaxRefund -= amount;
    const id = this.nextId++;
    a.tx.set(id, { TransactionID: id, TransactionStatus: true, TotalAmount: amount, InvoiceReference: '', ResponseMessage: 'A2000', MaxRefund: 0, OriginalTransactionId: chargeId });
    return id;
  }

  /** An extra transaction under a reference (not from us): the adapter must never lose or bind it silently. */
  extraTransaction(apiKey: string, invoiceRef: string, amount: number): number {
    const id = this.nextId++;
    this.acc(apiKey).tx.set(id, { TransactionID: id, TransactionStatus: true, TotalAmount: amount, InvoiceReference: invoiceRef, ResponseMessage: 'A2000', MaxRefund: amount });
    return id;
  }

  chargePosts(apiKey: string, invoiceRef: string): number {
    return this.acc(apiKey).chargePosts.get(invoiceRef) ?? 0;
  }

  refundPosts(apiKey: string, chargeId: number): number {
    return this.acc(apiKey).refundPosts.get(chargeId) ?? 0;
  }

  transactionsWith(apiKey: string, invoiceRef: string): Tx[] {
    return [...this.acc(apiKey).tx.values()].filter((t) => t.InvoiceReference === invoiceRef);
  }

  readonly transport = async (req: EwayRequest): Promise<EwayResponse> => {
    const url = new URL(req.url);
    if (url.origin !== 'https://api.sandbox.ewaypayments.com') throw new Error(`fake eway: unexpected host ${url.origin}`);
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    const [key, password] = basic ? Buffer.from(basic[1]!, 'base64').toString('utf8').split(':') : [];
    const a = key ? this.accounts.get(key) : undefined;
    if (!a || a.apiPassword !== password) return json(401, { Errors: 'S9993' });
    const path = url.pathname;
    if (this.next.status && this.next.status.path.test(path)) {
      const s = this.next.status.status;
      delete this.next.status;
      return json(s, { Errors: s >= 500 ? 'S9990' : 'V6000' });
    }
    if (req.method === 'GET' && this.next.raw404) {
      const kind = this.next.raw404;
      delete this.next.raw404;
      if (kind === 'html') return { status: 404, body: '<html><body>Not Found</body></html>' };
      if (kind === 'contradict') {
        // A 404 with the not-found code that still lists what it holds for that reference or id (note b).
        const p = new URL(req.url).pathname;
        const ref = /^\/Transaction\/InvoiceRef\/([^/]+)$/.exec(p)?.[1];
        const id = /^\/Transaction\/([0-9]+)$/.exec(p)?.[1];
        const listed = [...a.tx.values()].filter((t) => (ref !== undefined && t.InvoiceReference === decodeURIComponent(ref)) || (id !== undefined && t.TransactionID === Number(id)));
        return json(404, { Transactions: listed.map((t) => this.shown(t)), Errors: 'V6171' });
      }
      if (kind === 'empty') return { status: 404, body: '' };
      return json(404, { Transactions: [], Errors: 'V6171' });
    }
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    if (req.method === 'POST' && path === '/3dsenrol') return this.enrol(a, body);
    if (req.method === 'POST' && path === '/3dsverify') return this.verify(a, body);
    if (req.method === 'POST' && path === '/Transaction') return this.purchase(a, body);
    const refund = /^\/Transaction\/([0-9]+)\/Refund$/.exec(path);
    if (req.method === 'POST' && refund) return this.refund(a, Number(refund[1]), body);
    const byRef = /^\/Transaction\/InvoiceRef\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && byRef) return this.queryByRef(a, decodeURIComponent(byRef[1]!));
    const byId = /^\/Transaction\/([0-9]+)$/.exec(path);
    if (req.method === 'GET' && byId) {
      if (this.next.timeoutBefore === 'query') {
        delete this.next.timeoutBefore;
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      }
      const t = a.tx.get(Number(byId[1]));
      if (this.next.contradict && t) {
        delete this.next.contradict;
        return json(200, { Transactions: [this.shown(t)], Errors: 'V6171' });
      }
      return json(200, { Transactions: t ? [this.shown(t)] : [], Errors: t ? '' : 'V6171' });
    }
    return json(404, { Errors: 'V6000' });
  };

  private timeout(kind: 'charge' | 'refund' | 'enrol' | 'verify'): void {
    if (this.next.timeoutBefore === kind) {
      delete this.next.timeoutBefore;
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }
  }

  private enrol(a: Account, body: Record<string, unknown>): EwayResponse {
    this.timeout('enrol');
    if (this.next.enrolDecline) {
      const code = this.next.enrolDecline;
      delete this.next.enrolDecline;
      return json(200, { Errors: code });
    }
    const c = body.Customer as Record<string, unknown> | undefined;
    if (!c || !c.FirstName || !c.LastName || !c.Email || !c.Phone) return json(200, { Errors: 'V6011' });
    const code = a.codes.get(String(body.SecuredCardData));
    if (!code || code.expiresAt < Date.now() || code.uses > 0) return json(200, { Errors: 'V6148' });
    if (this.next.enrolConsumesCode) {
      delete this.next.enrolConsumesCode;
      code.uses += 1;
    }
    const accessCode = `AC${randomBytes(20).toString('hex')}`;
    const enrolled = !this.next.notEnrolled;
    delete this.next.notEnrolled;
    a.access.set(accessCode, { code: String(body.SecuredCardData), status: code.outcome === 'pay_frictionless' ? 'Y' : 'pending', enrolled });
    return json(200, { AccessCode: accessCode, Default3dsUrl: `https://secure.ewaypayments.com/3ds/${accessCode}`, Errors: '' });
  }

  private verify(a: Account, body: Record<string, unknown>): EwayResponse {
    this.timeout('verify');
    const x = a.access.get(String(body.AccessCode));
    if (!x) return json(200, { Errors: 'V6150' });
    if (!x.enrolled) return json(200, { AccessCode: body.AccessCode, Enrolled: false, ThreeDSecureAuth: null, Errors: '' });
    return json(200, {
      AccessCode: body.AccessCode, Enrolled: true, Errors: '',
      ThreeDSecureAuth: { Cryptogram: 'AAABBBCCC', ECI: '05', XID: 'x', AuthStatus: x.status === 'pending' ? 'U' : x.status, Version: '2.2.0', dsTransactionId: randomBytes(8).toString('hex') },
    });
  }

  private purchase(a: Account, body: Record<string, unknown>): EwayResponse {
    this.timeout('charge');
    const payment = body.Payment as Record<string, unknown>;
    const ref = String(payment.InvoiceReference ?? '');
    a.chargePosts.set(ref, (a.chargePosts.get(ref) ?? 0) + 1);
    const code = a.codes.get(String(body.SecuredCardData));
    if (!code || code.expiresAt < Date.now() || code.uses > 0) return json(200, { TransactionStatus: false, Errors: 'V6148' });
    const auth = (body.PaymentInstrument as Record<string, unknown> | undefined)?.ThreeDSecureAuth as Record<string, unknown> | undefined;
    if (!auth || (auth.AuthStatus !== 'Y' && auth.AuthStatus !== 'A')) return json(200, { TransactionStatus: false, Errors: 'V6230' });
    code.uses += 1;
    if (this.next.response) {
      const r = this.next.response;
      delete this.next.response;
      if (r === 'D4494') return json(200, { TransactionStatus: false, ResponseMessage: 'D4494', Errors: '' });
      if (r === 'S5666') return json(200, { TransactionStatus: false, ResponseMessage: 'S5666', Errors: '' });
    }
    const id = this.nextId++;
    const pays = code.outcome !== 'decline';
    const amount = this.next.chargedAmount ?? Number(payment.TotalAmount);
    delete this.next.chargedAmount;
    const approval = this.next.approval ?? 'A2000';
    delete this.next.approval;
    const t: Tx = { TransactionID: id, TransactionStatus: pays, TotalAmount: amount, InvoiceReference: ref, ResponseMessage: pays ? approval : 'D4405', MaxRefund: pays ? amount : 0 };
    a.tx.set(id, t);
    if (this.next.lose === 'charge') {
      delete this.next.lose;
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }
    return json(200, { TransactionID: id, TransactionStatus: pays, ResponseCode: pays ? '00' : '05', ResponseMessage: t.ResponseMessage, Payment: { TotalAmount: amount, InvoiceReference: ref, CurrencyCode: 'AUD' }, Errors: '' });
  }

  private refund(a: Account, chargeId: number, body: Record<string, unknown>): EwayResponse {
    this.timeout('refund');
    a.refundPosts.set(chargeId, (a.refundPosts.get(chargeId) ?? 0) + 1);
    const r = body.Refund as Record<string, unknown>;
    const amount = Number(r.TotalAmount);
    const t = a.tx.get(chargeId);
    if (!t || !t.TransactionStatus || t.OriginalTransactionId !== undefined) return json(200, { TransactionStatus: false, Errors: 'V6150' });
    if (amount > t.MaxRefund) return json(200, { TransactionStatus: false, Errors: 'V6151' });
    t.MaxRefund -= amount;
    const id = this.nextId++;
    a.tx.set(id, { TransactionID: id, TransactionStatus: true, TotalAmount: amount, InvoiceReference: String(r.InvoiceReference ?? ''), ResponseMessage: 'A2000', MaxRefund: 0, OriginalTransactionId: chargeId });
    if (this.next.lose === 'refund') {
      delete this.next.lose;
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }
    return json(200, { TransactionID: id, TransactionStatus: true, ResponseMessage: 'A2000', Refund: { TotalAmount: amount }, OriginalTransactionId: chargeId, Errors: '' });
  }

  private queryByRef(a: Account, ref: string): EwayResponse {
    if (this.next.timeoutBefore === 'query') {
      delete this.next.timeoutBefore;
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }
    if (this.notUnique.has(ref)) return json(200, { Transactions: [], Errors: 'V6170' });
    if (this.next.queryHides && this.next.queryHides > 0) {
      this.next.queryHides -= 1;
      return json(200, { Transactions: [], Errors: 'V6171' });
    }
    if (this.refundRefsHidden && ref.startsWith('mtr_')) return json(200, { Transactions: [], Errors: 'V6171' });
    const found = [...a.tx.values()].filter((t) => t.InvoiceReference === ref);
    if (this.next.contradict && found.length > 0) {
      delete this.next.contradict;
      return json(200, { Transactions: found.map((t) => this.shown(t)), Errors: 'V6171' });
    }
    if (found.length > 1) return json(200, { Transactions: [], Errors: 'V6170' });
    return json(200, { Transactions: found.map((t) => this.shown(t)), Errors: found.length === 0 ? 'V6171' : '' });
  }

  /** A transaction as a query shows it (without its InvoiceReference when that switch is on). */
  private shown(t: Tx): Partial<Tx> {
    if (!this.omitInvoiceRef) return t;
    const { InvoiceReference: _ref, ...rest } = t;
    return rest;
  }
}
