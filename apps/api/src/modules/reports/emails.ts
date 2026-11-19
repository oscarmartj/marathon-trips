import { Inject, Injectable } from '@nestjs/common';
import { REPORT_EMAIL_ROWS, reportDefinitionSchema, reportScheduleSchema } from '@mt/shared';
import type { ReportResult } from '@mt/shared';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { FeatureFlagService } from '../../platform/flags/flags.service';
import { AccessService } from '../../platform/access/access.service';
import { AppError } from '../../platform/errors/safe-error';
import { MAIL_NOT_SENDABLE, MAIL_SKIPPED } from '../../platform/mail/mail.service';
import type { MailTemplate, RenderContext, RenderedMail } from '../../platform/mail/templates';
import { ReportEngine } from './engine';
import { REPORTS_MODULE, REPORTS_PERMISSIONS as P, REPORT_EMAIL_TEMPLATE } from './manifest';
import { entityPermission } from './reports.service';

const pad = (s: string, n: number) => s.padEnd(n, ' ');

/** A plain-text table: the label, then one column per value. Counts only, no people and no amounts. */
export function formatReportText(name: string, result: ReportResult, link: string): string {
  const shown = result.rows.slice(0, REPORT_EMAIL_ROWS);
  const head = ['', ...result.columns];
  const lines = shown.map((r) => [r.label, ...result.columns.map((c) => (r.values[c] === null || r.values[c] === undefined ? '-' : String(r.values[c])))]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ').trimEnd();
  return [
    `${name}`,
    `From ${result.from} to ${result.to} (Brisbane time), grouped by ${result.groupBy}.`,
    '',
    fmt(head),
    ...lines.map(fmt),
    ...(result.rows.length > shown.length || result.truncated ? ['', `Showing the first ${shown.length} rows. Open the report in the admin panel to see the rest.`] : []),
    ...(shown.length === 0 ? ['', 'No data in this period.'] : []),
    '',
    `Open it in the admin panel: ${link}`,
  ].join('\n');
}

/**
 * The scheduled report email (task 7.7). Staff only: the wording is built in, English. It is rendered at send time from
 * the run id, and refuses to send when the person it is for is no longer active staff with access to the data.
 */
@Injectable()
export class ReportEmails {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ReportEngine) private readonly engine: ReportEngine,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
  ) {}

  mailTemplates(): MailTemplate[] {
    return [{ key: REPORT_EMAIL_TEMPLATE, version: 1, render: (ctx) => this.render(ctx) }];
  }

  private async render(ctx: RenderContext): Promise<RenderedMail> {
    // With the module off nothing goes out, also what was queued before it was switched off.
    if (!(await this.flags.isModuleEnabled(REPORTS_MODULE, ctx.tx))) throw new AppError(MAIL_SKIPPED, 'module_disabled');
    const runId = ctx.email.relatedEntityType === 'ReportRun' ? ctx.email.relatedEntityId : null;
    const run = runId ? await ctx.tx.reportRun.findUnique({ where: { id: runId }, select: { scheduledFor: true, report: { select: { id: true, name: true, definition: true, schedule: true, scheduleStartedAt: true, deletedAt: true, ownerUserId: true, recipientUserIds: true } } } }) : null;
    if (!run || run.report.deletedAt) throw new AppError(MAIL_NOT_SENDABLE, 'The report is gone');
    const def = reportDefinitionSchema.safeParse(run.report.definition);
    if (!def.success) throw new AppError(MAIL_NOT_SENDABLE, 'The report is no longer valid');
    // The schedule says which days this email covers. A report without one has no recipients either.
    const schedule = reportScheduleSchema.safeParse(run.report.schedule);
    if (!schedule.success) throw new AppError(MAIL_NOT_SENDABLE, 'The report is no longer on a schedule');
    // A schedule changed after this run was due restarts its clock (`scheduleStartedAt`). The days this email would cover
    // then come from a schedule it was not made for, and can even end before they start: it is not sent.
    if (!run.report.scheduleStartedAt || run.report.scheduleStartedAt > run.scheduledFor) throw new AppError(MAIL_NOT_SENDABLE, 'The schedule of the report changed after this email was due');
    const user = await ctx.tx.user.findFirst({ where: { email: ctx.email.to, kind: 'staff', status: 'active', anonymisedAt: null }, select: { id: true } });
    const eff = user ? await this.access.effective(ctx.tx, user.id) : null;
    if (!eff || !eff.keys.has(P.read) || !eff.keys.has(entityPermission(def.data.entity))) throw new AppError(MAIL_NOT_SENDABLE, 'The recipient can no longer see this report');
    // Sent only while the report still names this person and its owner can still see the data.
    if (!user || !run.report.recipientUserIds.includes(user.id)) throw new AppError(MAIL_NOT_SENDABLE, 'The recipient is no longer on this report');
    const ownerEff = await this.access.effective(ctx.tx, run.report.ownerUserId);
    if (!ownerEff.keys.has(P.read) || !ownerEff.keys.has(entityPermission(def.data.entity))) throw new AppError(MAIL_NOT_SENDABLE, 'The owner of the report can no longer see its data');
    // The whole days since the previous scheduled time, up to the day before this one: each email starts where the last
    // one ended, weekly or monthly, so no request is left out of the emails or counted in two of them.
    const result = await this.engine.run(ctx.tx, def.data, run.scheduledFor, { schedule: schedule.data });
    const link = `${new URL(this.config.WEB_ORIGIN).origin}/admin/reports`;
    return { subject: `Report: ${run.report.name}`, text: formatReportText(run.report.name, result, link) };
  }
}
