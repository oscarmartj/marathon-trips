// Pure parts of the payments core (plan docs/plans/3.1-payment-provider-core.md, sections 2, 4, 5 and 10): no database.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENVS, PAYMENT_METHODS, startPaymentSchema } from '@mt/shared';
import type { AppEnv } from '@mt/shared';
import { readSources } from '../../conventions/module-boundaries';
import { createAdapters } from '../../../src/modules/payments/adapters';
import { SimulatorControl, SimulatorProvider, SimulatorWorld, signSimulator } from '../../../src/modules/payments/adapters/simulator/simulator';
import { PAYMENT_STATUS_PAIRS, nextStatus } from '../../../src/modules/payments/core/attempt-state';
import type { AttemptEvent } from '../../../src/modules/payments/core/attempt-state';
import { ProviderGateway, TEST_ADAPTER_ENVS, callBlockReason } from '../../../src/modules/payments/core/gateway';
import type { AccountForCall, GatewayOperation } from '../../../src/modules/payments/core/gateway';
import { payable } from '../../../src/modules/payments/core/payable';
import type { AdapterManifest, ProviderContext } from '../../../src/modules/payments/core/provider';
import { PaymentAdapterRegistry, manifestProblems } from '../../../src/modules/payments/core/registry';
import { planItems } from '../../../src/modules/payments/core/schedule';

const repoRoot = resolve(__dirname, '../../../../..');
const srcDir = resolve(__dirname, '../../../src');
// The adapters and the simulator's manifest exactly as the API builds them (plan 3.6, 10.4).
const WEB_ORIGIN = 'http://localhost:3000';
const ADAPTERS = createAdapters({ webOrigin: WEB_ORIGIN });
const simulatorManifest = ADAPTERS.find((a) => a.manifest.key === 'simulator')!.manifest;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('schedule_split_table: the plan from the snapshot (plan 3.1, 4.1)', () => {
  // approvalExpiresAt is an instant; Brisbane is UTC+10 with no daylight saving, so 13:59:59.999Z is still the same day.
  const cases: Array<[string, { total: bigint; deposit: bigint; balanceDue: string; expires: string }, Array<[string, bigint, string]>]> = [
    ['deposit and balance', { total: 300000n, deposit: 100000n, balanceDue: '2027-04-18', expires: '2027-01-04T02:00:00.000Z' }, [['deposit', 100000n, '2027-01-04'], ['balance', 200000n, '2027-04-18']]],
    ['no deposit', { total: 10000n, deposit: 0n, balanceDue: '2027-04-18', expires: '2027-01-04T02:00:00.000Z' }, [['balance', 10000n, '2027-04-18']]],
    ['deposit is the total', { total: 50000n, deposit: 50000n, balanceDue: '2027-04-18', expires: '2027-01-04T02:00:00.000Z' }, [['deposit', 50000n, '2027-01-04']]],
    ['total 0: no items', { total: 0n, deposit: 0n, balanceDue: '2027-04-18', expires: '2027-01-04T02:00:00.000Z' }, []],
    ['balance would be due before the deposit', { total: 300000n, deposit: 100000n, balanceDue: '2027-01-01', expires: '2027-01-04T02:00:00.000Z' }, [['deposit', 100000n, '2027-01-04'], ['balance', 200000n, '2027-01-04']]],
    ['balance due the same day', { total: 300000n, deposit: 100000n, balanceDue: '2027-01-04', expires: '2027-01-04T02:00:00.000Z' }, [['deposit', 100000n, '2027-01-04'], ['balance', 200000n, '2027-01-04']]],
    ['balance the day after', { total: 300000n, deposit: 100000n, balanceDue: '2027-01-05', expires: '2027-01-04T02:00:00.000Z' }, [['deposit', 100000n, '2027-01-04'], ['balance', 200000n, '2027-01-05']]],
    ['expiry 23:59:59.999 in Brisbane (13:59:59.999Z)', { total: 2n, deposit: 1n, balanceDue: '2027-06-01', expires: '2027-01-04T13:59:59.999Z' }, [['deposit', 1n, '2027-01-04'], ['balance', 1n, '2027-06-01']]],
    ['expiry 00:00 in Brisbane (14:00Z the day before)', { total: 2n, deposit: 1n, balanceDue: '2027-06-01', expires: '2027-01-04T14:00:00.000Z' }, [['deposit', 1n, '2027-01-05'], ['balance', 1n, '2027-06-01']]],
    ['big amount (IDR-like, beyond 2^32)', { total: 4_500_000_000n, deposit: 1_000_000_000n, balanceDue: '2027-06-01', expires: '2027-01-04T02:00:00.000Z' }, [['deposit', 1_000_000_000n, '2027-01-04'], ['balance', 3_500_000_000n, '2027-06-01']]],
  ];
  it.each(cases)('%s', (_name, c, expected) => {
    const items = planItems({ totalMinor: c.total, depositMinor: c.deposit, balanceDueDate: d(c.balanceDue), approvalExpiresAt: new Date(c.expires) });
    expect(items.map((i) => [i.kind, i.amountMinor, i.dueDate])).toEqual(expected);
    expect(items.map((i) => i.sequence)).toEqual(expected.map((_, k) => k + 1));
    expect(items.reduce((s, i) => s + i.amountMinor, 0n)).toBe(c.total);
  });
  it('refuses a deposit above the total or negative amounts', () => {
    expect(() => planItems({ totalMinor: 1n, depositMinor: 2n, balanceDueDate: d('2027-01-01'), approvalExpiresAt: new Date() })).toThrow(/between 0 and the total/);
    expect(() => planItems({ totalMinor: -1n, depositMinor: 0n, balanceDueDate: d('2027-01-01'), approvalExpiresAt: new Date() })).toThrow();
  });
});

describe('payable_amount_table: what can be paid now (plan 0.1, P1; plan 3.1, 4.3)', () => {
  const items = [{ sequence: 1, amountMinor: 100000n }, { sequence: 2, amountMinor: 200000n }];
  const cases: Array<[string, bigint, number | undefined, { seq: number; amount: bigint } | null, bigint]> = [
    ['nothing collected: the deposit', 0n, undefined, { seq: 1, amount: 100000n }, 300000n],
    ['nothing collected, up to 2: everything (single_payment_covers_deposit_and_balance)', 0n, 2, { seq: 2, amount: 300000n }, 300000n],
    ['deposit paid: the balance', 100000n, undefined, { seq: 2, amount: 200000n }, 200000n],
    ['deposit paid, up to 1: nothing', 100000n, 1, null, 200000n],
    ['part of the deposit: the rest of it', 40000n, undefined, { seq: 1, amount: 60000n }, 260000n],
    ['part of the deposit, up to 2', 40000n, 2, { seq: 2, amount: 260000n }, 260000n],
    ['all collected: nothing', 300000n, undefined, null, 0n],
    ['more than all collected: never negative', 350000n, 2, null, 0n],
    ['unknown sequence: nothing', 0n, 3, null, 300000n],
  ];
  it.each(cases)('%s', (_n, collected, upTo, next, outstanding) => {
    const p = payable(items, collected, upTo);
    expect(p.next ? { seq: p.next.sequence, amount: p.next.amountMinor } : null).toEqual(next);
    expect(p.outstandingMinor).toBe(outstanding);
    if (p.next) expect(p.next.amountMinor <= p.outstandingMinor && p.next.amountMinor > 0n).toBe(true);
  });
  it('no items: nothing to pay', () => expect(payable([], 0n).next).toBeNull());
});

describe('no_surcharge_by_payment_method', () => {
  it('the amount does not depend on the method: the function has no method input and every method gets the same', () => {
    expect(payable.length).toBe(3);
    const amounts = PAYMENT_METHODS.map(() => payable([{ sequence: 1, amountMinor: 12345n }], 0n).next!.amountMinor);
    expect(new Set(amounts)).toEqual(new Set([12345n]));
    // The request body names a method and nothing that could carry a price difference.
    // Task 3.2 adds the replacement flag, a literal `true`: still nothing that could carry an amount.
    expect(Object.keys(startPaymentSchema.shape).sort()).toEqual(['method', 'replaceLiveAttempt', 'upToSequence']);
    expect(startPaymentSchema.safeParse({ method: 'card', replaceLiveAttempt: 1000 }).success).toBe(false);
  });
});

describe('card_data_never_reaches_api and client_amount_field_rejected (schema)', () => {
  const bad = [{ cardNumber: '4242424242424242' }, { pan: '4242' }, { cvc: '123' }, { expiry: '12/30' }, { card: { number: '4242' } }, { amountMinor: '1' }, { amount: 1 }, { currency: 'AUD' }, { returnUrl: 'https://x' }];
  it.each(bad)('%o is refused', (extra) => expect(startPaymentSchema.safeParse({ method: 'card', ...extra }).success).toBe(false));
  it('a valid body passes', () => expect(startPaymentSchema.safeParse({ method: 'card', upToSequence: 2 }).success).toBe(true));
  it('manifest_card_data_hosted_only: every adapter keeps card data on the gateway', () => {
    for (const a of ADAPTERS) expect(a.manifest.cardDataHandling).toBe('hosted_only');
  });
});

describe('adapter registry and states (plan 3.1, 2.3)', () => {
  const m = (over: Partial<AdapterManifest>): AdapterManifest => ({ ...simulatorManifest, key: 'x', ...over });
  it('adapter_registry_rejects_duplicates_and_planned_accounts', () => {
    expect(manifestProblems([m({}), m({})])).toContain('x: duplicate adapter key');
    expect(() => new PaymentAdapterRegistry([new SimulatorProvider({ webOrigin: WEB_ORIGIN }), new SimulatorProvider({ webOrigin: WEB_ORIGIN })])).toThrow(/duplicate/);
    // A planned adapter has a manifest only: no account may call it.
    expect(callBlockReason({ id: 'a', adapterKey: 'x', mode: 'test', status: 'active' }, m({ status: 'planned', testOnly: false }), 'create', 'test')).toBe('adapter_unavailable');
  });
  it('verified_manifest_requires_sandbox_evidence (and every real manifest passes)', () => {
    expect(manifestProblems([m({ status: 'verified', testOnly: false })])).toContain('x: verified without sandbox evidence (docs/done/…)');
    expect(manifestProblems([m({ status: 'verified', testOnly: false, evidence: 'docs/done/none-such.md' })], repoRoot)).toContain('x: evidence file docs/done/none-such.md does not exist');
    expect(manifestProblems([m({ status: 'verified', testOnly: false, evidence: 'docs/done/0.7.md' })], repoRoot)).toContain('x: evidence file does not record a test:sandbox run');
    expect(manifestProblems([m({ status: 'verified', testOnly: true, evidence: 'docs/done/0.7.md' })])).toContain('x: a test-only adapter cannot be verified');
    expect(manifestProblems(ADAPTERS.map((a) => a.manifest), repoRoot)).toEqual([]);
  });
  it('no adapter in the code can go live today: none is verified, the simulator is test-only', () => {
    for (const a of ADAPTERS) expect(a.manifest.status === 'verified' && !a.manifest.testOnly).toBe(false);
    expect(simulatorManifest.testOnly).toBe(true);
  });
});

describe('gateway_guard_matrix (plan 3.1, 2.4)', () => {
  const verified = { ...simulatorManifest, key: 'real', status: 'verified' as const, testOnly: false, evidence: 'docs/done/x.md' };
  const experimental = { ...simulatorManifest, key: 'exp', status: 'experimental' as const, testOnly: false };
  const ops: GatewayOperation[] = ['create', 'retrieve', 'cancel', 'webhook', 'test_connection'];
  const statuses: AccountForCall['status'][] = ['active', 'paused', 'retired', 'archived'];

  const expected = (acc: AccountForCall, man: AdapterManifest, op: GatewayOperation, env: AppEnv): string | null => {
    if (acc.mode === 'live' && env !== 'production') return 'live_call_blocked_outside_production';
    if (acc.mode === 'live' && (man.status !== 'verified' || man.testOnly)) return 'adapter_not_verified_for_live';
    if (man.testOnly && !['development', 'test', 'ci'].includes(env)) return 'test_adapter_blocked_in_environment';
    if (op === 'create' && acc.mode !== (env === 'production' ? 'live' : 'test')) return 'account_mode_not_for_environment';
    if (op === 'create' && acc.status !== 'active') return 'account_not_accepting_charges';
    return null;
  };
  it('every environment × mode × adapter × account status × operation', () => {
    const wrong: string[] = [];
    for (const env of APP_ENVS) for (const mode of ['test', 'live'] as const) for (const man of [simulatorManifest, verified, experimental]) for (const status of statuses) for (const op of ops) {
      const acc = { id: 'a', adapterKey: man.key, mode, status };
      const got = callBlockReason(acc, man, op, env);
      const want = expected(acc, man, op, env);
      if (got !== want) wrong.push(`${env}/${mode}/${man.key}/${status}/${op}: ${got} ≠ ${want}`);
    }
    expect(wrong).toEqual([]);
  });
  it('live_call_blocked_outside_production, live_charge_rejected_when_adapter_not_verified, test_only_adapter_never_live', () => {
    for (const env of APP_ENVS.filter((e) => e !== 'production')) expect(callBlockReason({ id: 'a', adapterKey: 'real', mode: 'live', status: 'active' }, verified, 'retrieve', env)).toBe('live_call_blocked_outside_production');
    expect(callBlockReason({ id: 'a', adapterKey: 'exp', mode: 'live', status: 'active' }, experimental, 'create', 'production')).toBe('adapter_not_verified_for_live');
    expect(callBlockReason({ id: 'a', adapterKey: 'simulator', mode: 'live', status: 'active' }, simulatorManifest, 'create', 'production')).toBe('adapter_not_verified_for_live');
    expect(callBlockReason({ id: 'a', adapterKey: 'real', mode: 'live', status: 'active' }, verified, 'create', 'production')).toBeNull();
  });
  it('test_adapter_blocked_in_environment: the simulator runs only in a closed list of environments', () => {
    expect([...TEST_ADAPTER_ENVS]).toEqual(['development', 'test', 'ci']);
    const allowed = APP_ENVS.filter((env) => callBlockReason({ id: 'a', adapterKey: 'simulator', mode: 'test', status: 'active' }, simulatorManifest, 'retrieve', env) === null);
    expect(allowed).toEqual(['development', 'test', 'ci']);
  });
  it('paused_account_rejects_new_charge_but_processes_webhooks', () => {
    for (const status of ['paused', 'retired', 'archived'] as const) {
      const acc = { id: 'a', adapterKey: 'simulator', mode: 'test' as const, status };
      expect(callBlockReason(acc, simulatorManifest, 'create', 'test')).toBe('account_not_accepting_charges');
      for (const op of ['retrieve', 'cancel', 'webhook'] as const) expect(callBlockReason(acc, simulatorManifest, op, 'test')).toBeNull();
    }
  });
  it('live_credentials_not_decrypted_outside_production: the guard runs before any secret is read', async () => {
    const reads: string[] = [];
    const prisma = {
      providerAccount: {
        findUnique: async () => ({ id: 'a', adapterKey: 'simulator', mode: 'live', status: 'active' }),
        findUniqueOrThrow: async () => { reads.push('secrets'); return {}; },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    };
    const box = { decrypt: () => { reads.push('decrypt'); return '{}'; } };
    const audit = { record: async () => 'id' };
    const registry = new PaymentAdapterRegistry([new SimulatorProvider({ webOrigin: WEB_ORIGIN })]);
    for (const env of APP_ENVS) {
      const gw = new ProviderGateway(prisma as never, box as never, { APP_ENV: env } as never, audit as never, registry);
      await expect(gw.call('a', 'retrieve', async () => 'called')).rejects.toMatchObject({ status: 409 });
    }
    expect(reads).toEqual([]);
  });
});

describe('payment_attempt_state_event_matrix (plan 3.1, 5.2)', () => {
  const states = ['created', 'requires_action', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'voided'] as const;
  const events: AttemptEvent[] = ['requires_action', 'pending', 'succeeded', 'failed', 'cancelled', 'expire_confirmed', 'void'];
  // Written out by hand from the table of the plan: '' is "no change".
  const TABLE: Record<AttemptEvent, Record<(typeof states)[number], string>> = {
    requires_action: { created: 'requires_action', requires_action: '', pending: '', succeeded: '', failed: '', cancelled: '', expired: '', voided: '' },
    pending: { created: 'pending', requires_action: 'pending', pending: '', succeeded: '', failed: '', cancelled: '', expired: '', voided: '' },
    succeeded: { created: 'succeeded', requires_action: 'succeeded', pending: 'succeeded', succeeded: '', failed: 'succeeded', cancelled: 'succeeded', expired: 'succeeded', voided: '' },
    failed: { created: 'failed', requires_action: 'failed', pending: 'failed', succeeded: '', failed: '', cancelled: '', expired: '', voided: '' },
    cancelled: { created: 'cancelled', requires_action: 'cancelled', pending: '', succeeded: '', failed: '', cancelled: '', expired: '', voided: '' },
    expire_confirmed: { created: 'expired', requires_action: 'expired', pending: '', succeeded: '', failed: '', cancelled: '', expired: '', voided: '' },
    void: { created: '', requires_action: '', pending: '', succeeded: 'voided', failed: '', cancelled: '', expired: '', voided: '' },
  };
  it.each(events.flatMap((e) => states.map((s) => [e, s] as const)))('%s on %s', (event, state) => {
    expect(nextStatus(state, event) ?? '').toBe(TABLE[event][state]);
  });
  it('every transition the table makes is an allowed pair, and every allowed pair is made by some event', () => {
    const made = new Set(events.flatMap((e) => states.map((s) => [s, nextStatus(s, e)] as const)).filter(([, to]) => to).map(([s, to]) => `${s}>${to}`));
    expect([...made].sort()).toEqual(PAYMENT_STATUS_PAIRS.map((p) => p.join('>')).sort());
  });
  it('payment_status_pairs_code_matches_trigger: the migration lists the same pairs (no pending → expired)', () => {
    // The function was last redefined by 0032 (task 3.4 added the voiding of a confirmed transfer).
    const sql = readFileSync(join(__dirname, '../../../prisma/migrations/0032_manual_transfers/migration.sql'), 'utf8');
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.mt_payment_guard()'));
    const block = fn.slice(fn.indexOf("IF NOT ((OLD.\"status\", NEW.\"status\") IN ("), fn.indexOf('payment status cannot go from'));
    const pairs = [...block.matchAll(/\('(\w+)'(?:::"PaymentStatus")?, '(\w+)'(?:::"PaymentStatus")?\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    expect(pairs).toEqual(PAYMENT_STATUS_PAIRS.map((p) => p.join('>')).sort());
    expect(pairs).not.toContain('pending>expired');
  });
});

describe('simulator_signature_verification (plan 3.1, 6)', () => {
  const world = new SimulatorWorld();
  const provider = new SimulatorProvider({ webOrigin: WEB_ORIGIN }, world);
  const control = new SimulatorControl(world);
  const secret = 'a'.repeat(64);
  const ctx: ProviderContext = { accountId: 'acc', mode: 'test', credentials: { apiKey: 'sim_test_0123456789abcdef' }, webhookSecret: secret };
  const now = new Date('2027-01-01T00:00:00Z');
  const ev = (opts: Parameters<SimulatorControl['paymentEvent']>[2] = {}) => control.paymentEvent(secret, { ref: 'sim_pay_1', status: 'succeeded', amountMinor: 100n, currency: 'AUD', paymentId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }, { at: now, signedAt: now, ...opts });
  it('valid', () => {
    const w = ev();
    expect(provider.verifyWebhook(ctx, w.body, w.headers, now)).toMatchObject({ ok: true, event: { kind: 'payment', payment: { status: 'succeeded', amount: { amountMinor: 100n } } } });
  });
  it('secret of another account', () => {
    const w = ev();
    expect(provider.verifyWebhook({ ...ctx, webhookSecret: 'b'.repeat(64) }, w.body, w.headers, now)).toMatchObject({ ok: false, code: 'bad_signature' });
  });
  it('body changed after signing', () => {
    const w = ev();
    const tampered = Buffer.from(w.body.toString().replace('"100"', '"1"'));
    expect(provider.verifyWebhook(ctx, tampered, w.headers, now)).toMatchObject({ ok: false, code: 'bad_signature' });
  });
  it('old and future timestamps are stale (replays)', () => {
    const old = ev({ signedAt: new Date(now.getTime() - 301_000) });
    expect(provider.verifyWebhook(ctx, old.body, old.headers, now)).toMatchObject({ ok: false, code: 'stale_timestamp' });
    const future = ev({ signedAt: new Date(now.getTime() + 301_000) });
    expect(provider.verifyWebhook(ctx, future.body, future.headers, now)).toMatchObject({ ok: false, code: 'stale_timestamp' });
  });
  it('missing or malformed header', () => {
    const w = ev();
    expect(provider.verifyWebhook(ctx, w.body, {}, now)).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(provider.verifyWebhook(ctx, w.body, { 'x-sim-signature': 'v1=abc' }, now)).toMatchObject({ ok: false, code: 'bad_signature' });
  });
  it('signed but not a valid event: malformed', () => {
    const body = Buffer.from('{"id":"nope"}');
    expect(provider.verifyWebhook(ctx, body, { 'x-sim-signature': signSimulator(secret, body, now) }, now)).toMatchObject({ ok: false, code: 'malformed' });
  });
  it('simulator_failed_is_terminal: a declined object cannot be charged or reused', async () => {
    control.queue('acc', 'decline');
    const p = await provider.createPayment(ctx, { amount: { amountMinor: 100n, currency: 'AUD' }, method: 'card', idempotencyKey: 'k1', metadata: { paymentId: 'p', bookingId: 'b' }, returnUrl: 'https://x.test/r', customerCountry: 'AU' });
    expect(p.status).toBe('failed');
    expect((await provider.cancelPayment(ctx, p.ref)).status).toBe('failed');
    expect((await provider.createPayment(ctx, { amount: { amountMinor: 100n, currency: 'AUD' }, method: 'card', idempotencyKey: 'k1', metadata: { paymentId: 'p', bookingId: 'b' }, returnUrl: 'https://x.test/r', customerCountry: 'AU' })).status).toBe('failed');
  });
});

describe('static checks', () => {
  const sources = readSources(srcDir);
  it('only_gateway_reads_credential_columns', () => {
    const readers = sources.filter((f) => /credentialsCiphertext|webhookSecretCiphertext/.test(f.text) && !f.name.startsWith('generated/') && f.name !== 'platform/audit/field-classes.generated.ts').map((f) => f.name).sort();
    // The gateway decrypts; the accounts service only writes them when it creates an account.
    expect(readers).toEqual(['modules/payments/core/accounts.service.ts', 'modules/payments/core/gateway.ts']);
    const accounts = sources.find((f) => f.name === 'modules/payments/core/accounts.service.ts')!.text;
    expect(accounts).not.toMatch(/decrypt\(/);
  });
  it('only_attempt_state_machine_writes_payment_status', () => {
    const writers = sources.filter((f) => /UPDATE payments SET[^;]*status\s*=|payment\.update(Many)?\(\{[^)]*status:/s.test(f.text)).map((f) => f.name);
    expect(writers).toEqual(['modules/payments/core/attempt-state.ts']);
  });
});
