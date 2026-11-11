import { MAX_EXPORT_ROWS, type TableQuery } from '@mt/shared';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { notFound, unprocessable } from '../http/api-error';
import { buildWhere, sortToOrderBy, validateQuery } from './query';
import { TagsService, type TagView } from './tags.service';
import { type Caller, TableAccessService } from './table-access.service';
import { type Row, type TableDef, delegateOf } from './table-def';

const jsonValue = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v ?? null);

/** A row as the panel receives it: whitelisted columns only, dates as ISO text, plus tags. */
export function serializeRow(def: TableDef, row: Row, tags?: TagView[]) {
  const out: Record<string, unknown> = { id: row.id };
  for (const c of def.columns) out[c.key] = jsonValue(row[c.key]);
  if (def.versioned) out.version = row.version;
  if (def.softDelete) out.deletedAt = jsonValue(row.deletedAt);
  if (def.taggable) out.tags = tags ?? [];
  return out;
}

@Injectable()
export class TablesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TableAccessService) private readonly access: TableAccessService,
    @Inject(TagsService) private readonly tags: TagsService,
  ) {}

  async meta(caller: Caller, def: TableDef) {
    await this.access.require(caller, def, 'read');
    const can = (cap: Parameters<TableAccessService['has']>[2]) => this.access.has(caller, def, cap);
    const [write, del, exp, imp, annotate] = await Promise.all([can('write'), def.permissions.delete ? can('delete') : false, def.permissions.export ? can('export') : false, def.permissions.import && def.import ? can('import') : false, can('annotate')]);
    return {
      entityType: def.entityType,
      columns: def.columns.map((c) => ({ key: c.key, type: c.type, sortable: !!c.sortable, filterable: !!c.filterable, searchable: !!c.searchable, exportable: !!c.exportable, values: c.values ?? null })),
      softDelete: def.softDelete, taggable: def.taggable, notes: def.notes,
      bulkActions: (def.bulkActions ?? []).map((a) => a.key),
      importColumns: def.import ? [...def.import.columns] : [],
      can: { write, delete: del, export: exp, import: imp, annotate },
    };
  }

  private async where(caller: Caller, def: TableDef, query: TableQuery) {
    await this.access.require(caller, def, 'read');
    if (query.deleted !== 'exclude') await this.access.require(caller, def, 'delete');
    validateQuery(def, query);
    return buildWhere(def, query, await this.tags.taggedIds(def, query.tagIds, query.tagMode));
  }

  async list(caller: Caller, def: TableDef, query: TableQuery, paging: { page: number; pageSize: number }) {
    const where = await this.where(caller, def, query);
    const d = delegateOf(this.prisma, def);
    const [total, rows] = await Promise.all([
      d.count({ where }),
      d.findMany({ where, orderBy: sortToOrderBy(def, query.sort), skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
    ]);
    const tags = def.taggable ? await this.tags.forRecords(def, rows.map((r) => r.id as string)) : undefined;
    return { total, page: paging.page, pageSize: paging.pageSize, rows: rows.map((r) => serializeRow(def, r, tags?.get(r.id as string))) };
  }

  /** Everything the query matches, for export. Refuses more than MAX_EXPORT_ROWS. */
  async all(caller: Caller, def: TableDef, query: TableQuery): Promise<{ rows: Row[]; tags: Map<string, TagView[]> }> {
    const where = await this.where(caller, def, query);
    const rows = await delegateOf(this.prisma, def).findMany({ where, orderBy: sortToOrderBy(def, query.sort), take: MAX_EXPORT_ROWS + 1 });
    if (rows.length > MAX_EXPORT_ROWS) throw unprocessable('export_too_large', 'Too many records to export at once; narrow the filters');
    return { rows, tags: def.taggable ? await this.tags.forRecords(def, rows.map((r) => r.id as string)) : new Map() };
  }

  async one(caller: Caller, def: TableDef, id: string) {
    await this.access.require(caller, def, 'read');
    const row = await delegateOf(this.prisma, def).findUnique({ where: { id } });
    if (!row) throw notFound('record_not_found', 'Record not found');
    const tags = def.taggable ? await this.tags.forRecords(def, [id]) : undefined;
    return serializeRow(def, row, tags?.get(id));
  }
}
