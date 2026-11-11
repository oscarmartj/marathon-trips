import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/platform/access/permissions';
import { QUEUE_LIST } from '../../src/platform/jobs/queues';
import { MONITOR_LIMITS, SystemMonitorService } from '../../src/platform/monitor/system-monitor.service';
import { FeatureFlagService } from '../../src/platform/flags/flags.service';
import { TestApp, createStaff, makeApp, signInStaff } from '../support/auth';
import { Platform, makePlatform } from '../support/platform';

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3600_000);
const tmp = mkdtempSync(join(tmpdir(), 'mt-monitor-'));
let t: TestApp;
let p: Platform;
/**
 * The monitor reports the whole database, so these tests start from a known state: queued and failed emails left by
 * earlier runs or other test files are removed (they are never real data in a test database), and each test removes
 * what it creates.
 */
const clearMailBacklog = () => t.prisma.outboundEmail.deleteMany({ where: { status: { in: ['queued', 'failed'] } } });
beforeAll(async () => {
  t = await makeApp();
  p = await makePlatform();
  await clearMailBacklog();
  await t.prisma.featureFlag.updateMany({ where: { key: 'platform.maintenance' }, data: { enabled: false } });
}, 60_000);
afterEach(async () => {
  await clearMailBacklog();
  await t.prisma.outboxEvent.deleteMany({ where: { type: { startsWith: 'testing.monitor' } } });
});
afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  await p.close();
  await t.close();
}, 60_000);

const staff = async (permissions: string[]) => {
  const cookie = await signInStaff(t, await createStaff(t, { permissions }));
  return () => t.http().get('/admin/system/status').set('Cookie', cookie);
};
const email = (key: string, data: Record<string, unknown> = {}) =>
  t.prisma.outboundEmail.create({
    data: { to: 'secret-person@example.test', templateKey: 'test', templateVersion: 1, locale: 'en-AU', dedupeKey: `test-monitor:${key}`, ...data },
  });

describe('system monitor (task 8.6)', () => {
  it('needs_a_staff_session_and_the_permission', async () => {
    expect((await t.http().get('/admin/system/status')).status).toBe(401);
    expect((await (await staff([PERMISSIONS.flagRead]))()).status).toBe(403);
    expect((await (await staff([PERMISSIONS.systemRead]))()).status).toBe(200);
  });

  it('reports_every_declared_queue_the_database_and_the_maintenance_switch', async () => {
    const res = await (await staff([PERMISSIONS.systemRead]))();
    expect(res.body.database.up).toBe(true);
    expect(res.body.appEnv).toBe(t.config.APP_ENV);
    expect(res.body.maintenance).toBe(false);
    expect(res.body.queues.map((q: { name: string }) => q.name).sort()).toEqual(QUEUE_LIST.map((q) => q.name).sort());
    expect(res.body.backup.state).toBe('unknown');
    expect(res.body.reasons).not.toContain('backup_unknown'); // only a problem in production
  });

  it('an_old_queued_email_and_a_failed_email_raise_attention_with_fixed_codes_and_no_personal_data', async () => {
    await email('old', { createdAt: hoursAgo(1) });
    await email('failed', { status: 'failed', error: 'bounce for secret-person@example.test' });
    const res = await (await staff([PERMISSIONS.systemRead]))();
    expect(res.body.status).toBe('attention');
    expect(res.body.reasons).toEqual(expect.arrayContaining(['mail_queued_old', 'mail_failed']));
    expect(res.body.mail.queued).toBeGreaterThanOrEqual(1);
    expect(res.body.mail.oldestQueuedSeconds).toBeGreaterThan(MONITOR_LIMITS.mailQueuedSeconds);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('secret-person');
    expect(text).not.toContain('example.test');
    expect(text).not.toContain('bounce');
  });

  it('an_undispatched_old_event_is_flagged', async () => {
    await t.prisma.outboxEvent.create({
      data: { type: 'testing.monitor', aggregateType: 'Test', aggregateId: crypto.randomUUID(), payload: {}, actorType: 'system', occurredAt: hoursAgo(1) },
    });
    const res = await (await staff([PERMISSIONS.systemRead]))();
    expect(res.body.reasons).toContain('events_pending_old');
    expect(res.body.events.pendingEvents).toBeGreaterThanOrEqual(1);
  });

  it('a_fresh_queued_email_is_not_a_problem', async () => {
    await email('fresh');
    const res = await (await staff([PERMISSIONS.systemRead]))();
    expect(res.body.reasons).not.toContain('mail_queued_old');
  });
});

describe('last backup as the monitor sees it', () => {
  const monitor = (file?: string, appEnv?: string) =>
    new SystemMonitorService(p.prisma, { ...p.config, BACKUP_STATUS_FILE: file, ...(appEnv ? { APP_ENV: appEnv as never } : {}) }, new FeatureFlagService(p.prisma));
  const write = (name: string, body: string) => {
    const f = join(tmp, name);
    writeFileSync(f, body);
    return f;
  };

  it('fresh_backup_is_ok', async () => {
    const f = write('ok.json', JSON.stringify({ finishedAt: hoursAgo(3).toISOString(), offsite: true, encrypted: true }));
    const s = await monitor(f).status();
    expect(s.backup).toMatchObject({ state: 'ok', offsite: true, encrypted: true });
    expect(s.backup.ageHours).toBeGreaterThan(2.9);
    expect(s.reasons).not.toContain('backup_stale');
  });

  it('old_backup_is_stale_and_raises_attention', async () => {
    const f = write('stale.json', JSON.stringify({ finishedAt: hoursAgo(MONITOR_LIMITS.backupStaleHours + 2).toISOString() }));
    const s = await monitor(f).status();
    expect(s.backup.state).toBe('stale');
    expect(s.status).toBe('attention');
    expect(s.reasons).toContain('backup_stale');
  });

  it('missing_or_damaged_status_file_is_unknown_never_an_error_and_a_problem_only_in_production', async () => {
    for (const f of [join(tmp, 'absent.json'), write('junk.json', 'not json'), write('wrong.json', '{"finishedAt":"yesterday-ish"}'), write('empty.json', '')]) {
      const s = await monitor(f).status();
      expect(s.backup.state).toBe('unknown');
      expect(s.reasons).not.toContain('backup_unknown');
    }
    expect((await monitor(join(tmp, 'absent.json'), 'production').status()).reasons).toContain('backup_unknown');
  });
});
