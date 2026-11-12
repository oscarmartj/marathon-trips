import { Inject, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CommonModule } from '../../platform/common/common.module';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { FlagRegistry } from '../../platform/flags/flag-registry';
import { JobsService } from '../../platform/jobs/jobs.service';
import { QUEUES } from '../../platform/jobs/queues';
import { KeyDatesAdminController } from './controller';
import { KeyDatesService } from './keydates.service';
import { KEYDATES_MODULE, keydatesManifest } from './manifest';

/** Task 7.3: the key dates calendar and the tasks it opens by itself. Reads other modules through their public API only. */
@Module({
  imports: [CommonModule],
  controllers: [KeyDatesAdminController],
  providers: [KeyDatesService],
  exports: [KeyDatesService],
})
export class KeyDatesModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(FlagRegistry) private readonly flags: FlagRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(KeyDatesService) private readonly service: KeyDatesService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.permissions.register(keydatesManifest.permissions);
    this.flags.declareModule(KEYDATES_MODULE, 'Key dates calendar: off = no tasks are opened for key dates and these routes answer 404');
    // A key date holds a staff label and a date: no customer data.
    this.entities.register({ entityType: 'KeyDate', model: 'KeyDate' });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.keydatesMaintenance, async () => void (await this.service.sweep()));
    await this.jobs.schedule(QUEUES.keydatesMaintenance, '*/30 * * * *');
  }
}
