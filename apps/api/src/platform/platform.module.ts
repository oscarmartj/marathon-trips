import { Global, Inject, Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { loadConfig } from './config/config';
import type { AppConfig } from './config/config';
import { APP_CONFIG, PrismaService } from './database/prisma.service';
import { AccessGuard } from './access/access.guard';
import { AccessService } from './access/access.service';
import { PermissionRegistry } from './access/permissions';
import { AuditService } from './audit/audit.service';
import { SessionService } from './auth/session.service';
import { ConsumerRegistry } from './events/consumers';
import { EventsService } from './events/events.service';
import { OutboxService } from './events/outbox.service';
import { EntityRegistry } from './entities/entity-registry';
import { FeatureFlagService, SettingsService } from './flags/flags.service';
import { FlagRegistry } from './flags/flag-registry';
import { RequiresFlagGuard } from './flags/requires-flag.guard';
import { RequiresModuleGuard } from './flags/requires-module.guard';
import { MaintenanceGuard } from './http/maintenance.guard';
import { RawBodyRoutes } from './http/raw-body';
import { SystemMonitorService } from './monitor/system-monitor.service';
import { ApiKeyAuthService } from './integrations/api-key-auth.service';
import { CsrfGuard } from './http/csrf.guard';
import { AuthRateLimitGuard } from './http/rate-limit.guard';
import { IdempotencyService } from './idempotency/idempotency.service';
import { JobsService } from './jobs/jobs.service';
import { QUEUES, QUEUE_LIST } from './jobs/queues';
import { MAIL_SENDER, MailSender } from './mail/mail-sender';
import { MailService } from './mail/mail.service';
import { SmtpMailSender } from './mail/smtp-mail-sender';
import { MailTemplateRegistry } from './mail/templates';
import { NumberSequenceService } from './sequences/number-sequence.service';
import { FILE_STORAGE, FileStorage } from './storage/file-storage';
import { FilesystemFileStorage } from './storage/filesystem-storage';
import { StoredFileService } from './storage/stored-file.service';

export const QUEUE_DEFS = Symbol('QUEUE_DEFS');

/** Starts pg-boss, registers the workers and runs the outbox poller. Nothing else in the API starts jobs. */
@Injectable()
class PlatformLifecycle implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs.start(); // throws, and the API does not start, when pgboss or a declared queue is missing
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work<{ deliveryId: string }>(QUEUES.eventsDeliver, async (d) => void (await this.events.processDelivery(d.deliveryId)));
    await this.jobs.work<{ outboundEmailId: string }>(QUEUES.mailSend, async (d) => void (await this.mail.processSend(d.outboundEmailId)));
    await this.jobs.work(QUEUES.eventsMaintenance, async () => this.events.maintenance());
    await this.jobs.schedule(QUEUES.eventsMaintenance, '*/5 * * * *');
    let running = false;
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      this.events.dispatchPending().catch(() => undefined).finally(() => { running = false; });
    }, this.config.EVENTS_POLL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
}

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    PrismaService,
    { provide: QUEUE_DEFS, useValue: QUEUE_LIST },
    { provide: JobsService, useFactory: (c: AppConfig, q: typeof QUEUE_LIST) => new JobsService(c, q), inject: [APP_CONFIG, QUEUE_DEFS] },
    ConsumerRegistry, OutboxService, EventsService, FeatureFlagService, SettingsService, RequiresModuleGuard,
    IdempotencyService, NumberSequenceService, EntityRegistry, MailTemplateRegistry, MailService, StoredFileService,
    AuditService, PermissionRegistry, AccessService, SessionService, FlagRegistry,
    RequiresFlagGuard, CsrfGuard, AuthRateLimitGuard, AccessGuard, MaintenanceGuard, SystemMonitorService, ApiKeyAuthService, RawBodyRoutes,
    {
      provide: FILE_STORAGE,
      useFactory: (c: AppConfig): FileStorage =>
        new FilesystemFileStorage({ rootDir: c.FILE_STORAGE_DIR, signingKey: c.FILE_SIGNING_KEY, baseUrl: c.API_BASE_URL }),
      inject: [APP_CONFIG],
    },
    { provide: MAIL_SENDER, useFactory: (c: AppConfig): MailSender => new SmtpMailSender(c.SMTP_HOST, c.SMTP_PORT), inject: [APP_CONFIG] },
    PlatformLifecycle,
  ],
  exports: [
    APP_CONFIG, PrismaService, JobsService, ConsumerRegistry, OutboxService, EventsService, FeatureFlagService, SettingsService,
    RequiresModuleGuard, IdempotencyService, NumberSequenceService, EntityRegistry, MailTemplateRegistry, MailService, StoredFileService, FILE_STORAGE,
    AuditService, PermissionRegistry, AccessService, SessionService, FlagRegistry, RequiresFlagGuard, CsrfGuard, AuthRateLimitGuard, AccessGuard, MaintenanceGuard, SystemMonitorService,
    ApiKeyAuthService, RawBodyRoutes,
  ],
})
export class PlatformModule {}
