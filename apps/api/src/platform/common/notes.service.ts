import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { OutboxService } from '../events/outbox.service';
import { conflict, forbidden, notFound } from '../http/api-error';
import { PERMISSIONS } from '../access/permissions';
import { type Caller, TableAccessService } from './table-access.service';
import { type TableDef, delegateOf } from './table-def';

/** Staff notes on any registered record. Their audit entries sit on the target record, so they show in its history. */
@Injectable()
export class NotesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(TableAccessService) private readonly access: TableAccessService,
  ) {}

  private async target(def: TableDef, entityId: string) {
    const row = await delegateOf(this.prisma, def).findUnique({ where: { id: entityId } });
    if (!row) throw notFound('record_not_found', 'Record not found');
    return row;
  }

  async list(caller: Caller, def: TableDef, entityId: string) {
    if (!def.notes) throw notFound('unknown_table', 'Table not found');
    await this.access.require(caller, def, 'read');
    await this.target(def, entityId);
    const notes = await this.prisma.note.findMany({
      where: { entityType: def.entityType, entityId, deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const canSeeAuthors = await this.access.hasKey(caller, PERMISSIONS.userRead);
    const authors = canSeeAuthors
      ? new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(notes.map((n) => n.authorId))] } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]))
      : new Map<string, string>();
    return notes.map((n) => ({
      id: n.id, body: n.body, pinned: n.pinned, version: n.version, createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString(),
      author: { id: n.authorId, email: authors.get(n.authorId) ?? null, you: n.authorId === caller.actor.id },
    }));
  }

  async add(caller: Caller, def: TableDef, entityId: string, input: { body: string; pinned: boolean }) {
    if (!def.notes) throw notFound('unknown_table', 'Table not found');
    await this.access.require(caller, def, 'annotate');
    return this.prisma.$transaction(async (tx) => {
      const row = await delegateOf(tx, def).findUnique({ where: { id: entityId } });
      if (!row) throw notFound('record_not_found', 'Record not found');
      if (row.deletedAt) throw conflict('record_deleted', 'Restore this record before adding notes');
      const note = await tx.note.create({ data: { entityType: def.entityType, entityId, body: input.body, pinned: input.pinned, authorId: caller.actor.id } });
      await this.audit.record(tx, {
        actor: caller.actor, action: 'common.note.added', entityType: def.entityType, entityId, model: 'Note',
        after: { body: note.body, pinned: note.pinned }, context: { noteId: note.id },
      });
      await this.outbox.publish(tx, {
        type: 'common.note.added', aggregateType: 'Note', aggregateId: note.id, actorType: caller.actor.type, actorId: caller.actor.id,
        payload: { entityType: def.entityType, entityId },
      });
      return { id: note.id };
    });
  }

  async update(caller: Caller, def: TableDef, entityId: string, noteId: string, input: { body?: string; pinned?: boolean; version: number }) {
    await this.access.require(caller, def, 'annotate');
    return this.prisma.$transaction(async (tx) => {
      const note = await tx.note.findFirst({ where: { id: noteId, entityType: def.entityType, entityId, deletedAt: null } });
      if (!note) throw notFound('note_not_found', 'Note not found');
      if (note.authorId !== caller.actor.id) throw forbidden('note_not_yours', 'Only the author can change a note');
      const bumped = await tx.note.updateMany({ where: { id: noteId, version: input.version }, data: { body: input.body ?? note.body, pinned: input.pinned ?? note.pinned, version: { increment: 1 } } });
      if (bumped.count !== 1) throw conflict('version_conflict', 'Someone else changed this note. Reload and try again.');
      await this.audit.record(tx, {
        actor: caller.actor, action: 'common.note.edited', entityType: def.entityType, entityId, model: 'Note',
        before: { body: note.body, pinned: note.pinned }, after: { body: input.body ?? note.body, pinned: input.pinned ?? note.pinned }, context: { noteId },
      });
      return { version: note.version + 1 };
    });
  }

  async remove(caller: Caller, def: TableDef, entityId: string, noteId: string): Promise<void> {
    await this.access.require(caller, def, 'annotate');
    await this.prisma.$transaction(async (tx) => {
      const note = await tx.note.findFirst({ where: { id: noteId, entityType: def.entityType, entityId, deletedAt: null } });
      if (!note) throw notFound('note_not_found', 'Note not found');
      if (note.authorId !== caller.actor.id && !def.permissions.delete) throw forbidden('note_not_yours', 'Only the author can delete a note');
      if (note.authorId !== caller.actor.id) await this.access.require(caller, def, 'delete');
      const now = new Date();
      await tx.note.update({ where: { id: noteId }, data: { deletedAt: now, deletedById: caller.actor.id, version: { increment: 1 } } });
      await this.audit.record(tx, {
        actor: caller.actor, action: 'common.note.deleted', entityType: def.entityType, entityId, model: 'Note',
        before: { deletedAt: null }, after: { deletedAt: now }, context: { noteId },
      });
    });
  }
}
