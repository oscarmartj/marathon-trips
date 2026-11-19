// The payment adapter contract suite (plan docs/plans/3.6-adapter-contract-suite.md, sections 2.2 and 10). Every
// adapter runs all of it: in CI against its local subject (the simulator is its own), and against the gateway's real
// sandbox with `pnpm --filter @mt/api test:sandbox` before its manifest may say `verified`. Nothing here is specific
// to one adapter: what differs (how a customer pays, how a webhook is obtained) comes from the ContractSubject.
//
// Failure messages never print a context or a credential: C20 asserts booleans, and helpers name fields, not values.
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { PAYMENT_METHODS } from '@mt/shared';
import { CONTRACT_CLAUSES } from '../../src/modules/payments/core/contract-clauses';
import type { ContractClause } from '../../src/modules/payments/core/contract-clauses';
import { PROVIDER_ERROR_CODES, ProviderError } from '../../src/modules/payments/core/provider';
import type { CreatePaymentInput, PaymentLookup, PaymentProvider, ProviderContext, ProviderDispute, ProviderPayment, ProviderPaymentStatus, ProviderRefund, WebhookVerification } from '../../src/modules/payments/core/provider';
import { manifestProblems } from '../../src/modules/payments/core/registry';

export interface SignedBody {
  body: Buffer;
  headers: Record<string, string>;
}

/** What one adapter brings to the suite. Every member is required, so every clause runs for every adapter. */
export interface ContractSubject {
  provider: PaymentProvider;
  /** A gateway account: random for a local subject; sandbox credentials from environment variables, never from a file. */
  context(): Promise<ProviderContext>;
  /** The same account with credentials the gateway refuses. */
  badCredentials(ctx: ProviderContext): ProviderContext;
  /** What a customer does on the gateway's hosted page. Throws if the gateway does not let them. */
  customerCompletes(ctx: ProviderContext, payment: ProviderPayment, outcome: 'pay' | 'decline'): Promise<void>;
  /**
   * Takes a payment waiting for the customer to the terminal state the gateway itself gives an unpaid object (plan 3.3,
   * 12.4): a declined card where that ends it, the session expiring where it does not. Never by our cancelPayment.
   */
  endAtGateway(ctx: ProviderContext, payment: ProviderPayment): Promise<void>;
  /** The webhook the gateway would send now for this object, signed at `at` with ctx.webhookSecret. */
  webhookFor(ctx: ProviderContext, ref: string, at: Date): Promise<SignedBody>;
  /** A refund made on the gateway's own dashboard (no id of ours), read back through the adapter. */
  gatewayRefunds(ctx: ProviderContext, payment: ProviderPayment, amountMinor: bigint): Promise<ProviderRefund>;
  /** The webhook the gateway would send now for this refund, signed at `at` with ctx.webhookSecret. */
  refundWebhookFor(ctx: ProviderContext, refundRef: string, at: Date): Promise<SignedBody>;
  /**
   * Task 4.5, required when the manifest declares `disputes`: a cardholder disputes a collected payment (the whole
   * amount, no funds taken yet), the dispute moves at the gateway, and the webhook the gateway would send now.
   */
  cardholderDisputes?(ctx: ProviderContext, payment: ProviderPayment): Promise<{ ref: string }>;
  disputeMoves?(ctx: ProviderContext, ref: string, to: { status?: 'lost' | 'won'; withdraw?: boolean; reinstate?: boolean }): Promise<void>;
  disputeWebhookFor?(ctx: ProviderContext, ref: string, at: Date): Promise<SignedBody>;
  /** A currency the gateway refuses for this account. */
  unsupportedCurrency: string;
  /** Throws unless the environment holds test-mode credentials for this gateway (checked before any network call). */
  assertSandboxCredentials(env: NodeJS.ProcessEnv): void;
}

export type SubjectFactory = () => ContractSubject;

const STATUSES: readonly ProviderPaymentStatus[] = ['requires_action', 'pending', 'succeeded', 'failed', 'cancelled'];
const TERMINAL: readonly ProviderPaymentStatus[] = ['succeeded', 'failed', 'cancelled'];
const CLAUSE_TIMEOUT_MS = 60_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

/** A serialisation of anything an adapter returned or threw, for the C20 search. */
function serialise(v: unknown): string {
  const json = (x: unknown) => {
    try {
      return JSON.stringify(x, (_k, val: unknown) => (typeof val === 'bigint' ? val.toString() : Buffer.isBuffer(val) ? val.toString('utf8') : val)) ?? '';
    } catch {
      return '';
    }
  };
  if (v instanceof Error) return `${v.name} ${v.message} ${String((v as { code?: unknown }).code)} ${v.stack ?? ''} ${json(v)}`;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return json(v);
}

class Harness {
  /** Everything the adapter returned or threw during this suite, for C20. */
  readonly seen: unknown[] = [];
  /** Every context the subject handed out (good and bad credentials), for C20: their secrets are what must not leak. */
  readonly contexts: ProviderContext[] = [];

  constructor(readonly s: ContractSubject) {}

  /** A context from the subject; every one must be test mode (C0 holds for all of them, plan 3.6, 10.2). */
  async ctx(): Promise<ProviderContext> {
    const c = await this.s.context();
    expect(c.mode, 'context mode').toBe('test');
    this.contexts.push(c);
    return c;
  }

  bad(c: ProviderContext): ProviderContext {
    const b = this.s.badCredentials(c);
    expect(b.mode, 'bad-credentials context mode').toBe('test');
    this.contexts.push(b);
    return b;
  }

  get p(): PaymentProvider {
    return this.s.provider;
  }

  /** verifyWebhook as the gateway wrapper calls it: the adapter's optional prepareWebhook first (task 4.3). */
  async verify(ctx: ProviderContext, body: Buffer, headers: Record<string, string>, when: Date): Promise<WebhookVerification> {
    await this.p.prepareWebhook?.(ctx, headers);
    return this.p.verifyWebhook(ctx, body, headers, when);
  }

  /** Runs an adapter call: a value, or a ProviderError with a listed code. Any other exception fails, naming its type only. */
  async call<T>(label: string, fn: () => Promise<T> | T): Promise<Outcome<T>> {
    try {
      const value = await fn();
      this.seen.push(value);
      return { ok: true, value };
    } catch (err) {
      this.seen.push(err);
      const isProviderError = err instanceof ProviderError;
      expect(isProviderError, `${label}: threw something other than a ProviderError (${(err as object)?.constructor?.name ?? typeof err})`).toBe(true);
      const e = err as ProviderError;
      expect(PROVIDER_ERROR_CODES as readonly string[], `${label}: error code`).toContain(e.code);
      expect(typeof e.retryable, `${label}: retryable`).toBe('boolean');
      return { ok: false, error: e };
    }
  }

  async value<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
    const r = await this.call(label, fn);
    if (!r.ok) expect.fail(`${label}: expected a value, got ProviderError ${r.error.code}`);
    return r.value;
  }

  async error(label: string, fn: () => Promise<unknown>): Promise<ProviderError> {
    const r = await this.call(label, fn);
    if (r.ok) expect.fail(`${label}: expected a ProviderError, got a value`);
    return r.error;
  }

  input(over: Partial<Pick<CreatePaymentInput, 'amount' | 'idempotencyKey'>> = {}): CreatePaymentInput {
    const m = this.p.manifest;
    return {
      amount: over.amount ?? { amountMinor: 1500n, currency: m.currencies[0]! },
      method: m.methods[0]!,
      idempotencyKey: over.idempotencyKey ?? `contract:${randomUUID()}`,
      metadata: { paymentId: randomUUID(), bookingId: randomUUID() },
      returnUrl: 'https://example.com/payments/return',
      customerCountry: 'AU',
      createdAt: new Date(),
    };
  }

  /** The lookup by our key, with the createdAt the input was built with. */
  byKey(input: CreatePaymentInput): PaymentLookup {
    return { idempotencyKey: input.idempotencyKey, createdAt: input.createdAt };
  }

  /** A collected payment of `amountMinor`. */
  async paid(ctx: ProviderContext, amountMinor = 1500n): Promise<{ input: CreatePaymentInput; p: ProviderPayment }> {
    const input = this.input({ amount: { amountMinor, currency: this.p.manifest.currencies[0]! } });
    const p = await this.create(ctx, input);
    await this.s.customerCompletes(ctx, p, 'pay');
    return { input, p };
  }

  refundInput(p: ProviderPayment, amountMinor: bigint, key = `contract-refund:${randomUUID()}`) {
    return { paymentRef: p.ref, amount: { amountMinor, currency: p.amount.currency }, idempotencyKey: key, metadata: { refundId: randomUUID(), paymentId: randomUUID(), bookingId: randomUUID() }, createdAt: new Date() };
  }

  get refunds(): 'none' | 'full' | 'partial' {
    return this.p.manifest.capabilities.refunds;
  }

  expectRefund(r: ProviderRefund | null, amountMinor: bigint): ProviderRefund {
    expect(r, 'refund').not.toBeNull();
    const q = r!;
    expect(typeof q.ref === 'string' && q.ref.length > 0, 'refund ref').toBe(true);
    expect(['pending', 'succeeded', 'failed', 'cancelled'], 'refund status').toContain(q.status);
    expect(q.amount.amountMinor, 'refund amount').toBe(amountMinor);
    expect(typeof q.paymentRef === 'string' && q.paymentRef.length > 0, 'refund paymentRef').toBe(true);
    return q;
  }

  create(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment> {
    return this.value('createPayment', () => this.p.createPayment(ctx, input));
  }

  retrieve(ctx: ProviderContext, by: PaymentLookup): Promise<ProviderPayment | null> {
    return this.value('retrievePayment', () => this.p.retrievePayment(ctx, by));
  }

  cancel(ctx: ProviderContext, ref: string): Promise<ProviderPayment> {
    return this.value('cancelPayment', () => this.p.cancelPayment(ctx, ref, `contract-cancel:${ref}`));
  }

  /** A normalised payment; with `input`, also its amount, our id and the redirect origin. */
  expectPayment(p: ProviderPayment | null, input?: CreatePaymentInput): ProviderPayment {
    expect(p, 'payment').not.toBeNull();
    const q = p!;
    expect(typeof q.ref === 'string' && q.ref.length > 0, 'ref is a non-empty string').toBe(true);
    expect(STATUSES, 'status').toContain(q.status);
    expect(typeof q.amount.amountMinor, 'amountMinor is a bigint').toBe('bigint');
    if (input) {
      expect(q.amount.amountMinor, 'amount').toBe(input.amount.amountMinor);
      expect(q.amount.currency, 'currency').toBe(input.amount.currency);
      if (q.ourPaymentId !== undefined) expect(q.ourPaymentId, 'our payment id').toBe(input.metadata.paymentId);
    }
    if (q.nextAction) {
      expect(q.status, 'a redirect only while the customer must act').toBe('requires_action');
      expect(q.nextAction.type).toBe('redirect');
      expect(q.nextAction.url.startsWith(`${this.p.manifest.checkoutOrigin}/`), 'redirect under the manifest checkout origin').toBe(true);
    }
    return q;
  }
}

const now = () => new Date();
const HOUR = 3_600_000;

/** One implementation per clause; the type makes a missing or extra clause a compile error. */
export const CLAUSE_IMPLS: { readonly [K in ContractClause]: (h: Harness) => Promise<void> } = {
  async context_is_test_mode(h) {
    // Every clause takes its contexts through h.ctx() and h.bad(), which assert this too.
    const ctx = await h.ctx();
    expect(ctx.mode, 'context mode').toBe('test');
    expect(h.bad(ctx).mode, 'bad-credentials context mode').toBe('test');
  },

  async manifest_is_valid(h) {
    const m = h.p.manifest;
    expect(manifestProblems([m])).toEqual([]);
    expect(m.key).toMatch(/^[a-z0-9_]+$/);
    expect(m.cardDataHandling).toBe('hosted_only');
    expect(m.capabilities.lookupByIdempotencyKey).toBe(true);
    expect(m.currencies.length).toBeGreaterThan(0);
    for (const c of m.currencies) expect(c).toMatch(/^[A-Z]{3}$/);
    expect(m.methods.length).toBeGreaterThan(0);
    for (const method of m.methods) expect(PAYMENT_METHODS as readonly string[]).toContain(method);
    expect(h.p.signatureHeaders.length).toBeGreaterThan(0);
    for (const name of h.p.signatureHeaders) expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(m.currencies).not.toContain(h.s.unsupportedCurrency);
  },

  async create_input_has_no_card_fields() {
    // Compile-time: no card field can be added to what an adapter receives (pnpm typecheck runs this file).
    expectTypeOf<keyof CreatePaymentInput>().toEqualTypeOf<'amount' | 'method' | 'idempotencyKey' | 'metadata' | 'returnUrl' | 'customerCountry' | 'createdAt'>();
    expectTypeOf<keyof CreatePaymentInput['metadata']>().toEqualTypeOf<'paymentId' | 'bookingId'>();
    expectTypeOf<keyof CreatePaymentInput['amount']>().toEqualTypeOf<'amountMinor' | 'currency'>();
  },

  async create_returns_normalised_payment(h) {
    const ctx = await h.ctx();
    const input = h.input();
    const p = await h.create(ctx, input);
    h.expectPayment(p, input);
    // Card data stays on the gateway's hosted page: a new payment waits for the customer there.
    expect(p.status, 'a new payment waits for the customer').toBe('requires_action');
    expect(p.nextAction, 'a new payment has a redirect').toBeDefined();
  },

  async same_idempotency_key_same_object(h) {
    const ctx = await h.ctx();
    const input = h.input();
    const a = await h.create(ctx, input);
    const b = await h.create(ctx, input);
    expect(b.ref).toBe(a.ref);
    const byKey = await h.retrieve(ctx, h.byKey(input));
    expect(byKey?.ref).toBe(a.ref);
  },

  async same_key_other_amount_never_a_second_object(h) {
    const ctx = await h.ctx();
    const input = h.input();
    const a = await h.create(ctx, input);
    const other = { ...input, amount: { ...input.amount, amountMinor: input.amount.amountMinor + 100n } };
    const r = await h.call('createPayment (same key, other amount)', () => h.p.createPayment(ctx, other));
    if (r.ok) {
      expect(r.value.ref).toBe(a.ref);
      expect(r.value.amount.amountMinor).toBe(input.amount.amountMinor);
    } else {
      expect(r.error.retryable).toBe(false);
    }
    const byKey = await h.retrieve(ctx, h.byKey(input));
    expect(byKey?.ref).toBe(a.ref);
    expect(byKey?.amount.amountMinor).toBe(input.amount.amountMinor);
  },

  async different_keys_different_objects(h) {
    const ctx = await h.ctx();
    const a = await h.create(ctx, h.input());
    const b = await h.create(ctx, h.input());
    expect(a.ref).not.toBe(b.ref);
  },

  async definitive_refusal_means_no_object(h) {
    const ctx = await h.ctx();
    const input = h.input({ amount: { amountMinor: 1500n, currency: h.s.unsupportedCurrency } });
    const e = await h.error('createPayment (unsupported currency)', () => h.p.createPayment(ctx, input));
    expect(e.retryable, 'a refusal for an unsupported currency is definitive').toBe(false);
    expect(await h.retrieve(ctx, h.byKey(input)), 'no object under the key after a definitive refusal').toBeNull();
  },

  async retrieve_by_ref_and_by_key_agree(h) {
    const ctx = await h.ctx();
    const input = h.input();
    const p = await h.create(ctx, input);
    const byRef = h.expectPayment(await h.retrieve(ctx, { ref: p.ref }), input);
    const byKey = h.expectPayment(await h.retrieve(ctx, h.byKey(input)), input);
    expect(byKey.ref).toBe(p.ref);
    expect(byRef.ref).toBe(p.ref);
    expect(byKey.status).toBe(byRef.status);
  },

  async retrieve_unknown_is_null(h) {
    const ctx = await h.ctx();
    expect(await h.retrieve(ctx, { idempotencyKey: `contract:unknown:${randomUUID()}`, createdAt: new Date() })).toBeNull();
    const r = await h.call('retrievePayment (unknown ref)', () => h.p.retrievePayment(ctx, { ref: `contract_unknown_${randomBytes(8).toString('hex')}` }));
    if (r.ok) expect(r.value).toBeNull();
    else expect([r.error.code, r.error.retryable]).toEqual(['provider_not_found', false]);
  },

  async customer_payment_reflected(h) {
    const ctx = await h.ctx();
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.s.customerCompletes(ctx, p, 'pay');
    for (const by of [{ ref: p.ref }, h.byKey(input)]) {
      const q = h.expectPayment(await h.retrieve(ctx, by), input);
      expect(q.status).toBe('succeeded');
    }
  },

  async failed_is_terminal(h) {
    const ctx = await h.ctx();
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.s.customerCompletes(ctx, p, 'decline');
    if (h.p.manifest.capabilities.declineOutcome === 'stays_payable') {
      // A declined card leaves the object waiting for the customer (plan 3.3, 12.4): same object, still payable. Its
      // real end is checked by terminal_state_is_final.
      expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('requires_action');
      const again = await h.create(ctx, input);
      expect(again.ref, 'the same key never gives a new object').toBe(p.ref);
      expect(again.status).toBe('requires_action');
      await h.s.customerCompletes(ctx, p, 'pay');
      expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('succeeded');
      return;
    }
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('failed');
    const again = await h.create(ctx, input);
    expect(again.ref, 'the same key never gives a new chargeable object').toBe(p.ref);
    expect(again.status).toBe('failed');
    await expect(h.s.customerCompletes(ctx, p, 'pay'), 'a failed object cannot be paid').rejects.toThrow();
    expect((await h.cancel(ctx, p.ref)).status).toBe('failed');
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('failed');
  },

  async terminal_state_is_final(h) {
    // The three checks of failed_is_terminal on the end the gateway itself gives an unpaid object (plan 3.3, 12.4).
    const ctx = await h.ctx();
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.s.endAtGateway(ctx, p);
    const end = (await h.retrieve(ctx, { ref: p.ref }))!.status;
    expect(['failed', 'cancelled'], 'an unpaid object ends failed or cancelled').toContain(end);
    const again = await h.create(ctx, input);
    expect(again.ref, 'the same key never gives a new chargeable object').toBe(p.ref);
    expect(again.status).toBe(end);
    await expect(h.s.customerCompletes(ctx, p, 'pay'), 'an ended object cannot be paid').rejects.toThrow();
    expect((await h.cancel(ctx, p.ref)).status).toBe(end);
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe(end);
  },

  async succeeded_is_final(h) {
    const ctx = await h.ctx();
    const p = await h.create(ctx, h.input());
    await h.s.customerCompletes(ctx, p, 'pay');
    expect((await h.cancel(ctx, p.ref)).status, 'cancelling a collected payment says what it is').toBe('succeeded');
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('succeeded');
  },

  async cancel_is_idempotent_and_final(h) {
    const ctx = await h.ctx();
    const p = await h.create(ctx, h.input());
    expect((await h.cancel(ctx, p.ref)).status).toBe('cancelled');
    expect((await h.cancel(ctx, p.ref)).status).toBe('cancelled');
    await expect(h.s.customerCompletes(ctx, p, 'pay'), 'a cancelled object cannot be paid').rejects.toThrow();
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('cancelled');
  },

  async cancel_unknown_is_not_found(h) {
    const ctx = await h.ctx();
    const e = await h.error('cancelPayment (unknown ref)', () => h.p.cancelPayment(ctx, `contract_unknown_${randomBytes(8).toString('hex')}`, `contract-cancel:${randomUUID()}`));
    expect([e.code, e.retryable]).toEqual(['provider_not_found', false]);
  },

  async statuses_only_move_forward(h) {
    const ctx = await h.ctx();
    const sequences: Array<(input: CreatePaymentInput, p: ProviderPayment) => Promise<ProviderPaymentStatus[]>> = [
      async (input, p) => {
        await h.s.customerCompletes(ctx, p, 'pay');
        return [(await h.retrieve(ctx, { ref: p.ref }))!.status, (await h.cancel(ctx, p.ref)).status, (await h.create(ctx, input)).status, (await h.retrieve(ctx, h.byKey(input)))!.status];
      },
      async (input, p) => {
        await h.s.customerCompletes(ctx, p, 'decline');
        return [(await h.retrieve(ctx, { ref: p.ref }))!.status, (await h.cancel(ctx, p.ref)).status, (await h.create(ctx, input)).status];
      },
      async (input, p) => [(await h.cancel(ctx, p.ref)).status, (await h.retrieve(ctx, { ref: p.ref }))!.status, (await h.cancel(ctx, p.ref)).status, (await h.create(ctx, input)).status],
    ];
    for (const run of sequences) {
      const input = h.input();
      const p = await h.create(ctx, input);
      const seen = [p.status, ...(await run(input, p))];
      const firstTerminal = seen.findIndex((s) => TERMINAL.includes(s));
      expect(firstTerminal, `a terminal status is reached (${seen.join(' → ')})`).toBeGreaterThan(0);
      for (const s of seen.slice(firstTerminal)) expect(s, `no status after a terminal one (${seen.join(' → ')})`).toBe(seen[firstTerminal]);
    }
  },

  async webhook_verifies_and_matches_retrieve(h) {
    const ctx = await h.ctx();
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.s.customerCompletes(ctx, p, 'pay');
    const at = now();
    const w = await h.s.webhookFor(ctx, p.ref, at);
    for (const name of h.p.signatureHeaders) expect(Object.keys(w.headers).map((k) => k.toLowerCase()), 'signature header present').toContain(name);
    const v = await h.value('verifyWebhook', () => h.verify(ctx, w.body, w.headers, at));
    if (!v.ok) expect.fail(`verifyWebhook refused a valid webhook: ${v.code}`);
    const ev = v.event;
    expect(ev.kind).toBe('payment');
    expect(ev.providerEventId.length).toBeGreaterThan(0);
    expect(ev.type.length).toBeGreaterThan(0);
    expect(Number.isNaN(ev.occurredAt.getTime()), 'occurredAt is a valid date').toBe(false);
    expect(Math.abs(ev.occurredAt.getTime() - at.getTime()), 'occurredAt within a day').toBeLessThan(24 * HOUR);
    const remote = await h.retrieve(ctx, { ref: p.ref });
    h.expectPayment(ev.payment ?? null, input);
    expect(ev.payment!.ref).toBe(p.ref);
    expect(ev.payment!.status).toBe(remote!.status);
    expect(ev.payment!.ourPaymentId, 'the event carries our payment id (the core matches by it first)').toBe(input.metadata.paymentId);
    expect(await h.value('parseEvent', () => h.p.parseEvent(w.body))).toEqual(ev);
  },

  async webhook_previous_state_and_duplicate(h) {
    const ctx = await h.ctx();
    const p = await h.create(ctx, h.input());
    const before = await h.s.webhookFor(ctx, p.ref, now());
    await h.s.customerCompletes(ctx, p, 'pay');
    const after = await h.s.webhookFor(ctx, p.ref, now());
    const v1 = await h.value('verifyWebhook (previous state)', () => h.verify(ctx, before.body, before.headers, now()));
    const v2 = await h.value('verifyWebhook (current state)', () => h.verify(ctx, after.body, after.headers, now()));
    const v2again = await h.value('verifyWebhook (same body again)', () => h.verify(ctx, after.body, after.headers, now()));
    if (!v1.ok || !v2.ok || !v2again.ok) expect.fail('a valid webhook was refused');
    expect(v1.event.payment?.status, 'an older event keeps its own state').toBe(p.status);
    expect(v2.event.payment?.status).toBe('succeeded');
    expect(v1.event.providerEventId, 'two events, two ids').not.toBe(v2.event.providerEventId);
    expect(v2again.event.providerEventId, 'the same body is the same event (duplicate key)').toBe(v2.event.providerEventId);
    expect((await h.value('parseEvent', () => h.p.parseEvent(after.body)))?.providerEventId).toBe(v2.event.providerEventId);
  },

  async webhook_rejections(h) {
    const ctx = await h.ctx();
    const p = await h.create(ctx, h.input());
    const at = now();
    const w = await h.s.webhookFor(ctx, p.ref, at);
    const verify = (label: string, c: ProviderContext, body: Buffer, headers: Record<string, string>, when: Date) => h.value(label, () => h.verify(c, body, headers, when));
    const tampered = Buffer.from(w.body);
    const mid = Math.floor(tampered.length / 2);
    tampered[mid] = tampered[mid]! ^ 0x01;
    expect(await verify('tampered body', ctx, tampered, w.headers, at)).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(await verify('other secret', { ...ctx, webhookSecret: randomBytes(32).toString('hex') }, w.body, w.headers, at)).toMatchObject({ ok: false, code: 'bad_signature' });
    const unsigned = Object.fromEntries(Object.entries(w.headers).filter(([k]) => !h.p.signatureHeaders.includes(k.toLowerCase())));
    expect((await verify('no signature headers', ctx, w.body, unsigned, at)).ok).toBe(false);
    // Signatures more than 300 s away from now are refused (replays); within that, accepted.
    expect((await verify('verified 299 s later', ctx, w.body, w.headers, new Date(at.getTime() + 299_000))).ok).toBe(true);
    expect(await verify('replayed 301 s later', ctx, w.body, w.headers, new Date(at.getTime() + 301_000))).toMatchObject({ ok: false, code: 'stale_timestamp' });
    expect(await verify('signed 301 s in the future', ctx, w.body, w.headers, new Date(at.getTime() - 301_000))).toMatchObject({ ok: false, code: 'stale_timestamp' });
    expect(await verify('replayed an hour later', ctx, w.body, w.headers, new Date(at.getTime() + HOUR))).toMatchObject({ ok: false, code: 'stale_timestamp' });
    expect(await verify('signed an hour in the future', ctx, w.body, w.headers, new Date(at.getTime() - HOUR))).toMatchObject({ ok: false, code: 'stale_timestamp' });
  },

  async verify_and_parse_never_throw(h) {
    const ctx = await h.ctx();
    const p = await h.create(ctx, h.input());
    const w = await h.s.webhookFor(ctx, p.ref, now());
    const bodies = [Buffer.alloc(0), Buffer.from('not json'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]), Buffer.alloc(256 * 1024, 0x7b), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{"id":1}')];
    for (const body of bodies) {
      expect((await h.value('verifyWebhook (garbage)', () => h.verify(ctx, body, w.headers, now()))).ok).toBe(false);
      expect(await h.value('parseEvent (garbage)', () => h.p.parseEvent(body))).toBeNull();
    }
    const huge = Object.fromEntries(h.p.signatureHeaders.map((n) => [n, 'x'.repeat(10 * 1024)]));
    expect((await h.value('verifyWebhook (huge header)', () => h.verify(ctx, w.body, { ...w.headers, ...huge }, now()))).ok).toBe(false);
  },

  async test_connection_reports_not_throws(h) {
    const ctx = await h.ctx();
    expect(await h.value('testConnection', () => h.p.testConnection(ctx))).toEqual({ ok: true });
    expect((await h.value('testConnection (bad credentials)', () => h.p.testConnection(h.bad(ctx)))).ok).toBe(false);
  },

  async bad_credentials_are_auth_failed(h) {
    const ctx = h.bad(await h.ctx());
    const input = h.input();
    for (const [label, fn] of [
      ['createPayment', () => h.p.createPayment(ctx, input)],
      ['retrievePayment', () => h.p.retrievePayment(ctx, h.byKey(input))],
      ['createRefund', () => h.p.createRefund(ctx, h.refundInput({ ref: `contract_unknown_${randomBytes(8).toString('hex')}`, status: 'succeeded', amount: input.amount }, 100n))],
      ['retrieveRefund', () => h.p.retrieveRefund(ctx, { ref: `contract_unknown_${randomBytes(8).toString('hex')}` })],
      ['cancelPayment', () => h.p.cancelPayment(ctx, `contract_unknown_${randomBytes(8).toString('hex')}`, `contract-cancel:${randomUUID()}`)],
    ] as const) {
      const e = await h.error(`${label} (bad credentials)`, fn);
      expect([e.code, e.retryable], label).toEqual(['provider_auth_failed', false]);
    }
  },

  async refund_full_and_idempotent(h) {
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx);
    const input = h.refundInput(p, p.amount.amountMinor);
    if (h.refunds === 'none') {
      const e = await h.error('createRefund (no refunds)', () => h.p.createRefund(ctx, input));
      expect([e.code, e.retryable]).toEqual(['provider_rejected', false]);
      return;
    }
    const r = h.expectRefund(await h.value('createRefund', () => h.p.createRefund(ctx, input)), p.amount.amountMinor);
    expect(['pending', 'succeeded']).toContain(r.status);
    const again = await h.value('createRefund (same key)', () => h.p.createRefund(ctx, input));
    expect(again.ref, 'the same key is the same refund').toBe(r.ref);
    const more = await h.error('createRefund (nothing left)', () => h.p.createRefund(ctx, h.refundInput(p, 1n)));
    expect([more.code, more.retryable]).toEqual(['provider_rejected', false]);
  },

  async refund_partial_follows_capability(h) {
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx, 1500n);
    const part = h.refundInput(p, 500n);
    if (h.refunds !== 'partial') {
      const e = await h.error('createRefund (partial, not supported)', () => h.p.createRefund(ctx, part));
      expect([e.code, e.retryable]).toEqual(['provider_rejected', false]);
      return;
    }
    h.expectRefund(await h.value('createRefund (part)', () => h.p.createRefund(ctx, part)), 500n);
    h.expectRefund(await h.value('createRefund (rest)', () => h.p.createRefund(ctx, h.refundInput(p, 1000n))), 1000n);
    const e = await h.error('createRefund (beyond)', () => h.p.createRefund(ctx, h.refundInput(p, 1n)));
    expect([e.code, e.retryable]).toEqual(['provider_rejected', false]);
  },

  async refund_over_amount_refused(h) {
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx);
    const input = h.refundInput(p, p.amount.amountMinor + 1n);
    const e = await h.error('createRefund (over the amount)', () => h.p.createRefund(ctx, input));
    expect([e.code, e.retryable]).toEqual(['provider_rejected', false]);
    expect(await h.value('retrieveRefund (refused key)', () => h.p.retrieveRefund(ctx, { idempotencyKey: input.idempotencyKey, paymentRef: p.ref, createdAt: input.createdAt }))).toBeNull();
  },

  async refund_of_unpaid_payment_refused(h) {
    const ctx = await h.ctx();
    const p = await h.create(ctx, h.input());
    const e = await h.error('createRefund (unpaid)', () => h.p.createRefund(ctx, h.refundInput(p, 100n)));
    expect([e.code, e.retryable]).toEqual(['provider_rejected', false]);
  },

  async refund_retrieve_by_ref_and_key_agree(h) {
    if (h.refunds === 'none') return;
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx);
    const input = h.refundInput(p, p.amount.amountMinor);
    const r = await h.value('createRefund', () => h.p.createRefund(ctx, input));
    const byRef = h.expectRefund(await h.value('retrieveRefund (ref)', () => h.p.retrieveRefund(ctx, { ref: r.ref })), p.amount.amountMinor);
    const byKey = h.expectRefund(await h.value('retrieveRefund (key)', () => h.p.retrieveRefund(ctx, { idempotencyKey: input.idempotencyKey, paymentRef: p.ref, createdAt: input.createdAt })), p.amount.amountMinor);
    expect([byRef.ref, byKey.ref]).toEqual([r.ref, r.ref]);
    expect(byKey.status).toBe(byRef.status);
    expect(byRef.ourRefundId, 'a refund we started carries our id').toBe(input.metadata.refundId);
    const unknown = await h.call('retrieveRefund (unknown)', () => h.p.retrieveRefund(ctx, { ref: `contract_unknown_${randomBytes(8).toString('hex')}` }));
    if (unknown.ok) expect(unknown.value).toBeNull();
    else expect([unknown.error.code, unknown.error.retryable]).toEqual(['provider_not_found', false]);
  },

  async refund_webhook_verifies_and_resolves_payment(h) {
    if (h.refunds === 'none') return;
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx);
    const input = h.refundInput(p, p.amount.amountMinor);
    const r = await h.value('createRefund', () => h.p.createRefund(ctx, input));
    const at = now();
    const w = await h.s.refundWebhookFor(ctx, r.ref, at);
    const v = await h.value('verifyWebhook (refund)', () => h.verify(ctx, w.body, w.headers, at));
    if (!v.ok) expect.fail(`verifyWebhook refused a valid refund webhook: ${v.code}`);
    expect(v.event.kind).toBe('refund');
    const ev = h.expectRefund(v.event.refund ?? null, p.amount.amountMinor);
    expect(ev.ref).toBe(r.ref);
    expect(ev.ourRefundId).toBe(input.metadata.refundId);
    expect(ev.amount.currency).toBe(p.amount.currency);
    // The core finds the payment through the gateway's name for it.
    expect((await h.retrieve(ctx, { ref: ev.paymentRef }))?.ref).toBe(p.ref);
    expect(await h.value('parseEvent (refund)', () => h.p.parseEvent(w.body))).toEqual(v.event);
  },

  async gateway_refund_has_no_our_id(h) {
    if (h.refunds === 'none') return;
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx, 1500n);
    const r = await h.s.gatewayRefunds(ctx, p, 400n);
    const at = now();
    const w = await h.s.refundWebhookFor(ctx, r.ref, at);
    const v = await h.value('verifyWebhook (dashboard refund)', () => h.verify(ctx, w.body, w.headers, at));
    if (!v.ok) expect.fail(`verifyWebhook refused a valid refund webhook: ${v.code}`);
    const ev = h.expectRefund(v.event.refund ?? null, 400n);
    expect(ev.ourRefundId, 'a dashboard refund carries no id of ours').toBeUndefined();
    expect((await h.retrieve(ctx, { ref: ev.paymentRef }))?.ref).toBe(p.ref);
  },

  async dispute_webhook_verifies_and_resolves_payment(h) {
    const d = disputeSubject(h);
    if (!d) return;
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx);
    const { ref } = await d.open(ctx, p);
    const at = now();
    const w = await d.webhook(ctx, ref, at);
    const v = await h.value('verifyWebhook (dispute)', () => h.verify(ctx, w.body, w.headers, at));
    if (!v.ok) expect.fail(`verifyWebhook refused a valid dispute webhook: ${v.code}`);
    expect(v.event.kind).toBe('dispute');
    const ev = expectDispute(v.event.dispute ?? null, p);
    expect([ev.ref, ev.status, ev.fundsWithdrawn, ev.fundsReinstated]).toEqual([ref, 'open', false, false]);
    expect((await h.retrieve(ctx, { ref: ev.paymentRef }))?.ref, 'the core finds the payment through the gateway name').toBe(p.ref);
    expect(await h.value('parseEvent (dispute)', () => h.p.parseEvent(w.body))).toEqual(v.event);
  },

  async dispute_retrieve_matches_webhook(h) {
    const d = disputeSubject(h);
    if (!d) return;
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx);
    const { ref } = await d.open(ctx, p);
    const got = expectDispute(await h.value('retrieveDispute', () => h.p.retrieveDispute!(ctx, ref)), p);
    const at = now();
    const w = await d.webhook(ctx, ref, at);
    const v = await h.value('verifyWebhook (dispute)', () => h.verify(ctx, w.body, w.headers, at));
    if (!v.ok) expect.fail(`verifyWebhook refused a valid dispute webhook: ${v.code}`);
    expect(v.event.dispute).toEqual(got);
    const unknown = await h.call('retrieveDispute (unknown)', () => h.p.retrieveDispute!(ctx, `contract_unknown_${randomBytes(8).toString('hex')}`));
    if (unknown.ok) expect(unknown.value).toBeNull();
    else expect([unknown.error.code, unknown.error.retryable]).toEqual(['provider_not_found', false]);
  },

  async dispute_funds_flags_are_cumulative(h) {
    const d = disputeSubject(h);
    if (!d) return;
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx);
    const { ref } = await d.open(ctx, p);
    await d.move(ctx, ref, { withdraw: true });
    const withdrawn = expectDispute(await h.value('retrieveDispute (withdrawn)', () => h.p.retrieveDispute!(ctx, ref)), p);
    expect([withdrawn.fundsWithdrawn, withdrawn.fundsReinstated]).toEqual([true, false]);
    await d.move(ctx, ref, { status: 'won', reinstate: true });
    const won = expectDispute(await h.value('retrieveDispute (won)', () => h.p.retrieveDispute!(ctx, ref)), p);
    expect([won.status, won.fundsWithdrawn, won.fundsReinstated], 'reinstated keeps the withdrawal').toEqual(['won', true, true]);
  },

  async refund_of_disputed_payment_refused(h) {
    const d = disputeSubject(h);
    if (!d || h.refunds === 'none') return;
    const ctx = await h.ctx();
    const { p } = await h.paid(ctx);
    await d.open(ctx, p);
    const input = h.refundInput(p, p.amount.amountMinor);
    const e = await h.error('createRefund (disputed)', () => h.p.createRefund(ctx, input));
    expect([e.code, e.retryable], 'a disputed payment is not refunded twice').toEqual(['provider_rejected', false]);
  },

  async no_secret_in_results_or_errors(h) {
    // Its own sweep (so the clause stands alone), plus everything the earlier clauses saw.
    const ctx = await h.ctx();
    const bad = h.bad(ctx);
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.call('retrievePayment', () => h.p.retrievePayment(ctx, { ref: p.ref }));
    await h.call('cancelPayment', () => h.p.cancelPayment(ctx, p.ref, `contract-cancel:${p.ref}`));
    await h.call('testConnection', () => h.p.testConnection(ctx));
    await h.call('testConnection (bad)', () => h.p.testConnection(bad));
    await h.call('createPayment (bad)', () => h.p.createPayment(bad, h.input()));
    await h.call('retrievePayment (bad)', () => h.p.retrievePayment(bad, { ref: p.ref }));
    await h.call('cancelPayment (bad)', () => h.p.cancelPayment(bad, p.ref, `contract-cancel:${p.ref}`));
    await h.call('createRefund (bad)', () => h.p.createRefund(bad, h.refundInput(p, 100n)));
    await h.call('retrieveRefund (bad)', () => h.p.retrieveRefund(bad, { ref: `contract_unknown_${randomBytes(8).toString('hex')}` }));
    const { p: paid } = await h.paid(ctx);
    const r = await h.call('createRefund', () => h.p.createRefund(ctx, h.refundInput(paid, 100n)));
    if (r.ok) await h.call('retrieveRefund', () => h.p.retrieveRefund(ctx, { ref: r.value.ref }));
    const w = await h.s.webhookFor(ctx, p.ref, now());
    await h.call('verifyWebhook (other secret)', () => h.verify(bad.webhookSecret === ctx.webhookSecret ? { ...bad, webhookSecret: randomBytes(32).toString('hex') } : bad, w.body, w.headers, now()));
    const haystack = h.seen.map(serialise).join('\n');
    // The secrets of every context handed out in this suite (C3 to C19 used their own accounts), each field once.
    const fields = new Map<string, string>();
    h.contexts.forEach((c, i) => {
      for (const [k, v] of Object.entries(c.credentials)) fields.set(`context ${i} credentials.${k}`, v);
      fields.set(`context ${i} webhookSecret`, c.webhookSecret);
    });
    const checked = [...fields].filter(([, v]) => typeof v === 'string' && v.length >= 8);
    expect(checked.length, 'at least one secret to look for').toBeGreaterThan(0);
    expect(h.contexts.length, 'its own good and bad contexts, plus those of the clauses before it').toBeGreaterThanOrEqual(2);
    for (const [name, value] of checked) {
      const leaked = haystack.includes(value);
      // A boolean, so a failure never prints the secret.
      expect(leaked, `C20 ${name}`).toBe(false);
    }
  },
};

/**
 * The dispute side of a subject (task 4.5): null when the adapter does not declare disputes (and then it must not
 * implement retrieveDispute half-way); otherwise the subject must bring every dispute member.
 */
function disputeSubject(h: Harness) {
  if (h.p.manifest.capabilities.disputes !== 'events') {
    expect(typeof h.p.retrieveDispute, 'retrieveDispute without the disputes capability').not.toBe('function');
    return null;
  }
  const s = h.s;
  expect(typeof h.p.retrieveDispute, 'retrieveDispute').toBe('function');
  expect(Boolean(s.cardholderDisputes && s.disputeMoves && s.disputeWebhookFor), 'the subject brings disputes').toBe(true);
  return { open: s.cardholderDisputes!.bind(s), move: s.disputeMoves!.bind(s), webhook: s.disputeWebhookFor!.bind(s) };
}

function expectDispute(d: ProviderDispute | null, p: ProviderPayment): ProviderDispute {
  expect(d, 'dispute').not.toBeNull();
  const q = d!;
  expect(typeof q.ref === 'string' && q.ref.length > 0, 'dispute ref').toBe(true);
  expect(['open', 'evidence_submitted', 'won', 'lost', 'closed'], 'dispute status').toContain(q.status);
  expect(q.amount, 'disputed amount').toEqual(p.amount);
  expect(typeof q.fundsWithdrawn === 'boolean' && typeof q.fundsReinstated === 'boolean', 'funds flags').toBe(true);
  return q;
}

/** Registers the whole suite for one subject: one `it` per clause, named exactly as in CONTRACT_CLAUSES. */
export function describePaymentProviderContract(name: string, subject: ContractSubject): void {
  const implemented = Object.keys(CLAUSE_IMPLS);
  if (implemented.length !== CONTRACT_CLAUSES.length || CONTRACT_CLAUSES.some((c, i) => implemented[i] !== c)) {
    throw new Error('contract suite: the implemented clauses differ from CONTRACT_CLAUSES');
  }
  describe(`payment adapter contract: ${name}`, () => {
    const h = new Harness(subject);
    for (const clause of CONTRACT_CLAUSES) it(clause, () => CLAUSE_IMPLS[clause](h), CLAUSE_TIMEOUT_MS);
  });
}
