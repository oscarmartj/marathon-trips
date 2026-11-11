import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/platform/access/permissions';
import { runCli } from '../../src/cli';
import { FLAGS } from '../../src/platform/flags/flag-registry';
import { isMaintenanceExempt } from '../../src/platform/http/maintenance.guard';
import { STATE_HEADERS, TestApp, createStaff, makeApp, signInStaff, uniqueEmail } from '../support/auth';
import { allRoutes } from '../support/routes';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
  await setMaintenance(false); // a previous aborted run must not leave the site in maintenance
});
afterAll(async () => {
  await t.prisma.featureFlag.updateMany({ where: { key: FLAGS.maintenance }, data: { enabled: false } });
  await t.close();
});

const setMaintenance = (on: boolean) => t.prisma.featureFlag.upsert({ where: { key: FLAGS.maintenance }, create: { key: FLAGS.maintenance, enabled: on }, update: { enabled: on } });

describe('maintenance mode (task 8.6)', () => {
  it('is_declared_off_by_default_and_changeable_through_the_flag_admin_api', async () => {
    const admin = await signInStaff(t, await createStaff(t, { permissions: [PERMISSIONS.flagRead, PERMISSIONS.flagManage, PERMISSIONS.systemRead] }));
    const list = await t.http().get('/admin/flags').set('Cookie', admin);
    expect(list.body.find((f: { key: string }) => f.key === FLAGS.maintenance)).toMatchObject({ enabled: false });
    try {
      const on = await t.http().put(`/admin/flags/${FLAGS.maintenance}`).set(STATE_HEADERS).set('Cookie', admin).send({ enabled: true, reason: 'Restore drill' });
      expect(on.status).toBe(200);
      // The admin API and the monitor keep working, and the monitor says so.
      const status = await t.http().get('/admin/system/status').set('Cookie', admin);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ maintenance: true });
      expect(status.body.reasons).toContain('maintenance_on');
      const flag = await t.prisma.featureFlag.findUniqueOrThrow({ where: { key: FLAGS.maintenance } });
      const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'FeatureFlag', entityId: flag.id }, orderBy: { occurredAt: 'desc' } });
      expect(log).toMatchObject({ action: 'platform.flag.updated', actorType: 'staff' });
      // Staff switch it off again with the same API.
      expect((await t.http().put(`/admin/flags/${FLAGS.maintenance}`).set(STATE_HEADERS).set('Cookie', admin).send({ enabled: false })).status).toBe(200);
    } finally {
      await setMaintenance(false);
    }
  });

  it('answers_503_with_retry_after_to_public_and_customer_routes_and_lets_health_and_staff_sign_in_through', async () => {
    const staffUser = await createStaff(t, { permissions: [PERMISSIONS.systemRead] });
    await setMaintenance(true);
    try {
      const magic = await t.http().post('/auth/customer/magic-link').set(STATE_HEADERS).send({ email: uniqueEmail('customer') });
      expect(magic.status).toBe(503);
      expect(magic.body).toMatchObject({ code: 'maintenance' });
      expect(magic.headers['retry-after']).toBe('120');
      expect((await t.http().get('/auth/customer/session')).status).toBe(503);
      expect((await t.http().get('/health')).status).toBe(200);
      const cookie = await signInStaff(t, staffUser); // password and second factor both pass the guard
      expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(200);
      expect((await t.http().get('/admin/system/status').set('Cookie', cookie)).status).toBe(200);
    } finally {
      await setMaintenance(false);
    }
    expect((await t.http().get('/auth/customer/session')).status).not.toBe(503);
  });

  it('every_route_is_either_exempt_or_blocked_and_the_exempt_set_is_exactly_this', () => {
    const exempt = allRoutes(t.app).filter((r) => isMaintenanceExempt(r.method, r.path)).map((r) => `${r.method} ${r.path}`);
    expect(exempt.every((r) => r === 'GET /health' || r.split(' ')[1]!.startsWith('/admin/') || r.split(' ')[1]!.startsWith('/auth/staff/'))).toBe(true);
    expect(exempt).toContain('GET /health');
    // A customer route can never be exempt by accident.
    expect(allRoutes(t.app).filter((r) => r.path.startsWith('/auth/customer')).some((r) => isMaintenanceExempt(r.method, r.path))).toBe(false);
  });

  it('exempt_paths_table', () => {
    const cases: Array<[string, string, boolean]> = [
      ['GET', '/health', true], ['GET', '/health/', true], ['POST', '/health', false], ['GET', '/healthz', false],
      ['POST', '/auth/staff/sign-in', true], ['GET', '/auth/staff/session', true], ['POST', '/auth/customer/magic-link', false],
      ['GET', '/admin/flags', true], ['GET', '/admin', true], ['GET', '/administrator', false], ['GET', '/auth/staffer/x', false],
      ['GET', '/races', false], ['POST', '/webhooks/anything', false],
    ];
    for (const [m, p, want] of cases) expect(isMaintenanceExempt(m, p), `${m} ${p}`).toBe(want);
  });

  it('console_commands_switch_it_on_and_off_audited_as_the_system', async () => {
    const lines: string[] = [];
    try {
      expect(await runCli(['maintenance:on'], (l) => lines.push(l))).toBe(0);
      expect(lines.at(-1)).toBe('Maintenance mode is ON');
      expect((await t.http().get('/auth/customer/session')).status).toBe(503);
      expect(await runCli(['maintenance:status'], (l) => lines.push(l))).toBe(0);
      expect(lines.at(-1)).toBe('Maintenance mode is ON');
      expect(await runCli(['maintenance:off'], (l) => lines.push(l))).toBe(0);
      expect(lines.at(-1)).toBe('Maintenance mode is off');
      expect((await t.http().get('/auth/customer/session')).status).not.toBe(503);
      const flag = await t.prisma.featureFlag.findUniqueOrThrow({ where: { key: FLAGS.maintenance } });
      const logs = await t.prisma.auditLog.findMany({ where: { entityType: 'FeatureFlag', entityId: flag.id, actorType: 'system' } });
      expect(logs.length).toBeGreaterThanOrEqual(2);
    } finally {
      await setMaintenance(false);
    }
  });
});
