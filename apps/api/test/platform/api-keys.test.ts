import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionRegistry } from '../../src/platform/access/permissions';
import { PERMISSIONS } from '../../src/platform/access/permissions';
import { AccessService } from '../../src/platform/access/access.service';
import { StaffAuthService } from '../../src/platform/auth/staff-auth.service';
import { ApiKeyAuthService } from '../../src/platform/integrations/api-key-auth.service';
import { apiKeySecretHash } from '../../src/platform/integrations/api-key-token';
import { INTEGRATIONS_PERMISSIONS as IP } from '../../src/platform/integrations/permissions';
import { CATALOGUE_PERMISSIONS } from '../../src/modules/catalogue/manifest';
import { COMMON_PERMISSIONS_KEYS } from '../../src/platform/common/permissions';
import { FLAGS } from '../../src/platform/flags/flag-registry';
import { STATE_HEADERS, TestApp, createStaff, makeApp, signInStaff } from '../support/auth';
import { raceBody } from '../support/catalogue';
import { allRoutes } from '../support/routes';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp({ API_KEY_FAILED_PER_MINUTE: '100000', API_KEY_RATE_LIMIT_PER_MINUTE: '100000' });
}, 60_000);
afterAll(async () => t.close(), 60_000);

const C = CATALOGUE_PERMISSIONS;
const secretOf = (token: string): string => /^mtk_[a-z2-7]{12}_(.+)$/.exec(token)![1]!;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const setIntegrations = (enabled: boolean) => t.prisma.featureFlag.update({ where: { key: 'module.integrations' }, data: { enabled } });

/** A signed-in owner-like staff member holding `permissions` plus key management. */
async function manager(permissions: string[] = [C.raceRead, C.raceManage, COMMON_PERMISSIONS_KEYS.tableUse]) {
  const staff = await createStaff(t, { permissions: [...permissions, IP.apiKeyRead, IP.apiKeyManage] });
  return { staff, cookie: await signInStaff(t, staff) };
}

async function newKey(cookie: string, scopes: string[], over: Record<string, unknown> = {}) {
  const res = await t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', cookie).send({ name: 'Zapier', scopes, ...over });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; prefix: string; token: string; expiresAt: string };
}

describe('creating and listing keys (C2, C3)', () => {
  it('api_key_secret_shown_once_and_stored_as_hmac', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    expect(k.token).toMatch(/^mtk_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
    const row = await t.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } });
    const secret = secretOf(k.token);
    expect(row.secretHash).toBe(apiKeySecretHash(t.config.AUTH_HMAC_KEY, row.prefix, secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: k.id, action: 'integrations.apiKey.created' } });
    expect((audit.changes as Record<string, unknown>).secretHash).toBe('[changed]');
    expect(JSON.stringify(audit.changes)).not.toContain(row.secretHash);
  });

  it('api_key_list_never_returns_secret_or_hash', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    const list = await t.http().get('/admin/integrations/api-keys').set('Cookie', m.cookie);
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    const row = await t.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } });
    expect(text).not.toContain(k.token);
    expect(text).not.toContain(row.secretHash);
    expect(text).not.toContain('secretHash');
    expect(list.body.find((x: { id: string }) => x.id === k.id)).toMatchObject({ prefix: k.prefix, status: 'active', mine: true, scopes: [C.raceRead] });
  });

  it('api_key_create_requires_step_up', async () => {
    const m = await manager();
    await t.prisma.session.updateMany({ where: { userId: m.staff.id }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const res = await t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', m.cookie).send({ name: 'x', scopes: [C.raceRead] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('step_up_required');
  });

  it('api_key_scopes_must_be_subset_of_creator_permissions', async () => {
    const m = await manager([C.raceRead]);
    const res = await t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', m.cookie).send({ name: 'x', scopes: [C.raceRead, C.packageRead] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('scope_not_held');
  });

  it('api_key_scope_with_step_up_permission_rejected_at_creation', async () => {
    const owner = await createStaff(t, { owner: true });
    const cookie = await signInStaff(t, owner);
    const res = await t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', cookie).send({ name: 'x', scopes: [C.claimManage] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('scope_requires_step_up');
  });

  it('api_key_scope_not_scopable_rejected (G1)', async () => {
    const owner = await createStaff(t, { owner: true });
    const cookie = await signInStaff(t, owner);
    for (const scope of [PERMISSIONS.flagManage, PERMISSIONS.settingManage, PERMISSIONS.userRead, PERMISSIONS.auditRead, IP.apiKeyRead, IP.webhookRead, PERMISSIONS.systemRead]) {
      const res = await t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', cookie).send({ name: 'x', scopes: [scope] });
      expect(res.status, scope).toBe(422);
      expect(res.body.code, scope).toBe('scope_not_scopable');
    }
  });

  it('api_key_scopable_list_is_explicit (G1)', () => {
    const scopable = t.app.get(PermissionRegistry).all().filter((d) => d.apiKeyScopable).map((d) => d.key).sort();
    // Adding a scope is a deliberate decision: change this list in the same pull request, with a reason.
    expect(scopable).toEqual([
      'alerts.subscription.read', 'catalogue.hotel.manage', 'catalogue.inventory.manage', 'catalogue.package.manage', 'catalogue.package.read',
      'catalogue.package.setSaleStatus', 'catalogue.race.manage', 'catalogue.race.read', 'common.table.use', 'common.task.read', 'common.task.write',
      'pricing.priceVersion.read', 'pricing.quote.preview', 'suppliers.allotment.manage', 'suppliers.supplier.manage', 'suppliers.supplier.read',
    ]);
    for (const d of t.app.get(PermissionRegistry).all().filter((x) => x.apiKeyScopable)) {
      expect(d.requiresStepUp, d.key).toBe(false);
      expect(d.key, d.key).not.toMatch(/^(platform|access|audit|integrations)\./);
    }
    const registry = new PermissionRegistry();
    expect(() => registry.register([{ key: 'platform.thing.manage', module: 'platform', description: 'x', apiKeyScopable: true }])).toThrow(/cannot be an API key scope/);
    expect(() => registry.register([{ key: 'catalogue.thing.publish', module: 'catalogue', description: 'x', requiresStepUp: true, apiKeyScopable: true }])).toThrow(/cannot be an API key scope/);
  });

  it('api_key_unknown_scope_rejected', async () => {
    const m = await manager();
    const res = await t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', m.cookie).send({ name: 'x', scopes: ['made.up.thing'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('unknown_scope');
  });

  it('api_key_expiry_required_and_capped', async () => {
    const m = await manager();
    for (const expiresInDays of [0, 366, 1.5, -1]) {
      const res = await t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', m.cookie).send({ name: 'x', scopes: [C.raceRead], expiresInDays });
      expect(res.status, String(expiresInDays)).toBe(422);
    }
    const k = await newKey(m.cookie, [C.raceRead], { expiresInDays: 365 });
    expect(new Date(k.expiresAt).getTime() - Date.now()).toBeGreaterThan(364 * 86400_000);
    // The database refuses a longer window whatever the API does.
    await expect(t.prisma.apiKey.create({
      data: { name: 'x', prefix: 'aaaaaaaaaaaa', secretHash: 'x', scopes: [C.raceRead], ownerUserId: m.staff.id, expiresAt: new Date(Date.now() + 400 * 86400_000) },
    })).rejects.toThrow();
  });

  it('api_key_max_active_per_owner', async () => {
    const m = await manager();
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      t.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', m.cookie).send({ name: 'x', scopes: [C.raceRead] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.code === 'too_many_api_keys')).toBe(true);
  });
});

describe('using a key (C1)', () => {
  it('api_key_grants_scoped_permission, without CSRF headers', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead, C.raceManage]);
    const list = await t.http().get('/admin/catalogue/races').set(bearer(k.token));
    expect(list.status).toBe(200);
    const created = await t.http().post('/admin/catalogue/races').set(bearer(k.token)).send(raceBody());
    expect(created.status).toBe(201);
  });

  it('api_key_without_scope_gets_403', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    const res = await t.http().post('/admin/catalogue/races').set(bearer(k.token)).send(raceBody());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('api_key_scope_not_allowed');
  });

  it('api_key_loses_permission_when_owner_loses_it', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    expect((await t.http().get('/admin/catalogue/races').set(bearer(k.token))).status).toBe(200);
    const roles = await t.prisma.userRole.findMany({ where: { userId: m.staff.id }, select: { roleId: true } });
    await t.prisma.rolePermission.deleteMany({ where: { roleId: { in: roles.map((r) => r.roleId) }, permissionKey: C.raceRead } });
    expect((await t.http().get('/admin/catalogue/races').set(bearer(k.token))).status).toBe(403);
  });

  it('api_key_of_owner_is_not_owner', async () => {
    const owner = await createStaff(t, { owner: true });
    const cookie = await signInStaff(t, owner);
    const k = await newKey(cookie, [C.raceRead]);
    const row = await t.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } });
    const eff = await t.app.get(AccessService).assertPermission(t.prisma, {
      via: 'api_key', kind: 'staff', userId: owner.id, sessionId: null, mfaVerifiedAt: null, apiKeyId: row.id, scopes: new Set(row.scopes),
    }, C.raceRead);
    expect(eff.isOwner).toBe(false);
    expect([...eff.keys]).toEqual([C.raceRead]);
  });

  it('api_key_invalid_when_owner_disabled', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    await t.prisma.user.update({ where: { id: m.staff.id }, data: { status: 'disabled' } });
    const res = await t.http().get('/admin/catalogue/races').set(bearer(k.token));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_api_key');
  });

  it('api_key_revoked_rejected and api_key_expired_rejected, with the same answer', async () => {
    const m = await manager();
    const revoked = await newKey(m.cookie, [C.raceRead]);
    const expiring = await newKey(m.cookie, [C.raceRead], { expiresInDays: 1 });
    expect((await t.http().post(`/admin/integrations/api-keys/${revoked.id}/revoke`).set(STATE_HEADERS).set('Cookie', m.cookie)).status).toBe(204);
    const a = await t.http().get('/admin/catalogue/races').set(bearer(revoked.token));
    expect(a.status).toBe(401);
    expect(a.body).toEqual({ code: 'invalid_api_key', message: 'The API key is not valid' });
    // Expiry cannot be moved in the database (trigger), so the service runs with a clock two days ahead.
    const svc = t.app.get(ApiKeyAuthService);
    const req = { headers: { authorization: `Bearer ${expiring.token}` }, ip: '203.0.113.9' } as never;
    await expect(svc.authenticate(req, new Date(Date.now() + 2 * 86400_000))).rejects.toMatchObject({ status: 401, code: 'invalid_api_key', message: a.body.message });
    await expect(svc.authenticate(req)).resolves.toMatchObject({ via: 'api_key', apiKeyId: expiring.id });
  });

  it('api_key_wrong_secret_same_response_as_unknown_prefix', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    const wrongSecret = `mtk_${k.prefix}_${'A'.repeat(43)}`;
    const unknownPrefix = `mtk_${'b'.repeat(12)}_${secretOf(k.token)}`;
    const a = await t.http().get('/admin/catalogue/races').set(bearer(wrongSecret));
    const b = await t.http().get('/admin/catalogue/races').set(bearer(unknownPrefix));
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('api_key_malformed_header_rejected', async () => {
    for (const h of ['Basic abc', 'Bearer', 'Bearer abc', 'Bearer mtk_short_x', `Bearer  mtk_${'a'.repeat(12)}_${'A'.repeat(43)}`, `bearer mtk_${'a'.repeat(12)}_${'A'.repeat(43)}`, `Bearer mtk_${'a'.repeat(12)}_${'A'.repeat(44)}`]) {
      const res = await t.http().get('/admin/catalogue/races').set('Authorization', h);
      expect(res.status, h).toBe(401);
      expect(res.body.code, h).toBe('invalid_api_key');
    }
  });

  it('api_key_cannot_use_step_up_permission: every step-up route refuses a key', async () => {
    const owner = await createStaff(t, { owner: true });
    const cookie = await signInStaff(t, owner);
    const k = await newKey(cookie, [C.raceRead]);
    const registry = t.app.get(PermissionRegistry);
    const routes = allRoutes(t.app).filter((r) => r.marks[0]?.type === 'permission' && registry.get((r.marks[0] as { key: string }).key)?.requiresStepUp);
    expect(routes.length).toBeGreaterThanOrEqual(8);
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, owner.id);
      const res = await t.http()[r.method.toLowerCase() as 'post'](path).set(bearer(k.token)).send({});
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body.code, `${r.method} ${r.path}`).toBe('api_key_cannot_use_step_up_permission');
    }
  });

  it('api_key_rejected_on_owned_routes: every owned route refuses a key', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    const routes = allRoutes(t.app).filter((r) => r.marks[0]?.type === 'owned');
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, m.staff.id);
      const res = await t.http()[r.method.toLowerCase() as 'post'](path).set(bearer(k.token)).set(STATE_HEADERS).send({});
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      expect(res.body.code, `${r.method} ${r.path}`).toBe('api_key_not_allowed');
    }
  });

  it('api_key_with_session_cookie_rejected, on POST and on GET', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead, C.raceManage]);
    const post = await t.http().post('/admin/catalogue/races').set(STATE_HEADERS).set(bearer(k.token)).set('Cookie', m.cookie).send(raceBody());
    expect(post.status).toBe(400);
    expect(post.body.code).toBe('ambiguous_credentials');
    const get = await t.http().get('/admin/catalogue/races').set(bearer(k.token)).set('Cookie', m.cookie);
    expect(get.status).toBe(400);
    expect(get.body.code).toBe('ambiguous_credentials');
  });

  it('bearer_with_any_cookie_does_not_skip_csrf', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead, C.raceManage]);
    const res = await t.http().post('/admin/catalogue/races').set(bearer(k.token)).set('Cookie', 'unrelated=1').send(raceBody());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_rejected');
  });

  it('bearer_on_public_route_does_not_skip_csrf', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    const res = await t.http().post('/auth/customer/magic-link').set(bearer(k.token)).send({ email: 'someone@example.test' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_rejected');
  });

  it('api_key_actions_audited_as_api_key', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead, C.raceManage]);
    const created = await t.http().post('/admin/catalogue/races').set(bearer(k.token)).send(raceBody());
    expect(created.status).toBe(201);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: created.body.id }, orderBy: { occurredAt: 'asc' } });
    expect(audit).toMatchObject({ actorType: 'api_key', actorId: k.id, sessionId: null });
  });

  it('api_key_secondary_checks_respect_scopes (global search)', async () => {
    const T = COMMON_PERMISSIONS_KEYS;
    const m = await manager([T.tableUse, T.taskRead, T.taskWrite]);
    const word = `zq${Date.now().toString(36)}`;
    const created = await t.http().post('/admin/tasks').set(STATE_HEADERS).set('Cookie', m.cookie).send({ title: `Call ${word} hotel` });
    expect(created.status).toBe(201);
    const bySession = await t.http().get(`/admin/search?q=${word}`).set('Cookie', m.cookie);
    expect(bySession.body.length).toBeGreaterThan(0);
    // The search filters by the caller's permissions inside the service, not in the guard: a key sees only its scopes.
    const narrow = await newKey(m.cookie, [T.tableUse]);
    const wide = await newKey(m.cookie, [T.tableUse, T.taskRead]);
    expect((await t.http().get(`/admin/search?q=${word}`).set(bearer(narrow.token))).body).toEqual([]);
    expect((await t.http().get(`/admin/search?q=${word}`).set(bearer(wide.token))).body.length).toBeGreaterThan(0);
  });

  it('api_key_refused_when_integrations_module_off', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    await setIntegrations(false);
    try {
      expect((await t.http().get('/admin/catalogue/races').set(bearer(k.token))).status).toBe(401);
      expect((await t.http().get('/admin/integrations/api-keys').set('Cookie', m.cookie)).status).toBe(404);
    } finally {
      await setIntegrations(true);
    }
    expect((await t.http().get('/admin/catalogue/races').set(bearer(k.token))).status).toBe(200);
  });

  it('api_key_last_used_updated_at_most_once_per_minute', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    await t.http().get('/admin/catalogue/races').set(bearer(k.token));
    const first = (await t.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } })).lastUsedAt;
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    await t.http().get('/admin/catalogue/races').set(bearer(k.token));
    expect((await t.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } })).lastUsedAt).toEqual(first);
  });

  it('api_key_token_never_logged', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((lvl) => vi.spyOn(Logger.prototype, lvl).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))));
    const staticSpies = (['log', 'warn', 'error'] as const).map((lvl) => vi.spyOn(Logger, lvl).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))));
    try {
      await t.http().get('/admin/catalogue/races').set(bearer(k.token));
      await t.http().get('/admin/catalogue/races').set(bearer(`mtk_${k.prefix}_${'Z'.repeat(43)}`));
    } finally {
      [...spies, ...staticSpies].forEach((s) => s.mockRestore());
    }
    expect(lines.some((l) => l.includes('api key rejected'))).toBe(true);
    const secret = secretOf(k.token);
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain('Z'.repeat(43));
  });

  it('maintenance_blocks_api_keys_on_admin_routes', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    await t.prisma.featureFlag.upsert({ where: { key: FLAGS.maintenance }, create: { key: FLAGS.maintenance, enabled: true }, update: { enabled: true } });
    try {
      expect((await t.http().get('/admin/catalogue/races').set(bearer(k.token))).status).toBe(503);
      expect((await t.http().get('/admin/catalogue/races').set('Cookie', m.cookie)).status).toBe(200);
      expect((await t.http().get('/health').set(bearer(k.token))).status).toBe(200);
    } finally {
      await t.prisma.featureFlag.update({ where: { key: FLAGS.maintenance }, data: { enabled: false } });
    }
  });

  it('preflight_options_has_no_cors_headers', async () => {
    const res = await t.http().options('/admin/catalogue/races').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'authorization');
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });
});

describe('revocation (C8)', () => {
  it('api_key_revoke_audited_and_takes_effect_immediately', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    expect((await t.http().get('/admin/catalogue/races').set(bearer(k.token))).status).toBe(200);
    expect((await t.http().post(`/admin/integrations/api-keys/${k.id}/revoke`).set(STATE_HEADERS).set('Cookie', m.cookie)).status).toBe(204);
    expect((await t.http().get('/admin/catalogue/races').set(bearer(k.token))).status).toBe(401);
    expect(await t.prisma.auditLog.count({ where: { entityId: k.id, action: 'integrations.apiKey.revoked', actorType: 'staff' } })).toBe(1);
    expect((await t.http().post(`/admin/integrations/api-keys/${k.id}/revoke`).set(STATE_HEADERS).set('Cookie', m.cookie)).body.code).toBe('already_revoked');
    // Using it again is audited once per hour at most.
    await t.http().get('/admin/catalogue/races').set(bearer(k.token));
    expect(await t.prisma.auditLog.count({ where: { entityId: k.id, action: 'integrations.apiKey.rejectedUse' } })).toBe(1);
  });

  it('api_key_revoked_when_owner_disabled_stays_revoked_after_reenable (G2)', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    const admin = await createStaff(t, { owner: true });
    const adminCookie = await signInStaff(t, admin);
    expect((await t.http().post(`/admin/staff/${m.staff.id}/disable`).set(STATE_HEADERS).set('Cookie', adminCookie).send({})).status).toBe(200);
    expect(await t.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } })).toMatchObject({ revokeReason: 'owner_disabled', revokedById: admin.id });
    expect((await t.http().post(`/admin/staff/${m.staff.id}/enable`).set(STATE_HEADERS).set('Cookie', adminCookie).send({})).status).toBe(200);
    expect((await t.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } })).revokedAt).not.toBeNull();
    expect((await t.http().get('/admin/catalogue/races').set(bearer(k.token))).status).toBe(401);
  });

  it('api_key_revoked_on_staff_reset (panel and CLI) (G2)', async () => {
    const m = await manager();
    const viaPanel = await newKey(m.cookie, [C.raceRead]);
    const admin = await createStaff(t, { owner: true });
    const adminCookie = await signInStaff(t, admin);
    expect((await t.http().post(`/admin/staff/${m.staff.id}/reset-enrolment`).set(STATE_HEADERS).set('Cookie', adminCookie).send({})).status).toBe(200);
    expect(await t.prisma.apiKey.findUniqueOrThrow({ where: { id: viaPanel.id } })).toMatchObject({ revokeReason: 'owner_reset' });

    const m2 = await manager();
    const viaCli = await newKey(m2.cookie, [C.raceRead]);
    await t.prisma.$transaction((tx) => t.app.get(StaffAuthService).resetCredentials(tx, m2.staff.id, { type: 'system', id: null }));
    expect(await t.prisma.apiKey.findUniqueOrThrow({ where: { id: viaCli.id } })).toMatchObject({ revokeReason: 'owner_reset', revokedById: null });
    expect(await t.prisma.auditLog.count({ where: { entityId: viaCli.id, action: 'integrations.apiKey.revoked', actorType: 'system' } })).toBe(1);
  });

  it('api_key_row_immutable (database)', async () => {
    const m = await manager();
    const k = await newKey(m.cookie, [C.raceRead]);
    await expect(t.prisma.apiKey.update({ where: { id: k.id }, data: { scopes: [C.raceRead, C.raceManage] } })).rejects.toThrow();
    await expect(t.prisma.apiKey.update({ where: { id: k.id }, data: { secretHash: 'f'.repeat(64) } })).rejects.toThrow();
    await expect(t.prisma.apiKey.update({ where: { id: k.id }, data: { ownerUserId: (await createStaff(t)).id } })).rejects.toThrow();
    await expect(t.prisma.apiKey.update({ where: { id: k.id }, data: { expiresAt: new Date(Date.now() + 86400_000) } })).rejects.toThrow();
    await t.prisma.apiKey.update({ where: { id: k.id }, data: { name: 'Renamed' } });
    await t.prisma.apiKey.update({ where: { id: k.id }, data: { revokedAt: new Date(), revokeReason: 'manual' } });
    await expect(t.prisma.apiKey.update({ where: { id: k.id }, data: { revokedAt: null, revokeReason: null } })).rejects.toThrow();
    await expect(t.prisma.apiKey.delete({ where: { id: k.id } })).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE api_keys')).rejects.toThrow();
  });
});

describe('integrations routes need their permission', () => {
  it('integrations_routes_need_their_permission: 403 without it', async () => {
    const staff = await createStaff(t, { permissions: [C.raceRead] });
    const cookie = await signInStaff(t, staff);
    const routes = allRoutes(t.app).filter((r) => r.path.startsWith('/admin/integrations'));
    expect(routes.length).toBeGreaterThanOrEqual(12);
    for (const r of routes) {
      const path = r.path.replace(/:[A-Za-z]+/g, staff.id);
      const res = await t.http()[r.method.toLowerCase() as 'post'](path).set(STATE_HEADERS).set('Cookie', cookie).send({});
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  });
});

describe('limits (G3)', () => {
  let small: TestApp;
  beforeAll(async () => {
    small = await makeApp({ API_KEY_FAILED_PER_MINUTE: '3', API_KEY_RATE_LIMIT_PER_MINUTE: '5' });
  }, 60_000);
  afterAll(async () => small.close(), 60_000);

  async function keyIn(app: TestApp, scopes: string[]) {
    const s = await createStaff(app, { permissions: [...scopes, IP.apiKeyManage] });
    const cookie = await signInStaff(app, s);
    const res = await app.http().post('/admin/integrations/api-keys').set(STATE_HEADERS).set('Cookie', cookie).send({ name: 'x', scopes });
    return res.body.token as string;
  }

  it('api_key_rate_limited_per_key', async () => {
    const token = await keyIn(small, [C.raceRead]);
    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1) codes.push((await small.http().get('/admin/catalogue/races').set(bearer(token))).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    const last = await small.http().get('/admin/catalogue/races').set(bearer(token));
    expect(last.status).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
  });

  it('api_key_failed_attempts_limited_per_ip: failures turn into 429, a valid key still gets in, sessions unaffected', async () => {
    const token = await keyIn(small, [C.raceRead]);
    const s = await createStaff(small, { permissions: [C.raceRead] });
    const cookie = await signInStaff(small, s);
    const bad = () => small.http().get('/admin/catalogue/races').set(bearer(`mtk_${'c'.repeat(12)}_${'B'.repeat(43)}`));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await bad()).status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect((await small.http().get('/admin/catalogue/races').set(bearer(token))).status).toBe(200);
    expect((await small.http().get('/admin/catalogue/races').set('Cookie', cookie)).status).toBe(200);
    // A 403 for a missing scope is not an authentication failure.
    const rate = await small.http().post('/admin/catalogue/races').set(bearer(token)).send(raceBody());
    expect(rate.status).toBe(403);
  });
});
