// The payment gateway simulator (plan 3.1, sections 2.3 and 6; plan 3.6, section 3): the only adapter that can take a
// (pretend) payment. Test-only: never live, and the gateway wrapper refuses it outside development, test and ci. Its
// "gateway" lives in the memory of the process; losing it on a restart leaves an attempt for the sweep, which never
// expires it without the gateway's word. A customer finishes a payment on its hosted checkout page (served by the API
// in development, test and ci only, see ../../simulator-checkout); tests also drive it through SimulatorControl.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PaymentMethod } from '@mt/shared';
import {
  AdapterManifest, CreatePaymentInput, Money, NormalisedEvent, PaymentProvider, ProviderContext, ProviderError, ProviderPayment, ProviderPaymentStatus,
  WebhookVerification,
} from '../../core/provider';

export const SIMULATOR_KEY = 'simulator';
export const SIMULATOR_SIGNATURE_HEADER = 'x-sim-signature';
/** The hosted checkout page, on the web origin behind its /api proxy (plan 3.6, section 3.1). */
export const SIMULATOR_CHECKOUT_PATH = '/api/payments/simulator/checkout';
/** Signatures older or newer than this are refused (replays). */
export const SIMULATOR_TOLERANCE_SECONDS = 300;
/** Checkout tokens: 32 random bytes in base64url. */
export const SIMULATOR_CHECKOUT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface SimulatorOptions {
  /** The web app's origin (WEB_ORIGIN), passed in by the payments module: the adapter reads no environment. */
  webOrigin: string;
}

/** The simulator's manifest for one web origin: its hosted page lives there. */
export function simulatorManifest(webOrigin: string): AdapterManifest {
  return {
    key: SIMULATOR_KEY,
    displayName: 'Payment simulator (test only)',
    status: 'experimental',
    testOnly: true,
    cardDataHandling: 'hosted_only',
    methods: ['card', 'apple_pay', 'google_pay'] satisfies PaymentMethod[],
    currencies: ['AUD'],
    countries: 'any',
    checkoutOrigin: new URL(webOrigin).origin,
    capabilities: { refunds: 'none', deferredCapture: false, lookupByIdempotencyKey: true },
  };
}

interface SimPayment {
  ref: string;
  idempotencyKey: string;
  status: ProviderPaymentStatus;
  amount: Money;
  method: PaymentMethod;
  paymentId: string;
  failureCode?: string;
  /** Where the hosted page sends the customer back: built by our server, kept as the gateway would. */
  returnUrl: string;
  /** The hosted page's token, only while the object waits for the customer. */
  checkoutToken?: string;
}

/** What the next createPayment does, set by a test. */
export type SimulatorOutcome =
  | 'requires_action' | 'pending' | 'succeeded' | 'decline' | 'timeout' | 'timeout_after_create' | 'unavailable'
  /** Definitive refusals with no object created (bad request, rotated credentials). */
  | 'rejected' | 'auth_failed'
  /** "Idempotency key in use": another request with the same key is still in flight; nothing exists yet. Retryable. */
  | 'in_use';
export type SimulatorRetrieveFault = 'unavailable' | 'not_found' | 'not_found_error' | 'auth_failed';

class SimAccount {
  readonly payments = new Map<string, SimPayment>();
  readonly byKey = new Map<string, string>();
  readonly next: SimulatorOutcome[] = [];
  readonly nextCancel: Array<'unavailable'> = [];
  readonly nextRetrieve: SimulatorRetrieveFault[] = [];
  createCalls = 0;
  /** Cancellations that changed an object (a repeated one changes nothing). */
  effectiveCancels = 0;
}

const tokenKey = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The simulated gateway's state, one per account id, in the process's memory. */
export class SimulatorWorld {
  private readonly accounts = new Map<string, SimAccount>();
  /** sha256(checkout token) → the object it opens. */
  private readonly checkouts = new Map<string, { accountId: string; ref: string }>();

  newCheckout(accountId: string, ref: string): string {
    const token = randomBytes(32).toString('base64url');
    this.checkouts.set(tokenKey(token), { accountId, ref });
    return token;
  }

  /** The object a checkout token opens, or null (unknown, malformed or forgotten). */
  checkout(token: string): { accountId: string; payment: SimPayment } | null {
    if (!SIMULATOR_CHECKOUT_TOKEN.test(token)) return null;
    const hit = this.checkouts.get(tokenKey(token));
    const payment = hit ? this.accounts.get(hit.accountId)?.payments.get(hit.ref) : undefined;
    return hit && payment ? { accountId: hit.accountId, payment } : null;
  }

  account(id: string): SimAccount {
    let a = this.accounts.get(id);
    if (!a) {
      a = new SimAccount();
      this.accounts.set(id, a);
    }
    return a;
  }

  /** As if the gateway lost everything (or this process restarted). */
  forget(id: string): void {
    this.accounts.delete(id);
    for (const [k, v] of this.checkouts) if (v.accountId === id) this.checkouts.delete(k);
  }
}

export const SIMULATOR_WORLD = new SimulatorWorld();

const view = (p: SimPayment, checkoutBase?: string): ProviderPayment => ({
  ref: p.ref,
  status: p.status,
  amount: { ...p.amount },
  ourPaymentId: p.paymentId,
  ...(p.failureCode ? { failureCode: p.failureCode } : {}),
  ...(checkoutBase && p.status === 'requires_action' && p.checkoutToken ? { nextAction: { type: 'redirect' as const, url: `${checkoutBase}/${p.checkoutToken}` } } : {}),
});

/** What the customer chose on the hosted page. */
export type CheckoutOutcome = 'pay' | 'decline';

export type CheckoutResult =
  | { changed: true; payment: ProviderPayment; webhook: SignedWebhook }
  | { changed: false; payment: ProviderPayment };

/** What the hosted page shows: no secret, nothing the customer could change. */
export interface CheckoutView {
  accountId: string;
  status: ProviderPaymentStatus;
  amount: Money;
  returnUrl: string;
}

function checkCredentials(ctx: ProviderContext): void {
  if (!/^sim_test_[A-Za-z0-9]{16,}$/.test(ctx.credentials.apiKey ?? '')) throw new ProviderError('provider_auth_failed', false);
}

export class SimulatorProvider implements PaymentProvider {
  readonly manifest: AdapterManifest;
  readonly signatureHeaders = [SIMULATOR_SIGNATURE_HEADER] as const;
  private readonly checkoutBase: string;

  constructor(opts: SimulatorOptions, private readonly world: SimulatorWorld = SIMULATOR_WORLD) {
    this.manifest = simulatorManifest(opts.webOrigin);
    this.checkoutBase = `${this.manifest.checkoutOrigin}${SIMULATOR_CHECKOUT_PATH}`;
  }

  async testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }> {
    try {
      checkCredentials(ctx);
      return ctx.webhookSecret.length >= 32 ? { ok: true } : { ok: false, code: 'webhook_secret_missing' };
    } catch {
      return { ok: false, code: 'provider_auth_failed' };
    }
  }

  async createPayment(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    acc.createCalls += 1;
    const known = acc.byKey.get(input.idempotencyKey);
    if (known) {
      const p = acc.payments.get(known)!;
      // Like a real gateway: the same key with other parameters is refused, never a second object.
      if (p.amount.amountMinor !== input.amount.amountMinor || p.amount.currency !== input.amount.currency) throw new ProviderError('provider_rejected', false);
      return view(p, this.checkoutBase);
    }
    const outcome = acc.next.shift() ?? 'requires_action';
    if (outcome === 'timeout') throw new ProviderError('provider_timeout', true);
    if (outcome === 'unavailable') throw new ProviderError('provider_unavailable', true);
    if (outcome === 'rejected') throw new ProviderError('provider_rejected', false);
    if (outcome === 'auth_failed') throw new ProviderError('provider_auth_failed', false);
    if (outcome === 'in_use') throw new ProviderError('provider_busy', true);
    if (!this.manifest.currencies.includes(input.amount.currency) || input.amount.amountMinor <= 0n) throw new ProviderError('provider_rejected', false);
    const p: SimPayment = {
      ref: `sim_pay_${randomBytes(12).toString('hex')}`,
      idempotencyKey: input.idempotencyKey,
      status: outcome === 'decline' ? 'failed' : outcome === 'timeout_after_create' ? 'requires_action' : outcome,
      amount: { ...input.amount },
      method: input.method,
      paymentId: input.metadata.paymentId,
      returnUrl: input.returnUrl,
      ...(outcome === 'decline' ? { failureCode: 'card_declined' } : {}),
    };
    if (p.status === 'requires_action') p.checkoutToken = this.world.newCheckout(ctx.accountId, p.ref);
    acc.payments.set(p.ref, p);
    acc.byKey.set(p.idempotencyKey, p.ref);
    if (outcome === 'timeout_after_create') throw new ProviderError('provider_timeout', true);
    return view(p, this.checkoutBase);
  }

  async retrievePayment(ctx: ProviderContext, by: { ref: string } | { idempotencyKey: string }): Promise<ProviderPayment | null> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    const fault = acc.nextRetrieve.shift();
    if (fault === 'unavailable') throw new ProviderError('provider_unavailable', true);
    if (fault === 'not_found') return null;
    if (fault === 'not_found_error') throw new ProviderError('provider_not_found', false);
    if (fault === 'auth_failed') throw new ProviderError('provider_auth_failed', false);
    const ref = 'ref' in by ? by.ref : acc.byKey.get(by.idempotencyKey);
    const p = ref ? acc.payments.get(ref) : undefined;
    return p ? view(p, this.checkoutBase) : null;
  }

  async cancelPayment(ctx: ProviderContext, ref: string): Promise<ProviderPayment> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    if (acc.nextCancel.shift() === 'unavailable') throw new ProviderError('provider_unavailable', true);
    const p = acc.payments.get(ref);
    if (!p) throw new ProviderError('provider_not_found', false);
    // A collected or in-flight payment cannot be cancelled: the gateway says what it is instead.
    if (p.status === 'requires_action') {
      p.status = 'cancelled';
      acc.effectiveCancels += 1;
    }
    return view(p);
  }

  /** The hosted page's view of a checkout token, or null. Reads memory only. */
  checkoutView(token: string): CheckoutView | null {
    const hit = this.world.checkout(token);
    return hit ? { accountId: hit.accountId, status: hit.payment.status, amount: { ...hit.payment.amount }, returnUrl: hit.payment.returnUrl } : null;
  }

  /**
   * The customer pays or declines on the hosted page (plan 3.6, section 3.1). Only an object waiting for the customer
   * moves; anything else is reported unchanged. If it moves, returns the payment.updated webhook the gateway sends,
   * signed with this account's secret. Check and change run with no await in between, so two submissions change it once.
   */
  completeCheckout(ctx: ProviderContext, token: string, outcome: CheckoutOutcome): CheckoutResult {
    checkCredentials(ctx);
    const hit = this.world.checkout(token);
    if (!hit || hit.accountId !== ctx.accountId) throw new ProviderError('provider_not_found', false);
    const p = hit.payment;
    if (p.status !== 'requires_action') return { changed: false, payment: view(p) };
    p.status = outcome === 'pay' ? 'succeeded' : 'failed';
    if (outcome === 'decline') p.failureCode = 'card_declined';
    return { changed: true, payment: view(p), webhook: signedPaymentEvent(ctx.webhookSecret, eventPayment(p)) };
  }

  /** The webhook the gateway would send now for an object of this account, signed at `at` (contract suite, plan 3.6). */
  currentWebhook(ctx: ProviderContext, ref: string, at: Date): SignedWebhook {
    checkCredentials(ctx);
    const p = this.world.account(ctx.accountId).payments.get(ref);
    if (!p) throw new ProviderError('provider_not_found', false);
    return signedPaymentEvent(ctx.webhookSecret, eventPayment(p), { at, signedAt: at });
  }

  parseEvent(rawBody: Buffer): NormalisedEvent | null {
    try {
      return parseEvent(JSON.parse(rawBody.toString('utf8')));
    } catch {
      return null;
    }
  }

  verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification {
    let claimedEventId: string | undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
      const id = (parsed as { id?: unknown })?.id;
      if (typeof id === 'string' && id.length <= 100) claimedEventId = id;
    } catch {
      parsed = undefined;
    }
    const header = headers[SIMULATOR_SIGNATURE_HEADER] ?? '';
    const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
    if (!m) return { ok: false, code: 'bad_signature', ...(claimedEventId ? { claimedEventId } : {}) };
    const t = Number(m[1]);
    const expected = createHmac('sha256', ctx.webhookSecret).update(`${t}.`).update(rawBody).digest();
    const given = Buffer.from(m[2]!, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: 'bad_signature', ...(claimedEventId ? { claimedEventId } : {}) };
    if (Math.abs(now.getTime() / 1000 - t) > SIMULATOR_TOLERANCE_SECONDS) return { ok: false, code: 'stale_timestamp', ...(claimedEventId ? { claimedEventId } : {}) };
    const event = parseEvent(parsed);
    if (!event) return { ok: false, code: 'malformed', ...(claimedEventId ? { claimedEventId } : {}) };
    return { ok: true, event };
  }
}

const STATUSES: readonly ProviderPaymentStatus[] = ['requires_action', 'pending', 'succeeded', 'failed', 'cancelled'];

function parseEvent(body: unknown): NormalisedEvent | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || !/^sim_evt_[A-Za-z0-9_]{1,80}$/.test(b.id) || typeof b.created !== 'number' || typeof b.type !== 'string') return null;
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(b.type)) return null;
  const base = { providerEventId: b.id, type: b.type, occurredAt: new Date(b.created * 1000) };
  if (b.type !== 'payment.updated') return { ...base, kind: 'unsupported' };
  const d = b.data as Record<string, unknown> | undefined;
  if (!d || typeof d.ref !== 'string' || !STATUSES.includes(d.status as ProviderPaymentStatus) || typeof d.amountMinor !== 'string' || !/^\d{1,18}$/.test(d.amountMinor) || typeof d.currency !== 'string') return null;
  const meta = d.metadata as Record<string, unknown> | undefined;
  return {
    ...base,
    kind: 'payment',
    payment: {
      ref: d.ref,
      status: d.status as ProviderPaymentStatus,
      amount: { amountMinor: BigInt(d.amountMinor), currency: d.currency },
      ...(typeof meta?.paymentId === 'string' ? { ourPaymentId: meta.paymentId } : {}),
      ...(typeof d.failureCode === 'string' ? { failureCode: d.failureCode } : {}),
    },
  };
}

export interface SignedWebhook {
  body: Buffer;
  headers: Record<string, string>;
  eventId: string;
}

/**
 * Test control of the simulated gateway. Moves a payment on the "gateway" side and builds the webhook it would send,
 * signed with the account's secret (the test reads it from the database). Not reachable over HTTP.
 */
export class SimulatorControl {
  constructor(private readonly world: SimulatorWorld = SIMULATOR_WORLD) {}

  /** The outcome of the next createPayment calls for this account. */
  queue(accountId: string, ...outcomes: SimulatorOutcome[]): void {
    this.world.account(accountId).next.push(...outcomes);
  }

  failNextCancel(accountId: string): void {
    this.world.account(accountId).nextCancel.push('unavailable');
  }

  failNextRetrieve(accountId: string, how: SimulatorRetrieveFault = 'unavailable'): void {
    this.world.account(accountId).nextRetrieve.push(how);
  }

  createCalls(accountId: string): number {
    return this.world.account(accountId).createCalls;
  }

  effectiveCancels(accountId: string): number {
    return this.world.account(accountId).effectiveCancels;
  }

  objectCount(accountId: string): number {
    return this.world.account(accountId).payments.size;
  }

  find(accountId: string, by: { ref: string } | { paymentId: string }): ProviderPayment | null {
    const acc = this.world.account(accountId);
    const p = 'ref' in by ? acc.payments.get(by.ref) : [...acc.payments.values()].find((x) => x.paymentId === by.paymentId);
    return p ? view(p) : null;
  }

  /** The customer finished (or abandoned) the hosted page: the gateway object moves to `status`. */
  settle(accountId: string, ref: string, status: ProviderPaymentStatus, failureCode?: string): ProviderPayment {
    const p = this.world.account(accountId).payments.get(ref);
    if (!p) throw new Error('simulator: unknown payment');
    p.status = status;
    if (failureCode) p.failureCode = failureCode;
    return view(p);
  }

  forget(accountId: string): void {
    this.world.forget(accountId);
  }

  /** A webhook for a payment, signed with `secret`; `over` changes what the event says (amount, currency, metadata…). */
  paymentEvent(secret: string, payment: EventPayment, opts: EventOptions = {}): SignedWebhook {
    return signedPaymentEvent(secret, payment, opts);
  }
}

interface EventPayment { ref: string; status: ProviderPaymentStatus; amountMinor: bigint; currency: string; paymentId?: string; failureCode?: string }
interface EventOptions { eventId?: string; at?: Date; signedAt?: Date; type?: string }

const eventPayment = (p: SimPayment): EventPayment => ({
  ref: p.ref, status: p.status, amountMinor: p.amount.amountMinor, currency: p.amount.currency, paymentId: p.paymentId, ...(p.failureCode ? { failureCode: p.failureCode } : {}),
});

/** The simulated gateway's payment.updated event, signed with `secret`. */
function signedPaymentEvent(secret: string, payment: EventPayment, opts: EventOptions = {}): SignedWebhook {
  const eventId = opts.eventId ?? `sim_evt_${randomBytes(10).toString('hex')}`;
  const created = Math.floor((opts.at ?? new Date()).getTime() / 1000);
  const body = Buffer.from(JSON.stringify({
    id: eventId,
    type: opts.type ?? 'payment.updated',
    created,
    data: {
      ref: payment.ref,
      status: payment.status,
      amountMinor: payment.amountMinor.toString(),
      currency: payment.currency,
      ...(payment.paymentId ? { metadata: { paymentId: payment.paymentId } } : {}),
      ...(payment.failureCode ? { failureCode: payment.failureCode } : {}),
    },
  }));
  return { body, eventId, headers: { 'content-type': 'application/json', [SIMULATOR_SIGNATURE_HEADER]: signSimulator(secret, body, opts.signedAt ?? new Date()) } };
}

export function signSimulator(secret: string, body: Buffer, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}`;
}
