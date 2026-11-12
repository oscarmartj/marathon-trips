// The payment gateway simulator (plan 3.1, sections 2.3 and 6): the only adapter that can take a (pretend) payment.
// Test-only: never live, and the gateway wrapper refuses it outside development, test and ci. Its "gateway" lives in
// the memory of the process; losing it on a restart leaves an attempt for the sweep, which never expires it without
// the gateway's word. Tests drive it through SimulatorControl; there is no HTTP route into it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PaymentMethod } from '@mt/shared';
import {
  AdapterManifest, CreatePaymentInput, Money, NormalisedEvent, PaymentProvider, ProviderContext, ProviderError, ProviderPayment, ProviderPaymentStatus,
  WebhookVerification,
} from '../../core/provider';

export const SIMULATOR_KEY = 'simulator';
export const SIMULATOR_SIGNATURE_HEADER = 'x-sim-signature';
export const SIMULATOR_CHECKOUT_ORIGIN = 'https://checkout.simulator.invalid';
/** Signatures older or newer than this are refused (replays). */
export const SIMULATOR_TOLERANCE_SECONDS = 300;

export const simulatorManifest: AdapterManifest = {
  key: SIMULATOR_KEY,
  displayName: 'Payment simulator (test only)',
  status: 'experimental',
  testOnly: true,
  cardDataHandling: 'hosted_only',
  methods: ['card', 'apple_pay', 'google_pay'] satisfies PaymentMethod[],
  currencies: ['AUD'],
  countries: 'any',
  checkoutOrigin: SIMULATOR_CHECKOUT_ORIGIN,
  capabilities: { refunds: 'none', deferredCapture: false, lookupByIdempotencyKey: true },
};

interface SimPayment {
  ref: string;
  idempotencyKey: string;
  status: ProviderPaymentStatus;
  amount: Money;
  method: PaymentMethod;
  paymentId: string;
  failureCode?: string;
}

/** What the next createPayment does, set by a test. */
export type SimulatorOutcome = 'requires_action' | 'pending' | 'succeeded' | 'decline' | 'timeout' | 'timeout_after_create' | 'unavailable';

class SimAccount {
  readonly payments = new Map<string, SimPayment>();
  readonly byKey = new Map<string, string>();
  readonly next: SimulatorOutcome[] = [];
  readonly nextCancel: Array<'unavailable'> = [];
  readonly nextRetrieve: Array<'unavailable' | 'not_found'> = [];
  createCalls = 0;
}

/** The simulated gateway's state, one per account id, in the process's memory. */
export class SimulatorWorld {
  private readonly accounts = new Map<string, SimAccount>();

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
  }
}

export const SIMULATOR_WORLD = new SimulatorWorld();

const view = (p: SimPayment, withAction: boolean): ProviderPayment => ({
  ref: p.ref,
  status: p.status,
  amount: { ...p.amount },
  ourPaymentId: p.paymentId,
  ...(p.failureCode ? { failureCode: p.failureCode } : {}),
  ...(withAction && p.status === 'requires_action' ? { nextAction: { type: 'redirect' as const, url: `${SIMULATOR_CHECKOUT_ORIGIN}/pay/${p.ref}` } } : {}),
});

function checkCredentials(ctx: ProviderContext): void {
  if (!/^sim_test_[A-Za-z0-9]{16,}$/.test(ctx.credentials.apiKey ?? '')) throw new ProviderError('provider_auth_failed', false);
}

export class SimulatorProvider implements PaymentProvider {
  readonly manifest = simulatorManifest;
  readonly signatureHeaders = [SIMULATOR_SIGNATURE_HEADER] as const;

  constructor(private readonly world: SimulatorWorld = SIMULATOR_WORLD) {}

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
      return view(p, true);
    }
    const outcome = acc.next.shift() ?? 'requires_action';
    if (outcome === 'timeout') throw new ProviderError('provider_timeout', true);
    if (outcome === 'unavailable') throw new ProviderError('provider_unavailable', true);
    if (!simulatorManifest.currencies.includes(input.amount.currency) || input.amount.amountMinor <= 0n) throw new ProviderError('provider_rejected', false);
    const p: SimPayment = {
      ref: `sim_pay_${randomBytes(12).toString('hex')}`,
      idempotencyKey: input.idempotencyKey,
      status: outcome === 'decline' ? 'failed' : outcome === 'timeout_after_create' ? 'requires_action' : outcome,
      amount: { ...input.amount },
      method: input.method,
      paymentId: input.metadata.paymentId,
      ...(outcome === 'decline' ? { failureCode: 'card_declined' } : {}),
    };
    acc.payments.set(p.ref, p);
    acc.byKey.set(p.idempotencyKey, p.ref);
    if (outcome === 'timeout_after_create') throw new ProviderError('provider_timeout', true);
    return view(p, true);
  }

  async retrievePayment(ctx: ProviderContext, by: { ref: string } | { idempotencyKey: string }): Promise<ProviderPayment | null> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    const fault = acc.nextRetrieve.shift();
    if (fault === 'unavailable') throw new ProviderError('provider_unavailable', true);
    if (fault === 'not_found') return null;
    const ref = 'ref' in by ? by.ref : acc.byKey.get(by.idempotencyKey);
    const p = ref ? acc.payments.get(ref) : undefined;
    return p ? view(p, true) : null;
  }

  async cancelPayment(ctx: ProviderContext, ref: string): Promise<ProviderPayment> {
    checkCredentials(ctx);
    const acc = this.world.account(ctx.accountId);
    if (acc.nextCancel.shift() === 'unavailable') throw new ProviderError('provider_unavailable', true);
    const p = acc.payments.get(ref);
    if (!p) throw new ProviderError('provider_not_found', false);
    // A collected or in-flight payment cannot be cancelled: the gateway says what it is instead.
    if (p.status === 'requires_action') p.status = 'cancelled';
    return view(p, false);
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
  const base = { providerEventId: b.id, occurredAt: new Date(b.created * 1000) };
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

  failNextRetrieve(accountId: string, how: 'unavailable' | 'not_found' = 'unavailable'): void {
    this.world.account(accountId).nextRetrieve.push(how);
  }

  createCalls(accountId: string): number {
    return this.world.account(accountId).createCalls;
  }

  objectCount(accountId: string): number {
    return this.world.account(accountId).payments.size;
  }

  find(accountId: string, by: { ref: string } | { paymentId: string }): ProviderPayment | null {
    const acc = this.world.account(accountId);
    const p = 'ref' in by ? acc.payments.get(by.ref) : [...acc.payments.values()].find((x) => x.paymentId === by.paymentId);
    return p ? view(p, false) : null;
  }

  /** The customer finished (or abandoned) the hosted page: the gateway object moves to `status`. */
  settle(accountId: string, ref: string, status: ProviderPaymentStatus, failureCode?: string): ProviderPayment {
    const p = this.world.account(accountId).payments.get(ref);
    if (!p) throw new Error('simulator: unknown payment');
    p.status = status;
    if (failureCode) p.failureCode = failureCode;
    return view(p, false);
  }

  forget(accountId: string): void {
    this.world.forget(accountId);
  }

  /** A webhook for a payment, signed with `secret`; `over` changes what the event says (amount, currency, metadata…). */
  paymentEvent(
    secret: string,
    payment: { ref: string; status: ProviderPaymentStatus; amountMinor: bigint; currency: string; paymentId?: string; failureCode?: string },
    opts: { eventId?: string; at?: Date; signedAt?: Date; type?: string } = {},
  ): SignedWebhook {
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
}

export function signSimulator(secret: string, body: Buffer, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}`;
}
