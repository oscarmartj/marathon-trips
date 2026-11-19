import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { AppConfig } from '../../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { safeError } from '../../../platform/errors/safe-error';
import { TasksService } from '../../../platform/common/tasks/tasks.service';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { PaymentAttemptSyncService } from './attempt-sync.service';
import type { SyncAction } from './attempt-sync.service';
import { PaymentWebhooksService } from './webhooks.service';
import { PaymentAmendmentService } from './amendment-plan.service';
import { ManualTransfersService } from './manual-transfers.service';

export const RAW_BODY_RETENTION_DAYS = 180;
export const REJECTION_RETENTION_DAYS = 30;
export const STUCK_EVENT_MINUTES = 10;
/** An event still `failed` this long after its last attempt (its job has given up) gets a task for Oscar. */
export const FAILED_EVENT_MINUTES = 30;
const DAY = 86_400_000;

/**
 * The payments sweep, every ten minutes (plan 3.1, sections 5.3, 6 and 14.6): live attempts past their expiry go to
 * the attempts queue (one job each), events stuck in `received` are queued again, raw bodies older than 180 days are
 * emptied, rejections older than 30 days deleted, and events that kept failing get a task. Also runs the workers of the three payments queues.
 */
@Injectable()
export class PaymentsMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Payments');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(PaymentAttemptSyncService) private readonly sync: PaymentAttemptSyncService,
    @Inject(PaymentWebhooksService) private readonly webhooks: PaymentWebhooksService,
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(PaymentAmendmentService) private readonly amendments: PaymentAmendmentService,
    @Inject(ManualTransfersService) private readonly transfers: ManualTransfersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work<{ webhookEventId: string }>(QUEUES.paymentsWebhooks, async (d) => void (await this.webhooks.process(d.webhookEventId)));
    await this.jobs.work<{ paymentId: string; action: SyncAction }>(QUEUES.paymentsAttempts, async (d) => void (await this.sync.run(d.paymentId, d.action)));
    await this.jobs.work(QUEUES.paymentsMaintenance, async () => void (await this.run()));
    await this.jobs.schedule(QUEUES.paymentsMaintenance, '*/10 * * * *');
  }

  async run(now: Date = new Date()): Promise<{ expiring: string[]; requeued: string[]; failedFlagged: string[]; bodiesPurged: number; rejectionsPurged: number; manualIntentsClosed: string[] }> {
    // An attempt whose collected money could not be applied waits for Oscar (its task): no loop (plan 3.2, section 11.8).
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT p.id::text AS id FROM payments p
      WHERE p."liveBookingId" IS NOT NULL AND p."pendingExpiresAt" <= ${now}
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t."sourceRef" = 'payments:coverage_failed:' || p.id::text AND t.status = 'open' AND t."deletedAt" IS NULL)
      ORDER BY p."pendingExpiresAt", p.id LIMIT 200`;
    for (const { id } of due) await this.jobs.send(QUEUES.paymentsAttempts, { paymentId: id, action: 'expire' }, { singletonKey: `expire:${id}` });
    const stuck = await this.prisma.webhookEvent.findMany({ where: { status: 'received', receivedAt: { lte: new Date(now.getTime() - STUCK_EVENT_MINUTES * 60_000) } }, select: { id: true }, take: 200 });
    for (const { id } of stuck) await this.jobs.send(QUEUES.paymentsWebhooks, { webhookEventId: id }, { singletonKey: `webhook:${id}` });
    // Events whose processing kept failing are visible as tasks (review M2): one per event while it is open.
    // Oldest first, and only those without an open task yet, so a backlog of failures never hides the new ones.
    const failed = await this.prisma.$queryRaw<Array<{ id: string; errorCode: string | null }>>`
      SELECT e.id::text AS id, e."errorCode" FROM webhook_events e
      WHERE e.status = 'failed' AND e."updatedAt" <= ${new Date(now.getTime() - FAILED_EVENT_MINUTES * 60_000)}
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t."sourceRef" = 'payments:webhook_failed:' || e.id::text AND t.status = 'open' AND t."deletedAt" IS NULL)
      ORDER BY e."updatedAt", e.id LIMIT 200`;
    const flagged: string[] = [];
    for (const ev of failed) {
      // The event is locked and read again: if processing got through meanwhile, no task (review round 3, point 3).
      const opened = await this.prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM webhook_events WHERE id = ${ev.id}::uuid FOR UPDATE`;
        if (row?.status !== 'failed') return false;
        await this.tasks.createSystemIn(tx, {
          title: 'Payment webhook could not be processed',
          description: `A payment gateway event kept failing (${ev.errorCode ?? 'unknown'}). Check the payment it belongs to and the gateway.`,
          entityType: 'WebhookEvent', entityId: ev.id, sourceRef: `payments:webhook_failed:${ev.id}`,
        });
        return true;
      });
      if (opened) flagged.push(ev.id);
    }
    // Unpaid adjustments past their due date (task 6.3, plan review M2): a task each, nothing cancelled.
    try {
      await this.prisma.$transaction((tx) => this.amendments.flagOverdueAdjustments(tx, now));
    } catch (err) {
      this.logger.error(`overdue adjustments check failed: ${safeError(err).code}`);
    }
    // Requests to pay by bank transfer that lapsed, or whose booking can no longer be paid (task 3.4).
    let manualIntentsClosed: string[] = [];
    try {
      manualIntentsClosed = await this.transfers.closeOpenIntents(now);
    } catch (err) {
      this.logger.error(`manual intent sweep failed: ${safeError(err).code}`);
    }
    let bodiesPurged = 0;
    let rejectionsPurged = 0;
    try {
      bodiesPurged = (await this.prisma.webhookEvent.updateMany({ where: { rawBody: { not: null }, receivedAt: { lt: new Date(now.getTime() - RAW_BODY_RETENTION_DAYS * DAY) } }, data: { rawBody: null } })).count;
      rejectionsPurged = (await this.prisma.webhookRejection.deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - REJECTION_RETENTION_DAYS * DAY) } } })).count;
    } catch (err) {
      this.logger.error(`payments retention failed: ${safeError(err).code}`);
    }
    return { expiring: due.map((d) => d.id), requeued: stuck.map((s) => s.id), failedFlagged: flagged, bodiesPurged, rejectionsPurged, manualIntentsClosed };
  }
}
