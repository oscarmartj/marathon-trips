import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { ContentKind, contentListQuerySchema, contentStatusSchema, legalReviewSchema } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { type Delegate, KINDS, type KindSpec } from './kinds';
import { type Tx, assertVersion, defined, orConflict, versionConflict, view } from './support';

type Actor = AuditActor & { id: string };
type Row = Record<string, unknown> & { id: string; version: number };

/**
 * Staff-side content: pages, race guides, FAQs, banners, menu items and the image library. One service for all of them,
 * driven by the table in kinds.ts, because they all behave the same way: optimistic version, audit entry in the same
 * transaction, draft and published states. Edits to published content go live on the next page revalidation (about a minute).
 */
@Injectable()
export class ContentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private delegate(tx: Tx | PrismaService, spec: KindSpec): Delegate {
    return (tx as unknown as Record<string, Delegate>)[spec.model]!;
  }

  async list(kind: ContentKind, q: z.infer<typeof contentListQuerySchema>) {
    const spec = KINDS[kind];
    const where: Record<string, unknown> = {};
    for (const f of spec.filters) if (q[f] !== undefined) where[f] = q[f];
    const d = this.delegate(this.prisma, spec);
    const [total, rows] = await Promise.all([
      d.count({ where }),
      d.findMany({ where, include: spec.include, orderBy: spec.orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return view({ items: rows, page: q.page, pageSize: q.pageSize, total });
  }

  async get(kind: ContentKind, id: string) {
    const spec = KINDS[kind];
    const row = await this.delegate(this.prisma, spec).findFirst({ where: { id }, include: spec.include });
    if (!row) throw notFound('content_not_found', 'Not found');
    return view(row);
  }

  async create(actor: Actor, kind: ContentKind, input: Record<string, unknown>) {
    const spec = KINDS[kind];
    const { reason, ...rest } = input;
    const row = await orConflict(spec.uniqueConflict?.code ?? 'content_conflict', spec.uniqueConflict?.message ?? 'This already exists', () =>
      this.prisma.$transaction(async (tx) => {
        const data = spec.prepareCreate ? await spec.prepareCreate(tx, rest) : rest;
        const created = (await this.delegate(tx, spec).create({ data })) as Row;
        await this.audit.record(tx, { actor, action: `content.${spec.noun}.created`, entityType: spec.entityType, entityId: created.id, reason: reason as string | undefined, after: view(created) });
        return created;
      }),
    );
    return this.get(kind, row.id);
  }

  async update(actor: Actor, kind: ContentKind, id: string, input: Record<string, unknown>) {
    const spec = KINDS[kind];
    const { version, reason, ...rest } = input as { version: number; reason?: string } & Record<string, unknown>;
    const changes = defined(rest);
    await orConflict(spec.uniqueConflict?.code ?? 'content_conflict', spec.uniqueConflict?.message ?? 'This already exists', () =>
      this.prisma.$transaction(async (tx) => {
        const d = this.delegate(tx, spec);
        const before = (await d.findFirst({ where: { id } })) as Row | null;
        assertVersion(before, version, 'Not found');
        if (spec.prepareUpdate) await spec.prepareUpdate(tx, before, changes);
        const res = await d.updateMany({ where: { id, version }, data: { ...changes, version: { increment: 1 } } });
        if (res.count !== 1) throw versionConflict();
        const after = (await d.findFirst({ where: { id } })) as Row;
        await this.audit.record(tx, { actor, action: `content.${spec.noun}.updated`, entityType: spec.entityType, entityId: id, reason, before: view(before), after: view(after) });
      }),
    );
    return this.get(kind, id);
  }

  /** Publishes or unpublishes. Publishing an empty page or guide is refused (409), so a blank page never goes public. */
  async setStatus(actor: Actor, kind: ContentKind, id: string, input: z.infer<typeof contentStatusSchema>) {
    const spec = KINDS[kind];
    if (!spec.hasStatus) throw notFound('content_not_found', 'Not found');
    await this.prisma.$transaction(async (tx) => {
      const d = this.delegate(tx, spec);
      const before = (await d.findFirst({ where: { id } })) as Row | null;
      assertVersion(before, input.version, 'Not found');
      if (before.status === input.status) throw conflict('content_status_unchanged', `This is already ${input.status}`);
      if (input.status === 'published') spec.publishGuard?.(before);
      const publishedAt = spec.hasPublishedAt ? { publishedAt: input.status === 'published' ? new Date() : null } : {};
      const res = await d.updateMany({ where: { id, version: input.version }, data: { status: input.status, ...publishedAt, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      const after = (await d.findFirst({ where: { id } })) as Row;
      await this.audit.record(tx, {
        actor, action: `content.${spec.noun}.${input.status === 'published' ? 'published' : 'unpublished'}`, entityType: spec.entityType, entityId: id,
        reason: input.reason, before: view(before), after: view(after),
      });
    });
    return this.get(kind, id);
  }

  async remove(actor: Actor, kind: ContentKind, id: string, reason?: string): Promise<void> {
    const spec = KINDS[kind];
    await this.prisma.$transaction(async (tx) => {
      const d = this.delegate(tx, spec);
      const before = (await d.findFirst({ where: { id } })) as Row | null;
      if (!before) throw notFound('content_not_found', 'Not found');
      if (spec.deleteGuard) await spec.deleteGuard(tx, before);
      await d.delete({ where: { id } });
      await this.audit.record(tx, { actor, action: `content.${spec.noun}.deleted`, entityType: spec.entityType, entityId: id, reason, before: view(before) });
    });
  }

  /**
   * Sets or clears "pending legal review" on a legal page. The only way to clear it; editing the text never does, so a
   * page stays marked until someone with the review permission says it has been reviewed.
   */
  async setLegalReview(actor: Actor, id: string, input: z.infer<typeof legalReviewSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const before = (await tx.contentPage.findFirst({ where: { id } })) as Row | null;
      assertVersion(before, input.version, 'Not found');
      if (before.kind !== 'legal') throw conflict('page_not_legal', 'Only a legal page has a legal review state');
      if (before.legalReviewPending === input.pending) throw conflict('content_status_unchanged', 'The review state is already set to this');
      const res = await tx.contentPage.updateMany({ where: { id, version: input.version }, data: { legalReviewPending: input.pending, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.contentPage.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, {
        actor, action: input.pending ? 'content.page.legal_review_requested' : 'content.page.legal_reviewed', entityType: 'ContentPage', entityId: id,
        reason: input.reason, before: view(before), after: view(after),
      });
    });
    return this.get('pages', id);
  }
}

