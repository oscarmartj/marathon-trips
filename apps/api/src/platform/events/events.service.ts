import { Inject, Injectable, Logger } from '@nestjs/common';
import { bossDb } from '../database/boss-db';
import { PrismaService } from '../database/prisma.service';
import { AppError, formatSafeError, safeError } from '../errors/safe-error';
import { FeatureFlagService } from '../flags/flags.service';
import { JobsService } from '../jobs/jobs.service';
import { QUEUES } from '../jobs/queues';
import { ConsumerRegistry, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_EVENT_AGE_MS, DeliveredEvent } from './consumers';

export type DeliveryOutcome = 'done' | 'skipped' | 'held' | 'noop' | 'retry' | 'failed';

const RETENTION_DAYS = 90;
const dayMs = 24 * 60 * 60 * 1000;

@Injectable()
export class EventsService {
  private readonly logger = new Logger('Events');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConsumerRegistry) private readonly registry: ConsumerRegistry,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(FeatureFlagService) private readonly flags: FeatureFlagService,
  ) {}

  /**
   * Takes pending outbox events with FOR UPDATE SKIP LOCKED (several API instances may run this), creates one
   * EventDelivery per matching consumer and one job per delivery in the same transaction, then marks the event
   * dispatched. Returns how many events were dispatched.
   */
  async dispatchPending(limit = 100, now: Date = new Date()): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const ids = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM outbox_events WHERE "dispatchedAt" IS NULL
        ORDER BY "occurredAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      for (const { id } of ids) {
        const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id }, select: { id: true, type: true } });
        for (const consumer of this.registry.forEvent(event.type)) {
          const delivery = await tx.eventDelivery.create({ data: { eventId: id, consumer: consumer.name }, select: { id: true } });
          await this.jobs.send(QUEUES.eventsDeliver, { deliveryId: delivery.id }, { db: bossDb(tx), singletonKey: `${consumer.name}:${id}` });
        }
        await tx.outboxEvent.update({ where: { id }, data: { dispatchedAt: now } });
      }
      return ids.length;
    });
  }

  /**
   * Runs one delivery. Safe to call twice: the row is locked and only a `pending` delivery is processed, so a
   * duplicate job does nothing. A handler failure rolls back its writes, then counts the attempt.
   */
  async processDelivery(deliveryId: string, now: Date = new Date()): Promise<DeliveryOutcome> {
    let consumerName = '';
    let attemptsBefore = 0;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM event_deliveries WHERE id = ${deliveryId}::uuid AND status = 'pending' FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return 'noop';
        const delivery = await tx.eventDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { event: true } });
        consumerName = delivery.consumer;
        attemptsBefore = delivery.attempts;
        const consumer = this.registry.get(delivery.consumer);
        if (!consumer) throw new AppError('consumer_not_registered', 'No consumer is registered under this delivery name');

        const settle = (status: 'done' | 'skipped') =>
          tx.eventDelivery.update({ where: { id: deliveryId }, data: { status, processedAt: now, ...(status === 'done' ? { attempts: { increment: 1 } } : {}) } });

        // A notice about something old is worse than no notice, even when the module was switched off meanwhile.
        if (consumer.notifyOnly) {
          const maxAge = consumer.maxEventAgeMs ?? DEFAULT_MAX_EVENT_AGE_MS;
          if (now.getTime() - delivery.event.occurredAt.getTime() > maxAge) {
            await settle('skipped');
            return 'skipped';
          }
        }
        if (!(await this.flags.isModuleEnabled(consumer.module, tx))) {
          if (consumer.whenDisabled === 'skip') {
            await settle('skipped');
            return 'skipped';
          }
          return 'held'; // stays pending; releaseHeld() or the sweep picks it up once the module is on
        }
        const e = delivery.event;
        const event: DeliveredEvent = {
          id: e.id, type: e.type, schemaVersion: e.schemaVersion, aggregateType: e.aggregateType, aggregateId: e.aggregateId,
          aggregateVersion: e.aggregateVersion, payload: e.payload, actorType: e.actorType, actorId: e.actorId, occurredAt: e.occurredAt,
        };
        await consumer.handle(event, { tx });
        await settle('done');
        return 'done';
      });
    } catch (err) {
      return this.recordFailure(deliveryId, consumerName, attemptsBefore, err);
    }
  }

  private async recordFailure(deliveryId: string, consumerName: string, attemptsBefore: number, err: unknown): Promise<DeliveryOutcome> {
    const info = safeError(err);
    if (!consumerName) throw err; // failed before the delivery was read (for example the database is down): let pg-boss retry
    const max = this.registry.get(consumerName)?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const attempts = attemptsBefore + 1;
    const failed = attempts >= max;
    await this.prisma.eventDelivery.updateMany({
      where: { id: deliveryId, status: 'pending' },
      data: { attempts, lastError: formatSafeError(info), ...(failed ? { status: 'failed' as const, processedAt: new Date() } : {}) },
    });
    this.logger.warn(`delivery ${deliveryId} (${consumerName}) failed: ${info.code}`);
    if (failed) return 'failed';
    throw err; // pg-boss retries with backoff; the worker wrapper stores only the safe form
  }

  /** Puts a failed delivery back to pending and enqueues it again (admin action from the monitor). */
  async retryFailed(deliveryId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.eventDelivery.updateMany({ where: { id: deliveryId, status: 'failed' }, data: { status: 'pending', attempts: 0, lastError: null, processedAt: null } });
      if (r.count === 1) await this.jobs.send(QUEUES.eventsDeliver, { deliveryId }, { db: bossDb(tx) });
    });
  }

  /**
   * Re-enqueues deliveries that have not been tried (attempts = 0) and whose module is on: events held while a
   * module was off, and jobs lost to a restart. Pass a module to release only its consumers right after enabling it.
   */
  async releaseHeld(module?: string, limit = 500): Promise<number> {
    const names = this.registry.all().filter((c) => !module || c.module === module);
    let released = 0;
    for (const consumer of names) {
      if (!(await this.flags.isModuleEnabled(consumer.module))) continue;
      const rows = await this.prisma.eventDelivery.findMany({
        where: { consumer: consumer.name, status: 'pending', attempts: 0 }, select: { id: true, eventId: true }, take: limit, orderBy: { createdAt: 'asc' },
      });
      for (const r of rows) {
        await this.jobs.send(QUEUES.eventsDeliver, { deliveryId: r.id }, { singletonKey: `${consumer.name}:${r.eventId}` });
        released += 1;
      }
    }
    return released;
  }

  /** Deletes finished deliveries and their events after 90 days, and expired idempotency records. */
  async purge(now: Date = new Date(), retentionDays = RETENTION_DAYS): Promise<{ deliveries: number; events: number; idempotency: number }> {
    const cutoff = new Date(now.getTime() - retentionDays * dayMs);
    const deliveries = await this.prisma.eventDelivery.deleteMany({
      where: { status: { in: ['done', 'skipped', 'failed'] }, event: { occurredAt: { lt: cutoff } } },
    });
    const events = await this.prisma.outboxEvent.deleteMany({ where: { dispatchedAt: { not: null }, occurredAt: { lt: cutoff }, deliveries: { none: {} } } });
    const idempotency = await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } });
    return { deliveries: deliveries.count, events: events.count, idempotency: idempotency.count };
  }

  /** The scheduled maintenance job. */
  async maintenance(now: Date = new Date()): Promise<void> {
    await this.dispatchPending(500, now);
    await this.releaseHeld();
    await this.purge(now);
  }
}
