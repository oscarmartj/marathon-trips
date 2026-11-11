import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import type { Db, Job } from 'pg-boss';
import { AppConfig } from '../config/config';
import { APP_CONFIG } from '../database/prisma.service';
import { AppError, SafeJobError, safeError } from '../errors/safe-error';
import { assertIdentifiersOnly } from '../guards/no-personal-data';
import { QUEUE_LIST, QueueDef } from './queues';

export const PGBOSS_SCHEMA = 'pgboss';
const QUEUE_TOKEN = Symbol('JOBS_QUEUES');
const SCHEMA_TOKEN = Symbol('JOBS_SCHEMA');

export interface SendJobOptions {
  /** Run the insert in the caller's transaction (see PrismaService.asBossDb). */
  db?: Db;
  singletonKey?: string;
  startAfter?: number | Date;
}

/**
 * Thin wrapper over pg-boss (plan 4.5). The schema and queues are created by migrations as mt_owner, so pg-boss
 * runs with migrate: false and createSchema: false, and the API refuses to start if a declared queue is missing.
 */
// Built by a factory in PlatformModule (the queue list is a plain value), so no @Inject on the second argument.
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private boss: PgBoss | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(QUEUE_TOKEN) private readonly queues: readonly QueueDef[] = QUEUE_LIST,
    @Optional() @Inject(SCHEMA_TOKEN) private readonly schema: string = PGBOSS_SCHEMA,
  ) {}

  get started(): boolean {
    return this.boss !== null;
  }

  async start(): Promise<void> {
    if (this.boss) return;
    const workers = this.config.JOBS_WORKERS === 'on';
    const boss = new PgBoss({
      connectionString: this.config.DATABASE_URL,
      schema: this.schema,
      migrate: false,
      createSchema: false,
      supervise: workers,
      schedule: workers,
      max: 5,
      application_name: 'marathon-trips-api',
    });
    // Errors from pg-boss can quote values; log only the safe form.
    boss.on('error', (err: unknown) => this.logger.error(safeError(err).code));
    try {
      await boss.start();
      await this.assertQueues(boss);
    } catch (err) {
      await boss.stop({ graceful: false }).catch(() => undefined);
      if (err instanceof AppError) throw err;
      throw new AppError('jobs_start_failed', `pg-boss could not start (${safeError(err).code}); run the migrations first`);
    }
    this.boss = boss;
  }

  /** Compares the declared queues with pgboss.queue. Never creates anything. */
  private async assertQueues(boss: PgBoss): Promise<void> {
    const existing = new Set((await boss.getQueues()).map((q) => q.name));
    const missing = this.queues.map((q) => q.name).filter((n) => !existing.has(n));
    if (missing.length > 0) {
      throw new AppError('queues_missing', `Missing pg-boss queues: ${missing.join(', ')}. Run the database migrations.`);
    }
  }

  private get b(): PgBoss {
    if (!this.boss) throw new AppError('jobs_not_started', 'JobsService.start() has not completed');
    return this.boss;
  }

  async send(queue: QueueDef, data: object, options: SendJobOptions = {}): Promise<string | null> {
    const parsed = queue.data.parse(data);
    assertIdentifiersOnly('job data', parsed);
    return this.b.send(queue.name, parsed, options);
  }

  /** Runs the handler for each job. A failure is rethrown as a SafeJobError so pg-boss stores a code, not values. */
  async work<T extends object>(queue: QueueDef, handler: (data: T, job: Job<T>) => Promise<void>, pollingIntervalSeconds = 2): Promise<void> {
    await this.b.work<T>(queue.name, { batchSize: 1, pollingIntervalSeconds }, async (jobs: Job<T>[]) => {
      for (const job of jobs) {
        try {
          await handler(job.data, job);
        } catch (err) {
          throw new SafeJobError(safeError(err));
        }
      }
    });
  }

  async schedule(queue: QueueDef, cron: string): Promise<void> {
    await this.b.schedule(queue.name, cron, {});
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    if (boss) await boss.stop({ graceful: true, timeout: 10000 });
  }
}
