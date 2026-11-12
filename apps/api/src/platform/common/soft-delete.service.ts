import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { OutboxService } from '../events/outbox.service';
import { conflict, notFound } from '../http/api-error';
import { SearchIndexService } from './search.service';
import { type Actor, type TableDef, delegateOf, snake } from './table-def';

/** Soft delete and restore for any table with deletedAt and deletedById (plan 1.3). Never removes a row. */
@Injectable()
export class SoftDeleteService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(SearchIndexService) private readonly search: SearchIndexService,
  ) {}

  /** In the caller's transaction, so a bulk element can use it. */
  async setDeleted(tx: Prisma.TransactionClient, def: TableDef, actor: Actor, id: string, deleted: boolean, reason?: string): Promise<void> {
    const d = delegateOf(tx, def);
    const row = await d.findUnique({ where: { id } });
    if (!row) throw notFound('record_not_found', 'Record not found');
    if (Boolean(row.deletedAt) === deleted) throw conflict(deleted ? 'already_deleted' : 'not_deleted', deleted ? 'This record is already deleted' : 'This record is not deleted');
    const now = new Date();
    const updated = await d.update({
      where: { id },
      data: { deletedAt: deleted ? now : null, deletedById: deleted ? actor.id : null, ...(def.versioned ? { version: { increment: 1 } } : {}) },
    });
    const verb = deleted ? 'deleted' : 'restored';
    await this.audit.record(tx, {
      actor, action: `common.${snake(def.entityType)}.${verb}`, entityType: def.entityType, entityId: id, model: def.model, reason,
      before: { deletedAt: row.deletedAt ?? null }, after: { deletedAt: updated.deletedAt ?? null },
    });
    await this.outbox.publish(tx, {
      type: `common.${snake(def.entityType)}.${verb}`, aggregateType: def.entityType, aggregateId: id, actorType: actor.type, actorId: actor.id,
      payload: { entityType: def.entityType, entityId: id },
    });
    await this.search.sync(tx, def, updated);
  }

  run(def: TableDef, actor: Actor, id: string, deleted: boolean, reason?: string): Promise<void> {
    return this.prisma.$transaction((tx) => this.setDeleted(tx, def, actor, id, deleted, reason));
  }
}
