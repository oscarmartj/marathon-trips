import { Inject, Injectable } from '@nestjs/common';
import { REPORT_ENTITY_CATALOGUE } from '@mt/shared';
import type { createReportSchema, funnelQuerySchema, raceEventSchema, ReportDefinition, ReportSchedule, updateReportSchema } from '@mt/shared';
import type { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../../platform/access/access.service';
import type { AuthContext } from '../../platform/access/auth-context';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { conflict, notFound, unprocessable } from '../../platform/http/api-error';
import { reportDefinitionSchema, reportScheduleSchema } from '@mt/shared';
import { addDays, todayInBusinessZone } from './dates';
import { ReportEngine } from './engine';
import { REPORTS_PERMISSIONS as P } from './manifest';

type Tx = Prisma.TransactionClient;
type Row = Prisma.SavedReportGetPayload<object>;
export interface Caller { auth: AuthContext; actor: AuditActor & { id: string } }

const audited = (r: Row) => ({ name: r.name, entity: r.entity, definition: r.definition, schedule: r.schedule, recipientUserIds: r.recipientUserIds, ownerUserId: r.ownerUserId, deletedAt: r.deletedAt });
const en = (v: unknown, fallback: string): string => ((v ?? {}) as Record<string, string>)['en-AU'] ?? fallback;

/** The permission that the data of a report needs (besides reading reports at all). */
export const entityPermission = (entity: keyof typeof REPORT_ENTITY_CATALOGUE): string => REPORT_ENTITY_CATALOGUE[entity].permission;

@Injectable()
export class ReportsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ReportEngine) private readonly engine: ReportEngine,
  ) {}

  // ---- Visits ----

  /**
   * Counts one visit. Anonymous: only a race and a day are kept. A slug that is not a published race counts nothing,
   * and the caller cannot tell the difference.
   */
  async recordEvent(input: z.infer<typeof raceEventSchema>, now: Date = new Date()): Promise<void> {
    const race = await this.prisma.race.findFirst({ where: { slug: input.raceSlug, status: 'published', deletedAt: null, isDemo: false }, select: { id: true } });
    if (!race) return;
    const day = todayInBusinessZone(now);
    const [views, builder] = input.kind === 'view' ? [1, 0] : [0, 1];
    await this.prisma.$executeRaw`
      INSERT INTO "race_daily_stats" ("raceId", "day", "views", "builderUses") VALUES (${race.id}::uuid, ${day}::date, ${views}, ${builder})
      ON CONFLICT ("raceId", "day") DO UPDATE SET "views" = "race_daily_stats"."views" + ${views}, "builderUses" = "race_daily_stats"."builderUses" + ${builder}`;
  }

  // ---- Funnel ----

  async funnel(q: z.infer<typeof funnelQuerySchema>, now: Date = new Date()) {
    if ((q.from === undefined) !== (q.to === undefined)) throw unprocessable('range_invalid', 'Give both dates or neither');
    if (q.from && q.to && (q.to < q.from || Date.parse(q.to) - Date.parse(q.from) > 366 * 86_400_000)) throw unprocessable('range_invalid', 'Choose a range of a year or less');
    const range = q.from && q.to ? { kind: 'dates' as const, from: q.from, to: q.to } : { kind: 'last_days' as const, days: q.days ?? 30 };
    return this.prisma.$transaction((tx) => this.engine.funnel(tx, range, now));
  }

  // ---- Catalogue for the builder ----

  async catalogue(auth: AuthContext) {
    const eff = await this.access.effectiveFor(this.prisma, auth);
    const [races, staff] = await Promise.all([
      this.prisma.race.findMany({ where: { deletedAt: null }, select: { id: true, name: true, slug: true }, orderBy: { slug: 'asc' }, take: 500 }),
      this.recipientCandidates(),
    ]);
    return {
      entities: (Object.keys(REPORT_ENTITY_CATALOGUE) as Array<keyof typeof REPORT_ENTITY_CATALOGUE>).map((entity) => ({
        entity, columns: REPORT_ENTITY_CATALOGUE[entity].columns, groups: REPORT_ENTITY_CATALOGUE[entity].groups, allowed: eff.keys.has(entityPermission(entity)),
      })),
      races: races.map((r) => ({ id: r.id, name: en(r.name, r.slug) })),
      recipients: staff,
    };
  }

  /** Active staff who may read reports: the only people a report can be emailed to. */
  private async recipientCandidates(): Promise<Array<{ id: string; email: string }>> {
    const users = await this.prisma.user.findMany({ where: { kind: 'staff', status: 'active', anonymisedAt: null }, select: { id: true, email: true }, orderBy: { email: 'asc' }, take: 200 });
    const out: Array<{ id: string; email: string }> = [];
    for (const u of users) if ((await this.access.effective(this.prisma, u.id)).keys.has(P.read)) out.push(u);
    return out;
  }

  // ---- Saved reports ----

  private view(r: Row) {
    return {
      id: r.id, name: r.name, entity: r.entity, definition: r.definition as unknown as ReportDefinition, schedule: (r.schedule ?? null) as ReportSchedule | null,
      recipientUserIds: r.recipientUserIds, ownerUserId: r.ownerUserId, version: r.version, createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }

  async list() {
    const rows = await this.prisma.savedReport.findMany({ where: { deletedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 500 });
    return { items: rows.map((r) => this.view(r)) };
  }

  async get(id: string) {
    const r = await this.prisma.savedReport.findUnique({ where: { id } });
    if (!r || r.deletedAt) throw notFound('report_not_found', 'Report not found');
    return this.view(r);
  }

  /** The caller must be allowed to see the data the report counts. */
  private async assertEntity(tx: Tx, auth: AuthContext, entity: ReportDefinition['entity']): Promise<void> {
    await this.access.assertPermission(tx, auth, entityPermission(entity));
  }

  /** Recipients are active staff who may read reports and the data of this report. */
  private async checkRecipients(tx: Tx, ids: string[], entity: ReportDefinition['entity']): Promise<void> {
    if (ids.length === 0) return;
    const users = await tx.user.findMany({ where: { id: { in: ids }, kind: 'staff', status: 'active', anonymisedAt: null }, select: { id: true } });
    if (users.length !== ids.length) throw unprocessable('report_recipient_invalid', 'A recipient is not an active staff member');
    for (const u of users) {
      const eff = await this.access.effective(tx, u.id);
      if (!eff.keys.has(P.read) || !eff.keys.has(entityPermission(entity))) throw unprocessable('report_recipient_cannot_see_data', 'A recipient is not allowed to see this report');
    }
  }

  private async checkRaces(tx: Tx, def: ReportDefinition): Promise<void> {
    const ids = [...new Set(def.raceIds ?? [])];
    if (ids.length && (await tx.race.count({ where: { id: { in: ids }, deletedAt: null } })) !== ids.length) throw unprocessable('report_race_not_found', 'A race in the filter does not exist');
  }

  async create(caller: Caller, input: z.infer<typeof createReportSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertEntity(tx, caller.auth, input.definition.entity);
      await this.checkRaces(tx, input.definition);
      const recipients = input.recipientUserIds ?? [];
      await this.checkRecipients(tx, recipients, input.definition.entity);
      if (recipients.length > 0 && !input.schedule) throw unprocessable('report_schedule_required', 'Recipients only receive a report on a schedule');
      const row = await tx.savedReport.create({
        data: {
          name: input.name, entity: input.definition.entity, definition: input.definition as Prisma.InputJsonValue, schedule: (input.schedule ?? Prisma.DbNull) as Prisma.InputJsonValue,
          recipientUserIds: recipients, ownerUserId: caller.actor.id, scheduleStartedAt: input.schedule ? new Date() : null,
        },
      });
      await this.audit.record(tx, { actor: caller.actor, action: 'reports.report.created', entityType: 'SavedReport', entityId: row.id, model: 'SavedReport', after: audited(row) });
      return this.view(row);
    });
  }

  private async lock(tx: Tx, id: string): Promise<Row> {
    await tx.$queryRaw`SELECT id FROM saved_reports WHERE id = ${id}::uuid FOR UPDATE`;
    const r = await tx.savedReport.findUnique({ where: { id } });
    if (!r || r.deletedAt) throw notFound('report_not_found', 'Report not found');
    return r;
  }

  async update(caller: Caller, id: string, input: z.infer<typeof updateReportSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== input.version) throw conflict('version_conflict', 'Someone else changed this report. Reload and try again.');
      const definition = input.definition ?? (reportDefinitionSchema.parse(before.definition));
      const schedule = input.schedule === undefined ? (before.schedule ? reportScheduleSchema.parse(before.schedule) : null) : input.schedule;
      const recipients = input.recipientUserIds ?? before.recipientUserIds;
      // Whoever changes what is counted or who receives it vouches for it: they need the data, and they become the owner.
      await this.assertEntity(tx, caller.auth, definition.entity);
      await this.checkRaces(tx, definition);
      await this.checkRecipients(tx, recipients, definition.entity);
      if (recipients.length > 0 && !schedule) throw unprocessable('report_schedule_required', 'Recipients only receive a report on a schedule');
      const scheduleChanged = JSON.stringify(schedule) !== JSON.stringify(before.schedule ?? null);
      const row = await tx.savedReport.update({
        where: { id },
        data: {
          name: input.name ?? before.name, entity: definition.entity, definition: definition as Prisma.InputJsonValue, schedule: (schedule ?? Prisma.DbNull) as Prisma.InputJsonValue,
          recipientUserIds: recipients, ownerUserId: caller.actor.id,
          // Occurrences before a change are never sent late: the clock starts again when the schedule changes.
          scheduleStartedAt: !schedule ? null : scheduleChanged || !before.scheduleStartedAt ? new Date() : before.scheduleStartedAt,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, { actor: caller.actor, action: 'reports.report.updated', entityType: 'SavedReport', entityId: id, model: 'SavedReport', before: audited(before), after: audited(row) });
      return this.view(row);
    });
  }

  async remove(caller: Caller, id: string, version: number) {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw conflict('version_conflict', 'Someone else changed this report. Reload and try again.');
      const row = await tx.savedReport.update({ where: { id }, data: { deletedAt: new Date(), schedule: Prisma.DbNull, scheduleStartedAt: null, recipientUserIds: [], version: { increment: 1 } } });
      await this.audit.record(tx, { actor: caller.actor, action: 'reports.report.deleted', entityType: 'SavedReport', entityId: id, model: 'SavedReport', before: audited(before), after: audited(row) });
    });
  }

  // ---- Running ----

  /** Runs a definition without saving or sending anything. The caller needs the permission of its data. */
  async preview(auth: AuthContext, def: ReportDefinition) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertEntity(tx, auth, def.entity);
      await this.checkRaces(tx, def);
      return this.engine.run(tx, def);
    });
  }

  async runSaved(auth: AuthContext, id: string) {
    const report = await this.get(id);
    return this.preview(auth, report.definition);
  }
}

