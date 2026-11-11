import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Prisma } from '../../src/generated/prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/platform/database/prisma.service';
import { EntityRegistry } from '../../src/platform/entities/entity-registry';
import { AppError, SafeJobError, safeError } from '../../src/platform/errors/safe-error';
import { FeatureFlagService, SettingsService, moduleFlagKey } from '../../src/platform/flags/flags.service';
import { RequiresModule, RequiresModuleGuard } from '../../src/platform/flags/requires-module.guard';
import { JobsService } from '../../src/platform/jobs/jobs.service';
import { QUEUE_LIST } from '../../src/platform/jobs/queues';
import { NumberSequenceService } from '../../src/platform/sequences/number-sequence.service';
import { newId, testConfig } from '../support/platform';

const config = testConfig();
let prisma: PrismaService;
let flags: FeatureFlagService;
beforeAll(() => {
  prisma = new PrismaService(config);
  flags = new FeatureFlagService(prisma);
});
afterAll(async () => prisma.$disconnect());
afterEach(async () => {
  await prisma.featureFlag.deleteMany({ where: { key: { startsWith: 'test.' } } });
  await prisma.setting.deleteMany({ where: { key: { startsWith: 'test.' } } });
  await prisma.numberSequence.deleteMany({ where: { key: { startsWith: 'test.' } } });
});

describe('feature flags and settings (read side; administration is 0.3)', () => {
  it('reads the flag on every call, so a change applies without a restart; a missing flag is off', async () => {
    expect(await flags.isEnabled('test.flag')).toBe(false);
    await flags.ensure('test.flag', true);
    expect(await flags.isEnabled('test.flag')).toBe(true);
    await prisma.featureFlag.update({ where: { key: 'test.flag' }, data: { enabled: false } });
    expect(await flags.isEnabled('test.flag')).toBe(false);
    await flags.ensure('test.flag', true); // ensure never overwrites an existing value
    expect(await flags.isEnabled('test.flag')).toBe(false);
  });

  it('modules without a flag are always on; others follow module.<name>', async () => {
    for (const m of ['platform', 'catalogue', 'pricing', 'bookings', 'payments']) expect(await flags.isModuleEnabled(m)).toBe(true);
    expect(await flags.isModuleEnabled('testmod')).toBe(false);
    await flags.ensure(moduleFlagKey('testmod'), true);
    expect(await flags.isModuleEnabled('testmod')).toBe(true);
    await prisma.featureFlag.deleteMany({ where: { key: moduleFlagKey('testmod') } });
  });

  it('a route of a switched-off module answers 404, then 200 once the flag is on, with no restart', async () => {
    @Controller('probe')
    class Probe {
      @Get() @RequiresModule('testmod2') get() { return { ok: true }; }
    }
    const mod = await Test.createTestingModule({
      controllers: [Probe],
      providers: [{ provide: PrismaService, useValue: prisma }, FeatureFlagService, { provide: APP_GUARD, useClass: RequiresModuleGuard }],
    }).compile();
    const app: INestApplication = mod.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get('/probe').expect(404);
    await flags.ensure(moduleFlagKey('testmod2'), true);
    await request(app.getHttpServer()).get('/probe').expect(200);
    await prisma.featureFlag.deleteMany({ where: { key: moduleFlagKey('testmod2') } });
    await request(app.getHttpServer()).get('/probe').expect(404);
    await app.close();
  });

  it('settings are validated by a schema defined in code', async () => {
    const settings = new SettingsService(prisma);
    settings.define('test.limits', z.object({ max: z.number().int().min(1) }).strict());
    expect(() => settings.define('test.limits', z.any())).toThrow(/already defined/);
    expect(await settings.get('test.limits', { max: 5 })).toEqual({ max: 5 });
    await settings.set('test.limits', { max: 9 });
    expect(await settings.get('test.limits', { max: 5 })).toEqual({ max: 9 });
    await expect(settings.set('test.limits', { max: 0 })).rejects.toThrow();
    await expect(settings.set('test.limits', { max: 1, extra: true })).rejects.toThrow();
    await expect(settings.set('test.unknown', {})).rejects.toMatchObject({ code: 'setting_unknown' });
  });
});

describe('number sequences', () => {
  it('hands out each number once under concurrent transactions', async () => {
    const seq = new NumberSequenceService();
    await prisma.$transaction((tx) => seq.ensure(tx, 'test.booking', 'MT-', 100n));
    const got = await Promise.all(Array.from({ length: 25 }, () => prisma.$transaction((tx) => seq.next(tx, 'test.booking'))));
    const values = got.map((g) => Number(g.value)).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 25 }, (_, i) => 100 + i));
    expect(got.every((g) => g.formatted === `MT-${g.value}`)).toBe(true);
    await expect(prisma.$transaction((tx) => seq.next(tx, 'test.missing'))).rejects.toMatchObject({ code: 'sequence_unknown' });
  });

  it('a rolled back transaction does not use up a number', async () => {
    const seq = new NumberSequenceService();
    await prisma.$transaction((tx) => seq.ensure(tx, 'test.rollback', '', 1n));
    await expect(prisma.$transaction(async (tx) => { await seq.next(tx, 'test.rollback'); throw new Error('x'); })).rejects.toThrow();
    expect((await prisma.$transaction((tx) => seq.next(tx, 'test.rollback'))).value).toBe(1n);
  });
});

describe('entity registry', () => {
  const handlers = { export: async () => [], anonymise: async () => undefined };
  it('requires handlers for a customer link and rejects duplicates', () => {
    const r = new EntityRegistry();
    expect(() => r.register({ entityType: 'Booking', model: 'Booking', customerLink: { kind: 'column', column: 'customerId' } })).toThrow(/no export and anonymise/);
    r.register({ entityType: 'Customer', model: 'Customer', customerLink: { kind: 'self' }, handlers });
    expect(() => r.register({ entityType: 'Customer', model: 'Customer' })).toThrow(/already registered/);
    r.register({ entityType: 'Race', model: 'Race' });
    expect(r.withCustomerLink().map((e) => e.entityType)).toEqual(['Customer']);
  });
  it('validate follows via-links to a customer, and rejects broken and circular chains', () => {
    const ok = new EntityRegistry();
    ok.register({ entityType: 'Customer', model: 'Customer', customerLink: { kind: 'self' }, handlers });
    ok.register({ entityType: 'Booking', model: 'Booking', customerLink: { kind: 'column', column: 'customerId' }, handlers });
    ok.register({ entityType: 'Payment', model: 'Payment', customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' }, handlers });
    expect(() => ok.validate()).not.toThrow();
    const broken = new EntityRegistry();
    broken.register({ entityType: 'Payment', model: 'Payment', customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' }, handlers });
    expect(() => broken.validate()).toThrow(/has no customer link/);
    const cyc = new EntityRegistry();
    cyc.register({ entityType: 'A', model: 'A', customerLink: { kind: 'via', entityType: 'B', column: 'b' }, handlers });
    cyc.register({ entityType: 'B', model: 'B', customerLink: { kind: 'via', entityType: 'A', column: 'a' }, handlers });
    expect(() => cyc.validate()).toThrow(/circular/);
  });
});

describe('safeError (plan 4.1)', () => {
  it('keeps codes of known classes and drops everything else', () => {
    expect(safeError(new AppError('my_code', 'Fixed text'))).toEqual({ code: 'my_code', message: 'Fixed text' });
    const prismaErr = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`) with value jane@example.com', { code: 'P2002', clientVersion: 'x', meta: { target: ['email'], value: 'jane@example.com' } });
    expect(safeError(prismaErr)).toEqual({ code: 'prisma_P2002', message: 'A unique constraint was violated' });
    expect(safeError(Object.assign(new Error('duplicate key value (jane@example.com)'), { code: '23505', detail: 'Key (email)=(jane@example.com) already exists.' }))).toEqual({ code: 'pg_23505', message: 'A database error occurred' });
    expect(safeError(new Error('whatever jane@example.com'))).toEqual({ code: 'unexpected_error', message: 'An unexpected error occurred' });
    expect(safeError('a string')).toMatchObject({ code: 'unexpected_error' });
    expect(safeError(null)).toMatchObject({ code: 'unexpected_error' });
  });
  it('SafeJobError has no stack and no original text', () => {
    const e = new SafeJobError(safeError(new Error('secret jane@example.com')));
    expect(e.stack).toBeUndefined();
    expect(e.message).not.toContain('jane');
  });
});

describe('API start-up', () => {
  it('does not start when a declared queue is missing', async () => {
    const missing = { name: 'module.never_migrated', data: z.object({}).strict(), options: { policy: 'short' as const, retryLimit: 1, retryDelay: 1, expireInSeconds: 60, deleteAfterSeconds: 60 } };
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JobsService).useValue(new JobsService(config, [...QUEUE_LIST, missing]))
      .compile();
    const app = mod.createNestApplication();
    await expect(app.init()).rejects.toMatchObject({ code: 'queues_missing' });
    await app.close().catch(() => undefined);
  });

  it('starts with the real queues and answers /health', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    await request(app.getHttpServer()).get('/health').expect(200);
    await app.close();
  });
});

void newId;
