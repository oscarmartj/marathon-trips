import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { reportDefinitionSchema, reportScheduleSchema } from '@mt/shared';
import type { ReportDefinition } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AccessService } from '../../platform/access/access.service';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { FeatureFlagService } from '../../platform/flags/flags.service';
import { MailService } from '../../platform/mail/mail.service';
import { SCHEDULE_WINDOW_MS, latestOccurrence } from './dates';
import { REPORTS_MODULE, REPORTS_PERMISSIONS as P, REPORT_EMAIL_TEMPLATE } from './manifest';
import { entityPermission } from './reports.service';

type Tx = Prisma.TransactionClient;

/**
 * Makes the scheduled runs that are due and queues one email for each recipient (task 7.7). One run per report and
 * scheduled time, also with two API instances. The owner and every recipient must still be active staff who may read
 * reports and the data of this report; anyone who is not is left out and counted. Never catches up on an old occurrence.
 */
@Injectable()
export class ReportScheduler {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  async tick(now: Date = new Date()): Promise<{ runs: number; emails: number }> {
    if (!(await this.flags.isModuleEnabled(REPORTS_MODULE))) return { runs: 0, emails: 0 };
    const candidates = await this.prisma.savedReport.findMany({ where: { deletedAt: null, schedule: { not: Prisma.DbNull }, scheduleStartedAt: { not: null } }, select: { id: true } });
    let runs = 0;
    let emails = 0;
    for (const { id } of candidates) {
      const made = await this.prisma.$transaction((tx) => this.runOne(tx, id, now));
      if (made) {
        runs += 1;
        emails += made.emails;
      }
    }
    return { runs, emails };
  }

  private async eligible(tx: Tx, userId: string, entity: ReportDefinition['entity']): Promise<{ id: string; email: string } | null> {
    const user = await tx.user.findFirst({ where: { id: userId, kind: 'staff', status: 'active', anonymisedAt: null }, select: { id: true, email: true } });
    if (!user) return null;
    const eff = await this.access.effective(tx, userId);
    return eff.keys.has(P.read) && eff.keys.has(entityPermission(entity)) ? user : null;
  }

  private async runOne(tx: Tx, reportId: string, now: Date): Promise<{ emails: number } | null> {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`reports:run:${reportId}`}))`;
    const report = await tx.savedReport.findUnique({ where: { id: reportId } });
    if (!report || report.deletedAt || !report.schedule || !report.scheduleStartedAt) return null;
    const schedule = reportScheduleSchema.safeParse(report.schedule);
    if (!schedule.success) return null;
    const due = latestOccurrence(schedule.data, now);
    if (due <= report.scheduleStartedAt || now.getTime() - due.getTime() > SCHEDULE_WINDOW_MS) return null;
    if (await tx.reportRun.findUnique({ where: { reportId_scheduledFor: { reportId, scheduledFor: due } }, select: { id: true } })) return null;

    const runId = randomUUID();
    const skip = async (reasonCode: string, recipientsSkipped = 0) => {
      await tx.reportRun.create({ data: { id: runId, reportId, scheduledFor: due, status: 'skipped', reasonCode, recipientsSkipped } });
      return { emails: 0 };
    };
    const def = reportDefinitionSchema.safeParse(report.definition);
    if (!def.success) return skip('report_invalid');
    const owner = await this.eligible(tx, report.ownerUserId, def.data.entity);
    if (!owner) {
      await this.tasks.createSystemIn(tx, { title: 'A scheduled report was not sent because its owner can no longer see its data', entityType: 'SavedReport', entityId: reportId, sourceRef: `reports:owner_unavailable:${reportId}` });
      return skip('owner_unavailable', report.recipientUserIds.length);
    }
    if (report.recipientUserIds.length === 0) return skip('no_recipients');

    let queued = 0;
    for (const userId of report.recipientUserIds) {
      const user = await this.eligible(tx, userId, def.data.entity);
      if (!user) continue;
      const res = await this.mail.enqueue(
        { to: user.email, templateKey: REPORT_EMAIL_TEMPLATE, templateVersion: 1, locale: 'en-AU', dedupeKey: `report:${runId}:${userId}`, relatedEntityType: 'ReportRun', relatedEntityId: runId },
        tx,
      );
      if (res.created) queued += 1;
    }
    await tx.reportRun.create({
      data: { id: runId, reportId, scheduledFor: due, status: queued > 0 ? 'queued' : 'skipped', reasonCode: queued > 0 ? null : 'no_recipients', emailsQueued: queued, recipientsSkipped: report.recipientUserIds.length - queued },
    });
    return { emails: queued };
  }
}
