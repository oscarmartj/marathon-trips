import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService, SYSTEM_ACTOR } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { conflict, notFound, unprocessable } from '../../http/api-error';
import { SearchIndexService } from '../search.service';
import { SoftDeleteService } from '../soft-delete.service';
import { type Caller, TableAccessService } from '../table-access.service';
import type { Actor } from '../table-def';
import { taskKeysFor } from './task.table';
import { COMMON_PERMISSIONS_KEYS as K } from '../permissions';

type Status = 'open' | 'done' | 'cancelled';
const ALLOWED: Record<Status, readonly Status[]> = { open: ['done', 'cancelled'], done: ['open'], cancelled: ['open'] };

export interface TaskChanges {
  title?: string;
  description?: string | null;
  dueAt?: Date | null;
  status?: Status;
  assigneeId?: string | null;
}

const TRACKED = ['title', 'description', 'dueAt', 'status', 'assigneeId'] as const;
const pick = (row: Record<string, unknown>) => Object.fromEntries(TRACKED.map((k) => [k, row[k] ?? null]));

/** The example table's own writes. The bulk path and the single-record routes both end up in `change` and `setDeleted`. */
@Injectable()
export class TasksService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SearchIndexService) private readonly search: SearchIndexService,
    @Inject(SoftDeleteService) private readonly softDeleteService: SoftDeleteService,
    @Inject(TableAccessService) private readonly access: TableAccessService,
  ) {}

  /** Set after the table is registered (the def holds this service's methods). */
  table!: import('../table-def').TableDef;

  private async checkAssignee(tx: Prisma.TransactionClient, id: string | null | undefined): Promise<void> {
    if (!id) return;
    if (!(await tx.user.findFirst({ where: { id, kind: 'staff', status: 'active' }, select: { id: true } }))) throw unprocessable('assignee_unknown', 'That person cannot be assigned');
  }

  async createIn(tx: Prisma.TransactionClient, actor: Actor, input: { title: string; description?: string | null; dueAt?: Date | null; assigneeId?: string | null }, ctx: { csvJobId?: string } = {}) {
    await this.checkAssignee(tx, input.assigneeId);
    const task = await tx.task.create({
      data: { title: input.title, description: input.description ?? null, dueAt: input.dueAt ?? null, assigneeId: input.assigneeId ?? null, createdById: actor.id },
    });
    await this.audit.record(tx, {
      actor, action: 'common.task.created', entityType: 'Task', entityId: task.id, after: pick(task as unknown as Record<string, unknown>),
      ...(ctx.csvJobId ? { context: { csvJobId: ctx.csvJobId } } : {}),
    });
    await this.search.sync(tx, this.table, task as unknown as Record<string, unknown>);
    return task;
  }

  /**
   * A task the system opens for Oscar (task 3.1: payments that need a person), in the caller's transaction. Once per
   * `sourceRef` while it is open: a second call with the same reference returns the open task instead of a new one.
   * Titles are generated from codes and references, never from personal data.
   */
  async createSystemIn(tx: Prisma.TransactionClient, input: { title: string; description?: string | null; entityType: string; entityId: string; sourceRef: string }) {
    const open = await tx.task.findFirst({ where: { sourceRef: input.sourceRef, source: 'system', status: 'open', deletedAt: null } });
    if (open) return open;
    const task = await tx.task.create({
      data: { title: input.title, description: input.description ?? null, entityType: input.entityType, entityId: input.entityId, source: 'system', sourceRef: input.sourceRef, createdById: null },
    });
    await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'common.task.created', entityType: 'Task', entityId: task.id, after: pick(task as unknown as Record<string, unknown>), context: { sourceRef: input.sourceRef } });
    await this.search.sync(tx, this.table, task as unknown as Record<string, unknown>);
    return task;
  }

  /** Closes (done) the open system task with this `sourceRef`, if any, when what it was about has resolved itself. */
  async closeSystemIn(tx: Prisma.TransactionClient, sourceRef: string): Promise<number> {
    const open = await tx.task.findMany({ where: { sourceRef, source: 'system', status: 'open', deletedAt: null }, select: { id: true } });
    for (const t of open) {
      const done = await tx.task.update({ where: { id: t.id }, data: { status: 'done', version: { increment: 1 } } });
      await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'common.task.updated', entityType: 'Task', entityId: t.id, before: { status: 'open' }, after: { status: 'done' }, context: { sourceRef } });
      await this.search.sync(tx, this.table, done as unknown as Record<string, unknown>);
    }
    return open.length;
  }

  async create(caller: Caller, input: { title: string; description?: string | null; dueAt?: string | null; assigneeId?: string | null }) {
    await this.access.assertKey(caller, K.taskWrite);
    const task = await this.prisma.$transaction((tx) => this.createIn(tx, caller.actor, { ...input, dueAt: input.dueAt ? new Date(input.dueAt) : null }));
    return { id: task.id, version: task.version };
  }

  /** Applies a change in the caller's transaction. `expectedVersion` is the optimistic lock (absent for bulk actions). */
  async change(tx: Prisma.TransactionClient, actor: Actor, id: string, changes: TaskChanges, opts: { expectedVersion?: number; reason?: string } = {}) {
    const row = await tx.task.findUnique({ where: { id } });
    if (!row) throw notFound('record_not_found', 'Record not found');
    if (row.deletedAt) throw conflict('record_deleted', 'Restore this task before changing it');
    if (changes.status) {
      if (changes.status === row.status) throw conflict('already_in_state', 'The task is already in that state');
      if (!ALLOWED[row.status as Status].includes(changes.status)) throw conflict('transition_not_allowed', 'The task cannot move to that state');
    }
    if (changes.assigneeId !== undefined && changes.assigneeId !== row.assigneeId) await this.checkAssignee(tx, changes.assigneeId);
    const bumped = await tx.task.updateMany({
      where: { id, ...(opts.expectedVersion === undefined ? {} : { version: opts.expectedVersion }) },
      data: { ...changes, version: { increment: 1 } },
    });
    if (bumped.count !== 1) throw conflict('version_conflict', 'Someone else changed this task. Reload and try again.');
    const after = await tx.task.findUniqueOrThrow({ where: { id } });
    await this.audit.record(tx, {
      actor, action: 'common.task.updated', entityType: 'Task', entityId: id, reason: opts.reason,
      before: pick(row as unknown as Record<string, unknown>), after: pick(after as unknown as Record<string, unknown>),
    });
    await this.search.sync(tx, this.table, after as unknown as Record<string, unknown>);
    return after;
  }

  setDeleted(tx: Prisma.TransactionClient, actor: Actor, id: string, deleted: boolean, reason?: string) {
    return this.softDeleteService.setDeleted(tx, this.table, actor, id, deleted, reason);
  }

  async update(caller: Caller, id: string, input: Omit<TaskChanges, 'dueAt'> & { dueAt?: string | null; version: number; reason?: string }) {
    const { version, reason, dueAt, ...rest } = input;
    const changes: TaskChanges = { ...rest, ...(dueAt === undefined ? {} : { dueAt: dueAt ? new Date(dueAt) : null }) };
    const after = await this.prisma.$transaction(async (tx) => {
      const row = await tx.task.findUnique({ where: { id } });
      if (!row) throw notFound('record_not_found', 'Record not found');
      for (const key of taskKeysFor(row as unknown as Record<string, unknown>, K.taskWrite)) await this.access.assertKey(caller, key);
      return this.change(tx, caller.actor, id, changes, { expectedVersion: version, reason });
    });
    return { id, version: after.version };
  }
}
