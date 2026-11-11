import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/platform/database/prisma.service';
import { assertIdentifiersOnly } from '../../src/platform/guards/no-personal-data';
import { JobsService } from '../../src/platform/jobs/jobs.service';
import { QUEUE_LIST, QUEUES, QueueDef } from '../../src/platform/jobs/queues';
import { z } from 'zod';
import { newId, testConfig } from '../support/platform';

const config = testConfig({ JOBS_WORKERS: 'on' });
const app = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaService(config);
afterAll(async () => {
  await app.end();
  await prisma.$disconnect();
});

describe('pg-boss set-up (plan 4.5)', () => {
  it('the declared queues are exactly the ones the migrations created, with the same options', async () => {
    const { rows } = await app.query(`SELECT name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds, deletion_seconds, partition FROM pgboss.queue WHERE name NOT LIKE '\\_\\_pgboss\\_\\_%' ORDER BY name`); // pg-boss adds its own internal queues (an INSERT, no DDL)
    const expected = [...QUEUE_LIST].sort((a, b) => a.name.localeCompare(b.name)).map((q) => ({
      name: q.name, policy: q.options.policy, retry_limit: q.options.retryLimit, retry_delay: q.options.retryDelay,
      retry_backoff: q.options.retryBackoff ?? false, expire_seconds: q.options.expireInSeconds, deletion_seconds: q.options.deleteAfterSeconds, partition: false,
    }));
    expect(rows).toEqual(expected);
  });

  it('the API refuses to start when a declared queue is missing, and creates nothing', async () => {
    const missing: QueueDef = { name: 'module.never_migrated', data: z.object({}).strict(), options: { policy: 'short', retryLimit: 1, retryDelay: 1, expireInSeconds: 60, deleteAfterSeconds: 60 } };
    const jobs = new JobsService(config, [...QUEUE_LIST, missing]);
    await expect(jobs.start()).rejects.toMatchObject({ code: 'queues_missing', message: expect.stringContaining('module.never_migrated') });
    expect(jobs.started).toBe(false);
    const { rows } = await app.query(`SELECT 1 FROM pgboss.queue WHERE name = 'module.never_migrated'`);
    expect(rows).toHaveLength(0);
  });

  it('the API refuses to start when the pg-boss schema is missing, and does not create it', async () => {
    const jobs = new JobsService(config, QUEUE_LIST, 'pgboss_absent');
    await expect(jobs.start()).rejects.toMatchObject({ code: 'jobs_start_failed' });
    const { rows } = await app.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss_absent'`);
    expect(rows).toHaveLength(0);
  });

  it('mt_app can use job data but cannot create or alter anything in pgboss', async () => {
    const denied = async (sql: string) => app.query(sql).then(() => '', (e: Error) => e.message);
    expect(await denied('create table pgboss.mt_app_should_not_exist (i int)')).toMatch(/permission denied/);
    expect(await denied('alter table pgboss.queue add column x int')).toMatch(/must be owner|permission denied/);
    expect(await denied('truncate pgboss.queue')).toMatch(/permission denied/);
    expect(await denied('drop schema pgboss cascade')).toMatch(/must be owner/);
    expect((await app.query(`select has_schema_privilege('mt_app','pgboss','CREATE') c`)).rows[0].c).toBe(false);
  });

  it('job data must be identifiers only', () => {
    expect(() => assertIdentifiersOnly('job data', { outboundEmailId: newId() })).not.toThrow();
    expect(() => assertIdentifiersOnly('job data', { to: 'a@b.c', email: 'a@b.c' })).toThrow(/identifiers only/);
    expect(() => assertIdentifiersOnly('job data', { line: { totalMinor: 100, currency: 'AUD' } })).toThrow(/totalMinor/);
    const err = (() => { try { assertIdentifiersOnly('job data', { email: 'jane@example.com' }); } catch (e) { return e as Error; } return null; })();
    expect(err?.message).not.toContain('jane@');
  });
});

describe('workers', () => {
  let jobs: JobsService;
  beforeAll(async () => {
    jobs = new JobsService(config);
    await jobs.start();
  });
  afterAll(async () => jobs.stop());

  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v as T;
      if (Date.now() > end) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  it('runs a job and validates its data against the queue schema', async () => {
    const seen: unknown[] = [];
    await jobs.work(QUEUES.mailSend, async (d) => void seen.push(d), 0.5);
    const outboundEmailId = newId();
    await expect(jobs.send(QUEUES.mailSend, { outboundEmailId, extra: 1 })).rejects.toThrow(); // strict schema
    await expect(jobs.send(QUEUES.mailSend, { outboundEmailId: 'not-a-uuid' })).rejects.toThrow();
    await jobs.send(QUEUES.mailSend, { outboundEmailId });
    await waitFor(async () => seen.length > 0);
    expect(seen).toEqual([{ outboundEmailId }]);
    await app.query(`DELETE FROM pgboss.job WHERE name = 'mail.send' AND data->>'outboundEmailId' = $1`, [outboundEmailId]);
  });

  it('stores only a safe code when a job fails: no value from the error reaches pgboss.job', async () => {
    const secret = `jane.citizen-${newId()}@example.com`;
    await prisma.featureFlag.create({ data: { key: secret } });
    await jobs.work(QUEUES.eventsMaintenance, async () => void (await prisma.featureFlag.create({ data: { key: secret } })), 0.5);
    const id = await jobs.send(QUEUES.eventsMaintenance, {});
    const row = await waitFor(async () => {
      const { rows } = await app.query(`SELECT state, retry_count, output::text AS output FROM pgboss.job WHERE id = $1`, [id]);
      return rows[0]?.output ? rows[0] : null;
    });
    expect(row.output).toContain('prisma_P2002');
    expect(row.output).not.toContain('jane.citizen');
    expect(row.output).not.toContain('example.com');
    expect(row.output).not.toMatch(/\bat \w+.*\.ts:\d+/); // no stack trace
    await app.query(`DELETE FROM pgboss.job WHERE id = $1`, [id]);
    await prisma.featureFlag.deleteMany({ where: { key: secret } });
  });
});
