// Pay later through Stripe Checkout (plan docs/plans/9.3-stripe-pay-later.md): Afterpay, Klarna and Zip on Stripe's hosted
// page, as a separate adapter key with its own Stripe account (plan 4.2). `experimental`: proven only against the fake of
// test/contract/subjects/stripe-fake.ts. It is the Stripe class with a pay-later session; what differs is below. No
// provider has approved this business: nothing here says otherwise.
import { randomBytes } from 'node:crypto';
import type { PaymentMethod } from '@mt/shared';
import type { AdapterManifest, CreatePaymentInput, CreateRefundInput, NormalisedEvent, ProviderContext, ProviderPayment, ProviderRefund, WebhookVerification } from '../../core/provider';
import { ProviderError } from '../../core/provider';
import { sessionPaymentIntentId, sessionToPayment } from './mapping';
import { StripeProvider, stripeManifest } from './stripe';

export const STRIPE_BNPL_KEY = 'stripe_bnpl';

/**
 * The pay-later methods offered on Checkout, in this fixed order, each with the amounts it documents for an Australian
 * business (inclusive, AUD minor units; plan 9.3, 6.1 and 19 points 3 and 6). Klarna only up to its Pay in 4 limit; Zip
 * capped where Zip Money needs merchant qualification. UNVERIFIED until the sandbox run.
 */
export const BNPL_METHODS: ReadonlyArray<{ type: 'afterpay_clearpay' | 'klarna' | 'zip'; minMinor: bigint; maxMinor: bigint }> = [
  { type: 'afterpay_clearpay', minMinor: 100n, maxMinor: 400_000n },
  { type: 'klarna', minMinor: 100n, maxMinor: 200_000n },
  { type: 'zip', minMinor: 100n, maxMinor: 500_000n },
];

/** How long after the charge each method still takes a refund (plan 9.3, 19 point 2a, A16). UNVERIFIED. */
export const BNPL_REFUND_WINDOW_DAYS: Readonly<Record<string, number>> = { afterpay_clearpay: 120, klarna: 180, zip: 180 };
/** A refund is refused this long before the window closes, so it is never sent at the edge. */
const REFUND_WINDOW_MARGIN_MS = 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** The pay-later types that can take this amount, in the table's order. */
export function bnplTypesFor(amountMinor: bigint): string[] {
  return BNPL_METHODS.filter((m) => amountMinor >= m.minMinor && amountMinor <= m.maxMinor).map((m) => m.type);
}

const SAMPLE = 'x'.repeat(24);

export function stripeBnplManifest(): AdapterManifest {
  const base = stripeManifest();
  return {
    ...base,
    key: STRIPE_BNPL_KEY,
    displayName: 'Stripe pay later (Afterpay, Klarna, Zip)',
    methods: ['bnpl'] satisfies PaymentMethod[],
    currencies: ['AUD'],
    countries: ['AU'],
    amountRange: { minMinor: BNPL_METHODS.reduce((a, m) => (m.minMinor < a ? m.minMinor : a), BNPL_METHODS[0]!.minMinor), maxMinor: BNPL_METHODS.reduce((a, m) => (m.maxMinor > a ? m.maxMinor : a), 0n) },
    account: {
      fields: [{
        key: 'secretKey', label: 'Secret key of the Stripe account used only for pay later (test mode, sk_test_… or rk_test_…)', pattern: '^(sk|rk)_test_[A-Za-z0-9]{10,250}$',
        samples: { valid: `sk_test_${SAMPLE}`, rejected: [`sk_live_${SAMPLE}`, `rk_live_${SAMPLE}`, `pk_test_${SAMPLE}`, `pk_live_${SAMPLE}`, `whsec_${SAMPLE}`] },
      }],
      webhookSecret: {
        source: 'entered', label: 'Webhook signing secret of that account (whsec_…)', pattern: '^whsec_[A-Za-z0-9]{10,250}$',
        samples: { valid: `whsec_${SAMPLE}`, rejected: [`sk_test_${SAMPLE}`, `sk_live_${SAMPLE}`, `whsec_${SAMPLE}-x`, 'whsec_'] },
      },
    },
    capabilities: { refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'stays_payable', disputes: 'events' },
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** PaymentIntent states in which the customer may still be at the provider: never read as ended (plan 9.3, 19 point 1). */
const OPEN_PI = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);

/**
 * A pay-later Checkout Session as our payment (plan 9.3, 19 point 1). `open` and `complete` read as for cards. `expired`
 * reads by its expanded PaymentIntent: money is money, an open one is still `requires_action`, none or cancelled is
 * `cancelled`. Null when it cannot be read (an id instead of an expanded PaymentIntent included).
 */
export function bnplSessionToPayment(o: unknown): ProviderPayment | null {
  if (!isObj(o) || o.status !== 'expired') return sessionToPayment(o);
  const pi = o.payment_intent;
  if (pi === null || pi === undefined) return sessionToPayment(o);
  if (!isObj(pi) || typeof pi.status !== 'string') return null;
  if (pi.status === 'succeeded') return sessionToPayment(o, 'succeeded');
  if (pi.status === 'processing' || pi.status === 'requires_capture') return sessionToPayment(o, 'pending');
  if (pi.status === 'canceled') return sessionToPayment(o, 'cancelled');
  if (OPEN_PI.has(pi.status)) return sessionToPayment(o, 'requires_action');
  return null;
}

/**
 * The pay-later reading of a verified event (plan 9.3, 19 points 1 and 4): a card session (a Stripe account shared with
 * the card adapter) and an expired session with a PaymentIntent (pulls decide) are `unsupported`; PaymentIntent events
 * stay `unsupported`, as in `stripe`. Everything else is the Stripe reading.
 */
export function bnplEvent(body: unknown, event: NormalisedEvent): NormalisedEvent {
  if (event.kind !== 'payment' || !isObj(body) || !isObj(body.data) || !isObj(body.data.object)) return event;
  const s = body.data.object;
  const unsupported: NormalisedEvent = { providerEventId: event.providerEventId, type: event.type, occurredAt: event.occurredAt, kind: 'unsupported' };
  if (Array.isArray(s.payment_method_types) && s.payment_method_types.includes('card')) return unsupported;
  if (event.type === 'checkout.session.expired' && s.payment_intent !== null && s.payment_intent !== undefined) return unsupported;
  return event;
}

export class StripeBnplProvider extends StripeProvider {
  override readonly manifest = stripeBnplManifest();

  protected override toPayment(o: unknown): ProviderPayment {
    const p = bnplSessionToPayment(o);
    if (!p) throw new ProviderError('provider_unavailable', true);
    return p;
  }

  protected override sessionParams(input: CreatePaymentInput): Array<[string, string]> {
    const types = bnplTypesFor(input.amount.amountMinor);
    const out: Array<[string, string]> = [];
    for (const [k, v] of super.sessionParams(input)) {
      if (k === 'payment_method_types[0]') types.forEach((t, i) => out.push([`payment_method_types[${i}]`, t]));
      else out.push([k, v]);
    }
    return out;
  }

  /** Refused before the network, so no object exists and none ever will under that key (plan 9.3, 6.2). */
  override async createPayment(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment> {
    this.key(ctx);
    const eligible = input.method === 'bnpl' && input.customerCountry === 'AU' && this.manifest.currencies.includes(input.amount.currency) && bnplTypesFor(input.amount.amountMinor).length > 0;
    if (!eligible) throw new ProviderError('provider_rejected', false);
    return super.createPayment(ctx, input);
  }

  /**
   * Expire the session first, then cancel a PaymentIntent still open at the provider, then read again. Never answers
   * `requires_action`: while the PaymentIntent stays open the answer is unknown (plan 9.3, 19 point 1).
   */
  override async cancelPayment(ctx: ProviderContext, ref: string, idempotencyKey: string): Promise<ProviderPayment> {
    this.key(ctx);
    const s = await this.getSession(ctx, ref);
    if (!s) throw new ProviderError('provider_not_found', false);
    const before = this.toPayment(s);
    if (before.status === 'succeeded' || before.status === 'pending' || before.status === 'failed') return before;
    if (s.status === 'open') {
      const r = await this.call(ctx, { method: 'POST', path: `/v1/checkout/sessions/${encodeURIComponent(ref)}/expire` }, idempotencyKey);
      if (!r.ok && r.error !== 'idempotency_error' && r.error.retryable) throw new ProviderError(r.error.code, true);
    }
    const mid = await this.getSession(ctx, ref);
    if (!mid) throw new ProviderError('provider_not_found', false);
    const pi = mid.payment_intent;
    if (isObj(pi) && typeof pi.id === 'string' && typeof pi.status === 'string' && OPEN_PI.has(pi.status)) {
      // Refused or not answered: the read below decides, and an open PaymentIntent is never called cancelled.
      // A key per run (code review 3): Stripe may keep an earlier refusal under a fixed key; the read below decides,
      // and cancelling a PaymentIntent twice cannot move money.
      await this.call(ctx, { method: 'POST', path: `/v1/payment_intents/${encodeURIComponent(pi.id)}/cancel` }, `${idempotencyKey}:pi:${randomBytes(8).toString('hex')}`).catch(() => undefined);
    }
    const after = await this.getSession(ctx, ref);
    if (!after) throw new ProviderError('provider_not_found', false);
    const p = this.toPayment(after);
    if (p.status === 'requires_action') throw new ProviderError('provider_unavailable', true);
    return p;
  }

  /**
   * A refund already made under our key is returned first (a lost answer is never refused); then a charge past its
   * method's refund window is refused before the network (plan 9.3, 19 point 2a); then the Stripe path.
   */
  override async createRefund(ctx: ProviderContext, input: CreateRefundInput): Promise<ProviderRefund> {
    this.key(ctx);
    const existing = await this.retrieveRefund(ctx, { idempotencyKey: input.idempotencyKey, paymentRef: input.paymentRef, createdAt: input.createdAt });
    if (existing) return existing;
    const s = await this.getSession(ctx, input.paymentRef);
    if (!s) throw new ProviderError('provider_not_found', false);
    const pi = sessionPaymentIntentId(s);
    if (pi && this.toPayment(s).status === 'succeeded') {
      const intent = await this.must(ctx, { method: 'GET', path: `/v1/payment_intents/${encodeURIComponent(pi)}`, query: [['expand[]', 'latest_charge']] });
      const charge = intent.latest_charge;
      const details = isObj(charge) && isObj(charge.payment_method_details) ? charge.payment_method_details : null;
      if (!isObj(charge) || typeof charge.created !== 'number' || !Number.isSafeInteger(charge.created) || !details || typeof details.type !== 'string') throw new ProviderError('provider_unavailable', true);
      const days = BNPL_REFUND_WINDOW_DAYS[details.type];
      if (days !== undefined && this.now().getTime() > charge.created * 1000 + days * DAY_MS - REFUND_WINDOW_MARGIN_MS) throw new ProviderError('provider_rejected', false);
    }
    return super.createRefund(ctx, input);
  }

  override verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification {
    const v = super.verifyWebhook(ctx, rawBody, headers, now);
    if (!v.ok) return v;
    return { ok: true, event: this.adjust(rawBody, v.event) };
  }

  override parseEvent(rawBody: Buffer): NormalisedEvent | null {
    const e = super.parseEvent(rawBody);
    return e ? this.adjust(rawBody, e) : null;
  }

  private adjust(rawBody: Buffer, event: NormalisedEvent): NormalisedEvent {
    try {
      return bnplEvent(JSON.parse(rawBody.toString('utf8')), event);
    } catch {
      return event;
    }
  }
}
