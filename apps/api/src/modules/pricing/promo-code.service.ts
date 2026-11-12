import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { archiveSchema, createPromoCodeSchema, updatePromoCodeSchema } from '@mt/shared';
import type { Prisma, PromoCode } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { PackagePricingReader } from '../catalogue';
import { assertScope, assertValidAdjustment, defined, effectData, isRedeemedCheckViolation, isUniqueViolation, storedEffectInput } from './adjustments';
import { toJson } from './rates';

type Actor = AuditActor & { id: string };
type Tx = Prisma.TransactionClient;

const versionConflict = () => conflict('version_conflict', 'Someone else changed this. Reload and try again.');
const belowRedeemed = () => conflict('max_below_redeemed', 'The limit cannot go below the redemptions already made');

/**
 * Promo codes (plan 2.2, section 4): the effect of a rule, always a discount, with limits. Every change needs a recent
 * TOTP check, is validated by the engine and audited; the text and the scope of a code never change and a code is never
 * reused. Redemptions move `redeemedCount`; the panel never writes it.
 */
@Injectable()
export class PromoCodeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PackagePricingReader) private readonly catalogue: PackagePricingReader,
  ) {}

  async list(filter: { packageId?: string; editionId?: string; includeArchived?: boolean }) {
    const rows = await this.prisma.promoCode.findMany({
      where: {
        ...(filter.packageId ? { packageId: filter.packageId } : {}),
        ...(filter.editionId ? { editionId: filter.editionId } : {}),
        ...(filter.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500,
    });
    return { items: toJson(rows) };
  }

  async get(id: string) {
    const row = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!row) throw notFound('promo_code_not_found', 'Promo code not found');
    return toJson(row);
  }

  async create(actor: Actor, input: z.infer<typeof createPromoCodeSchema>) {
    assertValidAdjustment({ ...input, kind: 'custom', direction: 'discount' }, 'promo');
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        await assertScope(tx, this.catalogue, input);
        const row = await tx.promoCode.create({
          data: {
            code: input.code, label: input.label, scopeType: input.scopeType, editionId: input.editionId, packageId: input.packageId,
            stackable: input.stackable, enabled: input.enabled, maxRedemptions: input.maxRedemptions, maxPerCustomer: input.maxPerCustomer,
            ...effectData({ ...input, kind: 'custom', direction: 'discount' }),
          },
        });
        await this.audit.record(tx, { actor, action: 'pricing.promo_code.created', entityType: 'PromoCode', entityId: row.id, reason: input.reason, after: toJson(row) as Record<string, unknown> });
        return row.id;
      });
    } catch (err) {
      // Unique among every code ever created, archived ones included: a code is never reused.
      if (isUniqueViolation(err)) throw conflict('promo_code_taken', 'This code exists already');
      throw err;
    }
    return this.get(id);
  }

  private async locked(tx: Tx, id: string, version: number): Promise<PromoCode> {
    await tx.$queryRaw`SELECT id FROM promo_codes WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.promoCode.findUnique({ where: { id } });
    if (!row) throw notFound('promo_code_not_found', 'Promo code not found');
    if (row.archivedAt !== null) throw conflict('promo_code_archived', 'An archived code cannot change');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  /** A partial update (code review G1): what is left out keeps its value; the merged code is validated as a whole. */
  async update(actor: Actor, id: string, input: z.infer<typeof updatePromoCodeSchema>) {
    const { version, reason, ...changes } = input;
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await this.locked(tx, id, version);
        const merged = {
          label: before.label, stackable: before.stackable, enabled: before.enabled, maxRedemptions: before.maxRedemptions, maxPerCustomer: before.maxPerCustomer,
          ...storedEffectInput(before), ...defined(changes),
        };
        assertValidAdjustment({ ...merged, kind: 'custom', direction: 'discount' }, 'promo');
        // The row is locked, so redemptions wait; the CHECK is the safety net (plan 2.2, section 15, point 9).
        if (merged.maxRedemptions !== null && merged.maxRedemptions < before.redeemedCount) throw belowRedeemed();
        await assertScope(tx, this.catalogue, { ...before, currency: merged.currency });
        const res = await tx.promoCode.updateMany({
          where: { id, version, archivedAt: null },
          data: {
            label: merged.label, stackable: merged.stackable, enabled: merged.enabled, maxRedemptions: merged.maxRedemptions, maxPerCustomer: merged.maxPerCustomer,
            ...effectData({ ...merged, kind: 'custom', direction: 'discount' }), version: { increment: 1 },
          },
        });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.promoCode.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'pricing.promo_code.updated', entityType: 'PromoCode', entityId: id, reason, before: toJson(before) as Record<string, unknown>, after: toJson(after) as Record<string, unknown> });
      });
    } catch (err) {
      if (isRedeemedCheckViolation(err)) throw belowRedeemed();
      throw err;
    }
    return this.get(id);
  }

  async archive(actor: Actor, id: string, input: z.infer<typeof archiveSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.locked(tx, id, input.version);
      const at = new Date();
      const res = await tx.promoCode.updateMany({ where: { id, version: input.version, archivedAt: null }, data: { archivedAt: at, enabled: false, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      await this.audit.record(tx, {
        actor, action: 'pricing.promo_code.archived', entityType: 'PromoCode', entityId: id, reason: input.reason,
        before: { archivedAt: null, enabled: before.enabled }, after: { archivedAt: at.toISOString(), enabled: false },
      });
    });
    return this.get(id);
  }
}
