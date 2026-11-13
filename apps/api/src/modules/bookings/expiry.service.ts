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
import { WaitlistOffersService } from './waitlist-offers.service';

/** The job payments queues when an attempt ends on an approval already past its time (plan 3.2, section 11, point 9). */
export const approvalExpiryJob = (bookingId: string) => ({ data: { bookingId }, singletonKey: `expire-approval:${bookingId}` });

/**
 * Expires requests nobody reviewed in time (plan 0.1, 6.2, "request expiry"; plan 2.4, section 5), every ten minutes,
 * each in its own transaction. A booking already changed by someone else is no change; one failure does not stop the
 * rest. Task 3.2 adds approvals whose deposit time ran out (plan 0.1, 6.2): payments' hook refuses (409, counted as
 * blocked) while a payment attempt is live or the deposit is covered. A job with a booking id evaluates that one only.
 */
@Injectable()
export class BookingExpiryService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Bookings');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BookingStateMachine) private readonly machine: BookingStateMachine,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WaitlistOffersService) private readonly offers: WaitlistOffersService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work<{ bookingId?: string }>(QUEUES.bookingsMaintenance, async (d) => {
      if (d?.bookingId) await this.expireApproval(d.bookingId);
      else {
        await this.run();
        // Waiting list offers past their time end too, and their places move on (task 6.5).
        await this.offers.expireOffers();
      }
    });
    await this.jobs.schedule(QUEUES.bookingsMaintenance, '*/10 * * * *');
  }

  async run(limit = 100): Promise<{ expired: number; failed: number; approvalsExpired: number; approvalsBlocked: number }> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bookings WHERE status = 'requested' AND "requestExpiresAt" <= clock_timestamp()
      ORDER BY "requestExpiresAt", id LIMIT ${limit}`;
    let expired = 0;
    let failed = 0;
    for (const { id } of due) {
      const r = await this.one(id, 'expire_request');
      if (r === 'changed') expired++;
      if (r === 'failed') failed++;
    }
    // Approvals: blocked ones stay first in the order, so the batch is larger than the number that can be blocked at once.
    const approvals = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bookings WHERE status = 'approved' AND "approvalExpiresAt" <= clock_timestamp()
      ORDER BY "approvalExpiresAt", id LIMIT ${limit * 5}`;
    let approvalsExpired = 0;
    let approvalsBlocked = 0;
    for (const { id } of approvals) {
      const r = await this.one(id, 'expire_approval');
      if (r === 'changed') approvalsExpired++;
      if (r === 'blocked') approvalsBlocked++;
      if (r === 'failed') failed++;
    }
    return { expired, failed, approvalsExpired, approvalsBlocked };
  }

  /** One approval, from the job payments queues when an attempt ends (plan 3.2, section 3). */
  expireApproval(bookingId: string): Promise<'changed' | 'unchanged' | 'blocked' | 'failed'> {
    return this.one(bookingId, 'expire_approval');
  }

  private async one(id: string, event: 'expire_request' | 'expire_approval'): Promise<'changed' | 'unchanged' | 'blocked' | 'failed'> {
    try {
      const r = await runTransaction(this.prisma, (tx) => this.machine.transition(tx, id, event, { actor: SYSTEM_ACTOR }), REQUEST_TX_OPTIONS);
      return r.changed ? 'changed' : 'unchanged';
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return 'blocked';
      this.logger.error(`${event === 'expire_request' ? 'request' : 'approval'} expiry failed: ${safeError(err).code}`);
      return 'failed';
    }
  }
}
