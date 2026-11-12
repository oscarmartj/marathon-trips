import { Inject, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { AUTOMATION_EVENT_TYPES } from '@mt/shared';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CommonModule } from '../../platform/common/common.module';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { ConsumerRegistry } from '../../platform/events/consumers';
import { FlagRegistry } from '../../platform/flags/flag-registry';
import { IntegrationsModule } from '../../platform/integrations/integrations.module';
import { JobsService } from '../../platform/jobs/jobs.service';
import { QUEUES } from '../../platform/jobs/queues';
import { MailTemplateRegistry } from '../../platform/mail/templates';
import { TemplatesModule } from '../templates';
import { AutomationActions } from './actions';
import { AutomationsAdminController } from './controller';
import { AutomationEmails } from './emails';
import { AutomationEngine } from './engine';
import { AUTOMATIONS_MODULE, automationsManifest } from './manifest';
import { AutomationRulesService } from './rules.service';

export const AUTOMATIONS_CONSUMER = 'automations.rules';

/**
 * Task 7.4: rules with a trigger, conditions and a closed list of actions, run in the background with their owner's
 * current permissions, with a test mode and a run log. Never money, booking transitions or permissions.
 */
@Module({
  imports: [CommonModule, TemplatesModule, IntegrationsModule],
  controllers: [AutomationsAdminController],
  providers: [AutomationActions, AutomationRulesService, AutomationEngine, AutomationEmails],
  exports: [AutomationEngine],
})
export class AutomationsModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(FlagRegistry) private readonly flags: FlagRegistry,
    @Inject(ConsumerRegistry) private readonly consumers: ConsumerRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(MailTemplateRegistry) private readonly mailTemplates: MailTemplateRegistry,
    @Inject(AutomationEngine) private readonly engine: AutomationEngine,
    @Inject(AutomationEmails) private readonly emails: AutomationEmails,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.permissions.register(automationsManifest.permissions);
    this.flags.declareModule(AUTOMATIONS_MODULE, 'Automations: off = no rule runs (events wait until it is on again) and these routes answer 404');
    // Rules and runs hold no customer data: ids and codes, and staff-written names and task titles.
    this.entities.register({ entityType: 'AutomationRule', model: 'AutomationRule' });
    this.entities.register({ entityType: 'AutomationRun', model: 'AutomationRun' });
    for (const t of this.emails.mailTemplates()) this.mailTemplates.register(t);
    // hold: bookings.* events must never be dropped while the module is off; the engine logs events older than 48 h
    // as skipped instead of acting on them.
    this.consumers.register({
      name: AUTOMATIONS_CONSUMER, module: AUTOMATIONS_MODULE, events: AUTOMATION_EVENT_TYPES, whenDisabled: 'hold',
      handle: async (event, { tx }) => void (await this.engine.onEvent(event, tx)),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.start();
    await this.jobs.work<{ runId: string }>(QUEUES.automationsRun, async (d) => void (await this.engine.processRun(d.runId)));
    await this.jobs.work(QUEUES.automationsTick, async () => void (await this.engine.tick()));
    await this.jobs.work(QUEUES.automationsMaintenance, async () => void (await this.engine.maintenance()));
    await this.jobs.schedule(QUEUES.automationsTick, '* * * * *');
    await this.jobs.schedule(QUEUES.automationsMaintenance, '17 * * * *');
  }
}
