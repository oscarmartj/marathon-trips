import { Inject, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CommonModule } from '../../platform/common/common.module';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { FlagRegistry } from '../../platform/flags/flag-registry';
import { JobsService } from '../../platform/jobs/jobs.service';
import { QUEUES } from '../../platform/jobs/queues';
import { MailTemplateRegistry } from '../../platform/mail/templates';
import { AnalyticsPublicController, ReportsAdminController } from './controller';
import { ReportEmails } from './emails';
import { ReportEngine } from './engine';
import { REPORTS_MODULE, reportsManifest } from './manifest';
import { ReportsService } from './reports.service';
import { ReportScheduler } from './scheduler';

/**
 * Task 7.7: the funnel per race and the report builder with scheduled sending. Counts only: no person and no amount of
 * money in any report, and recipients are active staff. Reads bookings with plain queries and writes only its own tables.
 */
@Module({
  imports: [CommonModule],
  controllers: [AnalyticsPublicController, ReportsAdminController],
  providers: [ReportsService, ReportEngine, ReportScheduler, ReportEmails],
  exports: [ReportEngine],
})
export class ReportsModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(FlagRegistry) private readonly flags: FlagRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(MailTemplateRegistry) private readonly mailTemplates: MailTemplateRegistry,
    @Inject(ReportEmails) private readonly emails: ReportEmails,
    @Inject(ReportScheduler) private readonly scheduler: ReportScheduler,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.permissions.register(reportsManifest.permissions);
    this.flags.declareModule(REPORTS_MODULE, 'Funnel and reports: off = no scheduled report is made or sent and the admin routes answer 404 (visits are still counted)');
    // Counters, staff-written report names, ids and codes: no customer data.
    this.entities.register({ entityType: 'SavedReport', model: 'SavedReport' });
    this.entities.register({ entityType: 'ReportRun', model: 'ReportRun' });
    this.entities.register({ entityType: 'RaceDailyStat', model: 'RaceDailyStat' });
    for (const t of this.emails.mailTemplates()) this.mailTemplates.register(t);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.reportsTick, async () => void (await this.scheduler.tick()));
    await this.jobs.schedule(QUEUES.reportsTick, '*/5 * * * *');
  }
}
