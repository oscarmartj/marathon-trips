import { Inject, Injectable } from '@nestjs/common';
import type { CreateRoutingRule, PaymentMethod, RoutingRuleView, RoutingWarning, UpdateRoutingRule } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { conflict, notFound, unprocessable } from '../../../platform/http/api-error';
import { COVERAGE_CURRENCY, CollectionCoverageGuard } from './coverage-guard';
import { ProviderGateway } from './gateway';
import type { AdapterManifest } from './provider';
import { RULE_SELECT, PaymentRouting } from './routing';
import { AUTH_FAILED_OPEN_UNTIL, CHARGE_CURRENCIES, MAX_LIMIT_MINOR, type RuleRow, defaultRules, ruleInsideManifest } from './routing-rules';

type Tx = Prisma.TransactionClient;
type RuleDb = Prisma.RoutingRuleGetPayload<{ select: typeof RULE_SELECT & { version: true } }>;

const LIST_SELECT = { ...RULE_SELECT, version: true, providerAccount: { select: { displayName: true, status: true, adapterKey: true } } } as const;
const MAX_BOOKINGS_IN_WARNING = 50;

/**
 * The default rules of a new account (plan 4.2, sections 6 and 15.7), inserted in the transaction that creates it, with
 * its createdAt so ties keep the account order of task 3.1. Every method but bnpl; no limits; priority 100.
 */
export async function insertDefaultRules(tx: Tx, accountId: string, manifest: AdapterManifest, createdAt: Date, only?: ReadonlySet<string>): Promise<number> {
  const rows = defaultRules(manifest).filter((r) => !only || only.has(`${r.method}|${r.currency}`));
  if (rows.length === 0) return 0;
  await tx.routingRule.createMany({ data: rows.map((r) => ({ providerAccountId: accountId, method: r.method, countries: [...r.countries], anyCountry: r.anyCountry, currency: r.currency, priority: r.priority, createdAt })) });
  return rows.length;
}

/** An integer string of minor units in [0, 10^12], null, or an error code (plan 4.2, section 8). Never a float. */
function parseMinor(v: string | null | undefined): bigint | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (!/^\d{1,13}$/.test(v)) return 'invalid';
  const n = BigInt(v);
  return n > MAX_LIMIT_MINOR ? 'invalid' : n;
}

interface RuleDraft {
  method: PaymentMethod;
  countries: string[];
  anyCountry: boolean;
  currency: string;
  minAmountMinor: bigint | null;
  maxAmountMinor: bigint | null;
  priority: number;
  enabled: boolean;
  fallbackForRuleId: string | null;
}

/**
 * Routing rules in the panel (task 4.2, plan section 8). Every change runs inside the coverage guard of task 4.1 (one
 * advisory lock with account status and manual-method changes); a change that leaves customers without a way to pay
 * needs `confirmCoverageLoss`. Rules only choose accounts: nothing here reads, computes or changes an amount to charge.
 */
@Injectable()
export class RoutingRulesAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentRouting) private readonly routing: PaymentRouting,
    @Inject(CollectionCoverageGuard) private readonly coverage: CollectionCoverageGuard,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(): Promise<{ items: RoutingRuleView[] }> {
    const rows = await this.prisma.routingRule.findMany({ select: LIST_SELECT, orderBy: [{ method: 'asc' }, { currency: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }, { providerAccountId: 'asc' }, { id: 'asc' }] });
    return {
      items: rows.map((r) => {
        const m = this.gateway.registry.get(r.providerAccount.adapterKey)?.manifest;
        return {
          id: r.id, providerAccountId: r.providerAccountId, accountName: r.providerAccount.displayName, accountStatus: r.providerAccount.status, adapterKey: r.providerAccount.adapterKey,
          adapterStatus: m?.status ?? 'unknown', method: r.method as PaymentMethod, countries: r.anyCountry ? null : [...r.countries], currency: r.currency,
          minAmountMinor: r.minAmountMinor?.toString() ?? null, maxAmountMinor: r.maxAmountMinor?.toString() ?? null, priority: r.priority, enabled: r.enabled,
          fallbackForRuleId: r.fallbackForRuleId, matchesAdapter: !!m && ruleInsideManifest(r, m), version: r.version, createdAt: r.createdAt.toISOString(),
        };
      }),
    };
  }

  async create(input: CreateRoutingRule, actor: AuditActor) {
    return runTransaction(this.prisma, async (tx) => {
      await this.coverage.lock(tx);
      const account = await this.accountFor(tx, input.providerAccountId);
      const draft = await this.validate(tx, input, account.manifest, input.providerAccountId, null);
      let id = '';
      const lost = await this.coverage.guard(tx, input.confirmCoverageLoss === true, async () => {
        id = (await tx.routingRule.create({ data: { providerAccountId: input.providerAccountId, ...draft, createdById: actor.id ?? null, updatedById: actor.id ?? null }, select: { id: true } })).id;
      });
      await this.audit.record(tx, { actor, action: 'payments.routingRule.created', entityType: 'RoutingRule', entityId: id, model: 'RoutingRule', after: auditView({ providerAccountId: input.providerAccountId, ...draft }), context: { lostCount: lost.length } });
      return { id, version: 0, lost };
    });
  }

  async update(id: string, input: UpdateRoutingRule, actor: AuditActor) {
    return runTransaction(this.prisma, async (tx) => {
      await this.coverage.lock(tx);
      const row = await this.lockRule(tx, id, input.version);
      const account = await this.accountFor(tx, row.providerAccountId, { allowInactive: true });
      const merged = {
        method: input.method ?? row.method, countries: input.countries !== undefined ? input.countries : row.anyCountry ? null : row.countries,
        currency: input.currency ?? row.currency,
        minAmountMinor: input.minAmountMinor !== undefined ? input.minAmountMinor : row.minAmountMinor?.toString() ?? null,
        maxAmountMinor: input.maxAmountMinor !== undefined ? input.maxAmountMinor : row.maxAmountMinor?.toString() ?? null,
        priority: input.priority ?? row.priority, enabled: input.enabled ?? row.enabled,
        fallbackForRuleId: input.fallbackForRuleId !== undefined ? input.fallbackForRuleId : row.fallbackForRuleId,
      };
      const draft = await this.validate(tx, merged as CreateRoutingRule, account.manifest, row.providerAccountId, id);
      const lost = await this.coverage.guard(tx, input.confirmCoverageLoss === true, async () => {
        await tx.routingRule.update({ where: { id }, data: { ...draft, version: { increment: 1 }, updatedById: actor.id ?? null } });
      });
      // A disabled primary is served by its backups (plan 15, Q2): say which.
      const backups = !draft.enabled && row.enabled ? (await tx.routingRule.findMany({ where: { fallbackForRuleId: id, enabled: true }, select: { id: true } })).map((b) => b.id) : [];
      await this.audit.record(tx, {
        actor, action: 'payments.routingRule.updated', entityType: 'RoutingRule', entityId: id, model: 'RoutingRule',
        before: auditView(row), after: auditView({ providerAccountId: row.providerAccountId, ...draft }), context: { lostCount: lost.length, ...(backups.length ? { backupsServing: backups.join(',') } : {}) },
      });
      return { id, version: row.version + 1, lost, backupsServing: backups };
    });
  }

  async remove(id: string, input: { version: number; confirmCoverageLoss?: boolean }, actor: AuditActor) {
    return runTransaction(this.prisma, async (tx) => {
      await this.coverage.lock(tx);
      const row = await this.lockRule(tx, id, input.version);
      if ((await tx.routingRule.count({ where: { fallbackForRuleId: id } })) > 0) throw conflict('rule_has_fallbacks', 'Other rules back this one up. Remove or change them first.');
      const lost = await this.coverage.guard(tx, input.confirmCoverageLoss === true, async () => {
        await tx.routingRule.delete({ where: { id } });
      });
      await this.audit.record(tx, { actor, action: 'payments.routingRule.deleted', entityType: 'RoutingRule', entityId: id, model: 'RoutingRule', before: auditView(row), context: { lostCount: lost.length } });
      return { id, lost };
    });
  }

  /** Adds the default rules the account is missing (plan 6); never changes or removes a rule. */
  async restoreDefaults(accountId: string, actor: AuditActor) {
    return runTransaction(this.prisma, async (tx) => {
      await this.coverage.lock(tx);
      const account = await this.accountFor(tx, accountId);
      const have = await tx.routingRule.findMany({ where: { providerAccountId: accountId, fallbackForRuleId: null }, select: { method: true, currency: true } });
      const haveKeys = new Set(have.map((h) => `${h.method}|${h.currency}`));
      const missing = new Set(defaultRules(account.manifest).map((r) => `${r.method}|${r.currency}`).filter((k) => !haveKeys.has(k)));
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now` as [{ now: Date }];
      const added = await insertDefaultRules(tx, accountId, account.manifest, now, missing);
      await this.audit.record(tx, { actor, action: 'payments.routingRule.defaultsRestored', entityType: 'ProviderAccount', entityId: accountId, context: { added } });
      return { added };
    });
  }

  async preview(q: { method: PaymentMethod; country: string; currency: string; amountMinor?: string }) {
    const amountMinor = q.amountMinor === undefined ? null : BigInt(q.amountMinor);
    const r = await this.prisma.$transaction((tx) => this.routing.preview(tx, { method: q.method, country: q.country, currency: q.currency, amountMinor }));
    return { route: r.route.map((c) => ({ accountId: c.accountId, ruleId: c.ruleId, backupFor: c.backupFor, halfOpen: c.halfOpen })), reasons: r.reasons };
  }

  /** Routing warnings for the panel (plan 5, 8 and 15.4, 15.5): codes and ids only. */
  async warnings(): Promise<{ items: RoutingWarning[] }> {
    const out: RoutingWarning[] = [];
    const countries = await this.coverage.salesCountries();
    // The database clock, as routing and the health writes use (review B2): never this instance's clock.
    const [{ now }] = await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now` as [{ now: Date }];
    const health = await this.prisma.providerAccountHealth.findMany({ where: { openUntil: { not: null } }, select: { providerAccountId: true, openUntil: true, lastFailureCode: true } });
    for (const h of health) {
      if (h.openUntil!.getTime() >= AUTH_FAILED_OPEN_UNTIL.getTime()) out.push({ code: 'account_auth_failed', accountId: h.providerAccountId });
      else if (h.openUntil!.getTime() > now.getTime()) out.push({ code: 'account_unreachable', accountId: h.providerAccountId, until: h.openUntil!.toISOString() });
      if (h.openUntil!.getTime() > now.getTime()) {
        const live = await this.prisma.payment.findMany({ where: { providerAccountId: h.providerAccountId, liveBookingId: { not: null } }, select: { bookingId: true }, orderBy: { createdAt: 'asc' }, take: MAX_BOOKINGS_IN_WARNING });
        if (live.length > 0) out.push({ code: 'live_attempts_on_unreachable_account', accountId: h.providerAccountId, bookingIds: live.map((l) => l.bookingId) });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      for (const u of await this.routing.unreachableNow(tx, { countries, currency: COVERAGE_CURRENCY })) out.push({ code: 'method_unreachable_now', ...u });
      for (const g of await this.routing.amountGaps(tx, { countries, currency: COVERAGE_CURRENCY })) {
        out.push({ code: 'method_limited_by_amount', method: g.method, country: g.country, gaps: g.gaps.map((x) => ({ fromMinor: x.fromMinor.toString(), toMinor: x.toMinor.toString() })) });
      }
    });
    const active = await this.prisma.providerAccount.findMany({ where: { status: 'active' }, select: { id: true, adapterKey: true, _count: { select: { routingRules: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    for (const a of active) if (a._count.routingRules === 0) out.push({ code: 'active_account_without_rules', accountId: a.id });
    const rules = (await this.list()).items;
    for (const r of rules) if (!r.matchesAdapter) out.push({ code: 'rule_outside_adapter_capabilities', ruleId: r.id });
    for (const r of rules) {
      if (r.enabled || r.fallbackForRuleId !== null) continue;
      const backups = rules.filter((b) => b.fallbackForRuleId === r.id && b.enabled).map((b) => b.id);
      if (backups.length > 0) out.push({ code: 'fallback_target_disabled', ruleId: r.id, backupRuleIds: backups });
    }
    return { items: out };
  }

  private async accountFor(tx: Tx, id: string, opts: { allowInactive?: boolean } = {}): Promise<{ manifest: AdapterManifest }> {
    const a = await tx.providerAccount.findUnique({ where: { id }, select: { id: true, status: true, adapterKey: true } });
    if (!a) throw notFound('provider_account_not_found', 'Payment account not found');
    const manifest = this.gateway.registry.get(a.adapterKey)?.manifest;
    if (!manifest || manifest.status === 'planned') throw conflict('adapter_unavailable', 'This payment account cannot be used for that here');
    if (!opts.allowInactive && (a.status === 'retired' || a.status === 'archived')) throw conflict('account_not_accepting_charges', 'This payment account takes no new payments');
    return { manifest };
  }

  private async lockRule(tx: Tx, id: string, version: number): Promise<RuleDb> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM payment_routing_rules WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw notFound('routing_rule_not_found', 'Routing rule not found');
    const row = await tx.routingRule.findUniqueOrThrow({ where: { id }, select: { ...RULE_SELECT, version: true } });
    if (row.version !== version) throw conflict('version_conflict', 'Someone else changed this rule. Reload and try again.');
    return row;
  }

  /** The service checks of plan section 8 (the trigger of 0036 is the net behind them). Codes only, never the values. */
  private async validate(tx: Tx, input: CreateRoutingRule, manifest: AdapterManifest, accountId: string, selfId: string | null): Promise<RuleDraft> {
    const bad = (code: string): never => {
      throw unprocessable(code, 'The routing rule is not valid');
    };
    if (!manifest.methods.includes(input.method)) bad('rule_method_not_supported');
    if (!/^[A-Z]{3}$/.test(input.currency) || !CHARGE_CURRENCIES.includes(input.currency) || !manifest.currencies.includes(input.currency)) bad('rule_currency_not_supported');
    let countries: string[] = [];
    if (input.countries !== null) {
      if (input.countries.length === 0 || input.countries.some((c) => !/^[A-Z]{2}$/.test(c)) || new Set(input.countries).size !== input.countries.length) bad('rule_countries_invalid');
      if (manifest.countries !== 'any' && input.countries.some((c) => !(manifest.countries as readonly string[]).includes(c))) bad('rule_country_not_supported');
      countries = [...input.countries].sort();
    } else if (manifest.countries !== 'any') bad('rule_country_not_supported');
    const min = parseMinor(input.minAmountMinor);
    const max = parseMinor(input.maxAmountMinor);
    if (min === 'invalid' || max === 'invalid' || max === 0n) bad('rule_amount_invalid');
    if (typeof min === 'bigint' && typeof max === 'bigint' && min > max) bad('rule_limits_inverted');
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000) bad('rule_priority_invalid');
    const fallback = input.fallbackForRuleId ?? null;
    if (fallback !== null) {
      if (fallback === selfId) bad('fallback_self');
      const target = await tx.routingRule.findUnique({ where: { id: fallback }, select: { method: true, currency: true, providerAccountId: true, fallbackForRuleId: true } });
      if (!target) bad('fallback_target_missing');
      if (target!.fallbackForRuleId !== null) bad('fallback_target_is_fallback');
      if (target!.method !== input.method || target!.currency !== input.currency) bad('fallback_mismatch');
      if (target!.providerAccountId === accountId) bad('fallback_same_account');
    }
    if (selfId !== null) {
      const current = await tx.routingRule.findUniqueOrThrow({ where: { id: selfId }, select: { method: true, currency: true } });
      const hasBackups = (await tx.routingRule.count({ where: { fallbackForRuleId: selfId } })) > 0;
      if (hasBackups && (fallback !== null || current.method !== input.method || current.currency !== input.currency)) bad('rule_is_fallback_target');
    }
    return {
      method: input.method, countries, anyCountry: input.countries === null, currency: input.currency, minAmountMinor: min as bigint | null, maxAmountMinor: max as bigint | null,
      priority: input.priority, enabled: input.enabled, fallbackForRuleId: fallback,
    };
  }
}

function auditView(r: Omit<RuleRow, 'id' | 'createdAt'> | RuleDraft & { providerAccountId: string }) {
  return {
    providerAccountId: r.providerAccountId, method: r.method, countries: r.anyCountry ? 'any' : r.countries.join(','), currency: r.currency,
    minAmountMinor: r.minAmountMinor?.toString() ?? null, maxAmountMinor: r.maxAmountMinor?.toString() ?? null, priority: r.priority, enabled: r.enabled,
    fallbackForRuleId: r.fallbackForRuleId,
  };
}
