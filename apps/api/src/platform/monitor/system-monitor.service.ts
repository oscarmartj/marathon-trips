import { Inject, Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { AppConfig } from '../config/config';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { FLAGS } from '../flags/flag-registry';
import { FeatureFlagService } from '../flags/flags.service';
import { QUEUE_LIST } from '../jobs/queues';

/** Thresholds, in seconds unless the name says otherwise. One place, so the monitor and its tests agree. */
export const MONITOR_LIMITS = {
  queueWaitingSeconds: 300,
  outboxPendingSeconds: 300,
  mailQueuedSeconds: 600,
  backupStaleHours: 26,
} as const;

export type BackupState = 'ok' | 'stale' | 'unknown';

export interface SystemStatus {
  status: 'ok' | 'attention';
  /** Fixed codes such as queue_backlog:mail.send. Never a value from the database. */
  reasons: string[];
  checkedAt: string;
  appEnv: string;
  database: { up: true; roundTripMs: number };
  maintenance: boolean;
  queues: Array<{ name: string; waiting: number; active: number; failedLast24h: number; oldestWaitingSeconds: number | null }>;
  events: { pendingEvents: number; oldestPendingSeconds: number | null; pendingDeliveries: number; failedDeliveries: number };
  mail: { queued: number; oldestQueuedSeconds: number | null; failedLast24h: number };
  backup: { state: BackupState; finishedAt: string | null; ageHours: number | null; offsite: boolean | null; encrypted: boolean | null };
  /** Outgoing webhooks (task 8.4): counts only, never an address. */
  webhooks: { pending: number; sending: number; oldestPendingSeconds: number | null; failedLast24h: number; autoDisabledSubscriptions: number };
}

const seconds = (from: Date | null, now: Date): number | null => (from ? Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000)) : null);

/**
 * Task 8.6, the "system monitor" of docs/architecture.md. Counts, ages, queue names and fixed codes only: no addresses,
 * no job data and no error text ever leave this service. Webhook-out health is in `webhooks` (task 8.4).
 */
@Injectable()
export class SystemMonitorService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
  ) {}

  async status(now: Date = new Date()): Promise<SystemStatus> {
    const t0 = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    const roundTripMs = Date.now() - t0;
    const day = new Date(now.getTime() - 24 * 3600 * 1000);

    const [jobRows, pendingEvents, oldestEvent, deliveries, mailGroups, oldestMail, mailFailed, maintenance, backup, webhooks] = await Promise.all([
      this.prisma.$queryRaw<Array<{ name: string; waiting: number; active: number; failed: number; oldest: Date | null }>>`
        SELECT name,
               count(*) FILTER (WHERE state IN ('created', 'retry'))::int AS waiting,
               count(*) FILTER (WHERE state = 'active')::int AS active,
               count(*) FILTER (WHERE state = 'failed' AND completed_on > ${day})::int AS failed,
               min(created_on) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now()) AS oldest
        FROM pgboss.job GROUP BY name`,
      this.prisma.outboxEvent.count({ where: { dispatchedAt: null } }),
      this.prisma.outboxEvent.aggregate({ where: { dispatchedAt: null }, _min: { occurredAt: true } }),
      this.prisma.eventDelivery.groupBy({ by: ['status'], where: { status: { in: ['pending', 'failed'] } }, _count: { _all: true } }),
      this.prisma.outboundEmail.count({ where: { status: 'queued' } }),
      this.prisma.outboundEmail.aggregate({ where: { status: 'queued' }, _min: { createdAt: true } }),
      this.prisma.outboundEmail.count({ where: { status: 'failed', updatedAt: { gt: day } } }),
      this.flags.isEnabled(FLAGS.maintenance),
      this.backupState(now),
      this.webhookState(now, day),
    ]);

    const byName = new Map(jobRows.map((r) => [r.name, r]));
    const queues = QUEUE_LIST.map((q) => {
      const r = byName.get(q.name);
      return { name: q.name, waiting: r?.waiting ?? 0, active: r?.active ?? 0, failedLast24h: r?.failed ?? 0, oldestWaitingSeconds: seconds(r?.oldest ?? null, now) };
    });
    const delivery = (s: string) => deliveries.find((d) => d.status === s)?._count._all ?? 0;
    const events = { pendingEvents, oldestPendingSeconds: seconds(oldestEvent._min.occurredAt, now), pendingDeliveries: delivery('pending'), failedDeliveries: delivery('failed') };
    const mail = { queued: mailGroups, oldestQueuedSeconds: seconds(oldestMail._min.createdAt, now), failedLast24h: mailFailed };

    const reasons: string[] = [];
    if (maintenance) reasons.push('maintenance_on');
    for (const q of queues) {
      if ((q.oldestWaitingSeconds ?? 0) > MONITOR_LIMITS.queueWaitingSeconds) reasons.push(`queue_backlog:${q.name}`);
      if (q.failedLast24h > 0) reasons.push(`queue_failed:${q.name}`);
    }
    if ((events.oldestPendingSeconds ?? 0) > MONITOR_LIMITS.outboxPendingSeconds) reasons.push('events_pending_old');
    if (events.failedDeliveries > 0) reasons.push('event_deliveries_failed');
    if ((mail.oldestQueuedSeconds ?? 0) > MONITOR_LIMITS.mailQueuedSeconds) reasons.push('mail_queued_old');
    if (mail.failedLast24h > 0) reasons.push('mail_failed');
    if (webhooks.failedLast24h > 0) reasons.push('webhook_deliveries_failed');
    if (webhooks.autoDisabledSubscriptions > 0) reasons.push('webhooks_auto_disabled');
    if (backup.state === 'stale') reasons.push('backup_stale');
    // Outside production nobody runs the backup script, so "unknown" is only a problem there.
    if (backup.state === 'unknown' && this.config.APP_ENV === 'production') reasons.push('backup_unknown');

    return {
      status: reasons.length === 0 ? 'ok' : 'attention',
      reasons,
      checkedAt: now.toISOString(),
      appEnv: this.config.APP_ENV,
      database: { up: true, roundTripMs },
      maintenance,
      queues,
      events,
      mail,
      backup,
      webhooks,
    };
  }

  async webhookState(now: Date, day: Date): Promise<SystemStatus['webhooks']> {
    const [pending, sending, oldest, failed, autoDisabled] = await Promise.all([
      this.prisma.webhookDelivery.count({ where: { status: 'pending' } }),
      this.prisma.webhookDelivery.count({ where: { status: 'sending' } }),
      this.prisma.webhookDelivery.aggregate({ where: { status: 'pending' }, _min: { createdAt: true } }),
      this.prisma.webhookDelivery.count({ where: { status: 'failed', lastAttemptAt: { gt: day } } }),
      this.prisma.webhookSubscription.count({ where: { deletedAt: null, disabledReason: 'consecutive_failures' } }),
    ]);
    return { pending, sending, oldestPendingSeconds: seconds(oldest._min.createdAt, now), failedLast24h: failed, autoDisabledSubscriptions: autoDisabled };
  }

  /** Reads the file backup.sh writes after a good backup. Missing, unreadable or malformed is "unknown", never an error. */
  async backupState(now: Date): Promise<SystemStatus['backup']> {
    const unknown = { state: 'unknown' as const, finishedAt: null, ageHours: null, offsite: null, encrypted: null };
    const file = this.config.BACKUP_STATUS_FILE;
    if (!file) return unknown;
    try {
      const j = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      const finished = typeof j.finishedAt === 'string' ? new Date(j.finishedAt) : null;
      if (!finished || Number.isNaN(finished.getTime())) return unknown;
      const ageHours = Math.max(0, Math.round(((now.getTime() - finished.getTime()) / 3600_000) * 10) / 10);
      return {
        state: ageHours > MONITOR_LIMITS.backupStaleHours ? 'stale' : 'ok',
        finishedAt: finished.toISOString(),
        ageHours,
        offsite: typeof j.offsite === 'boolean' ? j.offsite : null,
        encrypted: typeof j.encrypted === 'boolean' ? j.encrypted : null,
      };
    } catch {
      return unknown;
    }
  }
}
