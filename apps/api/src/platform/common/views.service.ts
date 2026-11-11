import { type TableQuery, tableQueryShape } from '@mt/shared';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { conflict, forbidden, notFound, unprocessable } from '../http/api-error';
import { validateQuery } from './query';
import { COMMON_PERMISSIONS_KEYS } from './permissions';
import { type Caller, TableAccessService } from './table-access.service';
import type { TableDef } from './table-def';

interface ViewInput {
  name: string;
  query: TableQuery;
  columns: string[];
  shared: boolean;
}

/** Saved views: own views plus shared ones. Their content is checked against the table's whitelist on every save. */
@Injectable()
export class ViewsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TableAccessService) private readonly access: TableAccessService,
  ) {}

  private check(def: TableDef, query: TableQuery, columns: readonly string[]): void {
    validateQuery(def, query);
    if (columns.some((c) => !def.columns.some((x) => x.key === c))) throw unprocessable('unknown_field', 'That field is not available on this table');
  }

  private shape(v: { id: string; name: string; filters: unknown; columns: unknown; shared: boolean; ownerId: string; version: number }, me: string) {
    const parsed = tableQueryShape.safeParse(v.filters);
    return {
      id: v.id, name: v.name, shared: v.shared, mine: v.ownerId === me, version: v.version,
      columns: Array.isArray(v.columns) ? (v.columns as string[]) : [],
      query: parsed.success ? parsed.data : null,
    };
  }

  async list(caller: Caller, def: TableDef) {
    await this.access.require(caller, def, 'read');
    const rows = await this.prisma.savedView.findMany({
      where: { entityType: def.entityType, OR: [{ ownerId: caller.actor.id }, { shared: true }] },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.shape(r, caller.actor.id));
  }

  async create(caller: Caller, def: TableDef, input: ViewInput) {
    await this.access.require(caller, def, 'read');
    if (input.shared) await this.access.assertKey(caller, COMMON_PERMISSIONS_KEYS.viewManage);
    this.check(def, input.query, input.columns);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const v = await tx.savedView.create({
          data: { entityType: def.entityType, ownerId: caller.actor.id, name: input.name, filters: input.query as Prisma.InputJsonValue, columns: input.columns, sort: input.query.sort, shared: input.shared },
        });
        await this.audit.record(tx, { actor: caller.actor, action: 'common.savedView.created', entityType: 'SavedView', entityId: v.id, after: { name: v.name, filters: input.query, columns: input.columns, shared: v.shared } });
        return { id: v.id };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('view_name_taken', 'You already have a view with this name');
      throw e;
    }
  }

  private async editable(caller: Caller, def: TableDef, id: string) {
    const v = await this.prisma.savedView.findFirst({ where: { id, entityType: def.entityType, OR: [{ ownerId: caller.actor.id }, { shared: true }] } });
    if (!v) throw notFound('view_not_found', 'View not found');
    if (v.ownerId !== caller.actor.id) {
      if (!(await this.access.hasKey(caller, COMMON_PERMISSIONS_KEYS.viewManage))) throw forbidden('view_not_yours', 'Only the owner can change this view');
    }
    return v;
  }

  async update(caller: Caller, def: TableDef, id: string, input: Partial<ViewInput> & { version: number }) {
    await this.access.require(caller, def, 'read');
    const v = await this.editable(caller, def, id);
    if (input.shared !== undefined && input.shared !== v.shared) await this.access.assertKey(caller, COMMON_PERMISSIONS_KEYS.viewManage);
    const query = input.query ?? tableQueryShape.parse(v.filters);
    const columns = input.columns ?? (v.columns as string[]);
    this.check(def, query, columns);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const data = { name: input.name ?? v.name, filters: query as Prisma.InputJsonValue, columns, sort: query.sort, shared: input.shared ?? v.shared };
        const bumped = await tx.savedView.updateMany({ where: { id, version: input.version }, data: { ...data, version: { increment: 1 } } });
        if (bumped.count !== 1) throw conflict('version_conflict', 'Someone else changed this view. Reload and try again.');
        await this.audit.record(tx, {
          actor: caller.actor, action: 'common.savedView.updated', entityType: 'SavedView', entityId: id,
          before: { name: v.name, filters: v.filters, columns: v.columns, shared: v.shared }, after: { name: data.name, filters: query, columns, shared: data.shared },
        });
        return { version: v.version + 1 };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('view_name_taken', 'You already have a view with this name');
      throw e;
    }
  }

  async remove(caller: Caller, def: TableDef, id: string): Promise<void> {
    await this.access.require(caller, def, 'read');
    const v = await this.editable(caller, def, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.savedView.delete({ where: { id } });
      await this.audit.record(tx, { actor: caller.actor, action: 'common.savedView.deleted', entityType: 'SavedView', entityId: id, before: { name: v.name, filters: v.filters, columns: v.columns, shared: v.shared } });
    });
  }
}
