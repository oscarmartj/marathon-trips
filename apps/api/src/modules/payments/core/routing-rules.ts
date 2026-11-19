// Pure routing (task 4.2, plan docs/plans/4.2-routing-rules.md, sections 2, 3 and 15). No database: the loader in
// routing.ts reads the rows in the caller's transaction and hands them here. Table-tested in routing.unit.test.ts.
// Rules only choose the account of a NEW attempt; they never change an amount (the amount is always the server's).
import type { AppEnv, PaymentMethod } from '@mt/shared';
import { PAYMENT_METHODS } from '@mt/shared';
import { type AccountForCall, callBlockReason } from './gateway';
import type { AdapterManifest } from './provider';

/** The largest amount a limit may hold, and the top of the range `amountGaps` checks: 10^12 minor units. */
export const MAX_LIMIT_MINOR = 1_000_000_000_000n;
/** The currencies customers are charged in (docs/payments.md, "Moneda"): a rule serves one of them. */
export const CHARGE_CURRENCIES: readonly string[] = ['AUD'];
/** How long a half-open account's single probe attempt holds the probe (plan 15.2). */
export const PROBE_HOLD_MS = 60_000;
/** The openUntil of an account whose gateway refused its credentials: no automatic half-open (plan 15.2). */
export const AUTH_FAILED_OPEN_UNTIL = new Date('9999-12-31T00:00:00.000Z');

export interface RuleRow {
  id: string;
  providerAccountId: string;
  method: PaymentMethod;
  countries: readonly string[];
  anyCountry: boolean;
  currency: string;
  minAmountMinor: bigint | null;
  maxAmountMinor: bigint | null;
  priority: number;
  enabled: boolean;
  fallbackForRuleId: string | null;
  createdAt: Date;
}

/** closed: routable; open: skipped; half_open: routable only by the transaction that claims the probe. */
export type HealthState = 'closed' | 'open' | 'half_open';

export interface HealthRow {
  openedAt: Date | null;
  openUntil: Date | null;
  probeUntil: Date | null;
}

export function healthState(h: HealthRow | undefined, now: Date): HealthState {
  if (!h || !h.openUntil) return 'closed';
  if (h.openUntil.getTime() > now.getTime()) return 'open';
  // Past the cooldown: one probe at a time (plan 15.2).
  if (h.probeUntil && h.probeUntil.getTime() > now.getTime()) return 'open';
  return 'half_open';
}

export interface RouteQuery {
  method?: PaymentMethod;
  country: string;
  currency: string;
  /** The server's due amount; null applies no limits (coverage, nothing due). */
  amountMinor: bigint | null;
}

export interface RouteContext {
  accounts: ReadonlyMap<string, AccountForCall>;
  manifest: (adapterKey: string) => AdapterManifest | undefined;
  env: AppEnv;
  /** The manual methods switched on, with valid payee details, for the query's country. */
  manualOffered: ReadonlySet<PaymentMethod>;
  manualKey: string;
  health: ReadonlyMap<string, HealthState>;
  /** Coverage: health is transient and never counts (plan 5). */
  ignoreHealth?: boolean;
  /** As if these accounts were not active (coverage before a change). */
  excludeAccountIds?: ReadonlySet<string>;
  /** Half-open accounts whose probe this transaction could not claim: they cannot serve. */
  unavailable?: ReadonlySet<string>;
}

export interface RouteChoice {
  accountId: string;
  ruleId: string;
  /** Set when a backup serves: the primary rule it stands in for. */
  backupFor: string | null;
  /** The account is half-open: whoever takes it must claim the probe first. */
  halfOpen: boolean;
}

export type ExclusionReason =
  | 'disabled' | 'method' | 'currency' | 'country' | 'below_min' | 'above_max' | 'outside_adapter'
  | 'account_not_active' | 'adapter_blocked' | 'manual_off' | 'unreachable' | 'primary_serving' | 'primary_not_matching';

/** Why a rule's own criteria do not match the query (enabled ignored), or null. */
function criteriaMismatch(r: RuleRow, q: RouteQuery, ctx: RouteContext): ExclusionReason | null {
  if (q.method && r.method !== q.method) return 'method';
  if (r.currency !== q.currency) return 'currency';
  if (!r.anyCountry && !r.countries.includes(q.country)) return 'country';
  if (q.amountMinor !== null) {
    if (r.minAmountMinor !== null && q.amountMinor < r.minAmountMinor) return 'below_min';
    if (r.maxAmountMinor !== null && q.amountMinor > r.maxAmountMinor) return 'above_max';
  }
  const account = ctx.accounts.get(r.providerAccountId);
  const m = account ? ctx.manifest(account.adapterKey) : undefined;
  if (m && !ruleInsideManifest(r, m)) return 'outside_adapter';
  return null;
}

/** Whether the adapter supports the rule's method, currency and countries today (plan 2.2, step 1). */
export function ruleInsideManifest(r: Pick<RuleRow, 'method' | 'currency' | 'countries' | 'anyCountry'>, m: AdapterManifest): boolean {
  if (!m.methods.includes(r.method) || !m.currencies.includes(r.currency)) return false;
  if (m.countries === 'any') return true;
  return !r.anyCountry && r.countries.every((c) => (m.countries as readonly string[]).includes(c));
}

/** Why the rule's account cannot take a new payment for `q`, or null (plan 2.2, step 2). */
function accountProblem(r: RuleRow, q: RouteQuery, ctx: RouteContext): ExclusionReason | null {
  const a = ctx.accounts.get(r.providerAccountId);
  if (!a || a.status !== 'active' || ctx.excludeAccountIds?.has(a.id)) return 'account_not_active';
  if (callBlockReason(a, ctx.manifest(a.adapterKey), 'create', ctx.env) !== null) return 'adapter_blocked';
  if (a.adapterKey === ctx.manualKey && !ctx.manualOffered.has(r.method)) return 'manual_off';
  if (!ctx.ignoreHealth) {
    if (ctx.unavailable?.has(a.id)) return 'unreachable';
    if ((ctx.health.get(a.id) ?? 'closed') === 'open') return 'unreachable';
  }
  return null;
}

/** The order of rules (plan 15.7): priority, then createdAt (a default rule's is its account's), account, id. */
export function compareRules(a: RuleRow, b: RuleRow): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  if (a.providerAccountId !== b.providerAccountId) return a.providerAccountId < b.providerAccountId ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * For every rule, why it does not route `q` (null: it does). A backup routes only when its primary's criteria match
 * and the primary cannot take the payment (disabled, or its account cannot serve): it never widens what is offered.
 */
export function explain(rules: readonly RuleRow[], ctx: RouteContext, q: RouteQuery): Map<string, ExclusionReason | null> {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const own = (r: RuleRow): ExclusionReason | null => {
    if (!r.enabled) return 'disabled';
    return criteriaMismatch(r, q, ctx) ?? accountProblem(r, q, ctx);
  };
  const out = new Map<string, ExclusionReason | null>();
  for (const r of rules) {
    const mine = own(r);
    if (mine !== null || r.fallbackForRuleId === null) {
      out.set(r.id, mine);
      continue;
    }
    const target = byId.get(r.fallbackForRuleId);
    if (!target || criteriaMismatch(target, q, ctx) !== null) out.set(r.id, 'primary_not_matching');
    else if (own(target) === null) out.set(r.id, 'primary_serving');
    else out.set(r.id, null);
  }
  return out;
}

/** The accounts that may take a new payment for `q`, best first (plan 2.2, steps 3 to 5). */
export function route(rules: readonly RuleRow[], ctx: RouteContext, q: RouteQuery): RouteChoice[] {
  const reasons = explain(rules, ctx, q);
  const routed = rules.filter((r) => reasons.get(r.id) === null);
  const primaries = routed.filter((r) => r.fallbackForRuleId === null).sort(compareRules);
  const backups = routed.filter((r) => r.fallbackForRuleId !== null).sort(compareRules);
  const seen = new Set<string>();
  const out: RouteChoice[] = [];
  for (const r of [...primaries, ...backups]) {
    if (seen.has(r.providerAccountId)) continue;
    seen.add(r.providerAccountId);
    const half = !ctx.ignoreHealth && ctx.health.get(r.providerAccountId) === 'half_open';
    out.push({ accountId: r.providerAccountId, ruleId: r.id, backupFor: r.fallbackForRuleId, halfOpen: half });
  }
  return out;
}

/** Every method `route` can serve for the query (sorted, as task 3.1 returned them). */
export function routableMethods(rules: readonly RuleRow[], ctx: RouteContext, q: Omit<RouteQuery, 'method'>): PaymentMethod[] {
  const methods = new Set(rules.map((r) => r.method));
  return PAYMENT_METHODS.filter((m) => methods.has(m) && route(rules, ctx, { ...q, method: m }).length > 0).sort() as PaymentMethod[];
}

/**
 * The amounts in [1, MAX_LIMIT_MINOR] for which `route` gives nothing (plan 15.5), as inclusive ranges. `route` only
 * changes at a rule's `min` or `max + 1`, so it is evaluated at the start of each segment between them.
 */
export function amountGaps(rules: readonly RuleRow[], ctx: RouteContext, q: Omit<RouteQuery, 'amountMinor'>): Array<{ fromMinor: bigint; toMinor: bigint }> {
  const points = new Set<bigint>([1n]);
  for (const r of rules) {
    if (r.minAmountMinor !== null && r.minAmountMinor >= 1n) points.add(r.minAmountMinor);
    if (r.maxAmountMinor !== null && r.maxAmountMinor < MAX_LIMIT_MINOR) points.add(r.maxAmountMinor + 1n);
  }
  const sorted = [...points].filter((p) => p >= 1n && p <= MAX_LIMIT_MINOR).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const gaps: Array<{ fromMinor: bigint; toMinor: bigint }> = [];
  sorted.forEach((p, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1]! - 1n : MAX_LIMIT_MINOR;
    if (route(rules, ctx, { ...q, amountMinor: p }).length > 0) return;
    const last = gaps[gaps.length - 1];
    if (last && last.toMinor + 1n === p) last.toMinor = end;
    else gaps.push({ fromMinor: p, toMinor: end });
  });
  return gaps;
}

/** The rules an account of `manifest` gets when it is created (plan 6): every method but bnpl, no limits, priority 100. */
export function defaultRules(m: AdapterManifest): Array<Pick<RuleRow, 'method' | 'currency' | 'countries' | 'anyCountry' | 'priority'>> {
  const out: Array<Pick<RuleRow, 'method' | 'currency' | 'countries' | 'anyCountry' | 'priority'>> = [];
  for (const currency of m.currencies) {
    if (!CHARGE_CURRENCIES.includes(currency)) continue;
    for (const method of m.methods) {
      if (method === 'bnpl') continue;
      out.push({ method, currency, countries: m.countries === 'any' ? [] : [...m.countries], anyCountry: m.countries === 'any', priority: 100 });
    }
  }
  return out;
}

/** Breaker settings (plan 3, 15.2, 15.3). */
export interface BreakerSettings {
  failures: number;
  windowSeconds: number;
  cooldownSeconds: number;
}

export interface HealthCounters extends HealthRow {
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  lastSuccessAt: Date | null;
}

/** The codes that count as the gateway not answering (plan 3). */
export const BREAKER_CODES = ['provider_unavailable', 'provider_timeout', 'provider_auth_failed'] as const;
export type BreakerCode = (typeof BREAKER_CODES)[number];
export const countsForBreaker = (code: string): code is BreakerCode => (BREAKER_CODES as readonly string[]).includes(code);

/**
 * The health after a failure at `now` (plan 3, 15.2, 15.3). A closed breaker counts failures within the window and
 * opens at the threshold; once opened (no success since), every failure reopens or extends it at once, whatever the
 * window, and frees the probe. Opened by a refused credential, it stays open until a success (no automatic half-open).
 */
export function afterFailure(h: HealthCounters | undefined, code: BreakerCode, now: Date, s: BreakerSettings): HealthCounters {
  const prev: HealthCounters = h ?? { consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, openedAt: null, openUntil: null, probeUntil: null, lastSuccessAt: null };
  const inWindow = prev.lastFailureAt !== null && now.getTime() - prev.lastFailureAt.getTime() <= s.windowSeconds * 1000;
  const count = prev.openedAt !== null || inWindow ? prev.consecutiveFailures + 1 : 1;
  const opens = prev.openedAt !== null || count >= s.failures;
  const cooldownEnd = new Date(now.getTime() + s.cooldownSeconds * 1000);
  let openUntil = prev.openUntil;
  if (opens) {
    if (code === 'provider_auth_failed' || (prev.openUntil && prev.openUntil.getTime() >= AUTH_FAILED_OPEN_UNTIL.getTime())) openUntil = AUTH_FAILED_OPEN_UNTIL;
    else openUntil = prev.openUntil && prev.openUntil.getTime() > cooldownEnd.getTime() ? prev.openUntil : cooldownEnd;
  }
  return {
    ...prev, consecutiveFailures: count, lastFailureAt: now, lastFailureCode: code,
    openedAt: opens ? (prev.openedAt ?? now) : prev.openedAt, openUntil, probeUntil: opens ? null : prev.probeUntil,
  };
}

/** The health after a success of a call that started at `startedAt`: ignored if a failure was recorded since (15.6). */
export function afterSuccess(h: HealthCounters | undefined, startedAt: Date, now: Date): HealthCounters | null {
  if (h?.lastFailureAt && h.lastFailureAt.getTime() > startedAt.getTime()) return null;
  return { consecutiveFailures: 0, lastFailureAt: h?.lastFailureAt ?? null, lastFailureCode: h?.lastFailureCode ?? null, openedAt: null, openUntil: null, probeUntil: null, lastSuccessAt: now };
}
