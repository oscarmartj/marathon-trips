import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { brand } from '@mt/shared';
import type { TemplateChannelValue, createTemplateSchema, listTemplatesQuerySchema, previewTemplateSchema, templateStatusSchema, updateTemplateSchema } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { type Tx, assertVersion, defined, orConflict, versionConflict, view } from './support';
import { TEMPLATE_DEFINITIONS, type TemplateDefinition, definitionOf, sampleValues } from './definitions';
import { buildPdf } from './pdf';
import { type TemplateProblem, checkWording, fill } from './render';

type Actor = AuditActor & { id: string };
const DEFAULT_LOCALE = 'en-AU';
const ENTITY = 'MessageTemplate';

export interface PreviewResult {
  /** Null when the wording has problems. */
  subject: string | null;
  body: string | null;
  problems: TemplateProblem[];
  variables: Array<{ name: string; description: string; sample: string }>;
}

export interface RenderedWording {
  subject: string;
  body: string;
}

/**
 * Editable wording for emails and documents (task 5.4). A change is always a new draft revision; putting one into use
 * retires the one before, so there is at most one live wording per template and language, and a sent email can be tied
 * to the revision that was live. Staff cannot invent variables: a placeholder must be in the template's list, or the
 * save is refused with the names that are not.
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  definitions(): Array<TemplateDefinition> {
    return [...TEMPLATE_DEFINITIONS];
  }

  private def(channel: TemplateChannelValue, key: string): TemplateDefinition {
    const d = definitionOf(channel, key);
    if (!d) throw unprocessable('template_unknown_key', 'There is no template with this key');
    return d;
  }

  /** Refuses wording with a placeholder outside the template's variables, or with braces that are not a placeholder. */
  private assertWording(d: TemplateDefinition, fields: { subject?: string; body?: string }): void {
    const problems = checkWording(fields, d.variables.map((x) => x.name));
    if (problems.length === 0) return;
    // Fixed wording, as for every error. The preview route names the problems; saving only says that there are some.
    throw unprocessable('template_wording_invalid', 'The wording uses a variable this template does not have, or has braces that are not a variable');
  }

  async list(channel: TemplateChannelValue, q: z.infer<typeof listTemplatesQuerySchema>) {
    const rows = await this.prisma.messageTemplate.findMany({
      where: { channel, ...(q.key ? { key: q.key } : {}), ...(q.locale ? { locale: q.locale } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: [{ key: 'asc' }, { locale: 'asc' }, { revision: 'desc' }],
      take: 500,
    });
    return view({ items: rows });
  }

  async get(channel: TemplateChannelValue, id: string) {
    const row = await this.prisma.messageTemplate.findFirst({ where: { id, channel } });
    if (!row) throw notFound('template_not_found', 'Not found');
    return view(row);
  }

  async create(actor: Actor, channel: TemplateChannelValue, input: z.infer<typeof createTemplateSchema>) {
    const d = this.def(channel, input.key);
    if (channel === 'email' && input.subject.trim() === '') throw unprocessable('template_subject_required', 'An email needs a subject');
    this.assertWording(d, { subject: input.subject, body: input.body });
    const id = await orConflict('template_revision_conflict', 'Someone else just added a revision. Reload and try again.', () =>
      this.prisma.$transaction(async (tx) => {
        const last = await tx.messageTemplate.aggregate({ where: { channel, key: input.key, locale: input.locale }, _max: { revision: true } });
        const created = await tx.messageTemplate.create({ data: { channel, key: input.key, locale: input.locale, revision: (last._max.revision ?? 0) + 1, subject: input.subject, body: input.body } });
        await this.audit.record(tx, { actor, action: 'templates.template.created', entityType: ENTITY, entityId: created.id, reason: input.reason, after: view(created) });
        return created.id;
      }),
    );
    return this.get(channel, id);
  }

  /** Only a draft can be edited: a revision that has been in use never changes. */
  async update(actor: Actor, channel: TemplateChannelValue, id: string, input: z.infer<typeof updateTemplateSchema>) {
    const { version, reason, ...rest } = input;
    const changes = defined(rest);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.messageTemplate.findFirst({ where: { id, channel } });
      assertVersion(before, version, 'Not found');
      if (before.status !== 'draft') throw conflict('template_not_draft', 'Only a draft can be edited. Create a new revision instead.');
      const next = { subject: changes.subject ?? before.subject, body: changes.body ?? before.body };
      if (channel === 'email' && next.subject.trim() === '') throw unprocessable('template_subject_required', 'An email needs a subject');
      this.assertWording(this.def(channel, before.key), next);
      const res = await tx.messageTemplate.updateMany({ where: { id, version, status: 'draft' }, data: { ...changes, version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.messageTemplate.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action: 'templates.template.updated', entityType: ENTITY, entityId: id, reason, before: view(before), after: view(after) });
    });
    return this.get(channel, id);
  }

  /** Puts a draft into use and retires the revision that was in use, in one transaction. */
  async activate(actor: Actor, channel: TemplateChannelValue, id: string, input: z.infer<typeof templateStatusSchema>) {
    await orConflict('template_activation_conflict', 'Someone else is changing this template. Reload and try again.', () =>
      this.prisma.$transaction(async (tx) => {
        const before = await tx.messageTemplate.findFirst({ where: { id, channel } });
        assertVersion(before, input.version, 'Not found');
        if (before.status !== 'draft') throw conflict('template_not_draft', 'Only a draft can be put into use');
        // Wording is checked again: the list of variables may have changed since the draft was saved.
        this.assertWording(this.def(channel, before.key), before);
        const retired = await tx.messageTemplate.findFirst({ where: { channel, key: before.key, locale: before.locale, status: 'active' } });
        if (retired) {
          await tx.messageTemplate.update({ where: { id: retired.id }, data: { status: 'archived', version: { increment: 1 } } });
          await this.audit.record(tx, { actor, action: 'templates.template.archived', entityType: ENTITY, entityId: retired.id, reason: input.reason ?? 'Replaced by a newer revision', before: view(retired), after: view({ ...retired, status: 'archived' }) });
        }
        const res = await tx.messageTemplate.updateMany({ where: { id, version: input.version, status: 'draft' }, data: { status: 'active', version: { increment: 1 } } });
        if (res.count !== 1) throw versionConflict();
        const after = await tx.messageTemplate.findUniqueOrThrow({ where: { id } });
        await this.audit.record(tx, { actor, action: 'templates.template.activated', entityType: ENTITY, entityId: id, reason: input.reason, before: view(before), after: view(after) });
      }),
    );
    return this.get(channel, id);
  }

  /** Takes a draft or the revision in use out of use. With none in use, the built-in wording is sent. */
  async archive(actor: Actor, channel: TemplateChannelValue, id: string, input: z.infer<typeof templateStatusSchema>) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.messageTemplate.findFirst({ where: { id, channel } });
      assertVersion(before, input.version, 'Not found');
      if (before.status === 'archived') throw conflict('template_already_archived', 'This is already archived');
      const res = await tx.messageTemplate.updateMany({ where: { id, version: input.version, status: before.status }, data: { status: 'archived', version: { increment: 1 } } });
      if (res.count !== 1) throw versionConflict();
      const after = await tx.messageTemplate.findUniqueOrThrow({ where: { id } });
      await this.audit.record(tx, { actor, action: 'templates.template.archived', entityType: ENTITY, entityId: id, reason: input.reason, before: view(before), after: view(after) });
    });
    return this.get(channel, id);
  }

  // ---- Preview ----

  /** Renders wording with the sample data for its key. Nothing is saved, sent or read from a customer. */
  previewWording(channel: TemplateChannelValue, input: z.infer<typeof previewTemplateSchema>): PreviewResult {
    const d = this.def(channel, input.key);
    const variables = d.variables.map((x) => ({ ...x }));
    const problems = checkWording(input, d.variables.map((x) => x.name));
    if (problems.length > 0) return { subject: null, body: null, problems, variables };
    const values = sampleValues(d);
    return { subject: fill(input.subject, values, { singleLine: true }), body: fill(input.body, values), problems: [], variables };
  }

  async previewSaved(channel: TemplateChannelValue, id: string) {
    const row = await this.prisma.messageTemplate.findFirst({ where: { id, channel } });
    if (!row) throw notFound('template_not_found', 'Not found');
    return this.previewWording(channel, { key: row.key, subject: row.subject, body: row.body });
  }

  async previewPdf(id: string): Promise<Buffer> {
    const p = await this.previewSaved('document', id);
    if (p.subject === null || p.body === null) throw unprocessable('template_wording_invalid', 'The wording uses a variable this template does not have, or has braces that are not a variable');
    return this.pdfOf(p.subject, p.body);
  }

  private pdfOf(title: string, body: string): Buffer {
    try {
      return buildPdf({ title, body });
    } catch {
      throw unprocessable('template_too_long', 'This document would run to more than 50 pages');
    }
  }

  // ---- Use by other modules ----

  /** The wording in use for a key and language (the default language when there is none in that language), or null. */
  async activeWording(db: Tx | PrismaService, channel: TemplateChannelValue, key: string, locale: string): Promise<(RenderedWording & { revision: number }) | null> {
    for (const l of locale === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [locale, DEFAULT_LOCALE]) {
      const row = await db.messageTemplate.findFirst({ where: { channel, key, locale: l, status: 'active' }, select: { subject: true, body: true, revision: true } });
      if (row) return row;
    }
    return null;
  }

  /**
   * The email for a key from the revision in use, or null when none is: the caller then sends its built-in wording.
   * `values` must have every variable of the template; a missing one fails the send rather than printing a blank.
   */
  async renderEmail(db: Tx | PrismaService, key: string, locale: string, values: Readonly<Record<string, string>>): Promise<{ subject: string; text: string; revision: number } | null> {
    const w = await this.activeWording(db, 'email', key, locale);
    if (!w) return null;
    const all = { brandName: brand.name, ...values };
    return { subject: fill(w.subject, all, { singleLine: true }), text: fill(w.body, all), revision: w.revision };
  }

  /** A document as a PDF, from the revision in use or else the starter wording. For booking documents (tasks 4.6, 5.1). */
  async renderDocument(db: Tx | PrismaService, key: string, locale: string, values: Readonly<Record<string, string>>): Promise<{ pdf: Buffer; revision: number | null }> {
    const d = this.def('document', key);
    const w = (await this.activeWording(db, 'document', key, locale)) ?? { ...d.starter, revision: null };
    const all = { brandName: brand.name, ...values };
    return { pdf: this.pdfOf(fill(w.subject, all, { singleLine: true }), fill(w.body, all)), revision: w.revision };
  }
}
