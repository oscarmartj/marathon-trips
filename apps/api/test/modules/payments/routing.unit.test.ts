// Pure routing (task 4.2, plan docs/plans/4.2-routing-rules.md): rules, backups, limits, the live guarantee, the
// breaker's arithmetic and the defaults. No database.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ENVS, type AppEnv, type PaymentMethod } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import { PLANNED_ADAPTERS } from '../../../src/modules/payments/adapters/planned';
import { createAdapters } from '../../../src/modules/payments/adapters';
import { ManualProvider } from '../../../src/modules/payments/adapters/manual/manual';
import { type AccountForCall, callBlockReason } from '../../../src/modules/payments/core/gateway';
import type { AdapterManifest } from '../../../src/modules/payments/core/provider';
import {
  AUTH_FAILED_OPEN_UNTIL, type BreakerSettings, type HealthState, MAX_LIMIT_MINOR, type RouteContext, type RuleRow, afterFailure, afterSuccess,
  amountGaps, compareRules, countsForBreaker, defaultRules, explain, healthState, route, routableMethods,
} from '../../../src/modules/payments/core/routing-rules';

const manifest = (key: string, over: Partial<AdapterManifest> = {}): AdapterManifest => ({
  key, displayName: key, status: 'experimental', testOnly: false, cardDataHandling: 'hosted_only', methods: ['card', 'apple_pay', 'google_pay'], currencies: ['AUD'],
  countries: 'any', checkoutOrigin: 'https://x.invalid', account: { fields: [], webhookSecret: { source: 'generated' } },
  capabilities: { refunds: 'partial', deferredCapture: false, lookupByIdempotencyKey: true, declineOutcome: 'failed' }, ...over,
});
const MANIFESTS: Record<string, AdapterManifest> = {
  gw: manifest('gw'),
  manual: manifest('manual', { methods: ['payid_transfer', 'manual_other'] }),
  au_only: manifest('au_only', { countries: ['AU'] }),
};

const T0 = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const rule = (account: string, over: Partial<RuleRow> = {}): RuleRow => ({
  id: `r${String(++seq).padStart(3, '0')}`, providerAccountId: account, method: 'card', countries: [], anyCountry: true, currency: 'AUD',
  minAmountMinor: null, maxAmountMinor: null, priority: 100, enabled: true, fallbackForRuleId: null, createdAt: T0, ...over,
});
const acct = (id: string, over: Partial<AccountForCall> = {}): AccountForCall => ({ id, adapterKey: 'gw', mode: 'test', status: 'active', ...over });

function ctx(accounts: AccountForCall[], over: Partial<RouteContext> = {}): RouteContext {
  return {
    accounts: new Map(accounts.map((a) => [a.id, a])), manifest: (k) => MANIFESTS[k], env: 'test', manualOffered: new Set<PaymentMethod>(['payid_transfer']),
    manualKey: 'manual', health: new Map<string, HealthState>(), ...over,
  };
}
const q = (over: Partial<{ method: PaymentMethod; country: string; currency: string; amountMinor: bigint | null }> = {}) => ({ method: 'card' as PaymentMethod, country: 'AU', currency: 'AUD', amountMinor: null, ...over });
const ids = (r: ReturnType<typeof route>) => r.map((c) => c.accountId);

describe('routing_table', () => {
  const A = acct('A'); const B = acct('B'); const C = acct('C');
  const cases: Array<{ name: string; rules: RuleRow[]; q: ReturnType<typeof q>; accounts?: AccountForCall[]; expect: string[] }> = [
    { name: 'lower priority first', rules: [rule('A', { priority: 20 }), rule('B', { priority: 10 })], q: q(), expect: ['B', 'A'] },
    { name: 'tie: createdAt, then account', rules: [rule('B'), rule('A'), rule('C', { createdAt: new Date(T0.getTime() - 1) })], q: q(), expect: ['C', 'A', 'B'] },
    { name: 'listed countries', rules: [rule('A', { countries: ['NZ'], anyCountry: false }), rule('B')], q: q(), expect: ['B'] },
    { name: 'listed country matches', rules: [rule('A', { countries: ['AU', 'NZ'], anyCountry: false })], q: q(), expect: ['A'] },
    { name: 'currency mismatch', rules: [rule('A', { currency: 'NZD' })], q: q(), expect: [] },
    { name: 'method mismatch', rules: [rule('A', { method: 'apple_pay' })], q: q(), expect: [] },
    { name: 'min − 1', rules: [rule('A', { minAmountMinor: 1000n })], q: q({ amountMinor: 999n }), expect: [] },
    { name: 'min', rules: [rule('A', { minAmountMinor: 1000n })], q: q({ amountMinor: 1000n }), expect: ['A'] },
    { name: 'max', rules: [rule('A', { maxAmountMinor: 5000n })], q: q({ amountMinor: 5000n }), expect: ['A'] },
    { name: 'max + 1', rules: [rule('A', { maxAmountMinor: 5000n })], q: q({ amountMinor: 5001n }), expect: [] },
    { name: 'no amount: limits not applied', rules: [rule('A', { maxAmountMinor: 1n, minAmountMinor: 1n })], q: q(), expect: ['A'] },
    { name: 'disabled rule', rules: [rule('A', { enabled: false })], q: q(), expect: [] },
    { name: 'account with two rules listed once', rules: [rule('A', { priority: 1 }), rule('B', { priority: 2 }), rule('A', { priority: 3 })], q: q(), expect: ['A', 'B'] },
    { name: 'rule outside the adapter', rules: [rule('A', { method: 'payto' })], q: q({ method: 'payto' }), expect: [] },
    { name: 'paused account', rules: [rule('A'), rule('B')], q: q(), accounts: [acct('A', { status: 'paused' }), B], expect: ['B'] },
    { name: 'country outside an AU-only adapter', rules: [rule('A', { countries: ['NZ'], anyCountry: false })], q: q({ country: 'NZ' }), accounts: [acct('A', { adapterKey: 'au_only' })], expect: [] },
  ];
  for (const c of cases) it(c.name, () => expect(ids(route(c.rules, ctx(c.accounts ?? [A, B, C]), c.q))).toEqual(c.expect));

  it('manual methods follow their own switch as well as the rules', () => {
    const M = acct('M', { adapterKey: 'manual' });
    const rules = [rule('M', { method: 'payid_transfer' }), rule('M', { method: 'manual_other' })];
    expect(routableMethods(rules, ctx([M]), { country: 'AU', currency: 'AUD', amountMinor: null })).toEqual(['payid_transfer']);
  });
});

describe('routing_limit_ignored_for_other_currency', () => {
  it('an AUD rule with limits never matches an NZD payment, and an NZD payment sees only NZD rules', () => {
    const rules = [rule('A', { maxAmountMinor: 100n }), rule('B', { currency: 'NZD' })];
    const multi = ctx([acct('A'), acct('B', { adapterKey: 'nzd' })], { manifest: (k) => (k === 'nzd' ? manifest('nzd', { currencies: ['NZD'] }) : MANIFESTS[k]) });
    expect(ids(route(rules, multi, q({ currency: 'NZD', amountMinor: 50n })))).toEqual(['B']);
    expect(ids(route(rules, multi, q({ currency: 'NZD', amountMinor: 10_000n })))).toEqual(['B']);
    expect(ids(route(rules, multi, q({ currency: 'AUD', amountMinor: 10_000n })))).toEqual([]);
  });
});

describe('fallback_table', () => {
  const accounts = [acct('A'), acct('B'), acct('C')];
  const pair = (primary: Partial<RuleRow> = {}, backup: Partial<RuleRow> = {}) => {
    const p = rule('A', { priority: 10, ...primary });
    return [p, rule('B', { priority: 50, fallbackForRuleId: p.id, ...backup })];
  };
  it('a backup is not used while its primary serves', () => expect(ids(route(pair(), ctx(accounts), q()))).toEqual(['A']));
  for (const status of ['paused', 'retired', 'archived'] as const) {
    it(`a backup serves while the primary account is ${status}`, () => {
      const r = route(pair(), ctx([acct('A', { status }), acct('B')]), q());
      expect(ids(r)).toEqual(['B']);
      expect(r[0]!.backupFor).not.toBeNull();
    });
  }
  it('a backup serves while the primary account is blocked (a test-only adapter in staging)', () => {
    const c = ctx([acct('A', { adapterKey: 'sim' }), acct('B')], { env: 'staging', manifest: (k) => (k === 'sim' ? manifest('sim', { testOnly: true }) : MANIFESTS[k]) });
    const rules = pair();
    expect(explain(rules, c, q()).get(rules[0]!.id)).toBe('adapter_blocked');
    expect(ids(route(rules, c, q()))).toEqual(['B']);
  });
  it('a backup serves while the primary breaker is open, not while it is half-open', () => {
    expect(ids(route(pair(), ctx(accounts, { health: new Map([['A', 'open']]) }), q()))).toEqual(['B']);
    const half = route(pair(), ctx(accounts, { health: new Map([['A', 'half_open']]) }), q());
    expect(ids(half)).toEqual(['A']);
    expect(half[0]!.halfOpen).toBe(true);
    expect(ids(route(pair(), ctx(accounts, { health: new Map([['A', 'half_open']]), unavailable: new Set(['A']) }), q()))).toEqual(['B']);
  });
  it('a backup serves a disabled primary (review answer Q2)', () => expect(ids(route(pair({ enabled: false }), ctx(accounts), q()))).toEqual(['B']));
  it('a backup serves while the manual method of its primary is off', () => {
    const p = rule('M', { method: 'manual_other' });
    const rules = [p, rule('B2', { method: 'manual_other', fallbackForRuleId: p.id })];
    const c = ctx([acct('M', { adapterKey: 'manual' }), acct('B2', { adapterKey: 'manual' })], { manualOffered: new Set(['manual_other']) });
    expect(ids(route(rules, c, q({ method: 'manual_other' })))).toEqual(['M']);
  });
  it('a backup never takes what its primary would not match (amount over its max, other country)', () => {
    const rules = pair({ maxAmountMinor: 1000n, countries: ['AU'], anyCountry: false });
    const c = ctx([acct('A', { status: 'paused' }), acct('B')]);
    expect(ids(route(rules, c, q({ amountMinor: 1001n })))).toEqual([]);
    expect(ids(route(rules, c, q({ country: 'NZ' })))).toEqual([]);
    expect(ids(route(rules, c, q({ amountMinor: 1000n })))).toEqual(['B']);
  });
  it('a backup serves a primary its gateway can no longer do (outside_adapter, review B4)', () => {
    const p = rule('A', { method: 'payto' });
    const rules = [p, rule('C', { method: 'payto', fallbackForRuleId: p.id })];
    const c = ctx([acct('A'), acct('C', { adapterKey: 'debits' })], { manifest: (k) => (k === 'debits' ? manifest('debits', { methods: ['payto'] }) : MANIFESTS[k]) });
    expect(explain(rules, c, q({ method: 'payto' })).get(p.id)).toBe('outside_adapter');
    expect(ids(route(rules, c, q({ method: 'payto' })))).toEqual(['C']);
  });
  it('a backup must match itself', () => {
    expect(ids(route(pair({}, { maxAmountMinor: 10n }), ctx([acct('A', { status: 'paused' }), acct('B')]), q({ amountMinor: 11n })))).toEqual([]);
  });
  it('backups come after every primary, ordered by priority', () => {
    const p = rule('A', { priority: 10 });
    const rules = [p, rule('B', { priority: 90, fallbackForRuleId: p.id }), rule('C', { priority: 80, fallbackForRuleId: p.id })];
    expect(ids(route(rules, ctx([acct('A', { status: 'paused' }), acct('B'), acct('C')]), q()))).toEqual(['C', 'B']);
  });
  it('explain gives primary_serving and primary_not_matching', () => {
    const rules = pair({ countries: ['AU'], anyCountry: false });
    const [p, b] = rules;
    expect(explain(rules, ctx(accounts), q()).get(b!.id)).toBe('primary_serving');
    expect(explain(rules, ctx(accounts), q({ country: 'NZ' })).get(b!.id)).toBe('primary_not_matching');
    expect(explain(rules, ctx(accounts), q({ country: 'NZ' })).get(p!.id)).toBe('country');
  });
});

describe('coverage_uses_route_fallback_scenario (review point 1)', () => {
  it('a backup of an AU-only primary does not cover NZ once the NZ rule is gone', () => {
    const T = rule('A', { countries: ['AU'], anyCountry: false });
    const F = rule('B', { fallbackForRuleId: T.id });
    const P = rule('C', { countries: ['NZ'], anyCountry: false });
    const c = ctx([acct('A'), acct('B'), acct('C')], { ignoreHealth: true });
    expect(routableMethods([T, F, P], c, { country: 'NZ', currency: 'AUD', amountMinor: null })).toEqual(['card']);
    expect(routableMethods([T, F], c, { country: 'NZ', currency: 'AUD', amountMinor: null })).toEqual([]);
    // With A excluded (pausing it), F covers AU.
    expect(routableMethods([T, F], { ...c, excludeAccountIds: new Set(['A']) }, { country: 'AU', currency: 'AUD', amountMinor: null })).toEqual(['card']);
  });
});

describe('method_limited_by_amount (review point 5)', () => {
  const c = ctx([acct('A'), acct('B')], { ignoreHealth: true });
  it('one card rule capped at 500.00 leaves 500.01 and above uncovered', () => {
    expect(amountGaps([rule('A', { maxAmountMinor: 50_000n })], c, { method: 'card', country: 'AU', currency: 'AUD' })).toEqual([{ fromMinor: 50_001n, toMinor: MAX_LIMIT_MINOR }]);
  });
  it('two rules that meet leave no gap; a hole between them is found exactly', () => {
    expect(amountGaps([rule('A', { maxAmountMinor: 100n }), rule('B', { minAmountMinor: 101n })], c, { method: 'card', country: 'AU', currency: 'AUD' })).toEqual([]);
    expect(amountGaps([rule('A', { maxAmountMinor: 100n }), rule('B', { minAmountMinor: 200n })], c, { method: 'card', country: 'AU', currency: 'AUD' })).toEqual([{ fromMinor: 101n, toMinor: 199n }]);
    expect(amountGaps([rule('A', { minAmountMinor: 10n })], c, { method: 'card', country: 'AU', currency: 'AUD' })).toEqual([{ fromMinor: 1n, toMinor: 9n }]);
  });
});

describe('routing_never_offers_unverified_live', () => {
  it('adapter status × account mode × environment: only what callBlockReason allows is routed, never a live account of a non-verified adapter', () => {
    for (const status of ['planned', 'experimental', 'verified'] as const) {
      for (const testOnly of [false, true]) {
        for (const mode of ['test', 'live'] as const) {
          for (const env of APP_ENVS as readonly AppEnv[]) {
            const m = manifest('gw', { status, testOnly });
            const a = acct('A', { mode });
            const c = ctx([a], { env, manifest: () => m });
            const routed = route([rule('A')], c, q()).length > 0;
            expect(routed).toBe(callBlockReason(a, m, 'create', env) === null);
            if (mode === 'live' && (status !== 'verified' || testOnly)) expect(routed).toBe(false);
            if (mode === 'live' && env !== 'production') expect(routed).toBe(false);
          }
        }
      }
    }
  });
});

describe('breaker_math', () => {
  const s: BreakerSettings = { failures: 3, windowSeconds: 300, cooldownSeconds: 120 };
  const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
  it('opens at the threshold within the window; restarts outside it', () => {
    let h = afterFailure(undefined, 'provider_unavailable', at(0), s);
    h = afterFailure(h, 'provider_timeout', at(10), s);
    expect(h.openUntil).toBeNull();
    h = afterFailure(h, 'provider_unavailable', at(20), s);
    expect(h.openUntil).toEqual(at(140));
    expect(h.openedAt).toEqual(at(20));
    let g = afterFailure(undefined, 'provider_unavailable', at(0), s);
    g = afterFailure(g, 'provider_unavailable', at(10), s);
    g = afterFailure(g, 'provider_unavailable', at(400), s);
    expect(g.consecutiveFailures).toBe(1);
    expect(g.openUntil).toBeNull();
  });
  it('reopen_after_cooldown_longer_than_window: once opened, the first failure reopens whatever the window', () => {
    const long: BreakerSettings = { failures: 3, windowSeconds: 60, cooldownSeconds: 3600 };
    let h = afterFailure(undefined, 'provider_unavailable', at(0), long);
    h = afterFailure(h, 'provider_unavailable', at(1), long);
    h = afterFailure(h, 'provider_unavailable', at(2), long);
    expect(h.openUntil).toEqual(at(3602));
    expect(healthState(h, at(3603))).toBe('half_open');
    h = afterFailure(h, 'provider_unavailable', at(3700), long);
    expect(h.openUntil).toEqual(at(7300));
    expect(healthState(h, at(3701))).toBe('open');
  });
  it('a failure while open extends the cooldown and frees the probe', () => {
    let h = afterFailure(undefined, 'provider_unavailable', at(0), { ...s, failures: 2 });
    h = afterFailure(h, 'provider_unavailable', at(1), { ...s, failures: 2 });
    h = { ...h, probeUntil: at(200) };
    h = afterFailure(h, 'provider_timeout', at(100), s);
    expect(h.openUntil).toEqual(at(220));
    expect(h.probeUntil).toBeNull();
  });
  it('half_open_admits_single_probe: a held probe counts as open', () => {
    const h = { openedAt: at(0), openUntil: at(10), probeUntil: at(80) };
    expect(healthState(h, at(5))).toBe('open');
    expect(healthState(h, at(20))).toBe('open');
    expect(healthState(h, at(81))).toBe('half_open');
    expect(healthState({ openedAt: null, openUntil: null, probeUntil: null }, at(0))).toBe('closed');
  });
  it('auth_failed_stays_open_until_success: no automatic half-open', () => {
    let h = afterFailure(undefined, 'provider_auth_failed', at(0), s);
    h = afterFailure(h, 'provider_auth_failed', at(1), s);
    h = afterFailure(h, 'provider_auth_failed', at(2), s);
    expect(h.openUntil).toEqual(AUTH_FAILED_OPEN_UNTIL);
    expect(healthState(h, at(1_000_000))).toBe('open');
    h = afterFailure(h, 'provider_unavailable', at(3), s);
    expect(h.openUntil).toEqual(AUTH_FAILED_OPEN_UNTIL);
    const ok = afterSuccess(h, at(4), at(5))!;
    expect(ok.openUntil).toBeNull();
    expect(healthState(ok, at(6))).toBe('closed');
  });
  it('slow_success_does_not_close_newer_failure', () => {
    const h = afterFailure(undefined, 'provider_unavailable', at(10), s);
    expect(afterSuccess(h, at(5), at(11))).toBeNull();
    expect(afterSuccess(h, at(10), at(11))!.consecutiveFailures).toBe(0);
  });
  it('counts unavailable, timeout and auth_failed; never busy, rejected or not_found', () => {
    expect(['provider_unavailable', 'provider_timeout', 'provider_auth_failed'].every(countsForBreaker)).toBe(true);
    expect(['provider_busy', 'provider_rejected', 'provider_not_found', 'account_not_accepting_charges'].some(countsForBreaker)).toBe(false);
  });
});

describe('defaults', () => {
  it('default rules: every method but bnpl, the charged currency, any country, priority 100', () => {
    expect(defaultRules(manifest('x', { methods: ['card', 'bnpl'], currencies: ['AUD', 'NZD'] }))).toEqual([{ method: 'card', currency: 'AUD', countries: [], anyCountry: true, priority: 100 }]);
    expect(defaultRules(manifest('x', { countries: ['AU'] }))[0]).toMatchObject({ countries: ['AU'], anyCountry: false });
  });

  it('default_rules_route_like_3_1: route() over default rules gives the order of the 3.1 routing', () => {
    // The 3.1 routing, copied: active accounts allowed to charge whose adapter supports the method, currency and
    // country, oldest first, then id; manual accounts only while the method is offered.
    const old = (accounts: Array<AccountForCall & { createdAt: Date }>, c: RouteContext, query: ReturnType<typeof q>) => accounts
      .filter((a) => a.status === 'active').filter((a) => {
        const m = c.manifest(a.adapterKey);
        if (!m || callBlockReason(a, m, 'create', c.env) !== null) return false;
        if (!m.methods.includes(query.method) || !m.currencies.includes(query.currency)) return false;
        if (m.countries !== 'any' && !m.countries.includes(query.country)) return false;
        return a.adapterKey !== 'manual' || c.manualOffered.has(query.method);
      })
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).map((a) => a.id);
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    for (let round = 0; round < 300; round++) {
      const accounts = Array.from({ length: 1 + rnd(6) }, (_, i) => ({
        ...acct(`acc-${rnd(1000).toString().padStart(4, '0')}-${i}`, { adapterKey: ['gw', 'manual', 'au_only'][rnd(3)]!, status: (['active', 'active', 'paused', 'retired'] as const)[rnd(4)] }),
        createdAt: new Date(T0.getTime() + rnd(3) * 1000),
      }));
      const rules = accounts.flatMap((a) => defaultRules(MANIFESTS[a.adapterKey]!).map((r, k) => ({ ...r, id: `${a.id}-${k}`, providerAccountId: a.id, minAmountMinor: null, maxAmountMinor: null, enabled: true, fallbackForRuleId: null, createdAt: a.createdAt })));
      const c = ctx(accounts);
      for (const method of ['card', 'apple_pay', 'payid_transfer', 'manual_other'] as PaymentMethod[]) {
        for (const country of ['AU', 'NZ']) {
          const query = q({ method, country });
          expect(ids(route(rules, c, query))).toEqual(old(accounts, c, query));
        }
      }
    }
  });

  it('backfill_matches_default_rules: the 0036 backfill holds the default methods of the manifests as they were in 0036', () => {
    // A fixed copy of the 0036 manifests (not the live ones, which later tasks may change).
    const at0036: Record<string, AdapterManifest> = {
      simulator: manifest('simulator', { methods: ['card', 'apple_pay', 'google_pay'], currencies: ['AUD'], countries: 'any' }),
      stripe: manifest('stripe', { methods: ['card', 'apple_pay', 'google_pay'], currencies: ['AUD'], countries: 'any' }),
      manual: manifest('manual', { methods: ['payid_transfer', 'manual_other'], currencies: ['AUD'], countries: 'any' }),
    };
    const dir = join(__dirname, '../../../prisma/migrations');
    const folder = readdirSync(dir).find((d) => d.endsWith('_routing_rules'))!;
    const sql = readFileSync(join(dir, folder, 'migration.sql'), 'utf8');
    const block = sql.slice(sql.indexOf('JOIN (VALUES'), sql.indexOf(') AS m(adapter, method)'));
    const values = [...block.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}:${m[2]}`).sort();
    const expected = Object.entries(at0036).flatMap(([k, m]) => defaultRules(m).map((r) => `${k}:${r.method}`)).sort();
    expect(values).toEqual(expected);
    expect(sql).toMatch(/'AUD', 100, true, a\."createdAt"/);
  });

  it('compareRules is a total order on (priority, createdAt, account, id)', () => {
    const a = rule('A', { id: 'x1' }); const b = rule('A', { id: 'x2' });
    expect(compareRules(a, b)).toBeLessThan(0);
    expect(compareRules(b, a)).toBeGreaterThan(0);
    expect(compareRules(a, a)).toBe(0);
  });
});

describe('planned adapters', () => {
  it('planned_catalogue_keys_unique_and_unregistered', () => {
    const registered = [...createAdapters({ webOrigin: 'http://localhost:3000' }), new ManualProvider()].map((p) => p.manifest.key);
    const keys = PLANNED_ADAPTERS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => registered.includes(k))).toEqual([]);
  });
});

describe('no_surcharge_by_payment_method (task 4.2)', () => {
  it('a routing rule has no price or fee field: rules only choose an account', () => {
    const schema = readFileSync(join(__dirname, '../../../prisma/schema/payments.prisma'), 'utf8');
    const model = /model RoutingRule \{([\s\S]*?)\n\}/.exec(schema)![1]!;
    const fields = model.split('\n').map((l) => l.trim()).filter((l) => /^[a-z]/.test(l)).map((l) => l.split(/\s+/)[0]);
    expect(fields.filter((f) => /fee|surcharge|price|percent|bps/i.test(f!))).toEqual([]);
    expect(fields.filter((f) => /Minor$/.test(f!))).toEqual(['minAmountMinor', 'maxAmountMinor']);
  });
});
