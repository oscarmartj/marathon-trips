import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { safeError } from '../errors/safe-error';
import { notFound, unprocessable } from '../http/api-error';
import { type Caller, TableAccessService } from './table-access.service';
import { SoftDeleteService } from './soft-delete.service';
import { type BulkAction, type TableDef, delegateOf } from './table-def';

export interface BulkResult {
  id: string;
  ok: boolean;
  code: string;
}

/**
 * Bulk actions (plan 0.5). Each element runs the same function as the single-record action, in its own transaction,
 * after its own permission check; one denied or failed element never undoes or blocks the others.
 */
@Injectable()
export class BulkService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TableAccessService) private readonly access: TableAccessService,
    @Inject(SoftDeleteService) private readonly softDelete: SoftDeleteService,
  ) {}

  private element(caller: Caller, def: TableDef, action: BulkAction, id: string, reason?: string): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const row = await delegateOf(tx, def).findUnique({ where: { id } });
      if (!row) throw notFound('record_not_found', 'Record not found');
      const need = action.permissionFor(row);
      for (const key of typeof need === 'string' ? [need] : need) await this.access.assertKey(caller, key);
      await action.run(tx, caller.actor, row, reason);
    });
  }

  /** Delete or restore one record: the table's own action when it has one (row-level permission), else the plain one. */
  async deleteOrRestore(caller: Caller, def: TableDef, deleted: boolean, id: string, reason?: string): Promise<void> {
    await this.access.require(caller, def, 'read');
    const action = def.bulkActions?.find((a) => a.key === (deleted ? 'delete' : 'restore'));
    if (action) return this.element(caller, def, action, id, reason);
    await this.access.require(caller, def, 'delete');
    await this.softDelete.run(def, caller.actor, id, deleted, reason);
  }

  async run(caller: Caller, def: TableDef, input: { action: string; ids: string[]; reason?: string }) {
    await this.access.require(caller, def, 'read');
    const action = def.bulkActions?.find((a) => a.key === input.action);
    if (!action) throw unprocessable('unknown_action', 'That action is not available on this table');
    const results: BulkResult[] = [];
    for (const id of [...new Set(input.ids)]) {
      try {
        await this.element(caller, def, action, id, input.reason);
        results.push({ id, ok: true, code: 'ok' });
      } catch (e) {
        const code = safeError(e).code;
        results.push({ id, ok: false, code });
      }
    }
    const ok = results.filter((r) => r.ok).length;
    const status = ok === results.length ? 'completed' : ok === 0 ? 'failed' : 'partial';
    const op = await this.prisma.$transaction(async (tx) => {
      const created = await tx.bulkOperation.create({
        data: { entityType: def.entityType, action: input.action, entityIds: results.map((r) => r.id), status, results: results as unknown as Prisma.InputJsonValue, createdById: caller.actor.id },
      });
      await this.audit.record(tx, {
        actor: caller.actor, action: 'common.bulk.run', entityType: 'BulkOperation', entityId: created.id, reason: input.reason,
        context: { table: def.entityType, action: input.action, ok, failed: results.length - ok },
      });
      return created;
    });
    return { id: op.id, status, results };
  }
}
