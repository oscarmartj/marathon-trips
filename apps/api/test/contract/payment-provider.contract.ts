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
import type { CreatePaymentInput, PaymentProvider, ProviderContext, ProviderPayment, ProviderPaymentStatus } from '../../src/modules/payments/core/provider';
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
  /** The webhook the gateway would send now for this object, signed at `at` with ctx.webhookSecret. */
  webhookFor(ctx: ProviderContext, ref: string, at: Date): Promise<SignedBody>;
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

  constructor(readonly s: ContractSubject) {}

  get p(): PaymentProvider {
    return this.s.provider;
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
    };
  }

  create(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment> {
    return this.value('createPayment', () => this.p.createPayment(ctx, input));
  }

  retrieve(ctx: ProviderContext, by: { ref: string } | { idempotencyKey: string }): Promise<ProviderPayment | null> {
    return this.value('retrievePayment', () => this.p.retrievePayment(ctx, by));
  }

  cancel(ctx: ProviderContext, ref: string): Promise<ProviderPayment> {
    return this.value('cancelPayment', () => this.p.cancelPayment(ctx, ref, `contract-cancel:${ref}`));
  }

  /** A normalised payment; with `input`, also its amount, our id and the redirect origin. */
  expectPayment(p: ProviderPayment | null, input?: CreatePaymentInput): asserts p is ProviderPayment {
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
  }
}

const now = () => new Date();
const HOUR = 3_600_000;

/** One implementation per clause; the type makes a missing or extra clause a compile error. */
export const CLAUSE_IMPLS: { readonly [K in ContractClause]: (h: Harness) => Promise<void> } = {
  async context_is_test_mode(h) {
    const ctx = await h.s.context();
    expect(ctx.mode, 'context mode').toBe('test');
    expect(h.s.badCredentials(ctx).mode, 'bad-credentials context mode').toBe('test');
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
    expectTypeOf<keyof CreatePaymentInput>().toEqualTypeOf<'amount' | 'method' | 'idempotencyKey' | 'metadata' | 'returnUrl' | 'customerCountry'>();
    expectTypeOf<keyof CreatePaymentInput['metadata']>().toEqualTypeOf<'paymentId' | 'bookingId'>();
    expectTypeOf<keyof CreatePaymentInput['amount']>().toEqualTypeOf<'amountMinor' | 'currency'>();
  },

  async create_returns_normalised_payment(h) {
    const ctx = await h.s.context();
    const input = h.input();
    const p = await h.create(ctx, input);
    h.expectPayment(p, input);
    // Card data stays on the gateway's hosted page: a new payment waits for the customer there.
    expect(p.status, 'a new payment waits for the customer').toBe('requires_action');
    expect(p.nextAction, 'a new payment has a redirect').toBeDefined();
  },

  async same_idempotency_key_same_object(h) {
    const ctx = await h.s.context();
    const input = h.input();
    const a = await h.create(ctx, input);
    const b = await h.create(ctx, input);
    expect(b.ref).toBe(a.ref);
    const byKey = await h.retrieve(ctx, { idempotencyKey: input.idempotencyKey });
    expect(byKey?.ref).toBe(a.ref);
  },

  async same_key_other_amount_never_a_second_object(h) {
    const ctx = await h.s.context();
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
    const byKey = await h.retrieve(ctx, { idempotencyKey: input.idempotencyKey });
    expect(byKey?.ref).toBe(a.ref);
    expect(byKey?.amount.amountMinor).toBe(input.amount.amountMinor);
  },

  async different_keys_different_objects(h) {
    const ctx = await h.s.context();
    const a = await h.create(ctx, h.input());
    const b = await h.create(ctx, h.input());
    expect(a.ref).not.toBe(b.ref);
  },

  async definitive_refusal_means_no_object(h) {
    const ctx = await h.s.context();
    const input = h.input({ amount: { amountMinor: 1500n, currency: h.s.unsupportedCurrency } });
    const e = await h.error('createPayment (unsupported currency)', () => h.p.createPayment(ctx, input));
    expect(e.retryable, 'a refusal for an unsupported currency is definitive').toBe(false);
    expect(await h.retrieve(ctx, { idempotencyKey: input.idempotencyKey }), 'no object under the key after a definitive refusal').toBeNull();
  },

  async retrieve_by_ref_and_by_key_agree(h) {
    const ctx = await h.s.context();
    const input = h.input();
    const p = await h.create(ctx, input);
    const byRef = await h.retrieve(ctx, { ref: p.ref });
    const byKey = await h.retrieve(ctx, { idempotencyKey: input.idempotencyKey });
    h.expectPayment(byRef, input);
    h.expectPayment(byKey, input);
    expect(byKey.ref).toBe(p.ref);
    expect(byRef.ref).toBe(p.ref);
    expect(byKey.status).toBe(byRef.status);
  },

  async retrieve_unknown_is_null(h) {
    const ctx = await h.s.context();
    expect(await h.retrieve(ctx, { idempotencyKey: `contract:unknown:${randomUUID()}` })).toBeNull();
    const r = await h.call('retrievePayment (unknown ref)', () => h.p.retrievePayment(ctx, { ref: `contract_unknown_${randomBytes(8).toString('hex')}` }));
    if (r.ok) expect(r.value).toBeNull();
    else expect([r.error.code, r.error.retryable]).toEqual(['provider_not_found', false]);
  },

  async customer_payment_reflected(h) {
    const ctx = await h.s.context();
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.s.customerCompletes(ctx, p, 'pay');
    for (const by of [{ ref: p.ref }, { idempotencyKey: input.idempotencyKey }]) {
      const q = await h.retrieve(ctx, by);
      h.expectPayment(q, input);
      expect(q.status).toBe('succeeded');
    }
  },

  async failed_is_terminal(h) {
    const ctx = await h.s.context();
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.s.customerCompletes(ctx, p, 'decline');
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('failed');
    const again = await h.create(ctx, input);
    expect(again.ref, 'the same key never gives a new chargeable object').toBe(p.ref);
    expect(again.status).toBe('failed');
    await expect(h.s.customerCompletes(ctx, p, 'pay'), 'a failed object cannot be paid').rejects.toThrow();
    expect((await h.cancel(ctx, p.ref)).status).toBe('failed');
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('failed');
  },

  async succeeded_is_final(h) {
    const ctx = await h.s.context();
    const p = await h.create(ctx, h.input());
    await h.s.customerCompletes(ctx, p, 'pay');
    expect((await h.cancel(ctx, p.ref)).status, 'cancelling a collected payment says what it is').toBe('succeeded');
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('succeeded');
  },

  async cancel_is_idempotent_and_final(h) {
    const ctx = await h.s.context();
    const p = await h.create(ctx, h.input());
    expect((await h.cancel(ctx, p.ref)).status).toBe('cancelled');
    expect((await h.cancel(ctx, p.ref)).status).toBe('cancelled');
    await expect(h.s.customerCompletes(ctx, p, 'pay'), 'a cancelled object cannot be paid').rejects.toThrow();
    expect((await h.retrieve(ctx, { ref: p.ref }))?.status).toBe('cancelled');
  },

  async cancel_unknown_is_not_found(h) {
    const ctx = await h.s.context();
    const e = await h.error('cancelPayment (unknown ref)', () => h.p.cancelPayment(ctx, `contract_unknown_${randomBytes(8).toString('hex')}`, `contract-cancel:${randomUUID()}`));
    expect([e.code, e.retryable]).toEqual(['provider_not_found', false]);
  },

  async statuses_only_move_forward(h) {
    const ctx = await h.s.context();
    const sequences: Array<(input: CreatePaymentInput, p: ProviderPayment) => Promise<ProviderPaymentStatus[]>> = [
      async (input, p) => {
        await h.s.customerCompletes(ctx, p, 'pay');
        return [(await h.retrieve(ctx, { ref: p.ref }))!.status, (await h.cancel(ctx, p.ref)).status, (await h.create(ctx, input)).status, (await h.retrieve(ctx, { idempotencyKey: input.idempotencyKey }))!.status];
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
    const ctx = await h.s.context();
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.s.customerCompletes(ctx, p, 'pay');
    const at = now();
    const w = await h.s.webhookFor(ctx, p.ref, at);
    for (const name of h.p.signatureHeaders) expect(Object.keys(w.headers).map((k) => k.toLowerCase()), 'signature header present').toContain(name);
    const v = await h.value('verifyWebhook', () => h.p.verifyWebhook(ctx, w.body, w.headers, at));
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
    const ctx = await h.s.context();
    const p = await h.create(ctx, h.input());
    const before = await h.s.webhookFor(ctx, p.ref, now());
    await h.s.customerCompletes(ctx, p, 'pay');
    const after = await h.s.webhookFor(ctx, p.ref, now());
    const v1 = await h.value('verifyWebhook (previous state)', () => h.p.verifyWebhook(ctx, before.body, before.headers, now()));
    const v2 = await h.value('verifyWebhook (current state)', () => h.p.verifyWebhook(ctx, after.body, after.headers, now()));
    const v2again = await h.value('verifyWebhook (same body again)', () => h.p.verifyWebhook(ctx, after.body, after.headers, now()));
    if (!v1.ok || !v2.ok || !v2again.ok) expect.fail('a valid webhook was refused');
    expect(v1.event.payment?.status, 'an older event keeps its own state').toBe(p.status);
    expect(v2.event.payment?.status).toBe('succeeded');
    expect(v1.event.providerEventId, 'two events, two ids').not.toBe(v2.event.providerEventId);
    expect(v2again.event.providerEventId, 'the same body is the same event (duplicate key)').toBe(v2.event.providerEventId);
    expect((await h.value('parseEvent', () => h.p.parseEvent(after.body)))?.providerEventId).toBe(v2.event.providerEventId);
  },

  async webhook_rejections(h) {
    const ctx = await h.s.context();
    const p = await h.create(ctx, h.input());
    const at = now();
    const w = await h.s.webhookFor(ctx, p.ref, at);
    const verify = (label: string, c: ProviderContext, body: Buffer, headers: Record<string, string>, when: Date) => h.value(label, () => h.p.verifyWebhook(c, body, headers, when));
    const tampered = Buffer.from(w.body);
    tampered[Math.floor(tampered.length / 2)] ^= 0x01;
    expect(await verify('tampered body', ctx, tampered, w.headers, at)).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(await verify('other secret', { ...ctx, webhookSecret: randomBytes(32).toString('hex') }, w.body, w.headers, at)).toMatchObject({ ok: false, code: 'bad_signature' });
    const unsigned = Object.fromEntries(Object.entries(w.headers).filter(([k]) => !h.p.signatureHeaders.includes(k.toLowerCase())));
    expect((await verify('no signature headers', ctx, w.body, unsigned, at)).ok).toBe(false);
    expect(await verify('replayed an hour later', ctx, w.body, w.headers, new Date(at.getTime() + HOUR))).toMatchObject({ ok: false, code: 'stale_timestamp' });
    expect(await verify('signed an hour in the future', ctx, w.body, w.headers, new Date(at.getTime() - HOUR))).toMatchObject({ ok: false, code: 'stale_timestamp' });
  },

  async verify_and_parse_never_throw(h) {
    const ctx = await h.s.context();
    const p = await h.create(ctx, h.input());
    const w = await h.s.webhookFor(ctx, p.ref, now());
    const bodies = [Buffer.alloc(0), Buffer.from('not json'), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]), Buffer.alloc(256 * 1024, 0x7b), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{"id":1}')];
    for (const body of bodies) {
      expect((await h.value('verifyWebhook (garbage)', () => h.p.verifyWebhook(ctx, body, w.headers, now()))).ok).toBe(false);
      expect(await h.value('parseEvent (garbage)', () => h.p.parseEvent(body))).toBeNull();
    }
    const huge = Object.fromEntries(h.p.signatureHeaders.map((n) => [n, 'x'.repeat(10 * 1024)]));
    expect((await h.value('verifyWebhook (huge header)', () => h.p.verifyWebhook(ctx, w.body, { ...w.headers, ...huge }, now()))).ok).toBe(false);
  },

  async test_connection_reports_not_throws(h) {
    const ctx = await h.s.context();
    expect(await h.value('testConnection', () => h.p.testConnection(ctx))).toEqual({ ok: true });
    expect((await h.value('testConnection (bad credentials)', () => h.p.testConnection(h.s.badCredentials(ctx)))).ok).toBe(false);
  },

  async bad_credentials_are_auth_failed(h) {
    const ctx = h.s.badCredentials(await h.s.context());
    const input = h.input();
    for (const [label, fn] of [
      ['createPayment', () => h.p.createPayment(ctx, input)],
      ['retrievePayment', () => h.p.retrievePayment(ctx, { idempotencyKey: input.idempotencyKey })],
      ['cancelPayment', () => h.p.cancelPayment(ctx, `contract_unknown_${randomBytes(8).toString('hex')}`, `contract-cancel:${randomUUID()}`)],
    ] as const) {
      const e = await h.error(`${label} (bad credentials)`, fn);
      expect([e.code, e.retryable], label).toEqual(['provider_auth_failed', false]);
    }
  },

  async no_secret_in_results_or_errors(h) {
    // Its own sweep (so the clause stands alone), plus everything the earlier clauses saw.
    const ctx = await h.s.context();
    const bad = h.s.badCredentials(ctx);
    const input = h.input();
    const p = await h.create(ctx, input);
    await h.call('retrievePayment', () => h.p.retrievePayment(ctx, { ref: p.ref }));
    await h.call('cancelPayment', () => h.p.cancelPayment(ctx, p.ref, `contract-cancel:${p.ref}`));
    await h.call('testConnection', () => h.p.testConnection(ctx));
    await h.call('testConnection (bad)', () => h.p.testConnection(bad));
    await h.call('createPayment (bad)', () => h.p.createPayment(bad, h.input()));
    await h.call('retrievePayment (bad)', () => h.p.retrievePayment(bad, { ref: p.ref }));
    await h.call('cancelPayment (bad)', () => h.p.cancelPayment(bad, p.ref, `contract-cancel:${p.ref}`));
    const w = await h.s.webhookFor(ctx, p.ref, now());
    await h.call('verifyWebhook (other secret)', () => h.p.verifyWebhook(bad.webhookSecret === ctx.webhookSecret ? { ...bad, webhookSecret: randomBytes(32).toString('hex') } : bad, w.body, w.headers, now()));
    const haystack = h.seen.map(serialise).join('\n');
    const fields: Array<[string, string]> = [
      ...Object.entries(ctx.credentials).map(([k, v]) => [`credentials.${k}`, v] as [string, string]),
      ['webhookSecret', ctx.webhookSecret],
      ...Object.entries(bad.credentials).map(([k, v]) => [`badCredentials.${k}`, v] as [string, string]),
    ];
    const checked = fields.filter(([, v]) => typeof v === 'string' && v.length >= 8);
    expect(checked.length, 'at least one secret to look for').toBeGreaterThan(0);
    for (const [name, value] of checked) {
      const leaked = haystack.includes(value);
      // A boolean, so a failure never prints the secret.
      expect(leaked, `C20 ${name}`).toBe(false);
    }
  },
};

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
