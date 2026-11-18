import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OWNER_ROLE } from '../../src/platform/access/access.service';
import { PERMISSIONS } from '../../src/platform/access/permissions';
import { AuthMaintenanceService } from '../../src/platform/auth/auth-maintenance.service';
import { FLAGS } from '../../src/platform/flags/flag-registry';
import { SettingsService } from '../../src/platform/flags/flags.service';
import { STATE_HEADERS, StaffFixture, TestApp, cookieFrom, createStaff, freshCode, makeApp, signInStaff, uniqueEmail } from '../support/auth';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
  const settings = t.app.get(SettingsService);
  if (!settings.definition('test.welcomeBanner')) settings.define('test.welcomeBanner', z.boolean(), 1, { description: 'test setting' });
  if (!settings.definition('test.money')) settings.define('test.money', z.string().length(3), 1, { financial: true, description: 'test financial setting' });
});
afterAll(async () => {
  await t.prisma.setting.deleteMany({ where: { key: { startsWith: 'test.' } } });
  await t.close();
});

const as = async (s: StaffFixture) => {
  let cookie = await signInStaff(t, s);
  // Task 8.5: a step-up renews the session token, so the client keeps the cookie it is given (as a browser does).
  const keep = <R extends { headers: Record<string, unknown> }>(r: R): R => {
    const renewed = cookieFrom(r, 'mt_staff_session');
    if (renewed) cookie = `mt_staff_session=${renewed}`;
    return r;
  };
  return {
    get: (path: string) => t.http().get(path).set('Cookie', cookie),
    post: async (path: string, body: object = {}) => keep(await t.http().post(path).set(STATE_HEADERS).set('Cookie', cookie).send(body)),
    patch: (path: string, body: object) => t.http().patch(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
    put: (path: string, body: object) => t.http().put(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
  };
};
const manager = (extra: string[] = []) => createStaff(t, { permissions: [PERMISSIONS.userRead, PERMISSIONS.userManage, ...extra] });

describe('audit of admin changes (phase 0 criterion)', () => {
  it('flag_change_audited_with_before_and_after', async () => {
    const admin = await as(await createStaff(t, { permissions: [PERMISSIONS.flagRead, PERMISSIONS.flagManage] }));
    const before = (await admin.get('/admin/flags')).body.find((f: { key: string }) => f.key === FLAGS.customerSignIn);
    expect(before.enabled).toBe(true);
    const res = await admin.put(`/admin/flags/${FLAGS.customerSignIn}`, { enabled: false, reason: 'Testing the switch' });
    expect(res.status).toBe(200);
    try {
      const flag = await t.prisma.featureFlag.findUniqueOrThrow({ where: { key: FLAGS.customerSignIn } });
      const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'FeatureFlag', entityId: flag.id }, orderBy: { occurredAt: 'desc' }, include: { piiValues: true } });
      expect(log.action).toBe('platform.flag.updated');
      expect(log.actorType).toBe('staff');
      expect(log.sessionId).toBeTruthy();
      expect(log.changes).toEqual({ enabled: { before: true, after: false }, _reason: '[pii]' });
      expect(log.piiValues).toEqual([expect.objectContaining({ field: '_reason', after: 'Testing the switch' })]);
      // And the history route shows it, without the personal values.
      const reader = await as(await createStaff(t, { permissions: [PERMISSIONS.auditRead] }));
      const history = await reader.get(`/admin/audit?entityType=FeatureFlag&entityId=${flag.id}`);
      expect(history.body[0]).toMatchObject({ action: 'platform.flag.updated', changes: { enabled: { before: true, after: false }, _reason: '[pii]' } });
      expect(JSON.stringify(history.body)).not.toContain('Testing the switch');
    } finally {
      await admin.put(`/admin/flags/${FLAGS.customerSignIn}`, { enabled: true });
    }
  });

  it('unknown_flag_key_404', async () => {
    const admin = await as(await createStaff(t, { permissions: [PERMISSIONS.flagManage] }));
    expect((await admin.put('/admin/flags/module.not_declared', { enabled: true })).status).toBe(404);
    expect(await t.prisma.featureFlag.count({ where: { key: 'module.not_declared' } })).toBe(0);
  });

  it('setting_change_audited_with_before_and_after, with optimistic locking', async () => {
    const admin = await as(await createStaff(t, { permissions: [PERMISSIONS.settingRead, PERMISSIONS.settingManage] }));
    await t.prisma.setting.deleteMany({ where: { key: 'test.welcomeBanner' } });
    expect((await admin.put('/admin/settings/test.welcomeBanner', { value: true, version: 0 })).body).toEqual({ version: 1 });
    expect((await admin.put('/admin/settings/test.welcomeBanner', { value: false, version: 0 })).body.code).toBe('version_conflict');
    expect((await admin.put('/admin/settings/test.welcomeBanner', { value: 'yes', version: 1 })).status).toBe(422);
    expect((await admin.put('/admin/settings/test.welcomeBanner', { value: false, version: 1 })).body).toEqual({ version: 2 });
    const row = await t.prisma.setting.findUniqueOrThrow({ where: { key: 'test.welcomeBanner' } });
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Setting', entityId: row.id }, orderBy: { occurredAt: 'desc' } });
    expect(log.changes).toEqual({ value: { before: true, after: false } });
  });

  it('financial_setting_requires_step_up (M12)', async () => {
    const plain = await as(await createStaff(t, { permissions: [PERMISSIONS.settingManage] }));
    expect((await plain.put('/admin/settings/test.money', { value: 'AUD', version: 0 })).status).toBe(403);
    const s = await createStaff(t, { permissions: [PERMISSIONS.settingManage, PERMISSIONS.settingManageFinancial] });
    const fin = await as(s);
    await t.prisma.session.updateMany({ where: { userId: s.id }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    expect((await fin.put('/admin/settings/test.money', { value: 'AUD', version: 0 })).body.code).toBe('step_up_required');
    await fin.post('/auth/staff/step-up', { code: await freshCode(t, s) });
    await t.prisma.setting.deleteMany({ where: { key: 'test.money' } });
    expect((await fin.put('/admin/settings/test.money', { value: 'AUD', version: 0 })).status).toBe(200);
  });

  it('role_permissions_change_audited; owner_role_not_editable; version conflict', async () => {
    const owner = await as(await createStaff(t, { owner: true }));
    const key = `ops${Date.now().toString(36)}`;
    expect((await owner.post('/admin/roles', { key, name: 'Operations' })).status).toBe(201);
    const set = await owner.put(`/admin/roles/${key}/permissions`, { permissionKeys: [PERMISSIONS.flagRead, PERMISSIONS.auditRead], version: 0, reason: 'Ops needs flags' });
    expect(set.body).toEqual({ version: 1 });
    expect((await owner.put(`/admin/roles/${key}/permissions`, { permissionKeys: [], version: 0 })).body.code).toBe('version_conflict');
    const role = await t.prisma.role.findUniqueOrThrow({ where: { key } });
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Role', entityId: role.id, action: 'access.role.permissionsChanged' } });
    expect(log.changes).toEqual({ permissionKeys: { before: [], after: [PERMISSIONS.auditRead, PERMISSIONS.flagRead] }, _reason: '[pii]' });
    expect((await owner.put(`/admin/roles/${OWNER_ROLE}/permissions`, { permissionKeys: [], version: 0 })).body.code).toBe('role_not_editable');
    expect((await owner.put('/admin/roles/does_not_exist/permissions', { permissionKeys: [], version: 0 })).status).toBe(404);
    expect((await owner.put(`/admin/roles/${key}/permissions`, { permissionKeys: ['made.up.permission'], version: 1 })).body.code).toBe('permission_unknown');
  });
});

describe('who may act on whom (G1, T9)', () => {
  it('cannot_grant_permission_actor_lacks', async () => {
    const actor = await createStaff(t, { permissions: [PERMISSIONS.roleRead, PERMISSIONS.roleManage, PERMISSIONS.flagRead] });
    const api = await as(actor);
    const key = `g${Date.now().toString(36)}`;
    await t.prisma.role.create({ data: { key, name: 'Granted' } });
    expect((await api.put(`/admin/roles/${key}/permissions`, { permissionKeys: [PERMISSIONS.flagManage], version: 0 })).body.code).toBe('cannot_grant_permission_actor_lacks');
    expect((await api.put(`/admin/roles/${key}/permissions`, { permissionKeys: [PERMISSIONS.flagRead], version: 0 })).status).toBe(200);
  });

  it('only_owner_assigns_owner and a manager cannot hand out a role with more than they hold', async () => {
    const m = await as(await manager());
    expect((await m.post('/admin/staff', { email: uniqueEmail(), roleKeys: [OWNER_ROLE] })).body.code).toBe('only_owner_assigns_owner');
    const strongKey = `s${Date.now().toString(36)}`;
    const strong = await t.prisma.role.create({ data: { key: strongKey, name: 'Strong' } });
    await t.prisma.rolePermission.create({ data: { roleId: strong.id, permissionKey: PERMISSIONS.flagManage } });
    expect((await m.post('/admin/staff', { email: uniqueEmail(), roleKeys: [strongKey] })).body.code).toBe('role_has_more_permissions');
    const ok = await m.post('/admin/staff', { email: uniqueEmail(), roleKeys: [] });
    expect(ok.status).toBe(201);
    expect(ok.body.enrolmentUrl).toMatch(/\/admin\/enrol#token=[A-Za-z0-9_-]{43}$/);
  });

  it('cannot_reset_user_with_permissions_actor_lacks (no account take-over through a reset link)', async () => {
    const m = await as(await manager());
    const stronger = await createStaff(t, { permissions: [PERMISSIONS.flagManage] });
    const res = await m.post(`/admin/staff/${stronger.id}/reset-enrolment`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('target_has_more_permissions');
    expect(res.body.enrolmentUrl).toBeUndefined();
    expect(await t.prisma.loginToken.count({ where: { userId: stronger.id, purpose: 'staff_enrolment' } })).toBe(0);
    for (const action of ['disable', 'enable']) expect((await m.post(`/admin/staff/${stronger.id}/${action}`)).status).toBe(403);
    const weaker = await createStaff(t, { permissions: [PERMISSIONS.userRead] });
    const reset = await m.post(`/admin/staff/${weaker.id}/reset-enrolment`, { reason: 'Lost phone' });
    expect(reset.status).toBe(200);
    expect(reset.body.enrolmentUrl).toMatch(/#token=/);
  });

  it('non_owner_cannot_disable_or_enable_owner', async () => {
    const m = await as(await manager());
    const owner = await createStaff(t, { owner: true });
    for (const action of ['disable', 'enable', 'reset-enrolment']) {
      const r = await m.post(`/admin/staff/${owner.id}/${action}`);
      expect(r.status, action).toBe(403);
      expect(r.body.code, action).toBe('target_is_owner');
    }
  });

  it('cannot_remove_role_actor_lacks and cannot_change_own_roles', async () => {
    const actor = await manager();
    const m = await as(actor);
    const target = await createStaff(t, { permissions: [] });
    const strongKey = `x${Date.now().toString(36)}`;
    const strong = await t.prisma.role.create({ data: { key: strongKey, name: 'Strong' } });
    await t.prisma.rolePermission.create({ data: { roleId: strong.id, permissionKey: PERMISSIONS.roleManage } });
    await t.prisma.userRole.create({ data: { userId: target.id, roleId: strong.id } });
    // Over HTTP the first barrier answers: the target holds more than the actor.
    expect((await m.patch(`/admin/staff/${target.id}/roles`, { roleKeys: [] })).body.code).toBe('target_has_more_permissions');
    // The removal check itself refuses to take away a role with permissions the actor lacks.
    const { AccessService } = await import('../../src/platform/access/access.service');
    const access = t.app.get(AccessService);
    const code = await t.prisma.$transaction(async (tx) => {
      const actorEff = await access.effective(tx, actor.id);
      return access.assertCanHandleRoles(tx, actorEff, [strong.id]).then(() => 'ok', (e: { code?: string }) => e.code);
    });
    expect(code).toBe('role_has_more_permissions');
    expect((await m.patch(`/admin/staff/${actor.id}/roles`, { roleKeys: [] })).body.code).toBe('cannot_act_on_self');
  });

  it('shared_role_edit_respects_holders (G1): a non-owner cannot change a role held by someone with more permissions', async () => {
    const actor = await createStaff(t, { permissions: [PERMISSIONS.roleRead, PERMISSIONS.roleManage, PERMISSIONS.flagRead] });
    const api = await as(actor);
    const key = `h${Date.now().toString(36)}`;
    const shared = await t.prisma.role.create({ data: { key, name: 'Shared' } });
    const holder = await createStaff(t, { permissions: [PERMISSIONS.flagManage] }); // more than the actor, via another role
    await t.prisma.userRole.create({ data: { userId: holder.id, roleId: shared.id } });
    const res = await api.put(`/admin/roles/${key}/permissions`, { permissionKeys: [PERMISSIONS.flagRead], version: 0 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('role_holder_has_more_permissions');
    const owner = await as(await createStaff(t, { owner: true }));
    expect((await owner.put(`/admin/roles/${key}/permissions`, { permissionKeys: [PERMISSIONS.flagRead], version: 0 })).status).toBe(200);
    await t.prisma.userRole.deleteMany({ where: { userId: holder.id, roleId: shared.id } });
    expect((await api.put(`/admin/roles/${key}/permissions`, { permissionKeys: [], version: 1 })).status).toBe(200);
  });

  it('role_holder_is_owner: a non-owner cannot edit a custom role that an owner also holds', async () => {
    const actor = await createStaff(t, { permissions: [PERMISSIONS.roleRead, PERMISSIONS.roleManage, PERMISSIONS.flagRead] });
    const api = await as(actor);
    const key = `o${Date.now().toString(36)}`;
    const custom = await t.prisma.role.create({ data: { key, name: 'Custom' } });
    const holder = await createStaff(t, { owner: true }); // an owner who also holds the custom role
    await t.prisma.userRole.create({ data: { userId: holder.id, roleId: custom.id } });
    const res = await api.put(`/admin/roles/${key}/permissions`, { permissionKeys: [PERMISSIONS.flagRead], version: 0 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('role_holder_is_owner');
    // An owner can still edit it, and once the owner stops holding it the non-owner can too.
    const owner = await as(await createStaff(t, { owner: true }));
    expect((await owner.put(`/admin/roles/${key}/permissions`, { permissionKeys: [PERMISSIONS.flagRead], version: 0 })).status).toBe(200);
    await t.prisma.userRole.deleteMany({ where: { userId: holder.id, roleId: custom.id } });
    expect((await api.put(`/admin/roles/${key}/permissions`, { permissionKeys: [], version: 1 })).status).toBe(200);
  });

  it('actor_rechecked_under_lock: three owners disabling each other at once never deadlock and leave one owner', async () => {
    const others = await t.prisma.user.findMany({ where: { status: 'active', roles: { some: { role: { key: OWNER_ROLE } } } }, select: { id: true } });
    await t.prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'disabled' } });
    try {
      const owners = [await createStaff(t, { owner: true }), await createStaff(t, { owner: true }), await createStaff(t, { owner: true })];
      const apis = [await as(owners[0]!), await as(owners[1]!), await as(owners[2]!)];
      // A disables B, B disables C, C disables A: a cycle that deadlocks without a single lock order.
      const results = await Promise.all(apis.map((api, i) => api.post(`/admin/staff/${owners[(i + 1) % 3]!.id}/disable`)));
      // A request that reaches the guard after "its actor was disabled" is answered 401 (the session no longer
      // authenticates): a correct outcome of losing the race, so 401 is accepted alongside 200, 403 and 409.
      for (const r of results) expect([200, 401, 403, 409]).toContain(r.status);
      const active = await t.prisma.user.count({ where: { id: { in: owners.map((o) => o.id) }, status: 'active' } });
      expect(active).toBeGreaterThanOrEqual(1);
      // A 401 can only come from an actor that ended up disabled.
      const states = await t.prisma.user.findMany({ where: { id: { in: owners.map((o) => o.id) } }, select: { id: true, status: true } });
      results.forEach((r, i) => {
        if (r.status === 401) expect(states.find((s) => s.id === owners[i]!.id)?.status).toBe('disabled');
      });
      // Whoever was disabled could not act afterwards: every success came from an owner still active at that moment.
      expect(results.filter((r) => r.status === 200).length).toBe(3 - active);
    } finally {
      await t.prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'active' } });
    }
  });

  it('disable_user_revokes_sessions; enable restores sign-in', async () => {
    const m = await as(await manager());
    const target = await createStaff(t, { permissions: [] });
    const cookie = await signInStaff(t, target);
    expect((await m.post(`/admin/staff/${target.id}/disable`, { reason: 'Left' })).body.status).toBe('disabled');
    expect((await t.http().get('/auth/staff/session').set('Cookie', cookie)).status).toBe(401);
    expect((await m.post(`/admin/staff/${target.id}/enable`)).body.status).toBe('active');
    expect(await signInStaff(t, target)).toMatch(/^mt_staff_session=/);
  });

  it('last_owner_cannot_be_removed_concurrently', async () => {
    // Only the owners this test creates are active while it runs.
    const others = await t.prisma.user.findMany({ where: { status: 'active', roles: { some: { role: { key: OWNER_ROLE } } } }, select: { id: true } });
    await t.prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'disabled' } });
    const activeOwners = (ids: string[]) => t.prisma.user.count({ where: { id: { in: ids }, status: 'active', roles: { some: { role: { key: OWNER_ROLE } } } } });
    try {
      // Two owners take the role from each other at the same time: exactly one wins.
      const a = await createStaff(t, { owner: true });
      const b = await createStaff(t, { owner: true });
      const [apiA, apiB] = [await as(a), await as(b)];
      const removed = await Promise.all([apiA.patch(`/admin/staff/${b.id}/roles`, { roleKeys: [] }), apiB.patch(`/admin/staff/${a.id}/roles`, { roleKeys: [] })]);
      expect(removed.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await activeOwners([a.id, b.id])).toBe(1);
      const [survivor, api] = removed[0]!.status === 200 ? [a, apiA] : [b, apiB];

      // Two owners disable each other at the same time: exactly one wins.
      const c = await createStaff(t, { owner: true });
      const apiC = await as(c);
      const disabled = await Promise.all([api.post(`/admin/staff/${c.id}/disable`), apiC.post(`/admin/staff/${survivor.id}/disable`)]);
      expect(disabled.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await activeOwners([survivor.id, c.id])).toBe(1);
      const last = disabled[0]!.status === 200 ? survivor : c;

      // The last owner cannot be removed: not by themselves, and the locked count refuses it.
      expect((await (await as(last)).patch(`/admin/staff/${last.id}/roles`, { roleKeys: [] })).body.code).toBe('cannot_act_on_self');
      const { AccessService } = await import('../../src/platform/access/access.service');
      const outcome = await t.prisma.$transaction((tx) => t.app.get(AccessService).assertAnotherOwnerRemains(tx, last.id).then(() => 'ok', (e: { code?: string }) => e.code));
      expect(outcome).toBe('last_owner');
    } finally {
      await t.prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'active' } });
    }
  });
});

describe('secrets and retention', () => {
  it('secret_columns_never_serialised_logged_or_audited', async () => {
    const owner = await createStaff(t, { owner: true });
    const api = await as(owner);
    const bodies = [await api.get('/admin/staff'), await api.get('/admin/roles'), await api.get('/auth/staff/session')].map((r) => JSON.stringify(r.body));
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    for (const b of bodies) {
      for (const col of ['passwordHash', 'totpSecretCiphertext', 'tokenHash', 'codeHash', 'totpLastUsedStep']) expect(b).not.toContain(col);
      expect(b).not.toContain(user.passwordHash!);
      expect(b).not.toContain(user.totpSecretCiphertext!);
    }
    const created = await api.post('/admin/staff', { email: uniqueEmail(), roleKeys: [] });
    const reset = await api.post(`/admin/staff/${created.body.id}/reset-enrolment`);
    expect(reset.status).toBe(200);
    const logs = await t.prisma.auditLog.findMany({ where: { entityId: created.body.id }, include: { piiValues: true } });
    const resetLog = logs.find((l) => l.action === 'access.user.credentialsReset')!;
    expect(resetLog.changes).toEqual({}); // nothing was set yet, so nothing changed
    const everything = JSON.stringify(logs);
    expect(everything).not.toContain(/#token=(.+)$/.exec(reset.body.enrolmentUrl)![1]!);
    // Completing the set-up: the audit marks the secrets as "[changed]" and stores no hash or secret.
    const token = /#token=(.+)$/.exec(reset.body.enrolmentUrl)![1]!;
    const start = await t.http().post('/auth/staff/enrolment/start').set(STATE_HEADERS).send({ token });
    const { totpCode } = await import('../../src/platform/auth/totp');
    const done = await t.http().post('/auth/staff/enrolment/complete').set(STATE_HEADERS).send({ token, password: 'a-long-enough-password', code: totpCode(start.body.secret) });
    expect(done.status).toBe(200);
    const enrolled = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.staff.enrolled', entityId: created.body.id }, include: { piiValues: true } });
    expect(enrolled.changes).toMatchObject({ passwordHash: '[changed]' });
    const stored = JSON.stringify(enrolled);
    expect(stored).not.toMatch(/\$argon2id\$/);
    expect(stored).not.toContain(start.body.secret);
    expect(stored).not.toContain('a-long-enough-password');
  });

  it('nothing secret reaches the logs during sign-in, enrolment and failures', async () => {
    const loud = await makeApp({}, { allLogs: true });
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), out(chunk as never, ...(rest as []))) ) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), err(chunk as never, ...(rest as []))) ) as typeof process.stderr.write;
    try {
      const s = await createStaff(loud);
      await loud.http().post('/auth/staff/sign-in').set(STATE_HEADERS).send({ email: s.email, password: 'wrong-password-in-logs' });
      const cookie = await signInStaff(loud, s);
      await loud.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', cookie).send({ code: '000000' });
      const all = written.join('');
      for (const secret of ['wrong-password-in-logs', s.password, s.secret, cookie.split('=')[1]!, s.email]) expect(all).not.toContain(secret);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      await loud.close();
    }
  });

  it('auth maintenance deletes expired tokens and finished sessions and runs the audit purge', async () => {
    const s = await createStaff(t);
    await signInStaff(t, s);
    await t.prisma.loginToken.updateMany({ where: { userId: s.id }, data: { expiresAt: new Date(Date.now() - 2 * 24 * 3600_000) } });
    const r = await t.app.get(AuthMaintenanceService).run();
    expect(r.tokens).toBeGreaterThanOrEqual(1);
    expect(await t.prisma.loginToken.count({ where: { userId: s.id } })).toBe(0);
    expect(await t.prisma.session.count({ where: { userId: s.id } })).toBe(1); // a live staff session stays
  });
});
