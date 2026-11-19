// Cancellation policies (task 6.4, plan docs/plans/6.4-cancellation-policies.md, sections 2, 5, 6 and 13). A draft is
// edited freely; activating freezes it (trigger in 0038) and is what bookings are sold under; a package's assignment
// is what new bookings freeze in their snapshot. Every change is audited and uses the row's version as an optimistic lock.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { CancellationPolicyPublicView, CancellationTierView, assignPackageCancellationPolicySchema, createCancellationPolicySchema, setCancellationTiersSchema, updateCancellationPolicySchema } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { canonicalJson, sha256Hex } from '../../platform/crypto/hmac';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { validatePolicy } from './engine';
import type { CancellationPolicyInput, CancellationTierInput } from './engine';
import { toJson } from './rates';

type Actor = AuditActor & { id: string };
type Tx = Prisma.TransactionClient;
type Db = Pick<Tx, '$queryRaw' | 'cancellationPolicy' | 'cancellationTier' | 'packageCancellationPolicy'>;

const versionConflict = () => conflict('version_conflict', 'Someone else changed this. Reload and try again.');
const notDraft = () => conflict('cancellation_policy_not_draft', 'Only a draft cancellation policy can be changed. Duplicate it into a new draft.');

/** A frozen policy as the engine and the snapshot see it, with its digest. */
export interface FrozenCancellationPolicy extends CancellationPolicyInput {
  digest: string;
  description: Record<string, string>;
}

const byDaysDesc = <T extends { minDaysBeforeDeparture: number }>(tiers: readonly T[]): T[] => [...tiers].sort((a, b) => b.minDaysBeforeDeparture - a.minDaysBeforeDeparture);

/**
 * The digest of what the customer agreed to (section 13, M2): the policy id, its currency and its tiers in threshold
 * order. An active policy never changes, so the digest is stable for its whole life.
 */
export function cancellationPolicyDigest(p: { id: string; currency: string | null; tiers: readonly Omit<CancellationTierInput, 'id'>[] }): string {
  return sha256Hex(canonicalJson({
    id: p.id, currency: p.currency,
    tiers: byDaysDesc(p.tiers).map((t) => ({ minDays: t.minDaysBeforeDeparture, mode: t.penaltyMode, bps: t.penaltyBps, minor: t.penaltyMinor === null ? null : t.penaltyMinor.toString(), currency: t.currency })),
  }));
}

export const tierView = (t: Omit<CancellationTierInput, 'id'>): CancellationTierView => ({
  minDaysBeforeDeparture: t.minDaysBeforeDeparture, penaltyMode: t.penaltyMode, penaltyBps: t.penaltyBps,
  penaltyMinor: t.penaltyMinor === null ? null : t.penaltyMinor.toString(), currency: t.currency,
});

export const publicPolicyView = (p: FrozenCancellationPolicy): CancellationPolicyPublicView => ({
  id: p.id, digest: p.digest, description: p.description, tiers: byDaysDesc(p.tiers).map(tierView),
});

/** Reads a policy and its tiers (any status). */
export async function loadCancellationPolicy(db: Db, id: string): Promise<(FrozenCancellationPolicy & { status: string }) | null> {
  const p = await db.cancellationPolicy.findUnique({ where: { id }, select: { id: true, currency: true, status: true, description: true, tiers: { select: { id: true, minDaysBeforeDeparture: true, penaltyMode: true, penaltyBps: true, penaltyMinor: true, currency: true } } } });
  if (!p) return null;
  const tiers = byDaysDesc(p.tiers);
  return { id: p.id, currency: p.currency, status: p.status, description: p.description as Record<string, string>, tiers, digest: cancellationPolicyDigest({ id: p.id, currency: p.currency, tiers }) };
}

@Injectable()
export class CancellationPolicyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.cancellationPolicy.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 500,
      select: { id: true, name: true, status: true, currency: true, version: true, activatedAt: true, archivedAt: true, _count: { select: { packages: true, tiers: true } } },
    });
    return { items: rows.map((r) => ({ ...toJson({ ...r, _count: undefined }) as object, packages: r._count.packages, tiers: r._count.tiers })) };
  }

  async get(id: string) {
    const row = await this.prisma.cancellationPolicy.findUnique({ where: { id }, include: { tiers: true, packages: { select: { packageId: true } } } });
    if (!row) throw notFound('cancellation_policy_not_found', 'Cancellation policy not found');
    const tiers = byDaysDesc(row.tiers);
    const problems = row.status === 'draft' ? validatePolicy(tiers).problems : [];
    return {
      ...(toJson({ ...row, tiers: undefined, packages: undefined }) as object),
      tiers: tiers.map((t) => ({ id: t.id, ...tierView(t) })),
      packageIds: row.packages.map((p) => p.packageId),
      digest: row.status === 'draft' ? null : cancellationPolicyDigest({ id: row.id, currency: row.currency, tiers }),
      problems,
    };
  }

  async create(actor: Actor, input: z.infer<typeof createCancellationPolicySchema>) {
    const id = await runTransaction(this.prisma, async (tx) => {
      const row = await tx.cancellationPolicy.create({ data: { name: input.name, description: input.description } });
      await this.audit.record(tx, { actor, action: 'pricing.cancellation_policy.created', entityType: 'CancellationPolicy', entityId: row.id, after: { name: row.name, status: row.status } });
      return row.id;
    });
    return this.get(id);
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateCancellationPolicySchema>) {
    await runTransaction(this.prisma, async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      await tx.cancellationPolicy.update({ where: { id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'pricing.cancellation_policy.updated', entityType: 'CancellationPolicy', entityId: id, before: { name: before.name }, after: { name: input.name ?? before.name } });
    });
    return this.get(id);
  }

  /** Replaces every tier of a draft (validated on activation; the panel shows the problems as it goes). */
  async setTiers(actor: Actor, id: string, input: z.infer<typeof setCancellationTiersSchema>) {
    await runTransaction(this.prisma, async (tx) => {
      await this.lockDraft(tx, id, input.version);
      const days = new Set(input.tiers.map((t) => t.minDaysBeforeDeparture));
      if (days.size !== input.tiers.length) throw unprocessable('cancellation_tiers_invalid', 'Two tiers start on the same day', { problems: [{ code: 'duplicate_days' }] });
      const tiers = input.tiers.map((t) => ({ ...t, penaltyMinor: t.penaltyMinor === null ? null : BigInt(t.penaltyMinor) }));
      const shape = validatePolicy(tiers).problems.filter((p) => p.code !== 'no_zero_tier' && p.code !== 'no_tiers');
      if (shape.length > 0) throw unprocessable('cancellation_tiers_invalid', 'Some tiers are not valid', { problems: shape });
      await tx.cancellationTier.deleteMany({ where: { policyId: id } });
      if (tiers.length > 0) await tx.cancellationTier.createMany({ data: tiers.map((t) => ({ policyId: id, ...t })) });
      await tx.cancellationPolicy.update({ where: { id }, data: { version: { increment: 1 }, currency: validatePolicy(tiers).currency } });
      await this.audit.record(tx, { actor, action: 'pricing.cancellation_policy.tiers_set', entityType: 'CancellationPolicy', entityId: id, after: { tiers: toJson(tiers) as unknown[] }, fieldClasses: { tiers: 'nopii' } });
    });
    return this.get(id);
  }

  async remove(actor: Actor, id: string, version: number): Promise<void> {
    await runTransaction(this.prisma, async (tx) => {
      await this.lockDraft(tx, id, version);
      await tx.cancellationTier.deleteMany({ where: { policyId: id } });
      await tx.cancellationPolicy.delete({ where: { id } });
      await this.audit.record(tx, { actor, action: 'pricing.cancellation_policy.deleted', entityType: 'CancellationPolicy', entityId: id, before: { status: 'draft' } });
    });
  }

  /** A new draft with the same name, description and tiers: the way to "edit" an active policy. */
  async duplicate(actor: Actor, id: string) {
    const copy = await runTransaction(this.prisma, async (tx) => {
      const src = await tx.cancellationPolicy.findUnique({ where: { id }, include: { tiers: true } });
      if (!src) throw notFound('cancellation_policy_not_found', 'Cancellation policy not found');
      const row = await tx.cancellationPolicy.create({ data: { name: `${src.name} (copy)`.slice(0, 120), description: src.description as Prisma.InputJsonValue, currency: src.currency } });
      if (src.tiers.length > 0) await tx.cancellationTier.createMany({ data: src.tiers.map((t) => ({ policyId: row.id, minDaysBeforeDeparture: t.minDaysBeforeDeparture, penaltyMode: t.penaltyMode, penaltyBps: t.penaltyBps, penaltyMinor: t.penaltyMinor, currency: t.currency })) });
      await this.audit.record(tx, { actor, action: 'pricing.cancellation_policy.created', entityType: 'CancellationPolicy', entityId: row.id, after: { name: row.name, status: 'draft' }, context: { duplicatedFrom: id } });
      return row.id;
    });
    return this.get(copy);
  }

  async activate(actor: Actor, id: string, version: number) {
    await runTransaction(this.prisma, async (tx) => {
      await this.lockDraft(tx, id, version);
      const tiers = await tx.cancellationTier.findMany({ where: { policyId: id } });
      const { problems, currency } = validatePolicy(tiers);
      if (problems.length > 0) throw unprocessable('cancellation_policy_invalid', 'This policy cannot be activated yet', { problems });
      const at = new Date();
      await tx.cancellationPolicy.update({ where: { id }, data: { status: 'active', currency, activatedAt: at, activatedById: actor.id, version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'pricing.cancellation_policy.activated', entityType: 'CancellationPolicy', entityId: id, before: { status: 'draft' }, after: { status: 'active', digest: cancellationPolicyDigest({ id, currency, tiers }) } });
    });
    return this.get(id);
  }

  async archive(actor: Actor, id: string, version: number) {
    await runTransaction(this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string; version: number }>>`SELECT status::text AS status, version FROM cancellation_policies WHERE id = ${id}::uuid FOR UPDATE`;
      const p = rows[0];
      if (!p) throw notFound('cancellation_policy_not_found', 'Cancellation policy not found');
      if (p.version !== version) throw versionConflict();
      if (p.status !== 'active') throw conflict('cancellation_policy_not_active', 'Only an active policy can be archived');
      if ((await tx.packageCancellationPolicy.count({ where: { policyId: id } })) > 0) throw conflict('cancellation_policy_in_use', 'A package still sells under this policy. Give it another one first.');
      await tx.cancellationPolicy.update({ where: { id }, data: { status: 'archived', archivedAt: new Date(), version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'pricing.cancellation_policy.archived', entityType: 'CancellationPolicy', entityId: id, before: { status: 'active' }, after: { status: 'archived' } });
    });
    return this.get(id);
  }

  /** The assignment of a package (section 6): new bookings freeze it; existing bookings keep theirs. */
  async packagePolicy(packageId: string) {
    const a = await this.prisma.packageCancellationPolicy.findUnique({ where: { packageId }, select: { policyId: true, version: true, updatedAt: true } });
    return { packageId, policyId: a?.policyId ?? null, version: a?.version ?? null, updatedAt: a?.updatedAt.toISOString() ?? null };
  }

  async assign(actor: Actor, packageId: string, input: z.infer<typeof assignPackageCancellationPolicySchema>) {
    await runTransaction(this.prisma, async (tx) => {
      const pkg = await tx.$queryRaw<Array<{ currency: string }>>`SELECT currency FROM packages WHERE id = ${packageId}::uuid FOR SHARE`;
      if (!pkg[0]) throw notFound('package_not_found', 'Package not found');
      const current = await tx.$queryRaw<Array<{ policyId: string; version: number }>>`SELECT "policyId"::text AS "policyId", version FROM package_cancellation_policies WHERE "packageId" = ${packageId}::uuid FOR UPDATE`;
      const cur = current[0] ?? null;
      if ((cur?.version ?? null) !== input.version) throw versionConflict();
      if (input.policyId === null) {
        if (cur) await tx.packageCancellationPolicy.delete({ where: { packageId } });
      } else {
        // FOR SHARE (review m5): an archive of the same policy waits for this assignment, or this waits for it.
        const p = await tx.$queryRaw<Array<{ status: string; currency: string | null }>>`SELECT status::text AS status, currency FROM cancellation_policies WHERE id = ${input.policyId}::uuid FOR SHARE`;
        if (!p[0]) throw notFound('cancellation_policy_not_found', 'Cancellation policy not found');
        if (p[0].status !== 'active') throw conflict('cancellation_policy_not_active', 'Only an active policy can be given to a package');
        if (p[0].currency !== null && p[0].currency !== pkg[0].currency) throw conflict('cancellation_policy_currency_mismatch', 'This policy\'s fixed amounts are in another currency than the package');
        if (cur) await tx.packageCancellationPolicy.update({ where: { packageId }, data: { policyId: input.policyId, version: { increment: 1 }, updatedById: actor.id } });
        else await tx.packageCancellationPolicy.create({ data: { packageId, currency: pkg[0].currency, policyId: input.policyId, updatedById: actor.id } });
      }
      await this.audit.record(tx, { actor, action: 'pricing.package_cancellation_policy.set', entityType: 'Package', entityId: packageId, before: { policyId: cur?.policyId ?? null }, after: { policyId: input.policyId } });
    });
    return this.packagePolicy(packageId);
  }

  /** What new bookings of a package are sold under now, read in the caller's transaction. */
  async currentForPackage(db: Db, packageId: string): Promise<FrozenCancellationPolicy | null> {
    const a = await db.packageCancellationPolicy.findUnique({ where: { packageId }, select: { policyId: true } });
    if (!a) return null;
    const p = await loadCancellationPolicy(db, a.policyId);
    return p && p.status === 'active' ? p : null;
  }

  /** The public policy of a package: what a customer is shown before requesting (section 13, M2). */
  async publicForPackage(packageId: string): Promise<{ policy: CancellationPolicyPublicView | null }> {
    const p = await this.currentForPackage(this.prisma, packageId);
    return { policy: p ? publicPolicyView(p) : null };
  }

  /** The policy a snapshot froze (any status: archived ones still bind the bookings sold under them). */
  async frozen(db: Db, policyId: string | null): Promise<FrozenCancellationPolicy | null> {
    if (!policyId) return null;
    return loadCancellationPolicy(db, policyId);
  }

  /** Section 13, M2: the request must carry exactly what the package shows now, null for none. */
  async assertShown(db: Db, packageId: string, shown: { id: string; digest: string } | null): Promise<FrozenCancellationPolicy | null> {
    const current = await this.currentForPackage(db, packageId);
    // FOR SHARE: the policy cannot be archived before the snapshot that freezes it commits.
    if (current) await db.$queryRaw`SELECT id FROM cancellation_policies WHERE id = ${current.id}::uuid FOR SHARE`;
    if ((current?.id ?? null) !== (shown?.id ?? null) || (current && current.digest !== shown!.digest)) {
      throw conflict('cancellation_policy_changed', 'The cancellation policy of this trip has changed since you opened the page. Read it again.');
    }
    return current;
  }

  private async lockDraft(tx: Tx, id: string, version: number): Promise<{ name: string }> {
    const rows = await tx.$queryRaw<Array<{ status: string; version: number; name: string }>>`SELECT status::text AS status, version, name FROM cancellation_policies WHERE id = ${id}::uuid FOR UPDATE`;
    const p = rows[0];
    if (!p) throw notFound('cancellation_policy_not_found', 'Cancellation policy not found');
    if (p.version !== version) throw versionConflict();
    if (p.status !== 'draft') throw notDraft();
    return p;
  }
}
