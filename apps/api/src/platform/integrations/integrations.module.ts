import { Inject, Logger, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../access/permissions';
import { AuthModule } from '../auth/auth.module';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../database/prisma.service';
import { ConsumerRegistry } from '../events/consumers';
import { FlagRegistry } from '../flags/flag-registry';
import { JobsService } from '../jobs/jobs.service';
import { QUEUES } from '../jobs/queues';
import { ApiKeysService } from './api-keys.service';
import { IntegrationsController } from './integrations.controller';
import { INTEGRATIONS_MODULE, INTEGRATIONS_PERMISSION_DEFS } from './permissions';
import { WEBHOOK_EVENT_CATALOGUE } from './webhook-catalogue';
import { devAllowlist, WebhookDeliveryService } from './webhook-delivery.service';
import { WebhooksService } from './webhooks.service';

export const WEBHOOK_CONSUMER = 'integrations.webhooks';

/**
 * Task 8.4: API key and webhook administration, the outbox consumer that fans events out to webhooks, and the send
 * and maintenance workers. API key authentication itself lives in PlatformModule (the global access guard needs it).
 */
@Module({
  imports: [AuthModule],
  controllers: [IntegrationsController],
  providers: [ApiKeysService, WebhooksService, WebhookDeliveryService],
  exports: [WebhookDeliveryService],
})
export class IntegrationsModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('Integrations');

  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(FlagRegistry) private readonly flags: FlagRegistry,
    @Inject(ConsumerRegistry) private readonly consumers: ConsumerRegistry,
    @Inject(WebhookDeliveryService) private readonly deliveries: WebhookDeliveryService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.permissions.register(INTEGRATIONS_PERMISSION_DEFS);
    this.flags.declareModule(INTEGRATIONS_MODULE, 'API keys and outgoing webhooks: off = no key authenticates and no webhook is sent');
    // Notice-only: none of these types is a payments, bookings or changes event, so "skip" is allowed. A later task
    // that adds one must switch to "hold" and handle the backlog while the module is off (plan 4.3).
    this.consumers.register({
      name: WEBHOOK_CONSUMER, module: INTEGRATIONS_MODULE, events: WEBHOOK_EVENT_CATALOGUE.map((e) => e.type), whenDisabled: 'skip', notifyOnly: true,
      maxEventAgeMs: 48 * 3600_000,
      handle: async (event, { tx }) => void (await this.deliveries.fanOut(event, tx)),
    });
    const allow = devAllowlist(this.config);
    if (allow.warning) this.logger.warn(allow.warning);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.start(); // idempotent; PlatformModule starts it too
    await this.jobs.work<{ deliveryId: string }>(QUEUES.webhooksSend, async (d) => void (await this.deliveries.processSend(d.deliveryId)));
    await this.jobs.work(QUEUES.webhooksMaintenance, async () => void (await this.deliveries.maintenance()));
    await this.jobs.schedule(QUEUES.webhooksMaintenance, '*/5 * * * *');
  }
}
