import { AppConfig, loadConfig } from '../../src/platform/config/config';
import { PrismaService } from '../../src/platform/database/prisma.service';
import { ConsumerRegistry } from '../../src/platform/events/consumers';
import { EventsService } from '../../src/platform/events/events.service';
import { OutboxService } from '../../src/platform/events/outbox.service';
import { FeatureFlagService } from '../../src/platform/flags/flags.service';
import { JobsService } from '../../src/platform/jobs/jobs.service';

export const testConfig = (overrides: Record<string, string> = {}): AppConfig => loadConfig({ ...process.env, ...overrides });

/** Real PostgreSQL and a started pg-boss (no workers), as the API would have them. */
export async function makePlatform(overrides: Record<string, string> = {}) {
  const config = testConfig({ JOBS_WORKERS: 'off', ...overrides });
  const prisma = new PrismaService(config);
  const jobs = new JobsService(config);
  await jobs.start();
  const registry = new ConsumerRegistry();
  const flags = new FeatureFlagService(prisma);
  const events = new EventsService(prisma, registry, jobs, flags);
  const outbox = new OutboxService();
  return {
    config, prisma, jobs, registry, flags, events, outbox,
    async close() {
      await jobs.stop();
      await prisma.$disconnect();
    },
  };
}

export type Platform = Awaited<ReturnType<typeof makePlatform>>;

/** Removes rows a test created (the API role may DELETE but not TRUNCATE). */
export async function cleanEvents(p: Platform, prefix = 'test-'): Promise<void> {
  await p.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'events.deliver' AND singleton_key LIKE '${prefix}%'`);
  await p.prisma.eventDelivery.deleteMany({ where: { consumer: { startsWith: prefix } } });
  await p.prisma.outboxEvent.deleteMany({ where: { type: { startsWith: 'testing.' } } });
}

export const newId = (): string => crypto.randomUUID();
