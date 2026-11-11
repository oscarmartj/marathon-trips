import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { type Caller, TableAccessService } from './table-access.service';
import { type Row, type TableDef, delegateOf } from './table-def';

export interface SearchHit {
  entityType: string;
  entityId: string;
  title: string;
  subtitle: string | null;
}

/** A prefix query over every word: `mel mar` becomes `mel:* & mar:*`. Only letters and digits survive. */
export function toTsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}]+/gu)?.slice(0, 8);
  return words?.length ? words.map((w) => `${w}:*`).join(' & ') : null;
}

/**
 * The global search index (plan 0.5). A record's document is written in the same transaction as the change, so a
 * delete, a restore or an edit is visible to the next search with no stale window; the database trigger keeps the
 * vector in step with title and subtitle.
 */
@Injectable()
export class SearchIndexService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TableAccessService) private readonly access: TableAccessService,
  ) {}

  /** Writes, replaces or removes the document of a row, following its current state. */
  async sync(tx: Prisma.TransactionClient, def: TableDef, row: Row): Promise<void> {
    const id = row.id as string;
    const doc = row.deletedAt ? null : (def.searchDocument?.(row) ?? null);
    if (!doc) {
      await tx.searchDocument.deleteMany({ where: { entityType: def.entityType, entityId: id } });
      return;
    }
    const data = { title: doc.title.slice(0, 300), subtitle: doc.subtitle?.slice(0, 300) ?? null, permissionKey: def.permissions.read };
    await tx.searchDocument.upsert({
      where: { entityType_entityId: { entityType: def.entityType, entityId: id } },
      create: { entityType: def.entityType, entityId: id, ...data },
      update: data,
    });
  }

  /** Rebuilds every document of one table (repair after a bulk data change). */
  async reindex(def: TableDef): Promise<number> {
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const rows = await delegateOf(this.prisma, def).findMany({ orderBy: { id: 'asc' }, take: 500, ...(after ? { cursor: { id: after }, skip: 1 } : {}) });
      if (rows.length === 0) break;
      await this.prisma.$transaction(async (tx) => {
        for (const r of rows) await this.sync(tx, def, r);
      });
      count += rows.length;
      after = rows[rows.length - 1]!.id as string;
    }
    return count;
  }

  /** Only results whose permission the caller holds are returned. */
  async search(caller: Caller, q: string, limit: number): Promise<SearchHit[]> {
    const query = toTsQuery(q);
    if (!query) return [];
    const eff = await this.access.effective(caller);
    const keys = [...eff.keys];
    if (keys.length === 0) return [];
    return this.prisma.$queryRaw<SearchHit[]>(Prisma.sql`
      SELECT "entityType", "entityId", "title", "subtitle"
      FROM "search_documents"
      WHERE "searchVector" @@ to_tsquery('simple'::regconfig, ${query}) AND "permissionKey" = ANY(${keys}::text[])
      ORDER BY ts_rank("searchVector", to_tsquery('simple'::regconfig, ${query})) DESC, "title" ASC
      LIMIT ${limit}`);
  }
}
