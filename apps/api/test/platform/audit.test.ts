import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyFields, renderFieldClasses } from '../../scripts/field-classes';
import { AuditService, SYSTEM_ACTOR } from '../../src/platform/audit/audit.service';
import { registerAuthAuditSubjects } from '../../src/platform/auth/audit-subjects';
import { PrismaService } from '../../src/platform/database/prisma.service';
import { EntityRegistry } from '../../src/platform/entities/entity-registry';
import { newId, testConfig } from '../support/platform';

let prisma: PrismaService;
let audit: AuditService;
let entities: EntityRegistry;
beforeAll(() => {
  prisma = new PrismaService(testConfig());
  entities = new EntityRegistry();
  audit = new AuditService(entities);
  registerAuthAuditSubjects(audit);
});
afterAll(async () => prisma.$disconnect());

const rowsOf = async (logId: string) => ({
  log: await prisma.auditLog.findUniqueOrThrow({ where: { id: logId } }),
  // Sorted in JS: database collations order '_reason' differently.
  pii: (await prisma.auditPiiValue.findMany({ where: { auditLogId: logId } })).sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
});

describe('field classes', () => {
  it('field_classes_up_to_date: the generated file matches the schema annotations', () => {
    const root = join(__dirname, '../..');
    const expected = renderFieldClasses(classifyFields(join(root, 'prisma/schema')));
    expect(readFileSync(join(root, 'src/platform/audit/field-classes.generated.ts'), 'utf8')).toBe(expected);
  });

  it('unannotated or unknown fields count as personal data', () => {
    expect(audit.classify('User', 'email')).toBe('pii');
    expect(audit.classify('User', 'status')).toBe('nopii');
    expect(audit.classify('User', 'passwordHash')).toBe('secret');
    expect(audit.classify('User', 'notAColumn')).toBe('pii');
    expect(audit.classify('NoSuchModel', 'x')).toBe('pii');
  });
});

describe('AuditService', () => {
  it('audit_splits_pii_and_reason: @nopii with before/after, @pii, unknown fields and the reason in AuditPiiValue, secrets only as [changed]', async () => {
    const entityId = newId();
    const logId = await prisma.$transaction((tx) =>
      audit.record(tx, {
        actor: { type: 'staff', id: newId(), sessionId: newId(), requestId: 'req-1' },
        action: 'access.user.updated', entityType: 'User', entityId,
        before: { kind: 'staff', status: 'active', email: 'old@example.test', passwordHash: 'argon-old', mystery: 'x', failedLoginCount: 2 },
        after: { kind: 'staff', status: 'disabled', email: 'new@example.test', passwordHash: 'argon-new', mystery: 'y', failedLoginCount: 2 },
        reason: 'Left the company (Jane Citizen)',
      }),
    );
    const { log, pii } = await rowsOf(logId);
    expect(log.changes).toEqual({ status: { before: 'active', after: 'disabled' }, email: '[pii]', passwordHash: '[changed]', mystery: '[pii]', _reason: '[pii]' });
    expect(pii.map((p) => [p.field, p.before, p.after])).toEqual([
      ['_reason', null, 'Left the company (Jane Citizen)'],
      ['email', 'old@example.test', 'new@example.test'],
      ['mystery', 'x', 'y'],
    ]);
    const everything = JSON.stringify({ log, pii });
    expect(everything).not.toContain('argon-old');
    expect(everything).not.toContain('argon-new');
    expect(pii.every((p) => p.subjectUserId === null && p.subjectCustomerId === null)).toBe(true); // staff user: no subject
    expect(log).toMatchObject({ actorType: 'staff', requestId: 'req-1', entityType: 'User', entityId });
  });

  it('customer_user_audit_pii_has_subject', async () => {
    const userId = newId();
    await prisma.user.create({ data: { id: userId, kind: 'customer', email: `${userId}@example.test` } });
    const logId = await prisma.$transaction((tx) =>
      audit.record(tx, { actor: SYSTEM_ACTOR, action: 'auth.user.created', entityType: 'User', entityId: userId, after: { email: `${userId}@example.test` } }),
    );
    const { pii } = await rowsOf(logId);
    expect(pii).toHaveLength(1);
    expect(pii[0]).toMatchObject({ field: 'email', subjectUserId: userId, subjectCustomerId: null });
  });

  it('follows the entity registry customer link for subjectCustomerId', async () => {
    const reg = new EntityRegistry();
    const a = new AuditService(reg);
    const handlers = { export: async () => [], anonymise: async () => undefined };
    reg.register({ entityType: 'TestTraveller', model: 'TestTraveller', customerLink: { kind: 'column', column: 'customerId' }, handlers });
    const customerId = newId();
    const logId = await prisma.$transaction((tx) =>
      a.record(tx, { actor: SYSTEM_ACTOR, action: 'test.traveller.updated', entityType: 'TestTraveller', model: 'TestTraveller', entityId: newId(), before: { customerId, name: 'A' }, after: { customerId, name: 'B' } }),
    );
    const { pii } = await rowsOf(logId);
    expect(pii).toEqual([expect.objectContaining({ field: 'name', subjectCustomerId: customerId })]);
  });

  it('records nothing when the transaction rolls back', async () => {
    const entityId = newId();
    await expect(
      prisma.$transaction(async (tx) => {
        await audit.record(tx, { actor: SYSTEM_ACTOR, action: 'test.rollback', entityType: 'Test', entityId, after: { x: 1 } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.auditLog.count({ where: { entityId } })).toBe(0);
  });

  it('context holds codes only, never free text', async () => {
    await expect(
      prisma.$transaction((tx) => audit.record(tx, { actor: SYSTEM_ACTOR, action: 'test.ctx', entityType: 'Test', entityId: newId(), context: { reason: 'jane@example.test tried' } })),
    ).rejects.toMatchObject({ code: 'audit_context_not_a_code' });
    const logId = await prisma.$transaction((tx) => audit.record(tx, { actor: SYSTEM_ACTOR, action: 'test.ctx', entityType: 'Test', entityId: newId(), context: { reason: 'unknown_account', attempts: 3 } }));
    expect((await rowsOf(logId)).log.changes).toEqual({ _context: { reason: 'unknown_account', attempts: 3 } });
  });
});
