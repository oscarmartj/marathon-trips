import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { conflict, notFound, unprocessable } from '../http/api-error';
import { type Actor, type TableDef, delegateOf } from './table-def';

export interface TagView {
  id: string;
  name: string;
  colour: string;
}

const MAX_TAGGED = 10_000;

@Injectable()
export class TagsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list() {
    const [tags, counts] = await Promise.all([
      this.prisma.tag.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.tagging.groupBy({ by: ['tagId'], _count: { _all: true } }),
    ]);
    const used = new Map(counts.map((c) => [c.tagId, c._count._all]));
    return tags.map((t) => ({ id: t.id, name: t.name, colour: t.colour, entityTypes: t.entityTypes, usedBy: used.get(t.id) ?? 0 }));
  }

  async create(actor: Actor, input: { name: string; colour: string; entityTypes: string[] }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tag = await tx.tag.create({ data: input });
        await this.audit.record(tx, { actor, action: 'common.tag.created', entityType: 'Tag', entityId: tag.id, after: { name: tag.name, colour: tag.colour, entityTypes: tag.entityTypes } });
        return { id: tag.id };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('tag_name_taken', 'A tag with this name already exists');
      throw e;
    }
  }

  async update(actor: Actor, id: string, input: Partial<{ name: string; colour: string; entityTypes: string[] }>) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.tag.findUnique({ where: { id } });
        if (!before) throw notFound('tag_not_found', 'Tag not found');
        const after = await tx.tag.update({ where: { id }, data: input });
        const pick = (t: typeof before) => ({ name: t.name, colour: t.colour, entityTypes: t.entityTypes });
        await this.audit.record(tx, { actor, action: 'common.tag.updated', entityType: 'Tag', entityId: id, before: pick(before), after: pick(after) });
        return { id };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('tag_name_taken', 'A tag with this name already exists');
      throw e;
    }
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const tag = await tx.tag.findUnique({ where: { id } });
      if (!tag) throw notFound('tag_not_found', 'Tag not found');
      if ((await tx.tagging.count({ where: { tagId: id } })) > 0) throw conflict('tag_in_use', 'Remove this tag from its records before deleting it');
      await tx.tag.delete({ where: { id } });
      await this.audit.record(tx, { actor, action: 'common.tag.deleted', entityType: 'Tag', entityId: id, before: { name: tag.name, colour: tag.colour, entityTypes: tag.entityTypes } });
    });
  }

  async forRecords(def: TableDef, ids: readonly string[]): Promise<Map<string, TagView[]>> {
    const out = new Map<string, TagView[]>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.tagging.findMany({
      where: { entityType: def.entityType, entityId: { in: [...ids] } },
      select: { entityId: true, tag: { select: { id: true, name: true, colour: true } } },
    });
    for (const r of rows) out.set(r.entityId, [...(out.get(r.entityId) ?? []), r.tag]);
    for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Ids of records carrying any (or all) of the tags, for the list filter. */
  async taggedIds(def: TableDef, tagIds: readonly string[], mode: 'any' | 'all'): Promise<string[] | null> {
    if (tagIds.length === 0) return null;
    const rows = await this.prisma.tagging.groupBy({
      by: ['entityId'],
      where: { entityType: def.entityType, tagId: { in: [...tagIds] } },
      _count: { _all: true },
    });
    const ids = rows.filter((r) => mode === 'any' || r._count._all === new Set(tagIds).size).map((r) => r.entityId);
    if (ids.length > MAX_TAGGED) throw unprocessable('tag_filter_too_broad', 'That tag matches too many records; add another filter');
    return ids;
  }

  /**
   * Adds or removes one tag on one record in the caller's transaction (task 7.4, automations). Insert-or-nothing and
   * delete-or-nothing, audited on the record like setTags. Returns what happened, as a code.
   */
  async changeOneIn(
    tx: Prisma.TransactionClient, actor: Actor, def: TableDef, entityId: string, tagId: string, op: 'add' | 'remove', context: AuditContext = {},
  ): Promise<'done' | 'tag_unavailable' | 'already_tagged' | 'not_tagged' | 'entity_gone'> {
    if (!def.taggable) return 'tag_unavailable';
    const row = await delegateOf(tx, def).findUnique({ where: { id: entityId } });
    if (!row || row.deletedAt) return 'entity_gone';
    const tag = await tx.tag.findUnique({ where: { id: tagId } });
    if (!tag || (tag.entityTypes.length > 0 && !tag.entityTypes.includes(def.entityType))) return 'tag_unavailable';
    const before = await tx.tagging.findMany({ where: { entityType: def.entityType, entityId }, include: { tag: true } });
    const has = before.some((b) => b.tagId === tagId);
    if (op === 'add') {
      if (has) return 'already_tagged';
      const inserted = await tx.$executeRaw`
        INSERT INTO taggings (id, "tagId", "entityType", "entityId", "createdById")
        VALUES (gen_random_uuid(), ${tagId}::uuid, ${def.entityType}, ${entityId}::uuid, NULL)
        ON CONFLICT ("tagId", "entityType", "entityId") DO NOTHING`;
      if (inserted === 0) return 'already_tagged';
    } else {
      if (!has) return 'not_tagged';
      const removed = await tx.tagging.deleteMany({ where: { tagId, entityType: def.entityType, entityId } });
      if (removed.count === 0) return 'not_tagged';
    }
    const names = (list: Array<{ name: string }>) => list.map((t) => t.name).sort();
    const beforeNames = names(before.map((b) => b.tag));
    const afterNames = op === 'add' ? [...beforeNames, tag.name].sort() : names(before.filter((b) => b.tagId !== tagId).map((b) => b.tag));
    await this.audit.record(tx, {
      actor, action: 'common.tags.changed', entityType: def.entityType, entityId, model: def.model, fieldClasses: { tags: 'nopii' },
      before: { tags: beforeNames }, after: { tags: afterNames }, context,
    });
    return 'done';
  }

  /** Sets the full tag set of one record; audits the names before and after on the record itself. */
  async setTags(actor: Actor, def: TableDef, entityId: string, tagIds: readonly string[], reason?: string): Promise<TagView[]> {
    const wanted = [...new Set(tagIds)];
    return this.prisma.$transaction(async (tx) => {
      const row = await delegateOf(tx, def).findUnique({ where: { id: entityId } });
      if (!row) throw notFound('record_not_found', 'Record not found');
      if (row.deletedAt) throw conflict('record_deleted', 'Restore this record before changing its tags');
      const tags = await tx.tag.findMany({ where: { id: { in: wanted } } });
      if (tags.length !== wanted.length) throw unprocessable('tag_unknown', 'One of the tags does not exist');
      if (tags.some((t) => t.entityTypes.length > 0 && !t.entityTypes.includes(def.entityType))) throw unprocessable('tag_not_allowed_here', 'A tag cannot be used on this kind of record');
      const current = await tx.tagging.findMany({ where: { entityType: def.entityType, entityId }, include: { tag: true } });
      const have = new Set(current.map((c) => c.tagId));
      const add = wanted.filter((id) => !have.has(id));
      const drop = current.filter((c) => !wanted.includes(c.tagId));
      if (add.length) await tx.tagging.createMany({ data: add.map((tagId) => ({ tagId, entityType: def.entityType, entityId, createdById: actor.id })) });
      if (drop.length) await tx.tagging.deleteMany({ where: { id: { in: drop.map((d) => d.id) } } });
      if (add.length || drop.length) {
        const names = (list: Array<{ name: string }>) => list.map((t) => t.name).sort();
        await this.audit.record(tx, {
          actor, action: 'common.tags.changed', entityType: def.entityType, entityId, model: def.model, reason, fieldClasses: { tags: 'nopii' },
          before: { tags: names(current.map((c) => c.tag)) }, after: { tags: names(tags) },
        });
      }
      return tags.map((t) => ({ id: t.id, name: t.name, colour: t.colour })).sort((a, b) => a.name.localeCompare(b.name));
    });
  }
}
