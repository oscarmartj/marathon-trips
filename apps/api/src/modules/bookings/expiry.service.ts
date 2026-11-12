import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SYSTEM_ACTOR } from '../../platform/audit/audit.service';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { safeError } from '../../platform/errors/safe-error';
import { ApiError } from '../../platform/http/api-error';
import { JobsService } from '../../platform/jobs/jobs.service';
import { QUEUES } from '../../platform/jobs/queues';
import { REQUEST_TX_OPTIONS } from './request.service';
import { BookingStateMachine } from './state-machine';

/**
 * Expires requests nobody reviewed in time (plan 0.1, 6.2, "request expiry"; plan 2.4, section 5), every ten minutes,
 * each in its own transaction. A booking already changed by someone else is no change; one failure does not stop the
 * rest.
 */
@Injectable()
export class BookingExpiryService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Bookings');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BookingStateMachine) private readonly machine: BookingStateMachine,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.bookingsMaintenance, async () => void (await this.run()));
    await this.jobs.schedule(QUEUES.bookingsMaintenance, '*/10 * * * *');
  }

  async run(limit = 100): Promise<{ expired: number; failed: number }> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bookings WHERE status = 'requested' AND "requestExpiresAt" <= clock_timestamp()
      ORDER BY "requestExpiresAt", id LIMIT ${limit}`;
    let expired = 0;
    let failed = 0;
    for (const { id } of due) {
      try {
        const r = await runTransaction(this.prisma, (tx) => this.machine.transition(tx, id, 'expire_request', { actor: SYSTEM_ACTOR }), REQUEST_TX_OPTIONS);
        if (r.changed) expired++;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) continue;
        failed++;
        this.logger.error(`request expiry failed: ${safeError(err).code}`);
      }
    }
    return { expired, failed };
  }
}
