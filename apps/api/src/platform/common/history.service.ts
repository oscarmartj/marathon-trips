import { Inject, Injectable } from '@nestjs/common';
import { PERMISSIONS } from '../access/permissions';
import { PrismaService } from '../database/prisma.service';
import { notFound } from '../http/api-error';
import { type Caller, TableAccessService } from './table-access.service';
import { type TableDef, delegateOf } from './table-def';

export interface HistoryField {
  field: string;
  before?: unknown;
  after?: unknown;
  /** The field changed but its values are not shown to this caller. */
  hidden?: boolean;
}

/** History of a record (plan 4.4): a query on AuditLog. Personal values only when the table says readers may see them. */
@Injectable()
export class HistoryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TableAccessService) private readonly access: TableAccessService,
  ) {}

  async list(caller: Caller, def: TableDef, entityId: string) {
    await this.access.require(caller, def, 'read');
    await this.access.assertKey(caller, PERMISSIONS.auditRead);
    if (!(await delegateOf(this.prisma, def).findUnique({ where: { id: entityId } }))) throw notFound('record_not_found', 'Record not found');
    const showPii = def.historyShowsPii === true;
    const logs = await this.prisma.auditLog.findMany({
      where: { entityType: def.entityType, entityId },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      include: { piiValues: showPii },
    });
    return logs.map((l) => {
      const changes = (l.changes ?? {}) as Record<string, unknown>;
      const pii = new Map((l.piiValues ?? []).map((p) => [p.field, p]));
      const fields: HistoryField[] = [];
      let reason: string | null = null;
      for (const [field, value] of Object.entries(changes)) {
        if (field === '_context') continue;
        if (field === '_reason') {
          const r = pii.get('_reason');
          reason = r && typeof r.after === 'string' ? r.after : null;
          continue;
        }
        if (value && typeof value === 'object' && 'before' in value) fields.push({ field, before: (value as { before: unknown }).before, after: (value as unknown as { after: unknown }).after });
        else if (value === '[pii]' && pii.has(field)) fields.push({ field, before: pii.get(field)!.before, after: pii.get(field)!.after });
        else fields.push({ field, hidden: true });
      }
      return { id: l.id, occurredAt: l.occurredAt.toISOString(), actorType: l.actorType, actorId: l.actorId, action: l.action, fields, reason };
    });
  }
}
