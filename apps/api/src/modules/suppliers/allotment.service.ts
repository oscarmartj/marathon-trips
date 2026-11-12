import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { coverageQuerySchema, createAllotmentSchema, releaseAllotmentSchema, releasesQuerySchema, updateAllotmentSchema } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { Tx, assertVersion, defined, fromDate, toDate, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };

const DAY = 86_400_000;
const todayUtc = (): string => new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Sums quantity x unit cost per currency. Currencies are never added together (plan 5.1). */
export function costByCurrency(rows: Array<{ quantity: number; unitCostMinor: bigint; currency: string }>): Array<{ currency: string; amountMinor: string }> {
  const totals = new Map<string, bigint>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0n) + BigInt(r.quantity) * r.unitCostMinor);
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amountMinor: amount.toString() }));
}

/**
 * Contracted allotments (plan 5.7). An allotment records what the supplier holds for us; it never writes to the stock
 * pool it covers. The panel compares the two (coverage) so staff change the pool's capacity in the catalogue.
 */
@Injectable()
export class AllotmentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async listForSupplier(supplierId: string) {
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, deletedAt: null }, select: { id: true } });
    if (!supplier) throw notFound('supplier_not_found', 'Supplier not found');
    const rows = await this.prisma.allotment.findMany({
      where: { contract: { supplierId, deletedAt: null } },
      orderBy: [{ releaseDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      include: { contract: { select: { reference: true, editionId: true } }, pool: { select: { label: true, kind: true, capacity: true, consumed: true, editionId: true } } },
    });
    return view({ items: rows, committedCost: costByCurrency(rows.filter((r) => r.status === 'held')) });
  }

  async create(actor: Actor, contractId: string, input: z.infer<typeof createAllotmentSchema>) {
    const { reason, unitCostMinor, releaseDate, ...rest } = input;
    return view(
      await this.prisma.$transaction(async (tx) => {
        const contract = await this.liveContract(tx, contractId);
        const pool = await this.checkedPool(tx, rest.poolId, contract.editionId, releaseDate);
        const row = await tx.allotment.create({
          data: { ...rest, contractId, kind: pool.kind as 'room' | 'entry', unitCostMinor: BigInt(unitCostMinor), releaseDate: releaseDate ? toDate(releaseDate) : null },
        });
        await this.audit.record(tx, { actor, action: 'suppliers.allotment.created', entityType: 'Allotment', entityId: row.id, reason, after: view(row) });
        return row;
      }),
    );
  }

  async update(actor: Actor, id: string, input: z.infer<typeof updateAllotmentSchema>) {
    const { version, reason, unitCostMinor, releaseDate, ...rest } = input;
    return view(
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.allotment.findFirst({ where: { id, contract: { deletedAt: null } }, include: { contract: { select: { editionId: true } } } });
        assertVersion(before, version, 'Allotment not found');
        if (before.status !== 'held') throw conflict('allotment_released', 'A released allotment cannot be changed');
        if (releaseDate !== undefined) await this.checkedPool(tx, before.poolId, before.contract.editionId, releaseDate);
        const res = await tx.allotment.updateMany({
          where: { id, version, status: 'held' },
          data: {
            ...defined(rest),
            ...(unitCostMinor !== undefined ? { unitCostMinor: BigInt(unitCostMinor) } : {}),
            ...(releaseDate !== undefined ? { releaseDate: releaseDate ? toDate(releaseDate) : null } : {}),
            version: { increment: 1 },
          },
        });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.allotment.findUniqueOrThrow({ where: { id } });
        const { contract: _c, ...beforeRow } = before;
        await this.audit.record(tx, { actor, action: 'suppliers.allotment.updated', entityType: 'Allotment', entityId: id, reason, before: view(beforeRow), after: view(after) });
        return after;
      }),
    );
  }

  /** held to released, once. A compare-and-set, so two people clicking at once produce one release and one event. */
  async release(actor: Actor, id: string, input: z.infer<typeof releaseAllotmentSchema>) {
    return view(
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.allotment.findFirst({ where: { id, contract: { deletedAt: null } } });
        if (!before) throw notFound('allotment_not_found', 'Allotment not found');
        if (before.status === 'released') throw conflict('allotment_released', 'This allotment is already released');
        const res = await tx.allotment.updateMany({ where: { id, version: input.version, status: 'held' }, data: { status: 'released', releasedAt: new Date(), version: { increment: 1 } } });
        if (res.count !== 1) {
          const now = await tx.allotment.findUniqueOrThrow({ where: { id }, select: { status: true } });
          throw now.status === 'released' ? conflict('allotment_released', 'This allotment is already released') : versionConflict();
        }
        const after = await tx.allotment.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'suppliers.allotment.released', entityType: 'Allotment', entityId: id, reason: input.reason, before: { status: 'held' }, after: { status: 'released' } });
        await this.outbox.publish(tx, {
          type: 'suppliers.allotment.released', aggregateType: 'Allotment', aggregateId: id, aggregateVersion: after.version,
          payload: { allotmentId: id, poolId: after.poolId, contractId: after.contractId }, actorType: actor.type, actorId: actor.id,
        });
        return after;
      }),
    );
  }

  async remove(actor: Actor, id: string, reason?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text FROM allotments WHERE id = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw notFound('allotment_not_found', 'Allotment not found');
      if (rows[0]!.status !== 'held') throw conflict('allotment_released', 'A released allotment is kept as history');
      const before = await tx.allotment.findUniqueOrThrow({ where: { id } });
      await tx.allotment.delete({ where: { id } });
      await this.audit.record(tx, { actor, action: 'suppliers.allotment.deleted', entityType: 'Allotment', entityId: id, reason, before: view(before) });
    });
  }

  /** Held allotments whose release date is overdue or within `withinDays` of `asOf` (today by default). */
  async releases(q: z.infer<typeof releasesQuerySchema>) {
    const asOf = q.asOf ?? todayUtc();
    const limit = addDays(asOf, q.withinDays);
    const rows = await this.prisma.allotment.findMany({
      where: { status: 'held', releaseDate: { not: null, lte: toDate(limit) }, contract: { deletedAt: null, supplier: { deletedAt: null } } },
      orderBy: [{ releaseDate: 'asc' }, { id: 'asc' }],
      include: { contract: { select: { reference: true, supplier: { select: { id: true, name: true } } } }, pool: { select: { label: true, capacity: true, consumed: true, editionId: true } } },
    });
    return view({
      asOf,
      items: rows.map((r) => ({ ...r, overdue: fromDate(r.releaseDate)! < asOf, placesLeftToSell: Math.max(0, r.pool.capacity - r.pool.consumed) })),
    });
  }

  /** Per entry or room pool of an edition: what we can sell against what suppliers hold for us. */
  async coverage(q: z.infer<typeof coverageQuerySchema>) {
    const edition = await this.prisma.raceEdition.findFirst({ where: { id: q.editionId, race: { deletedAt: null } }, select: { id: true } });
    if (!edition) throw notFound('edition_not_found', 'Edition not found');
    const pools = await this.prisma.inventoryPool.findMany({ where: { editionId: q.editionId, kind: { in: ['entry', 'room'] } }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
    const held = await this.prisma.allotment.findMany({ where: { poolId: { in: pools.map((p) => p.id) }, status: 'held', contract: { deletedAt: null } }, select: { poolId: true, quantity: true, unitCostMinor: true, currency: true } });
    return view({
      items: pools.map((p) => {
        const mine = held.filter((h) => h.poolId === p.id);
        const contracted = mine.reduce((n, h) => n + h.quantity, 0);
        return { poolId: p.id, kind: p.kind, label: p.label, capacity: p.capacity, consumed: p.consumed, contracted, uncovered: Math.max(0, p.capacity - contracted), committedCost: costByCurrency(mine) };
      }),
    });
  }

  // ---- helpers ----

  private async liveContract(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT c.id FROM supplier_contracts c JOIN suppliers s ON s.id = c."supplierId" WHERE c.id = ${id}::uuid AND c."deletedAt" IS NULL AND s."deletedAt" IS NULL FOR SHARE OF c`;
    if (rows.length === 0) throw notFound('contract_not_found', 'Contract not found');
    return tx.supplierContract.findUniqueOrThrow({ where: { id }, select: { id: true, editionId: true } });
  }

  private async checkedPool(tx: Tx, poolId: string, contractEditionId: string | null, releaseDate: string | null) {
    const pool = await tx.inventoryPool.findUnique({ where: { id: poolId }, include: { edition: { select: { startDate: true } } } });
    if (!pool) throw notFound('pool_not_found', 'Stock pool not found');
    if (pool.kind === 'extra') throw unprocessable('pool_kind_not_allowed', 'Only entry and room pools can be contracted');
    if (contractEditionId && pool.editionId !== contractEditionId) throw unprocessable('pool_edition_mismatch', 'The stock pool is for another edition than the contract');
    const start = fromDate(pool.edition.startDate);
    if (releaseDate && start && releaseDate > start) throw unprocessable('release_after_event', 'The release date is after the race');
    return pool;
  }
}
