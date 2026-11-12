import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { JobsService } from '../../platform/jobs/jobs.service';
import { QUEUES } from '../../platform/jobs/queues';
import { QuoteService } from './quote.service';

/** Expires quotes nobody accepted in time, every ten minutes (plan 2.5, section 3). */
@Injectable()
export class QuoteExpiryService implements OnApplicationBootstrap {
  constructor(
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.crmMaintenance, async () => void (await this.quotes.expireDue()));
    await this.jobs.schedule(QUEUES.crmMaintenance, '*/10 * * * *');
  }
}
