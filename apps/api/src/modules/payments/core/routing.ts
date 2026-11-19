import { Inject, Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@mt/shared';
import { MANUAL_PAYMENT_METHODS } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { MANUAL_KEY } from '../adapters/manual/manual';
import { ACCOUNT_PUBLIC_SELECT, AccountForCall, ProviderGateway, callBlockReason } from './gateway';
import { ManualMethodsService } from './manual-methods.service';
import {
  type ExclusionReason, type HealthState, type RouteChoice, type RouteContext, type RuleRow,
  PROBE_HOLD_MS, amountGaps, explain, healthState, route, routableMethods,
} from './routing-rules';

type Db = Prisma.TransactionClient;

export interface RouteQuery {
  method?: PaymentMethod;
  currency: string;
  country: string;
  /** The server's due amount (never the request's); null or absent applies no limits. */
  amountMinor?: bigint | null;
}

export const RULE_SELECT = {
  id: true, providerAccountId: true, method: true, countries: true, anyCountry: true, currency: true, minAmountMinor: true,
  maxAmountMinor: true, priority: true, enabled: true, fallbackForRuleId: true, createdAt: true,
} as const;

interface Loaded {
  rules: RuleRow[];
  ctx: RouteContext;
}

/**
 * Routing by rules (task 4.2, plan docs/plans/4.2-routing-rules.md): the rows are read in the caller's transaction and
 * the pure functions of routing-rules.ts decide. The same `route` answers a charge, the plan view, a payment link and
 * the coverage the 4.1 guard watches (plan 15.1). In production nothing qualifies today (test accounts and test-only
 * adapters are out, and a live account of a non-verified adapter is blocked by callBlockReason).
 */
@Injectable()
export class PaymentRouting {
  constructor(
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(ManualMethodsService) private readonly manual: ManualMethodsService,
  ) {}

  private async load(db: Db, q: { currency: string; country: string }, opts: { ignoreHealth?: boolean; excludeAccountIds?: readonly string[]; now?: Date; allCurrencies?: boolean } = {}): Promise<Loaded> {
    // A rule of another currency never matches; only the preview lists them, to say why.
    const rows = await db.routingRule.findMany({ where: opts.allCurrencies ? {} : { currency: q.currency }, select: RULE_SELECT });
    const ids = [...new Set(rows.map((r) => r.providerAccountId))];
    const accounts = ids.length === 0 ? [] : await db.providerAccount.findMany({ where: { id: { in: ids } }, select: ACCOUNT_PUBLIC_SELECT });
    const health = new Map<string, HealthState>();
    if (!opts.ignoreHealth && ids.length > 0) {
      // The database clock, as the health writes and the probe claim use (review B2).
      const now = opts.now ?? (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
      const hs = await db.providerAccountHealth.findMany({ where: { providerAccountId: { in: ids } }, select: { providerAccountId: true, openedAt: true, openUntil: true, probeUntil: true } });
      for (const h of hs) health.set(h.providerAccountId, healthState(h, now));
    }
    const manualOffered = new Set<PaymentMethod>();
    if (accounts.some((a) => a.adapterKey === MANUAL_KEY)) {
      for (const m of MANUAL_PAYMENT_METHODS) if (await this.manual.offered(db, m, q.country)) manualOffered.add(m);
    }
    const rules: RuleRow[] = rows.map((r) => ({ ...r, method: r.method as PaymentMethod }));
    return {
      rules,
      ctx: {
        accounts: new Map(accounts.map((a) => [a.id, a])), manifest: (k) => this.gateway.registry.get(k)?.manifest, env: this.gateway.env,
        manualOffered, manualKey: MANUAL_KEY, health, ignoreHealth: opts.ignoreHealth, excludeAccountIds: new Set(opts.excludeAccountIds ?? []),
      },
    };
  }

  private query(q: RouteQuery) {
    return { method: q.method, country: q.country, currency: q.currency, amountMinor: q.amountMinor ?? null };
  }

  /** The accounts that may take a new payment, best first (read only: no probe is claimed). */
  async candidates(db: Db, q: RouteQuery): Promise<AccountForCall[]> {
    const { rules, ctx } = await this.load(db, q);
    return route(rules, ctx, this.query(q)).map((c) => ctx.accounts.get(c.accountId)!);
  }

  /**
   * The account a NEW attempt goes to (plan 2.2 and 15.2), inside transaction A. A half-open account is taken only if
   * this transaction claims its single probe; otherwise it counts as unable to serve and routing is worked out again
   * (so its backups step in). The claim is undone if the transaction rolls back.
   */
  async choose(db: Db, q: RouteQuery): Promise<{ account: AccountForCall; choice: RouteChoice } | null> {
    // The read-only answer first (the same rows, in this transaction): nothing routable means no probe is touched.
    if ((await this.candidates(db, q)).length === 0) return null;
    const { rules, ctx } = await this.load(db, q);
    const unavailable = new Set<string>();
    for (let i = 0; i <= ctx.accounts.size; i++) {
      const first = route(rules, { ...ctx, unavailable }, this.query(q))[0];
      if (!first) return null;
      if (!first.halfOpen || (await this.claimProbe(db, first.accountId))) return { account: ctx.accounts.get(first.accountId)!, choice: first };
      unavailable.add(first.accountId);
    }
    return null;
  }

  private async claimProbe(db: Db, accountId: string): Promise<boolean> {
    const n = await db.$executeRaw`
      UPDATE provider_account_health SET "probeUntil" = clock_timestamp() + make_interval(secs => ${PROBE_HOLD_MS / 1000}), "updatedAt" = clock_timestamp()
      WHERE "providerAccountId" = ${accountId}::uuid AND "openUntil" IS NOT NULL AND "openUntil" <= clock_timestamp()
        AND ("probeUntil" IS NULL OR "probeUntil" <= clock_timestamp())`;
    return n === 1;
  }

  /** Whether a live attempt on this account may be resumed (plan 4.3): active and allowed, whatever rules and health say. */
  canResumeOn(account: AccountForCall | null): boolean {
    if (!account || account.status !== 'active') return false;
    return callBlockReason(account, this.gateway.registry.get(account.adapterKey)?.manifest, 'create', this.gateway.env) === null;
  }

  async methods(db: Db, q: Omit<RouteQuery, 'method'>, excludeAccountIds: readonly string[] = []): Promise<PaymentMethod[]> {
    const { rules, ctx } = await this.load(db, q, { excludeAccountIds });
    return routableMethods(rules, ctx, this.query(q));
  }

  /**
   * Every (method, country) a customer can pay with, for the sales countries and a currency (task 4.1, plan section 5),
   * optionally as if some accounts were not active: `route` with no amount and health ignored (plan 4.2, 15.1).
   */
  async coverage(db: Db, q: { countries: readonly string[]; currency: string }, excludeAccountIds: readonly string[] = []): Promise<Array<{ method: PaymentMethod; country: string }>> {
    const out: Array<{ method: PaymentMethod; country: string }> = [];
    for (const country of [...q.countries].sort()) {
      const { rules, ctx } = await this.load(db, { currency: q.currency, country }, { ignoreHealth: true, excludeAccountIds });
      for (const method of routableMethods(rules, ctx, { country, currency: q.currency, amountMinor: null })) out.push({ method, country });
    }
    return out;
  }

  /** Covered pairs that some amount cannot use (plan 15.5), health ignored. */
  async amountGaps(db: Db, q: { countries: readonly string[]; currency: string }): Promise<Array<{ method: PaymentMethod; country: string; gaps: Array<{ fromMinor: bigint; toMinor: bigint }> }>> {
    const out: Array<{ method: PaymentMethod; country: string; gaps: Array<{ fromMinor: bigint; toMinor: bigint }> }> = [];
    for (const country of [...q.countries].sort()) {
      const { rules, ctx } = await this.load(db, { currency: q.currency, country }, { ignoreHealth: true });
      for (const method of routableMethods(rules, ctx, { country, currency: q.currency, amountMinor: null })) {
        const gaps = amountGaps(rules, ctx, { method, country, currency: q.currency });
        if (gaps.length > 0) out.push({ method, country, gaps });
      }
    }
    return out;
  }

  /** Covered pairs whose every serving account is unreachable right now (plan 5, warning `method_unreachable_now`). */
  async unreachableNow(db: Db, q: { countries: readonly string[]; currency: string }): Promise<Array<{ method: PaymentMethod; country: string }>> {
    const out: Array<{ method: PaymentMethod; country: string }> = [];
    for (const country of [...q.countries].sort()) {
      const cold = await this.load(db, { currency: q.currency, country }, { ignoreHealth: true });
      const hot = await this.load(db, { currency: q.currency, country });
      const now = new Set(routableMethods(hot.rules, hot.ctx, { country, currency: q.currency, amountMinor: null }));
      for (const method of routableMethods(cold.rules, cold.ctx, { country, currency: q.currency, amountMinor: null })) if (!now.has(method)) out.push({ method, country });
    }
    return out;
  }

  /** "Who would take this payment?" for the panel (plan 8): the ordered choice and why each other rule is left out. */
  async preview(db: Db, q: Required<Pick<RouteQuery, 'method'>> & RouteQuery): Promise<{ route: RouteChoice[]; reasons: Array<{ ruleId: string; reason: ExclusionReason | null }> }> {
    const { rules, ctx } = await this.load(db, q, { allCurrencies: true });
    const reasons = explain(rules, ctx, this.query(q));
    return { route: route(rules, ctx, this.query(q)), reasons: rules.map((r) => ({ ruleId: r.id, reason: reasons.get(r.id) ?? null })) };
  }
}
