import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnedBy, Public, RequirePermission } from '../../src/platform/access/access.decorators';
import { ZodPipe } from '../../src/platform/http/zod.pipe';
import { AccessGuard } from '../../src/platform/access/access.guard';
import { AccessService, OWNER_ROLE, computeEffective } from '../../src/platform/access/access.service';
import { PERMISSIONS, PermissionRegistry } from '../../src/platform/access/permissions';
import { SessionService } from '../../src/platform/auth/session.service';
import { APP_CONFIG, PrismaService } from '../../src/platform/database/prisma.service';
import { configureApp } from '../../src/platform/http/configure-app';
import { STATE_HEADERS, TestApp, cookieFrom, createStaff, makeApp, signInCustomer, signInStaff, freshCode, uniqueEmail } from '../support/auth';
import { OWNED_ROUTE_FIXTURES } from '../support/owned-route-fixtures';
import { checkOwnedRoutes } from '../support/owned-routes';
import { allRoutes } from '../support/routes';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => t.close());

const stepUpOld = (userId: string) => t.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });

describe('access marks (plan 4.1)', () => {
  it('every_route_has_exactly_one_access_mark', () => {
    const routes = allRoutes(t.app);
    expect(routes.length).toBeGreaterThan(20);
    const bad = routes.filter((r) => r.marks.length !== 1).map((r) => `${r.method} ${r.path} (${r.marks.length})`);
    expect(bad).toEqual([]);
  });

  it('a route with no mark or with two is denied by the guard', async () => {
    @Controller('probe')
    class Probe {
      @Get('none') none() { return { ok: true }; }
      @Get('two') @Public('test') @RequirePermission(PERMISSIONS.flagRead) two() { return { ok: true }; }
      @Get('open') @Public('test') open() { return { ok: true }; }
    }
    const mod = await Test.createTestingModule({
      controllers: [Probe],
      providers: [
        { provide: APP_CONFIG, useValue: t.config }, { provide: PrismaService, useValue: t.prisma }, PermissionRegistry, AccessService, SessionService,
        { provide: APP_GUARD, useClass: AccessGuard },
      ],
    }).compile();
    const app = mod.createNestApplication({ logger: false });
    configureApp(app, t.config);
    await app.init();
    try {
      expect((await request(app.getHttpServer()).get('/probe/none')).body.code).toBe('route_not_marked');
      expect((await request(app.getHttpServer()).get('/probe/two')).body.code).toBe('route_not_marked');
      expect((await request(app.getHttpServer()).get('/probe/open')).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('every_owned_route_rejects_other_customer and self_routes_take_no_resource_ids (path, query and body)', async () => {
    const a = await signInCustomer(t);
    const b = await signInCustomer(t);
    const { problems, checked } = await checkOwnedRoutes(t, OWNED_ROUTE_FIXTURES, a, b);
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(5);
    // Customer-resource fixtures build real data (task 2.4: a priced, open package and a booking request).
  }, 60_000);

  it('the owned-route harness catches a leaky route, a missing fixture and self routes that take ids', async () => {
    let db: TestApp['prisma'] | null = null;
    const ownsSession = async ({ userId, params }: { userId: string; params: Record<string, string> }) =>
      !!(await db!.session.findFirst({ where: { id: params.id, userId } }));
    @Controller('probe')
    class Probe {
      @Get('sessions/:id') @OwnedBy({ kind: 'customer', resource: 'session', fixture: 'probeSession', owns: ownsSession }) good() { return { ok: true }; }
      @Get('leaky/:id') @OwnedBy({ kind: 'customer', resource: 'session', fixture: 'probeLeaky', owns: async () => true }) leaky() { return { ok: true }; }
      @Get('unfixtured/:id') @OwnedBy({ kind: 'customer', resource: 'session', fixture: 'nobodyWroteThis', owns: ownsSession }) unfixtured() { return { ok: true }; }
      @Post('self-body') @OwnedBy({ kind: 'customer', resource: 'self' }) selfBody(@Body(new ZodPipe(z.strictObject({ bookingId: z.string() }))) _b: unknown) { return {}; }
      @Get('self-query') @OwnedBy({ kind: 'customer', resource: 'self' }) selfQuery(@Query('id') _id: string) { return {}; }
    }
    const probe = await makeApp({}, { controllers: [Probe] });
    db = probe.prisma;
    try {
      const a = await signInCustomer(probe);
      const b = await signInCustomer(probe);
      const sessionOf = async (c: { userId: string }) => (await probe.prisma.session.findFirstOrThrow({ where: { userId: c.userId, revokedAt: null } })).id;
      const fixture = (path: string) => ({
        create: async (tt: TestApp, owner: typeof a, other: typeof b) => {
          const id = await sessionOf(owner);
          return { asOwner: () => tt.http().get(`/probe/${path}/${id}`).set('Cookie', owner.cookie), asOther: () => tt.http().get(`/probe/${path}/${id}`).set('Cookie', other.cookie) };
        },
      });
      // The app's own customer-resource routes (task 2.4 on) bring their fixtures; the probes add theirs.
      const { problems } = await checkOwnedRoutes(probe, { ...OWNED_ROUTE_FIXTURES, probeSession: fixture('sessions'), probeLeaky: fixture('leaky') }, a, b);
      expect(problems.sort()).toEqual([
        'GET /probe/leaky/:id: other customer got 200, expected 404',
        'GET /probe/self-query: self route reads the query',
        'GET /probe/unfixtured/:id: no fixture "nobodyWroteThis"',
        'POST /probe/self-body: self route takes bookingId in the body',
      ]);
    } finally {
      await probe.close();
    }
  }, 60_000);

  it('a handler mark never hides a controller mark: two marks at any level are denied and reported', async () => {
    @Controller('probe2')
    @RequirePermission(PERMISSIONS.flagManage)
    class Mixed {
      @Get('open') @Public('looks public but the controller needs a permission') open() { return { ok: true }; }
    }
    const probe = await makeApp({}, { controllers: [Mixed] });
    try {
      expect((await probe.http().get('/probe2/open')).body.code).toBe('route_not_marked');
      const bad = allRoutes(probe.app).filter((r) => r.marks.length !== 1).map((r) => r.path);
      expect(bad).toEqual(['/probe2/open']);
    } finally {
      await probe.close();
    }
  });
});

describe('permissions (plan 4.3)', () => {
  it('role_without_permission_gets_403 (401 without a session, 200 with the permission)', async () => {
    const without = await createStaff(t, { permissions: [PERMISSIONS.roleRead] });
    const withIt = await createStaff(t, { permissions: [PERMISSIONS.flagRead] });
    expect((await t.http().get('/admin/flags')).status).toBe(401);
    const denied = await t.http().get('/admin/flags').set('Cookie', await signInStaff(t, without));
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ code: 'forbidden', message: 'You do not have permission to do this' });
    expect((await t.http().get('/admin/flags').set('Cookie', await signInStaff(t, withIt))).status).toBe(200);
  });

  it('step_up_enforced_from_permission_manifest: every route whose permission requires step-up refuses an old TOTP check', async () => {
    const registry = t.app.get(PermissionRegistry);
    const stepUpRoutes = allRoutes(t.app).filter((r) => r.marks[0]?.type === 'permission' && registry.get((r.marks[0] as { key: string }).key)?.requiresStepUp);
    expect(stepUpRoutes.length).toBeGreaterThanOrEqual(5);
    const owner = await createStaff(t, { owner: true });
    const cookie = await signInStaff(t, owner);
    await stepUpOld(owner.id);
    for (const r of stepUpRoutes) {
      const path = r.path.replace(':id', owner.id).replace(':key', 'some_role');
      const res = await t.http()[r.method.toLowerCase() as 'post'](path).set(STATE_HEADERS).set('Cookie', cookie).send({});
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body.code, `${r.method} ${r.path}`).toBe('step_up_required');
    }
  });

  it('step_up_without_recent_totp_403, then allowed after stepping up', async () => {
    const owner = await createStaff(t, { owner: true });
    let cookie = await signInStaff(t, owner);
    const create = () => t.http().post('/admin/roles').set(STATE_HEADERS).set('Cookie', cookie).send({ key: `r${Date.now().toString(36)}`, name: 'Guides' });
    await stepUpOld(owner.id);
    expect((await create()).body.code).toBe('step_up_required');
    const up = await t.http().post('/auth/staff/step-up').set(STATE_HEADERS).set('Cookie', cookie).send({ code: await freshCode(t, owner) });
    expect(up.status).toBe(200);
    // Task 8.5: stepping up renews the session token; the old cookie no longer works (test/security/auth-hardening.test.ts).
    expect((await create()).status).toBe(401);
    cookie = `mt_staff_session=${cookieFrom(up, 'mt_staff_session')}`;
    expect((await create()).status).toBe(201);
  });

  it('non_empty_role_scope_rejected_and_denies', async () => {
    const declared = new Set([PERMISSIONS.flagRead, PERMISSIONS.flagManage]);
    expect(computeEffective([{ scope: { editionIds: ['x'] }, role: { key: 'guide', permissions: [{ permissionKey: PERMISSIONS.flagRead }] } }], declared).keys.size).toBe(0);
    expect(computeEffective([{ scope: { editionIds: ['x'] }, role: { key: OWNER_ROLE, permissions: [] } }], declared).isOwner).toBe(false);
    expect(computeEffective([{ scope: null, role: { key: 'guide', permissions: [{ permissionKey: PERMISSIONS.flagRead }, { permissionKey: 'not.declared.anywhere' }] } }], declared).keys).toEqual(new Set([PERMISSIONS.flagRead]));
    const owner = await createStaff(t, { owner: true });
    const target = await createStaff(t);
    const res = await t.http().patch(`/admin/staff/${target.id}/roles`).set(STATE_HEADERS).set('Cookie', await signInStaff(t, owner)).send({ roleKeys: [], scope: { editionIds: [] } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('role_scope_not_supported');
  });
});

describe('HTTP protections', () => {
  it('state_change_without_origin_or_header_rejected', async () => {
    const body = { email: uniqueEmail(), password: 'whatever-password' };
    for (const headers of [{}, { Origin: 'http://localhost:3000' }, { 'X-MT-CSRF': '1' }, { Origin: 'https://evil.example', 'X-MT-CSRF': '1' }]) {
      const res = await t.http().post('/auth/staff/sign-in').set(headers).send(body);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.body.code).toBe('csrf_rejected');
    }
    expect((await t.http().post('/auth/staff/sign-in').set(STATE_HEADERS).send(body)).status).toBe(401);
  });

  it('forwarded_for_ignored_without_trust_proxy (rate limit and stored IP prefix)', async () => {
    const limited = await makeApp({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await limited.http().post('/auth/staff/sign-in').set(STATE_HEADERS).set('X-Forwarded-For', `203.0.113.${i}`).send({ email: uniqueEmail(), password: 'whatever-password' });
        statuses.push(r.status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
    }
    // The stored prefix comes from the socket address, not from the header.
    const s = await createStaff(t);
    const step1 = await t.http().post('/auth/staff/sign-in').set(STATE_HEADERS).set('X-Forwarded-For', '203.0.113.9').send({ email: s.email, password: s.password });
    const mfa = /mt_staff_mfa=([^;]+)/.exec(String(step1.headers['set-cookie']))![1];
    await t.http().post('/auth/staff/sign-in/second-factor').set(STATE_HEADERS).set('X-Forwarded-For', '203.0.113.9').set('Cookie', `mt_staff_mfa=${mfa}`).send({ code: await freshCode(t, s) });
    const session = await t.prisma.session.findFirstOrThrow({ where: { userId: s.id } });
    expect(session.ipPrefix).toBe('127.0.0.0/24');
  });

  it('errors never echo request values', async () => {
    const res = await t.http().post('/auth/staff/sign-in').set(STATE_HEADERS).send({ email: 'not-an-email<script>', password: 'x' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain('script');
    expect(res.body).toEqual({ code: 'validation_failed', message: 'Some fields are not valid', fields: ['email'] });
  });
});
