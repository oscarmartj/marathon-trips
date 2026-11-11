import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { createPoolSchema, updatePoolSchema } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { AppError } from '../../platform/errors/safe-error';
import { conflict, notFound } from '../../platform/http/api-error';
import { Tx, assertVersion, defined, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };

export interface HoldContext {
  actor: AuditActor;
  bookingId?: string | null;
}

export type StockState = 'available' | 'low' | 'none';

/** Remaining places and the three-way state the public site may show (never the numbers). */
export function stockOf(p: { capacity: number; consumed: number; lowStockThreshold: number | null }): { remaining: number; lowStock: boolean; state: StockState } {
  const remaining = p.capacity - p.consumed;
  const lowStock = p.lowStockThreshold !== null && remaining <= p.lowStockThreshold;
  return { remaining, lowStock, state: remaining <= 0 ? 'none' : lowStock ? 'low' : 'available' };
}

/**
 * Stock pools for dorsales, rooms and extras (plan 5.2). Bookings call hold and release (task 2.4) inside their own
 * transaction, after locking in the order of plan 6.3 (pools by ascending id). A pool never goes below zero or above
 * its capacity: the UPDATE is conditional and the CHECK constraint is the backstop.
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /** Takes `places` from the pool. 409 `inventory_unavailable` when fewer remain; 404 when the pool does not exist. */
  async hold(tx: Tx, poolId: string, places: number, ctx: HoldContext): Promise<void> {
    this.assertPlaces(places);
    const n = await tx.$executeRaw`UPDATE inventory_pools SET consumed = consumed + ${places}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ${poolId}::uuid AND consumed + ${places} <= capacity`;
    if (n !== 1) {
      const exists = await tx.inventoryPool.findUnique({ where: { id: poolId }, select: { id: true } });
      if (!exists) throw notFound('pool_not_found', 'Stock pool not found');
      throw conflict('inventory_unavailable', 'Not enough places left');
    }
    await tx.inventoryMovement.create({ data: { poolId, delta: places, reason: 'hold', bookingId: ctx.bookingId ?? null, actorType: ctx.actor.type, actorId: ctx.actor.id } });
  }

  /** Gives `places` back. Releasing more than is held is a 409: a release is never silently clamped. */
  async release(tx: Tx, poolId: string, places: number, ctx: HoldContext): Promise<void> {
    this.assertPlaces(places);
    const n = await tx.$executeRaw`UPDATE inventory_pools SET consumed = consumed - ${places}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ${poolId}::uuid AND consumed - ${places} >= 0`;
    if (n !== 1) {
      const exists = await tx.inventoryPool.findUnique({ where: { id: poolId }, select: { id: true } });
      if (!exists) throw notFound('pool_not_found', 'Stock pool not found');
      throw conflict('release_exceeds_held', 'More places released than were held');
    }
    await tx.inventoryMovement.create({ data: { poolId, delta: -places, reason: 'release', bookingId: ctx.bookingId ?? null, actorType: ctx.actor.type, actorId: ctx.actor.id } });
    const pool = await tx.inventoryPool.findUniqueOrThrow({ where: { id: poolId }, select: { editionId: true } });
    await this.outbox.publish(tx, {
      type: 'catalogue.inventory.released', aggregateType: 'InventoryPool', aggregateId: poolId, payload: { poolId, editionId: pool.editionId },
      actorType: ctx.actor.type, actorId: ctx.actor.id ?? undefined,
    });
  }

  private assertPlaces(places: number): void {
    if (!Number.isInteger(places) || places < 1 || places > 1000) throw new AppError('inventory_bad_places', 'Places must be a whole number from 1 to 1000');
  }

  // ---- Panel ----

  async listForEdition(editionId: string) {
    const edition = await this.prisma.raceEdition.findFirst({ where: { id: editionId, race: { deletedAt: null } }, select: { id: true } });
    if (!edition) throw notFound('edition_not_found', 'Edition not found');
    const pools = await this.prisma.inventoryPool.findMany({ where: { editionId }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
    return view(pools.map((p) => ({ ...p, ...stockOf(p) })));
  }

  async movements(poolId: string) {
    const pool = await this.prisma.inventoryPool.findUnique({ where: { id: poolId }, select: { id: true } });
    if (!pool) throw notFound('pool_not_found', 'Stock pool not found');
    return view(await this.prisma.inventoryMovement.findMany({ where: { poolId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 }));
  }

  async create(actor: Actor, editionId: string, input: z.infer<typeof createPoolSchema>) {
    return view(
      await this.prisma.$transaction(async (tx) => {
        const edition = await tx.raceEdition.findFirst({ where: { id: editionId, race: { deletedAt: null } }, select: { id: true } });
        if (!edition) throw notFound('edition_not_found', 'Edition not found');
        const pool = await tx.inventoryPool.create({ data: { ...input, editionId } });
        await this.audit.record(tx, { actor, action: 'catalogue.inventory.created', entityType: 'InventoryPool', entityId: pool.id, after: view(pool) });
        return { ...pool, ...stockOf(pool) };
      }),
    );
  }

  /** Capacity below what is already held is refused (plan 7). A capacity change leaves a movement and an audit entry. */
  async update(actor: Actor, id: string, input: z.infer<typeof updatePoolSchema>) {
    const { version, reason, ...rest } = input;
    return view(
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM inventory_pools WHERE id = ${id}::uuid FOR UPDATE`;
        if (rows.length === 0) throw notFound('pool_not_found', 'Stock pool not found');
        const before = await tx.inventoryPool.findUniqueOrThrow({ where: { id } });
        assertVersion(before, version, 'Stock pool not found');
        if (rest.capacity !== undefined && rest.capacity < before.consumed) throw conflict('capacity_below_consumed', 'Capacity cannot be lower than the places already held');
        const res = await tx.inventoryPool.updateMany({ where: { id, version }, data: { ...defined(rest), version: { increment: 1 } } });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.inventoryPool.findUniqueOrThrow({ where: { id } });
        if (after.capacity !== before.capacity) {
          await tx.inventoryMovement.create({ data: { poolId: id, delta: after.capacity - before.capacity, reason: 'capacity_change', actorType: actor.type, actorId: actor.id } });
        }
        await this.audit.record(tx, { actor, action: 'catalogue.inventory.updated', entityType: 'InventoryPool', entityId: id, reason, before: view(before), after: view(after) });
        return { ...after, ...stockOf(after) };
      }),
    );
  }
}
