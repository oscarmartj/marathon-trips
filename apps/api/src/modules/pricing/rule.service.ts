import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { archiveSchema, createPriceRuleSchema, updatePriceRuleSchema } from '@mt/shared';
import type { Prisma, PriceRule } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { PackagePricingReader } from '../catalogue';
import { MAX_RULES_PER_SCOPE, assertScope, assertValidAdjustment, defined, effectData, storedEffectInput } from './adjustments';
import { toJson } from './rates';

type Actor = AuditActor & { id: string };
type Tx = Prisma.TransactionClient;

const versionConflict = () => conflict('version_conflict', 'Someone else changed this. Reload and try again.');

/** The key of the advisory lock that serialises the count of a scope's rules (plan 2.2, section 15, point 8). */
export const scopeLockKey = (table: string, s: { scopeType: string; editionId: string | null; packageId: string | null }) =>
  `${table}:${s.scopeType}:${s.packageId ?? s.editionId ?? 'all'}`;

export async function lockScope(tx: Tx, key: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`;
}

/**
 * Price rules (plan 2.2, section 3). Every change needs a recent TOTP check (the permission says so), is validated by
 * the engine's own checks, audited with before and after, and uses the row's version as an optimistic lock. Rules are
 * archived, never deleted; an archived rule never changes.
 */
@Injectable()
export class PriceRuleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PackagePricingReader) private readonly catalogue: PackagePricingReader,
  ) {}

  async list(filter: { scopeType?: string; packageId?: string; editionId?: string; includeArchived?: boolean }) {
    const rows = await this.prisma.priceRule.findMany({
      where: {
        ...(filter.scopeType ? { scopeType: filter.scopeType as PriceRule['scopeType'] } : {}),
        ...(filter.packageId ? { packageId: filter.packageId } : {}),
        ...(filter.editionId ? { editionId: filter.editionId } : {}),
        ...(filter.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return { items: toJson(rows) };
  }

  async get(id: string) {
    const row = await this.prisma.priceRule.findUnique({ where: { id } });
    if (!row) throw notFound('rule_not_found', 'Rule not found');
    return toJson(row);
  }

  async create(actor: Actor, input: z.infer<typeof createPriceRuleSchema>) {
    assertValidAdjustment(input, 'rule');
    const id = await this.prisma.$transaction(async (tx) => {
      await assertScope(tx, this.catalogue, input);
      await lockScope(tx, scopeLockKey('price_rules', input));
      const count = await tx.priceRule.count({ where: { archivedAt: null, scopeType: input.scopeType, editionId: input.editionId, packageId: input.packageId } });
      if (count >= MAX_RULES_PER_SCOPE) throw conflict('rule_limit_reached', 'This scope already has the most rules allowed. Archive one first.');
      const row = await tx.priceRule.create({
        data: {
          label: input.label, scopeType: input.scopeType, editionId: input.editionId, packageId: input.packageId, kind: input.kind, direction: input.direction,
          priority: input.priority, stackable: input.stackable, enabled: input.enabled, ...effectData(input),
        },
      });
      await this.audit.record(tx, { actor, action: 'pricing.rule.created', entityType: 'PriceRule', entityId: row.id, reason: input.reason, after: toJson(row) as Record<string, unknown> });
      return row.id;
    });
    return this.get(id);
  }

  private async locked(tx: Tx, id: string, version: number): Promise<PriceRule> {
    await tx.$queryRaw`SELECT id FROM price_rules WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.priceRule.findUnique({ where: { id } });
    if (!row) throw notFound('rule_not_found', 'Rule not found');
    if (row.archivedAt !== null) throw conflict('rule_archived', 'An archived rule cannot change');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  /** A partial update (code review G1): what is left out keeps its value; the merged rule is validated as a whole. */
  async update(actor: Actor, id: string, input: z.infer<typeof updatePriceRuleSchema>) {
    const { version, reason, ...changes } = input;
    await this.prisma.$transaction(async (tx) => {
      const before = await this.locked(tx, id, version);
      const merged = {
        label: before.label, kind: before.kind, direction: before.direction, priority: before.priority, stackable: before.stackable, enabled: before.enabled,
        ...storedEffectInput(before), ...defined(changes),
      };
      assertValidAdjustment(merged, 'rule');
      await assertScope(tx, this.catalogue, { ...before, currency: merged.currency });
      const res = await tx.priceRule.updateMany({
        where: { id, version, archivedAt: null },
        data: {
          label: merged.label, kind: merged.kind, direction: merged.direction, priority: merged.priority, stackable: merged.stackable, enabled: merged.enabled,
          ...effectData(merged), version: { increment: 1 },
        },
      });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.priceRule.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action: 'pricing.rule.updated', entityType: 'PriceRule', entityId: id, reason, before: toJson(before) as Record<string, unknown>, after: toJson(after) as Record<string, unknown> });
    });
    return this.get(id);
  }

  async archive(actor: Actor, id: string, input: z.infer<typeof archiveSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.locked(tx, id, input.version);
      const at = new Date();
      const res = await tx.priceRule.updateMany({ where: { id, version: input.version, archivedAt: null }, data: { archivedAt: at, enabled: false, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      await this.audit.record(tx, {
        actor, action: 'pricing.rule.archived', entityType: 'PriceRule', entityId: id, reason: input.reason,
        before: { archivedAt: null, enabled: before.enabled }, after: { archivedAt: at.toISOString(), enabled: false },
      });
    });
    return this.get(id);
  }
}
