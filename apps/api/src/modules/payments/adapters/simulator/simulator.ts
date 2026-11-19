// The payment gateway simulator (plan 3.1, sections 2.3 and 6; plan 3.6, section 3): the only adapter that can take a
// (pretend) payment. Test-only: never live, and the gateway wrapper refuses it outside development, test and ci. Its
// "gateway" lives in the memory of the process; losing it on a restart leaves an attempt for the sweep, which never
// expires it without the gateway's word. A customer finishes a payment on its hosted checkout page (served by the API
// in development, test and ci only, see ../../simulator-checkout); tests also drive it through SimulatorControl.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PaymentMethod } from '@mt/shared';
import {
  AdapterManifest, CreatePaymentInput, CreateRefundInput, DisputeReasonCode, Money, NormalisedEvent, PaymentLookup, PaymentProvider, ProviderContext, ProviderDispute,
  ProviderDisputeStatus, ProviderError, ProviderPayment, ProviderPaymentStatus, ProviderRefund, ProviderRefundStatus, RefundLookup, WebhookVerification,
  ProviderActivity, ProviderSettlement, ProviderSettlementLine,
} from '../../core/provider';
import { DISPUTE_REASON_CODES } from '../../core/provider';

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
    // Task 4.1: nothing typed; the API key and the webhook secret are made by the server.
    account: { fields: [], generated: [{ key: 'apiKey', prefix: 'sim_test_' }], webhookSecret: { source: 'generated' } },
    capabilities: { refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'failed', disputes: 'events', reconciliation: { activity: true, settlements: true } },
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

/** A refund at the simulated gateway (task 3.3): made by us (with a key) or on its "dashboard" (without). */
interface SimRefund {
  ref: string;
  paymentRef: string;
  status: ProviderRefundStatus;
  amount: Money;
  idempotencyKey?: string;
  refundId?: string;
  failureCode?: string;
}

/** A dispute at the simulated gateway (task 4.5): opened and moved by tests, as a cardholder's bank would. */
interface SimDispute {
  ref: string;
  paymentRef: string;
  amount: Money;
  reasonCode: DisputeReasonCode;
  status: ProviderDisputeStatus;
  evidenceDueBy?: Date;
  fundsWithdrawn: boolean;
  fundsReinstated: boolean;
}

class SimAccount {
  readonly disputes = new Map<string, SimDispute>();
  readonly payments = new Map<string, SimPayment>();
  readonly byKey = new Map<string, string>();
  readonly refunds = new Map<string, SimRefund>();
  readonly refundsByKey = new Map<string, string>();
  readonly nextRefund: Array<'pending' | 'unavailable'> = [];
  readonly nextRefundRetrieve: SimulatorRetrieveFault[] = [];
  readonly nextDisputeRetrieve: Array<'unavailable'> = [];
  readonly next: SimulatorOutcome[] = [];
  readonly nextCancel: Array<'unavailable'> = [];
  readonly nextRetrieve: SimulatorRetrieveFault[] = [];
  createCalls = 0;
  /** Task 4.6: when each object was created (listActivity's window), what was paid out and the payouts made. */
  readonly createdAt = new Map<string, Date>();
  readonly settled = new Set<string>();
  readonly payouts: ProviderSettlement[] = [];
  readonly nextList: Array<'unavailable' | 'timeout'> = [];
  listCalls = 0;
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

const disputeView = (d: SimDispute): ProviderDispute => ({
  ref: d.ref, paymentRef: d.paymentRef, amount: { ...d.amount }, reasonCode: d.reasonCode, status: d.status, fundsWithdrawn: d.fundsWithdrawn, fundsReinstated: d.fundsReinstated,
  ...(d.evidenceDueBy ? { evidenceDueBy: new Date(d.evidenceDueBy.getTime()) } : {}),
});

/** Like Stripe (charge_disputed): a payment with a dispute that is not won or closed cannot be refunded. */
const disputed = (acc: SimAccount, paymentRef: string): boolean => [...acc.disputes.values()].some((d) => d.paymentRef === paymentRef && (d.status === 'open' || d.status === 'evidence_submitted' || d.status === 'lost'));

const refundView = (r: SimRefund): ProviderRefund => ({
  ref: r.ref, status: r.status, amount: { ...r.amount }, paymentRef: r.paymentRef,
  ...(r.refundId ? { ourRefundId: r.refundId } : {}), ...(r.failureCode ? { failureCode: r.failureCode } : {}),
});

/** What is still refundable on a payment: its amount less every refund not failed or cancelled. */
function refundable(acc: SimAccount, p: SimPayment): bigint {
  let left = p.amount.amountMinor;
  for (const r of acc.refunds.values()) if (r.paymentRef === p.ref && r.status !== 'failed' && r.status !== 'cancelled') left -= r.amount.amountMinor;
  return left;
}

const view = (p: SimPayment, checkoutBase?: string): ProviderPayment => ({
  ref: p.ref,
  status: p.status,
  amount: { ...p.amount },
  ...(p.paymentId ? { ourPaymentId: p.paymentId } : {}),
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
    acc.createdAt.set(p.ref, new Date());
    acc.byKey.set(p.idempotencyKey, p.ref);
    if (outcome === 'timeout_after_create') throw new ProviderError('provider_timeout', true);
    return view(p, this.checkoutBase);
  }

  async retrievePayment(ctx: ProviderContext, by: PaymentLookup): Promise<ProviderPayment | null> {
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

  async createRefund(ctx: ProviderContext, input: CreateRefundInput): Promise<ProviderRefund> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    const known = acc.refundsByKey.get(input.idempotencyKey);
    if (known) {
      const r = acc.refunds.get(known)!;
      if (r.amount.amountMinor !== input.amount.amountMinor || r.paymentRef !== input.paymentRef) throw new ProviderError('provider_rejected', false);
      return refundView(r);
    }
    const outcome = acc.nextRefund.shift();
    if (outcome === 'unavailable') throw new ProviderError('provider_unavailable', true);
    const p = acc.payments.get(input.paymentRef);
    if (!p) throw new ProviderError('provider_not_found', false);
    if (disputed(acc, p.ref)) throw new ProviderError('provider_rejected', false);
    if (p.status !== 'succeeded' || input.amount.currency !== p.amount.currency || input.amount.amountMinor <= 0n || input.amount.amountMinor > refundable(acc, p)) {
      throw new ProviderError('provider_rejected', false);
    }
    const r: SimRefund = {
      ref: `sim_ref_${randomBytes(12).toString('hex')}`, paymentRef: p.ref, status: outcome === 'pending' ? 'pending' : 'succeeded', amount: { ...input.amount },
      idempotencyKey: input.idempotencyKey, refundId: input.metadata.refundId,
    };
    acc.refunds.set(r.ref, r);
    acc.createdAt.set(r.ref, new Date());
    acc.refundsByKey.set(input.idempotencyKey, r.ref);
    return refundView(r);
  }

  async retrieveRefund(ctx: ProviderContext, by: RefundLookup): Promise<ProviderRefund | null> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    const fault = acc.nextRefundRetrieve.shift();
    if (fault === 'unavailable') throw new ProviderError('provider_unavailable', true);
    if (fault === 'auth_failed') throw new ProviderError('provider_auth_failed', false);
    if (fault === 'not_found') return null;
    if (fault === 'not_found_error') throw new ProviderError('provider_not_found', false);
    const ref = 'ref' in by ? by.ref : acc.refundsByKey.get(by.idempotencyKey);
    const r = ref ? acc.refunds.get(ref) : undefined;
    return r ? refundView(r) : null;
  }

  async retrieveDispute(ctx: ProviderContext, ref: string): Promise<ProviderDispute | null> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    if (acc.nextDisputeRetrieve.shift() === 'unavailable') throw new ProviderError('provider_unavailable', true);
    const d = acc.disputes.get(ref);
    return d ? disputeView(d) : null;
  }

  /** Task 4.6: what the simulated gateway recorded in the window, oldest first, SIM_PAGE items a page. */
  async listActivity(ctx: ProviderContext, window: { from: Date; to: Date; cursor?: string }): Promise<{ items: ProviderActivity[]; next?: string }> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    listFault(acc);
    const at = (ref: string) => acc.createdAt.get(ref) ?? new Date(0);
    const all: ProviderActivity[] = [
      ...[...acc.payments.values()].map((p): ProviderActivity => ({ kind: 'payment', ref: p.ref, ...(p.paymentId ? { ourId: p.paymentId } : {}), amount: { ...p.amount }, status: p.status, occurredAt: at(p.ref) })),
      ...[...acc.refunds.values()].map((r): ProviderActivity => ({ kind: 'refund', ref: r.ref, paymentRef: r.paymentRef, ...(r.refundId ? { ourId: r.refundId } : {}), amount: { ...r.amount }, status: r.status, occurredAt: at(r.ref) })),
      ...[...acc.disputes.values()].map((d): ProviderActivity => ({ kind: 'dispute', ref: d.ref, paymentRef: d.paymentRef, amount: { ...d.amount }, status: d.status, occurredAt: at(d.ref) })),
    ].filter((x) => x.occurredAt >= window.from && x.occurredAt < window.to).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.ref < b.ref ? -1 : 1));
    return page(all, window.cursor);
  }

  /** Task 4.6: the payouts made on or after a calendar date, SIM_PAGE a page. */
  async listSettlements(ctx: ProviderContext, since: { payoutDateFrom: string; cursor?: string }): Promise<{ items: ProviderSettlement[]; next?: string }> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    listFault(acc);
    return page(acc.payouts.filter((s) => s.payoutDate >= since.payoutDateFrom).map(copySettlement), since.cursor);
  }

  /** The webhook the gateway would send now for a dispute of this account, signed at `at` (contract suite). */
  currentDisputeWebhook(ctx: ProviderContext, ref: string, at: Date): SignedWebhook {
    checkCredentials(ctx);
    const d = this.world.account(ctx.accountId).disputes.get(ref);
    if (!d) throw new ProviderError('provider_not_found', false);
    return signedDisputeEvent(ctx.webhookSecret, d, { at, signedAt: at });
  }

  /** The webhook the gateway would send now for a refund of this account, signed at `at` (contract suite). */
  currentRefundWebhook(ctx: ProviderContext, ref: string, at: Date): SignedWebhook {
    checkCredentials(ctx);
    const r = this.world.account(ctx.accountId).refunds.get(ref);
    if (!r) throw new ProviderError('provider_not_found', false);
    return signedRefundEvent(ctx.webhookSecret, r, { at, signedAt: at });
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
  if (b.type === 'refund.updated') return parseRefundEvent(base, b.data);
  if (b.type === 'dispute.updated') return parseDisputeEvent(base, b.data);
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

const REFUND_STATUSES: readonly ProviderRefundStatus[] = ['pending', 'succeeded', 'failed', 'cancelled'];

function parseRefundEvent(base: { providerEventId: string; type: string; occurredAt: Date }, data: unknown): NormalisedEvent | null {
  const d = data as Record<string, unknown> | undefined;
  if (!d || typeof d.ref !== 'string' || typeof d.paymentRef !== 'string' || !REFUND_STATUSES.includes(d.status as ProviderRefundStatus)
    || typeof d.amountMinor !== 'string' || !/^\d{1,18}$/.test(d.amountMinor) || typeof d.currency !== 'string') return null;
  const meta = d.metadata as Record<string, unknown> | undefined;
  return {
    ...base,
    kind: 'refund',
    refund: {
      ref: d.ref, paymentRef: d.paymentRef, status: d.status as ProviderRefundStatus, amount: { amountMinor: BigInt(d.amountMinor), currency: d.currency },
      ...(typeof meta?.refundId === 'string' ? { ourRefundId: meta.refundId } : {}),
      ...(typeof d.failureCode === 'string' ? { failureCode: d.failureCode } : {}),
    },
  };
}

const DISPUTE_STATUSES: readonly ProviderDisputeStatus[] = ['open', 'evidence_submitted', 'won', 'lost', 'closed'];

function parseDisputeEvent(base: { providerEventId: string; type: string; occurredAt: Date }, data: unknown): NormalisedEvent | null {
  const d = data as Record<string, unknown> | undefined;
  if (!d || typeof d.ref !== 'string' || typeof d.paymentRef !== 'string' || !DISPUTE_STATUSES.includes(d.status as ProviderDisputeStatus)
    || typeof d.amountMinor !== 'string' || !/^\d{1,18}$/.test(d.amountMinor) || typeof d.currency !== 'string'
    || typeof d.fundsWithdrawn !== 'boolean' || typeof d.fundsReinstated !== 'boolean') return null;
  const reason = (DISPUTE_REASON_CODES as readonly string[]).includes(d.reasonCode as string) ? (d.reasonCode as DisputeReasonCode) : 'other';
  const due = typeof d.evidenceDueBy === 'number' ? new Date(d.evidenceDueBy * 1000) : undefined;
  return {
    ...base,
    kind: 'dispute',
    dispute: {
      ref: d.ref, paymentRef: d.paymentRef, amount: { amountMinor: BigInt(d.amountMinor), currency: d.currency }, reasonCode: reason,
      status: d.status as ProviderDisputeStatus, fundsWithdrawn: d.fundsWithdrawn, fundsReinstated: d.fundsReinstated, ...(due ? { evidenceDueBy: due } : {}),
    },
  };
}

/** The simulated gateway's dispute.updated event, signed with `secret`. */
function signedDisputeEvent(secret: string, d: SimDispute, opts: EventOptions = {}): SignedWebhook {
  const eventId = opts.eventId ?? `sim_evt_${randomBytes(10).toString('hex')}`;
  const created = Math.floor((opts.at ?? new Date()).getTime() / 1000);
  const body = Buffer.from(JSON.stringify({
    id: eventId, type: 'dispute.updated', created,
    data: {
      ref: d.ref, paymentRef: d.paymentRef, status: d.status, amountMinor: d.amount.amountMinor.toString(), currency: d.amount.currency, reasonCode: d.reasonCode,
      fundsWithdrawn: d.fundsWithdrawn, fundsReinstated: d.fundsReinstated, ...(d.evidenceDueBy ? { evidenceDueBy: Math.floor(d.evidenceDueBy.getTime() / 1000) } : {}),
    },
  }));
  return { body, eventId, headers: { 'content-type': 'application/json', [SIMULATOR_SIGNATURE_HEADER]: signSimulator(secret, body, opts.signedAt ?? new Date()) } };
}

/** The simulated gateway's refund.updated event, signed with `secret`. */
function signedRefundEvent(secret: string, r: SimRefund, opts: EventOptions = {}): SignedWebhook {
  const eventId = opts.eventId ?? `sim_evt_${randomBytes(10).toString('hex')}`;
  const created = Math.floor((opts.at ?? new Date()).getTime() / 1000);
  const body = Buffer.from(JSON.stringify({
    id: eventId, type: 'refund.updated', created,
    data: {
      ref: r.ref, paymentRef: r.paymentRef, status: r.status, amountMinor: r.amount.amountMinor.toString(), currency: r.amount.currency,
      ...(r.refundId ? { metadata: { refundId: r.refundId } } : {}), ...(r.failureCode ? { failureCode: r.failureCode } : {}),
    },
  }));
  return { body, eventId, headers: { 'content-type': 'application/json', [SIMULATOR_SIGNATURE_HEADER]: signSimulator(secret, body, opts.signedAt ?? new Date()) } };
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
/** Task 4.6: page size of the simulator's listings, small so that tests page. */
export const SIM_PAGE = 20;

function listFault(acc: SimAccount): void {
  acc.listCalls += 1;
  const f = acc.nextList.shift();
  if (f === 'unavailable') throw new ProviderError('provider_unavailable', true);
  if (f === 'timeout') throw new ProviderError('provider_timeout', true);
}

function page<T>(all: T[], cursor?: string): { items: T[]; next?: string } {
  const from = cursor && /^[0-9]{1,9}$/.test(cursor) ? Number(cursor) : 0;
  const items = all.slice(from, from + SIM_PAGE);
  return from + SIM_PAGE < all.length ? { items, next: String(from + SIM_PAGE) } : { items };
}

const copySettlement = (s: ProviderSettlement): ProviderSettlement => ({ ...s, lines: s.lines.map((l) => ({ ...l })) });

/** The simulated gateway's fees (task 4.6): 1.75 % + 30 c a charge, A$15 a dispute withdrawn. Its data, not our prices. */
export const simulatorChargeFee = (amountMinor: bigint): bigint => (amountMinor * 175n + 5_000n) / 10_000n + 30n;
export const SIMULATOR_DISPUTE_FEE = 1_500n;

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

  /** A refund made on the gateway's own dashboard (task 3.3): no key and no id of ours. Refused beyond what is left. */
  gatewayRefund(accountId: string, paymentRef: string, amountMinor: bigint, status: ProviderRefundStatus = 'succeeded'): ProviderRefund {
    const acc = this.world.account(accountId);
    const p = acc.payments.get(paymentRef);
    if (!p || p.status !== 'succeeded' || amountMinor <= 0n || amountMinor > refundable(acc, p)) throw new Error('simulator: refund refused');
    const r: SimRefund = { ref: `sim_ref_${randomBytes(12).toString('hex')}`, paymentRef, status, amount: { amountMinor, currency: p.amount.currency } };
    acc.refunds.set(r.ref, r);
    acc.createdAt.set(r.ref, new Date());
    return refundView(r);
  }

  /**
   * A cardholder disputes a payment (task 4.5): the bank opens a dispute for `amountMinor` (default the whole payment),
   * with evidence due in 14 days. Funds are not taken until withdrawDispute (or `withdrawn: true`).
   */
  /**
   * Task 4.6: the gateway pays out everything not paid out yet (collected payments, refunds, disputes withdrawn and
   * reinstated), with its fees, as one settlement dated `payoutDate`.
   */
  payout(accountId: string, payoutDate: string): ProviderSettlement {
    const acc = this.world.account(accountId);
    const lines: ProviderSettlementLine[] = [];
    const add = (key: string, l: Omit<ProviderSettlementLine, 'ref'>) => {
      if (acc.settled.has(key)) return;
      acc.settled.add(key);
      lines.push({ ref: `sim_line_${randomBytes(8).toString('hex')}`, ...l });
    };
    for (const p of acc.payments.values()) if (p.status === 'succeeded') add(`charge:${p.ref}`, { kind: 'charge', paymentRef: p.ref, amountMinor: p.amount.amountMinor, feeMinor: simulatorChargeFee(p.amount.amountMinor) });
    for (const r of acc.refunds.values()) if (r.status === 'succeeded') add(`refund:${r.ref}`, { kind: 'refund', paymentRef: r.paymentRef, refundRef: r.ref, amountMinor: -r.amount.amountMinor, feeMinor: 0n });
    for (const d of acc.disputes.values()) {
      if (d.fundsWithdrawn) add(`dw:${d.ref}`, { kind: 'dispute_withdrawal', paymentRef: d.paymentRef, disputeRef: d.ref, amountMinor: -d.amount.amountMinor, feeMinor: SIMULATOR_DISPUTE_FEE });
      if (d.fundsReinstated) add(`dr:${d.ref}`, { kind: 'dispute_reinstatement', paymentRef: d.paymentRef, disputeRef: d.ref, amountMinor: d.amount.amountMinor, feeMinor: 0n });
    }
    const grossMinor = lines.reduce((s, l) => s + l.amountMinor, 0n);
    const feesMinor = lines.reduce((s, l) => s + l.feeMinor, 0n);
    const s: ProviderSettlement = { ref: `sim_po_${randomBytes(10).toString('hex')}`, payoutDate, currency: 'AUD', grossMinor, feesMinor, netMinor: grossMinor - feesMinor, lines };
    acc.payouts.push(s);
    return copySettlement(s);
  }

  /** Task 4.6: a payout written by hand (another currency, a negative one, an unknown line…). */
  addPayout(accountId: string, s: ProviderSettlement): void {
    this.world.account(accountId).payouts.push(copySettlement(s));
  }

  /** Task 4.6: the gateway changes a payout it already reported (a difference the reconciliation must catch). */
  alterPayout(accountId: string, ref: string, change: (s: ProviderSettlement) => void): void {
    const s = this.world.account(accountId).payouts.find((x) => x.ref === ref);
    if (!s) throw new Error('simulator: unknown payout');
    change(s);
  }

  /** Task 4.6: the gateway's record of a payment changes behind our back (an injected difference). */
  alterPayment(accountId: string, ref: string, change: { amountMinor?: bigint; status?: ProviderPaymentStatus }): void {
    const p = this.world.account(accountId).payments.get(ref);
    if (!p) throw new Error('simulator: unknown payment');
    if (change.amountMinor !== undefined) p.amount = { ...p.amount, amountMinor: change.amountMinor };
    if (change.status) p.status = change.status;
  }

  /** Task 4.6: the gateway loses one payment. */
  dropPayment(accountId: string, ref: string): void {
    this.world.account(accountId).payments.delete(ref);
  }

  /** Task 4.6: a payment taken at the gateway that we never started (no id of ours). */
  foreignPayment(accountId: string, amountMinor: bigint): ProviderPayment {
    const acc = this.world.account(accountId);
    const p: SimPayment = { ref: `sim_pay_${randomBytes(12).toString('hex')}`, idempotencyKey: `foreign:${randomBytes(6).toString('hex')}`, status: 'succeeded', amount: { amountMinor, currency: 'AUD' }, method: 'card', paymentId: '', returnUrl: 'https://invalid.example/' };
    acc.payments.set(p.ref, p);
    acc.createdAt.set(p.ref, new Date());
    return view(p);
  }

  /** Task 4.6: the next listing calls fail. */
  failNextList(accountId: string, ...how: Array<'unavailable' | 'timeout'>): void {
    this.world.account(accountId).nextList.push(...how);
  }

  listCalls(accountId: string): number {
    return this.world.account(accountId).listCalls;
  }

  /** Task 4.6: moves the creation time of an object (a test looks at old or very recent activity). */
  backdate(accountId: string, ref: string, at: Date): void {
    this.world.account(accountId).createdAt.set(ref, at);
  }

  openDispute(accountId: string, paymentRef: string, opts: { amountMinor?: bigint; reasonCode?: DisputeReasonCode; withdrawn?: boolean; status?: ProviderDisputeStatus } = {}): ProviderDispute {
    const acc = this.world.account(accountId);
    const p = acc.payments.get(paymentRef);
    if (!p || p.status !== 'succeeded') throw new Error('simulator: only a collected payment can be disputed');
    const d: SimDispute = {
      ref: `sim_dp_${randomBytes(12).toString('hex')}`, paymentRef, amount: { amountMinor: opts.amountMinor ?? p.amount.amountMinor, currency: p.amount.currency },
      reasonCode: opts.reasonCode ?? 'fraudulent', status: opts.status ?? 'open', evidenceDueBy: new Date(Math.floor(Date.now() / 1000) * 1000 + 14 * 86_400_000),
      fundsWithdrawn: opts.withdrawn ?? false, fundsReinstated: false,
    };
    acc.disputes.set(d.ref, d);
    acc.createdAt.set(d.ref, new Date());
    return disputeView(d);
  }

  /** Moves a dispute on the gateway side: its status and its cumulative funds flags. */
  moveDispute(accountId: string, ref: string, to: { status?: ProviderDisputeStatus; fundsWithdrawn?: boolean; fundsReinstated?: boolean }): ProviderDispute {
    const d = this.world.account(accountId).disputes.get(ref);
    if (!d) throw new Error('simulator: unknown dispute');
    if (to.status) d.status = to.status;
    if (to.fundsWithdrawn !== undefined) d.fundsWithdrawn = to.fundsWithdrawn;
    if (to.fundsReinstated !== undefined) d.fundsReinstated = to.fundsReinstated;
    return disputeView(d);
  }

  /** A dispute webhook as the gateway would send it now; `over` changes what it says (not what the gateway holds). */
  disputeEvent(secret: string, accountId: string, ref: string, over: { status?: ProviderDisputeStatus; fundsWithdrawn?: boolean; fundsReinstated?: boolean; amountMinor?: bigint; currency?: string; eventId?: string } = {}): SignedWebhook {
    const d = this.world.account(accountId).disputes.get(ref);
    if (!d) throw new Error('simulator: unknown dispute');
    const said: SimDispute = {
      ...d, status: over.status ?? d.status, fundsWithdrawn: over.fundsWithdrawn ?? d.fundsWithdrawn, fundsReinstated: over.fundsReinstated ?? d.fundsReinstated,
      amount: { amountMinor: over.amountMinor ?? d.amount.amountMinor, currency: over.currency ?? d.amount.currency },
    };
    return signedDisputeEvent(secret, said, over.eventId ? { eventId: over.eventId } : {});
  }

  /** The next retrieveDispute fails as unavailable. */
  failNextDisputeRetrieve(accountId: string): void {
    this.world.account(accountId).nextDisputeRetrieve.push('unavailable');
  }

  /** Moves a refund on the gateway side (a pending one settles or fails; a succeeded one can fail later). */
  settleRefund(accountId: string, ref: string, status: ProviderRefundStatus, failureCode?: string): ProviderRefund {
    const r = this.world.account(accountId).refunds.get(ref);
    if (!r) throw new Error('simulator: unknown refund');
    r.status = status;
    if (failureCode) r.failureCode = failureCode;
    return refundView(r);
  }

  findRefund(accountId: string, ref: string): ProviderRefund | null {
    const r = this.world.account(accountId).refunds.get(ref);
    return r ? refundView(r) : null;
  }

  /** The next retrieveRefund fails this way (its own queue: retrievePayment has another). */
  failNextRefundRetrieve(accountId: string, how: SimulatorRetrieveFault = 'unavailable'): void {
    this.world.account(accountId).nextRefundRetrieve.push(how);
  }

  /** The next createRefund answers pending, or fails as unavailable. */
  queueRefund(accountId: string, outcome: 'pending' | 'unavailable'): void {
    this.world.account(accountId).nextRefund.push(outcome);
  }

  /** A refund webhook as the gateway would send it now; `over` changes what it says. */
  refundEvent(secret: string, accountId: string, ref: string, over: { amountMinor?: bigint; currency?: string; status?: ProviderRefundStatus; eventId?: string; paymentRef?: string } = {}): SignedWebhook {
    const r = this.world.account(accountId).refunds.get(ref);
    if (!r) throw new Error('simulator: unknown refund');
    const said: SimRefund = { ...r, amount: { amountMinor: over.amountMinor ?? r.amount.amountMinor, currency: over.currency ?? r.amount.currency }, status: over.status ?? r.status, paymentRef: over.paymentRef ?? r.paymentRef };
    return signedRefundEvent(secret, said, over.eventId ? { eventId: over.eventId } : {});
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
