// Automations (task 7.4) against PostgreSQL: the routes and their permissions, test mode, the owner's permissions,
// real runs and their effects, idempotency, atomicity, retries, every skip, the caps, and what is stored.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTOMATION_REASON_CODES, AUTOMATION_ACTION_TYPES, automationStepSchema } from '@mt/shared';
import { AUTOMATIONS_CONSUMER, AUTOMATIONS_PERMISSIONS } from '../../../src/modules/automations';
import { AutomationEngine, MAX_RUN_ATTEMPTS } from '../../../src/modules/automations/engine';
import { AutomationActions } from '../../../src/modules/automations/actions';
import { PermissionRegistry } from '../../../src/platform/access/permissions';
import { emailHash } from '../../../src/platform/crypto/hmac';
import { AppError } from '../../../src/platform/errors/safe-error';
import { ConsumerRegistry } from '../../../src/platform/events/consumers';
import { OutboxService } from '../../../src/platform/events/outbox.service';
import { MailService } from '../../../src/platform/mail/mail.service';
import { STATE_HEADERS, TestApp, createStaff, makeApp, signInStaff } from '../../support/auth';
import type { StaffFixture } from '../../support/auth';
import { Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { bookingStaff, cleanBookingEvents, makeBookingFor } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import { MAX_CUSTOMER_NOTICES_PER_WINDOW, MAX_REAL_RUNS_PER_HOUR } from '@mt/shared';
import { AUTOMATIONS_TIME_ZONE } from '../../../src/modules/automations/manifest';
import { BUSINESS_TIME_ZONE } from '../../../src/modules/pricing/engine/calendar';
import { AccessService } from '../../../src/platform/access/access.service';
import { SettingsService } from '../../../src/platform/flags/flags.service';

const P = AUTOMATIONS_PERMISSIONS;
const ACTION_PERMISSIONS = [
  'common.task.write', 'common.task.manageAutomated', 'bookings.booking.annotate', 'bookings.customer.read', 'bookings.booking.read', 'crm.quote.read',
  'catalogue.package.read', 'integrations.webhook.manage', 'integrations.webhook.read',
];
const ALL = [...Object.values(P), ...ACTION_PERMISSIONS];
const TEMPLATE_KEYS = ['automations.customer_notice_1', 'automations.customer_notice_2', 'automations.staff_notice'];

let t: TestApp;
let owner: Client & { staff: StaffFixture };
let engine: AutomationEngine;
let w: PricedWorld;
let tagId: string;
let hookId: string;

const q = async (sql: string): Promise<number> => Number((await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]!.n);
const freshStepUp = (userId: string) => t.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { mfaVerifiedAt: new Date() } });

async function signedIn(permissions: string[]): Promise<Client & { staff: StaffFixture }> {
  return staffClient(t, permissions);
}

/** Removes a permission from a test staff member's own role. */
async function revoke(s: StaffFixture, key: string): Promise<void> {
  const roles = await t.prisma.userRole.findMany({ where: { userId: s.id }, select: { roleId: true } });
  await t.prisma.rolePermission.deleteMany({ where: { roleId: { in: roles.map((r) => r.roleId) }, permissionKey: key } });
}

const taskAction = (title = 'Call the customer') => ({ type: 'create_task', title, dueInHours: 24 });
const ruleBody = (over: Record<string, unknown> = {}) => ({ name: 'Follow up new requests', triggerType: 'event', eventType: 'bookings.booking.requested', conditions: [], actions: [taskAction()], ...over });

async function createRule(c: Client & { staff: StaffFixture }, over: Record<string, unknown> = {}) {
  await freshStepUp(c.staff.id);
  const res = await c.post('/admin/automations', ruleBody(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; version: number };
}

/** `serviceMessageAck`: the customer notices are confirmed as service messages (task 7.fix-2). */
async function enable(c: Client & { staff: StaffFixture }, id: string, testMode: boolean, serviceMessageAck?: boolean) {
  await freshStepUp(c.staff.id);
  const cur = (await c.get(`/admin/automations/${id}`)).body;
  const res = await c.post(`/admin/automations/${id}/enable`, { version: cur.version, testMode, ...(serviceMessageAck === undefined ? {} : { serviceMessageAck }) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { id: string; version: number };
}

async function ruleOn(over: Record<string, unknown> = {}, testMode = false, c: Client & { staff: StaffFixture } = owner, serviceMessageAck?: boolean) {
  const r = await createRule(c, over);
  return enable(c, r.id, testMode, serviceMessageAck);
}

async function newBooking(): Promise<{ bookingId: string; customerId: string }> {
  return makeBookingFor(t, { pkg: w.pkg, edition: w.edition, versionId: w.versionId });
}

/** Publishes an event and runs the automations consumer on it, as the event delivery job would. */
async function fire(type: string, aggregateId: string, opts: { actorType?: 'staff' | 'customer' | 'system' | 'automation'; payload?: Record<string, unknown>; occurredAt?: Date; aggregateType?: string } = {}) {
  const outbox = t.app.get(OutboxService);
  const id = await t.prisma.$transaction((tx) => outbox.publish(tx, {
    type, aggregateType: opts.aggregateType ?? 'Booking', aggregateId, payload: opts.payload ?? { bookingId: aggregateId }, actorType: opts.actorType ?? 'customer',
  }));
  if (opts.occurredAt) await t.prisma.outboxEvent.update({ where: { id }, data: { occurredAt: opts.occurredAt } });
  const e = await t.prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
  const event = { id: e.id, type: e.type, schemaVersion: e.schemaVersion, aggregateType: e.aggregateType, aggregateId: e.aggregateId, aggregateVersion: e.aggregateVersion, payload: e.payload, actorType: e.actorType, actorId: e.actorId, occurredAt: e.occurredAt };
  const consumer = t.app.get(ConsumerRegistry).get(AUTOMATIONS_CONSUMER)!;
  const handle = () => t.prisma.$transaction((tx) => consumer.handle(event, { tx }));
  await handle();
  return { eventId: id, handle };
}

const runsOf = (ruleId: string) => t.prisma.automationRun.findMany({ where: { ruleId }, orderBy: { startedAt: 'asc' } });
async function runPending(): Promise<void> {
  for (const r of await t.prisma.automationRun.findMany({ where: { status: 'pending' }, orderBy: { startedAt: 'asc' } })) await engine.processRun(r.id);
}
const tasksOn = (entityId: string) => t.prisma.task.findMany({ where: { entityId, source: 'automation' } });

async function counts(bookingId: string) {
  return {
    emails: await q('SELECT count(*) AS n FROM outbound_emails'),
    tasks: await q('SELECT count(*) AS n FROM tasks'),
    taggings: await q('SELECT count(*) AS n FROM taggings'),
    deliveries: await q('SELECT count(*) AS n FROM webhook_deliveries'),
    events: await q(`SELECT count(*) AS n FROM outbox_events WHERE type LIKE 'automations.%'`),
    jobs: await q(`SELECT count(*) AS n FROM pgboss.job WHERE name IN ('mail.send', 'webhooks.send')`),
    audit: await q('SELECT count(*) AS n FROM audit_logs'),
    booking: (await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { version: true, status: true } })),
  };
}

beforeAll(async () => {
  t = await makeApp();
  engine = t.app.get(AutomationEngine);
  owner = await signedIn(ALL);
  const catalogue = await bookingStaff(t);
  w = await pricedWorld(catalogue);
  tagId = (await t.prisma.tag.create({ data: { name: `vip-${randomUUID().slice(0, 8)}`, colour: '#336699', entityTypes: ['Booking'] } })).id;
  await t.prisma.messageTemplate.deleteMany({ where: { key: { in: TEMPLATE_KEYS } } });
  for (const key of TEMPLATE_KEYS) {
    await t.prisma.messageTemplate.create({
      data: key.includes('staff')
        ? { channel: 'email', key, revision: 1, status: 'active', subject: 'Rule {{ruleName}}', body: 'Ran {{ruleName}} on {{reference}} {{adminLink}}' }
        : { channel: 'email', key, revision: 1, status: 'active', subject: 'About {{reference}}', body: 'Hi {{givenName}}, about {{trip}}: {{link}}' },
    });
  }
  // At most 20 live webhooks exist at once: start with none.
  await t.prisma.$executeRawUnsafe(`UPDATE webhook_subscriptions SET "deletedAt" = now(), enabled = false, url = '', "secretCiphertext" = '' WHERE "deletedAt" IS NULL`);
  await freshStepUp(owner.staff.id);
  const hook = await owner.post('/admin/integrations/webhooks', { url: 'https://hooks.example.test/in', eventTypes: ['automations.rule.fired'], description: 'Automation receiver' });
  expect(hook.status, JSON.stringify(hook.body)).toBe(201);
  hookId = hook.body.webhook.id;
});

beforeEach(async () => {
  // Every test starts with no live rule (rules are never deleted, only marked deleted).
  await t.prisma.$executeRawUnsafe(`UPDATE automation_rules SET enabled = false, "deletedAt" = now(), "deletedById" = "ownerUserId" WHERE "deletedAt" IS NULL`);
  await t.prisma.$executeRawUnsafe(`UPDATE automation_runs SET status = 'skipped', "reasonCode" = 'rule_disabled', "finishedAt" = now() WHERE status = 'pending'`);
  engine.beforeAction = null;
});

afterAll(async () => {
  // Every stored step and reason is from the closed lists (no free text), whatever happened in this file.
  const runs = await t.prisma.automationRun.findMany({ select: { steps: true, reasonCode: true } });
  for (const r of runs) {
    for (const s of r.steps as unknown[]) expect(automationStepSchema.safeParse(s).success, JSON.stringify(s)).toBe(true);
    if (r.reasonCode) expect(AUTOMATION_REASON_CODES).toContain(r.reasonCode);
  }
  await t.prisma.$executeRawUnsafe(`UPDATE automation_rules SET enabled = false, "deletedAt" = now(), "deletedById" = "ownerUserId" WHERE "deletedAt" IS NULL`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM automation_runs`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name LIKE 'automations.%' OR name IN ('mail.send', 'webhooks.send')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'automations.%' OR type LIKE 'catalogue.%' OR type LIKE 'crm.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'automations.%' OR type LIKE 'catalogue.%' OR type LIKE 'crm.%'`);
  await t.prisma.messageTemplate.deleteMany({ where: { key: { in: TEMPLATE_KEYS } } });
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

describe('routes and permissions', () => {
  it('needs read, manage and enable separately; enabling needs a fresh authenticator check', async () => {
    const reader = await signedIn([P.read, ...ACTION_PERMISSIONS]);
    expect((await reader.get('/admin/automations')).status).toBe(200);
    expect((await reader.post('/admin/automations', ruleBody())).status).toBe(403);
    const manager = await signedIn([P.read, P.manage, ...ACTION_PERMISSIONS]);
    const r = await createRule(manager);
    expect((await manager.post(`/admin/automations/${r.id}/enable`, { version: r.version, testMode: true })).status).toBe(403);
    expect((await manager.post(`/admin/automations/${r.id}/test`, {})).status).not.toBe(403);
    await t.prisma.session.updateMany({ where: { userId: owner.staff.id }, data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) } });
    const res = await owner.post(`/admin/automations/${r.id}/enable`, { version: r.version, testMode: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('step_up_required');
    expect((await t.http().get('/admin/automations')).status).toBe(401);
  });

  it('no automation permission can be an API key scope', () => {
    const reg = t.app.get(PermissionRegistry);
    for (const k of Object.values(P)) expect(reg.get(k)?.apiKeyScopable).toBe(false);
    expect(reg.get(P.enable)?.requiresStepUp).toBe(true);
  });

  it('answers 404 while the module is off', async () => {
    await t.prisma.featureFlag.update({ where: { key: 'module.automations' }, data: { enabled: false } });
    try {
      expect((await owner.get('/admin/automations')).status).toBe(404);
    } finally {
      await t.prisma.featureFlag.update({ where: { key: 'module.automations' }, data: { enabled: true } });
    }
  });

  it('refuses unknown actions, triggers, facts, records and tags; one customer email and each webhook once', async () => {
    const bad = async (over: Record<string, unknown>) => (await owner.post('/admin/automations', ruleBody(over))).body.code as string;
    expect(await bad({ actions: [{ type: 'approve_booking' }] })).toBe('validation_failed');
    expect(await bad({ eventType: 'payments.payment.succeeded' })).toBe('validation_failed');
    expect(await bad({ conditions: [{ fact: 'toStatus', op: 'is', value: 'open' }] })).toBe('automation_condition_invalid');
    expect(await bad({ conditions: [{ fact: 'packageId', op: 'is', value: randomUUID() }] })).toBe('automation_condition_invalid');
    expect(await bad({ conditions: [{ fact: 'tagIds', op: 'has_tag', value: randomUUID() }] })).toBe('automation_tag_invalid');
    expect(await bad({ actions: [{ type: 'add_tag', tagId: randomUUID() }] })).toBe('automation_tag_invalid');
    expect(await bad({ actions: [{ type: 'create_task', title: 'x', assigneeId: randomUUID() }] })).toBe('automation_assignee_unknown');
    expect(await bad({ actions: [{ type: 'send_email', template: 'customer_notice_1' }, { type: 'send_email', template: 'customer_notice_2' }] })).toBe('automation_too_many_customer_emails');
    expect(await bad({ actions: [{ type: 'call_webhook', subscriptionId: hookId }, { type: 'call_webhook', subscriptionId: hookId }] })).toBe('duplicate_webhook_action');
  });

  it('every action against every trigger: allowed where declared, 422 elsewhere', async () => {
    const actions: Record<string, Record<string, unknown>> = {
      create_task: taskAction(), add_tag: { type: 'add_tag', tagId }, remove_tag: { type: 'remove_tag', tagId }, close_tasks: { type: 'close_tasks' },
      send_email: { type: 'send_email', template: 'customer_notice_1' }, call_webhook: { type: 'call_webhook', subscriptionId: hookId },
    };
    const triggers = {
      Booking: { eventType: 'bookings.booking.approved' }, Quote: { eventType: 'crm.quote.sent' }, Package: { eventType: 'catalogue.package.sale_status_changed' },
      schedule: { triggerType: 'schedule', eventType: undefined, schedule: { frequency: 'daily', time: '08:00' } },
    };
    const allowed: Record<string, string[]> = {
      create_task: ['Booking', 'Quote', 'Package', 'schedule'], add_tag: ['Booking'], remove_tag: ['Booking'], close_tasks: ['Booking', 'Quote', 'Package'],
      send_email: ['Booking', 'Quote'], call_webhook: ['Booking', 'Quote', 'Package', 'schedule'],
    };
    expect(Object.keys(actions).sort()).toEqual([...AUTOMATION_ACTION_TYPES].sort());
    for (const [type, action] of Object.entries(actions)) {
      for (const [scope, trig] of Object.entries(triggers)) {
        await freshStepUp(owner.staff.id);
        const res = await owner.post('/admin/automations', ruleBody({ ...trig, actions: [action] }));
        if (allowed[type]!.includes(scope)) expect(res.status, `${type} on ${scope}: ${JSON.stringify(res.body)}`).toBe(201);
        else expect([res.status, res.body.code], `${type} on ${scope}`).toEqual([422, 'automation_action_not_allowed']);
      }
    }
    // The staff notice works on every trigger.
    for (const trig of Object.values(triggers)) expect((await owner.post('/admin/automations', ruleBody({ ...trig, actions: [{ type: 'send_email', template: 'staff_notice' }] }))).status).toBe(201);
  });

  it('versions, delete only when off, and an audit trail with the name kept as personal data', async () => {
    const r = await createRule(owner, { name: 'Ada special' });
    expect((await owner.patch(`/admin/automations/${r.id}`, { ...ruleBody(), version: r.version + 5 })).status).toBe(409);
    const on = await enable(owner, r.id, true);
    expect((await owner.delete(`/admin/automations/${r.id}?version=${on.version}`)).body.code).toBe('automation_is_on');
    const off = (await owner.post(`/admin/automations/${r.id}/disable`, { version: on.version })).body;
    expect((await owner.delete(`/admin/automations/${r.id}?version=${off.version}`)).status).toBe(204);
    expect((await owner.get(`/admin/automations/${r.id}`)).status).toBe(404);
    expect((await owner.post(`/admin/automations/${r.id}/test`, {})).status).toBe(404);
    const audit = await t.prisma.auditLog.findMany({ where: { entityType: 'AutomationRule', entityId: r.id }, orderBy: { occurredAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['automations.rule.created', 'automations.rule.enabled', 'automations.rule.disabled', 'automations.rule.deleted']);
    expect(JSON.stringify(audit[0]!.changes)).not.toContain('Ada special');
    expect(JSON.stringify(audit[0]!.changes)).toContain('[pii]');
    // The API role cannot delete a rule row at all.
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM automation_rules WHERE id = '${r.id}'`)).rejects.toThrow();
  });

  it('a template that is not in use cannot be switched on', async () => {
    await t.prisma.messageTemplate.updateMany({ where: { key: 'automations.customer_notice_2' }, data: { status: 'archived' } });
    try {
      const r = await createRule(owner, { actions: [{ type: 'send_email', template: 'customer_notice_2' }] });
      await freshStepUp(owner.staff.id);
      expect((await owner.post(`/admin/automations/${r.id}/enable`, { version: r.version, testMode: false })).body.code).toBe('automation_template_not_in_use');
    } finally {
      await t.prisma.messageTemplate.updateMany({ where: { key: 'automations.customer_notice_2' }, data: { status: 'active' } });
    }
  });

  it('a webhook must subscribe to automations.rule.fired', async () => {
    await freshStepUp(owner.staff.id);
    const other = await owner.post('/admin/integrations/webhooks', { url: 'https://other.example.test/in', eventTypes: ['catalogue.package.sale_status_changed'] });
    expect(other.status).toBe(201);
    expect((await owner.post('/admin/automations', ruleBody({ actions: [{ type: 'call_webhook', subscriptionId: other.body.webhook.id }] }))).body.code).toBe('webhook_not_subscribed');
    await t.prisma.webhookSubscription.update({ where: { id: other.body.webhook.id }, data: { deletedAt: new Date(), enabled: false } });
  });

  it('at most 50 automations are on at once', async () => {
    const r = await createRule(owner);
    const extra = Array.from({ length: 50 }, () => randomUUID());
    await t.prisma.$executeRawUnsafe(`INSERT INTO automation_rules (id, name, "triggerType", schedule, actions, enabled, "enabledAt", "ownerUserId", "updatedAt")
      SELECT unnest($1::uuid[]), 'Filler', 'schedule', '{"frequency":"daily","time":"03:00"}', '[]', true, now() + interval '1 day', $2::uuid, now()`, extra, owner.staff.id);
    await freshStepUp(owner.staff.id);
    expect((await owner.post(`/admin/automations/${r.id}/enable`, { version: r.version, testMode: true })).body.code).toBe('too_many_enabled_rules');
  });
});

describe('automation_cannot_exceed_author_permissions', () => {
  it('cannot save a rule whose actions need a permission the author lacks', async () => {
    const partial = await signedIn([...Object.values(P), 'bookings.booking.read']);
    const res = await partial.post('/admin/automations', ruleBody());
    expect([res.status, res.body.code]).toEqual([403, 'automation_cannot_exceed_author_permissions']);
    // A webhook action uses a step-up permission: an old authenticator check is not enough.
    await t.prisma.session.updateMany({ where: { userId: owner.staff.id }, data: { mfaVerifiedAt: new Date(Date.now() - 10 * 60_000) } });
    const hook = await owner.post('/admin/automations', ruleBody({ actions: [{ type: 'call_webhook', subscriptionId: hookId }] }));
    expect(hook.body.code).toBe('step_up_required');
  });

  it('a run uses the owner’s current permissions: a lost one stops it, once noticed; a disabled owner pauses it', async () => {
    const author = await signedIn(ALL);
    const r = await ruleOn({}, false, author);
    await revoke(author.staff, 'common.task.write');
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const runs = await runsOf(r.id);
    expect(runs.map((x) => [x.status, x.reasonCode])).toEqual([['failed', 'automation_cannot_exceed_author_permissions'], ['failed', 'automation_cannot_exceed_author_permissions']]);
    expect(await tasksOn(bookingId)).toHaveLength(0);
    expect(await t.prisma.task.count({ where: { source: 'system', sourceRef: `automations:permission_lost:${r.id}` } })).toBe(1);

    const second = await signedIn(ALL);
    const r2 = await ruleOn({}, false, second);
    await t.prisma.user.update({ where: { id: second.staff.id }, data: { status: 'disabled' } });
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    expect((await runsOf(r2.id)).map((x) => x.reasonCode)).toEqual(['owner_inactive']);
    expect(await t.prisma.task.count({ where: { source: 'system', sourceRef: `automations:owner_inactive:${r2.id}` } })).toBe(1);
  });

  it('the subscription’s creator must still be able to read the records', async () => {
    const creator = await signedIn(ALL);
    await freshStepUp(creator.staff.id);
    const hook = await creator.post('/admin/integrations/webhooks', { url: 'https://third.example.test/in', eventTypes: ['automations.rule.fired'] });
    expect(hook.status).toBe(201);
    const r = await ruleOn({ actions: [{ type: 'call_webhook', subscriptionId: hook.body.webhook.id }] });
    await revoke(creator.staff, 'bookings.booking.read');
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const [run] = await runsOf(r.id);
    expect(run!.steps).toEqual([{ index: 0, action: 'call_webhook', status: 'skipped', code: 'webhook_unavailable' }]);
    expect(await t.prisma.webhookDelivery.count({ where: { subscriptionId: hook.body.webhook.id } })).toBe(0);
    await t.prisma.webhookSubscription.update({ where: { id: hook.body.webhook.id }, data: { deletedAt: new Date(), enabled: false } });
  });
});

const everyAction = () => [
  { type: 'close_tasks' }, taskAction('Check the request'), { type: 'add_tag', tagId }, { type: 'send_email', template: 'customer_notice_1' },
  { type: 'send_email', template: 'staff_notice' }, { type: 'call_webhook', subscriptionId: hookId },
];

describe('review round 1 of the code', () => {
  it('a member who can manage but not switch on can draft a rule and test it', async () => {
    const manager = await signedIn([P.read, P.manage, ...ACTION_PERMISSIONS]);
    const r = await createRule(manager, { actions: [taskAction('Draft check'), { type: 'add_tag', tagId }] });
    const { bookingId } = await newBooking();
    const res = await manager.post(`/admin/automations/${r.id}/test`, { entityId: bookingId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect([res.body.status, res.body.reasonCode]).toEqual(['succeeded', null]);
    expect(res.body.steps.map((s: { status: string }) => s.status)).toEqual(['simulated', 'simulated']);
    expect(await tasksOn(bookingId)).toHaveLength(0);
  });

  it('a rule needs its owner to read the records its trigger is about, when saved and at every run', async () => {
    const blind = await signedIn([...Object.values(P), 'common.task.write']);
    const res = await blind.post('/admin/automations', ruleBody({ conditions: [{ fact: 'status', op: 'is', value: 'requested' }] }));
    expect([res.status, res.body.code]).toEqual([403, 'automation_cannot_exceed_author_permissions']);
    // A scheduled rule is about no record, so it needs no read permission.
    expect((await blind.post('/admin/automations', ruleBody({ triggerType: 'schedule', eventType: undefined, schedule: { frequency: 'daily', time: '08:00' } }))).status).toBe(201);

    const author = await signedIn(ALL);
    const r = await ruleOn({ conditions: [{ fact: 'status', op: 'is', value: 'requested' }] }, false, author);
    await revoke(author.staff, 'bookings.booking.read');
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    expect((await runsOf(r.id)).map((x) => [x.status, x.reasonCode, x.steps])).toEqual([['failed', 'automation_cannot_exceed_author_permissions', []]]);
    expect(await tasksOn(bookingId)).toHaveLength(0);
    expect(await t.prisma.task.count({ where: { sourceRef: `automations:permission_lost:${r.id}` } })).toBe(1);
  });

  it('an owner who loses the automation permissions stops the rule', async () => {
    const author = await signedIn(ALL);
    const r = await ruleOn({}, false, author);
    for (const k of Object.values(P)) await revoke(author.staff, k);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    expect((await runsOf(r.id)).map((x) => x.reasonCode)).toEqual(['automation_cannot_exceed_author_permissions']);
    expect(await tasksOn(bookingId)).toHaveLength(0);
    expect(await t.prisma.task.count({ where: { sourceRef: `automations:permission_lost:${r.id}` } })).toBe(1);
  });

  it('a run locked by another attempt is retried later, not dropped', async () => {
    const r = await ruleOn({}, false);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    const [run] = await runsOf(r.id);
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let locked!: () => void;
    const isLocked = new Promise<void>((res) => { locked = res; });
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM automation_runs WHERE id = ${run!.id}::uuid FOR UPDATE`;
      locked();
      await held;
    }, { timeout: 30_000 });
    await isLocked;
    await expect(engine.processRun(run!.id)).rejects.toMatchObject({ code: 'automation_run_busy' });
    release();
    await holder;
    expect((await t.prisma.automationRun.findUniqueOrThrow({ where: { id: run!.id } })).status).toBe('pending');
    expect(await engine.processRun(run!.id)).toBe('succeeded');
  });

  it('whether a customer could be reached is shown only to staff who can see customers', async () => {
    const r = await ruleOn({ actions: [{ type: 'send_email', template: 'customer_notice_1' }] }, false);
    const { bookingId, customerId } = await newBooking();
    await t.prisma.customer.update({ where: { id: customerId }, data: { anonymisedAt: new Date() } });
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const step = (body: { items: Array<{ steps: unknown[] }> }) => body.items[0]!.steps[0];
    expect(step((await owner.get(`/admin/automations/${r.id}/runs`)).body)).toEqual({ index: 0, action: 'send_email', status: 'skipped', code: 'recipient_unavailable' });
    const reader = await signedIn([P.read, P.manage, 'bookings.booking.read']);
    expect(step((await reader.get(`/admin/automations/${r.id}/runs`)).body)).toEqual({ index: 0, action: 'send_email', status: 'skipped' });
    const tested = await reader.post(`/admin/automations/${r.id}/test`, { entityId: bookingId });
    expect(tested.body.steps).toEqual([{ index: 0, action: 'send_email', status: 'skipped' }]);
  });
});

describe('automation_test_mode_sends_and_changes_nothing', () => {
  it('a rule in test mode, fired by a real event, only records what it would do', async () => {
    const r = await ruleOn({ actions: [...everyAction(), { type: 'remove_tag', tagId }] }, true);
    const { bookingId } = await newBooking();
    // An open automation task, so close_tasks would have something to close.
    await t.prisma.task.create({ data: { title: 'Earlier', entityType: 'Booking', entityId: bookingId, source: 'automation', sourceRef: 'automation:earlier' } });
    await fire('bookings.booking.requested', bookingId);
    const before = await counts(bookingId);
    await runPending();
    expect(await counts(bookingId)).toEqual(before);
    const [run] = await runsOf(r.id);
    expect(run!.status).toBe('succeeded');
    expect(run!.testMode).toBe(true);
    expect((run!.steps as Array<{ status: string }>).map((s) => s.status)).toEqual(['simulated', 'simulated', 'simulated', 'simulated', 'simulated', 'simulated', 'simulated']);
    expect((await tasksOn(bookingId)).map((x) => [x.sourceRef, x.status])).toEqual([['automation:earlier', 'open']]);
  });

  it('the panel test changes nothing, and a manual run can never be real (database check)', async () => {
    const r = await ruleOn({ actions: everyAction() }, false);
    const { bookingId } = await newBooking();
    const before = await counts(bookingId);
    const res = await owner.post(`/admin/automations/${r.id}/test`, { entityId: bookingId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.steps.map((s: { status: string }) => s.status)).toEqual(['skipped', 'simulated', 'simulated', 'simulated', 'simulated', 'simulated']);
    // The only new row is the audit record of the staff member's test (an action of the staff, not of the rule).
    expect(await counts(bookingId)).toEqual({ ...before, audit: before.audit + 1 });
    expect((await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'AutomationRule', entityId: r.id }, orderBy: { occurredAt: 'desc' } })).action).toBe('automations.rule.tested');
    await expect(t.prisma.automationRun.create({ data: { ruleId: r.id, ruleVersion: 1, source: 'manual', testMode: false } })).rejects.toThrow();
  });

  it('a test of a rule whose owner lost a permission opens no system task', async () => {
    const author = await signedIn(ALL);
    const r = await ruleOn({}, false, author);
    await revoke(author.staff, 'common.task.write');
    const { bookingId } = await newBooking();
    const before = await counts(bookingId);
    const res = await owner.post(`/admin/automations/${r.id}/test`, { entityId: bookingId });
    expect([res.body.status, res.body.reasonCode]).toEqual(['failed', 'automation_cannot_exceed_author_permissions']);
    expect(await counts(bookingId)).toEqual({ ...before, audit: before.audit + 1 });
    expect(await t.prisma.task.count({ where: { sourceRef: `automations:permission_lost:${r.id}` } })).toBe(0);
  });

  it('a run dispatched in test mode stays a test after test mode is switched off', async () => {
    const r = await ruleOn({}, true);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await enable(owner, r.id, false);
    await runPending();
    const [run] = await runsOf(r.id);
    expect([run!.status, run!.testMode]).toEqual(['succeeded', true]);
    expect(await tasksOn(bookingId)).toHaveLength(0);
  });

  it('a run dispatched for real becomes a test if the rule went back to test mode', async () => {
    const r = await ruleOn({}, false);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await enable(owner, r.id, true);
    await runPending();
    expect((await runsOf(r.id))[0]!.testMode).toBe(true);
    expect(await tasksOn(bookingId)).toHaveLength(0);
  });
});

describe('real runs', () => {
  it('does every action once, audited as the automation, and announces the run', async () => {
    const r = await ruleOn({ actions: everyAction() }, false, owner, true);
    const { bookingId, customerId } = await newBooking();
    await t.prisma.task.create({ data: { title: 'Earlier', entityType: 'Booking', entityId: bookingId, source: 'automation', sourceRef: 'automation:earlier' } });
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const [run] = await runsOf(r.id);
    expect(run!.status).toBe('succeeded');
    expect((run!.steps as Array<{ status: string }>).every((s) => s.status === 'done')).toBe(true);

    const tasks = await tasksOn(bookingId);
    expect(tasks.find((x) => x.sourceRef === 'automation:earlier')!.status).toBe('done');
    const made = tasks.find((x) => x.sourceRef?.startsWith(`automation:${r.id}:`))!;
    expect([made.title, made.status, made.entityType, made.source]).toEqual(['Check the request', 'open', 'Booking', 'automation']);
    expect(made.dueAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await t.prisma.tagging.count({ where: { tagId, entityId: bookingId } })).toBe(1);

    const emails = await t.prisma.outboundEmail.findMany({ where: { dedupeKey: { startsWith: `automation:${run!.id}:` } } });
    expect(emails.map((e) => e.templateKey).sort()).toEqual(['automations.customer_notice_1', 'automations.staff_notice']);
    const customerEmail = emails.find((e) => e.templateKey === 'automations.customer_notice_1')!;
    expect([customerEmail.customerId, customerEmail.category]).toEqual([customerId, 'transactional']);
    const before = t.mail.sent.length;
    for (const e of emails) await t.app.get(MailService).processSend(e.id);
    const sent = t.mail.sent.slice(before);
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { reference: true } });
    expect(sent.find((m) => m.subject === `About ${booking.reference}`)!.text).toContain('Hi Test');
    const staffMail = sent.find((m) => m.subject.startsWith('Rule'))!;
    expect(staffMail.to).toBe(owner.staff.email);
    expect(staffMail.text).toContain(`/admin/bookings/${bookingId}`);
    expect(staffMail.text).not.toContain('Test Customer');

    const delivery = await t.prisma.webhookDelivery.findFirstOrThrow({ where: { subscriptionId: hookId, eventId: run!.id } });
    expect(delivery.eventType).toBe('automations.rule.fired');
    expect((delivery.body as { data: Record<string, unknown> }).data).toMatchObject({ ruleId: r.id, runId: run!.id, entityType: 'Booking', entityId: bookingId, triggerEventType: 'bookings.booking.requested' });
    expect(JSON.stringify(delivery.body)).not.toMatch(/Test|@example/);

    const audit = await t.prisma.auditLog.findMany({ where: { actorType: 'automation', actorId: r.id } });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'automations.action.email_queued', 'automations.action.email_queued', 'automations.action.webhook_queued', 'common.tags.changed', 'common.task.created', 'common.task.updated',
    ]);
    expect(JSON.stringify(audit.map((a) => a.changes))).not.toMatch(/Test|@example/);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'automations.run.completed', aggregateId: run!.id } })).toBe(1);
  });

  it('one run per event and rule, and one set of effects, however often the consumer and the job run', async () => {
    const r = await ruleOn({}, false);
    const { bookingId } = await newBooking();
    const { handle } = await fire('bookings.booking.requested', bookingId);
    await handle();
    const runs = await runsOf(r.id);
    expect(runs).toHaveLength(1);
    const results = await Promise.allSettled([engine.processRun(runs[0]!.id), engine.processRun(runs[0]!.id), engine.processRun(runs[0]!.id)]);
    expect(results.filter((x) => x.status === 'fulfilled' && x.value === 'succeeded')).toHaveLength(1);
    // The others found the run finished (noop) or still being processed (thrown, so pg-boss tries again later).
    for (const x of results) {
      if (x.status === 'fulfilled') expect(['succeeded', 'noop']).toContain(x.value);
      else expect(x.reason).toMatchObject({ code: 'automation_run_busy' });
    }
    expect(await engine.processRun(runs[0]!.id)).toBe('noop');
    expect(await tasksOn(bookingId)).toHaveLength(1);
  });

  it('facts are taken when the event is handled: a tag added by one rule does not decide another', async () => {
    const tagger = await ruleOn({ name: 'Tag it', actions: [{ type: 'add_tag', tagId }] }, false);
    const follower = await ruleOn({ name: 'Untagged ones', conditions: [{ fact: 'tagIds', op: 'lacks_tag', value: tagId }] }, false);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await engine.processRun((await runsOf(tagger.id))[0]!.id);
    expect(await t.prisma.tagging.count({ where: { tagId, entityId: bookingId } })).toBe(1);
    await engine.processRun((await runsOf(follower.id))[0]!.id);
    expect((await runsOf(follower.id))[0]!.status).toBe('succeeded');
    expect(await tasksOn(bookingId)).toHaveLength(1);
  });

  it('a scheduled rule runs once per occurrence and local date, also after a change of time zone', async () => {
    const r = await ruleOn({ triggerType: 'schedule', eventType: undefined, schedule: { frequency: 'daily', time: '08:00' }, actions: [taskAction('Morning check')] }, false);
    await t.prisma.automationRule.update({ where: { id: r.id }, data: { enabledAt: new Date('2026-01-01T00:00:00Z') } });
    const now = new Date('2027-03-10T22:30:00Z'); // 08:30 on the 11th in Brisbane
    expect(await Promise.all([engine.tick(now), engine.tick(now)]).then((x) => x.reduce((a, b) => a + b, 0))).toBe(1);
    expect(await engine.tick(new Date(now.getTime() + 60_000))).toBe(0);
    // Sydney is an hour ahead in March: its 08:00 on the 11th is a new instant, but the same local date.
    expect(await engine.tick(new Date('2027-03-10T21:30:00Z'), 'Australia/Sydney')).toBe(0);
    // Older than six hours: not caught up.
    expect(await engine.tick(new Date('2027-03-12T05:00:00Z'))).toBe(0);
    await runPending();
    const runs = await runsOf(r.id);
    expect(runs.map((x) => [x.source, x.status, x.scheduledFor?.toISOString()])).toEqual([['schedule', 'succeeded', '2027-03-10T22:00:00.000Z']]);
    expect(await t.prisma.task.count({ where: { sourceRef: { startsWith: `automation:${r.id}:` }, entityId: null } })).toBe(1);
  });
});

describe('failures and retries', () => {
  it('a known failure rolls back every action, is recorded with codes and never retried', async () => {
    const r = await ruleOn({ actions: [taskAction(), { type: 'add_tag', tagId }] }, false);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    engine.beforeAction = (i) => { if (i === 1) throw new AppError('injected_failure', 'Injected'); };
    const [run] = await runsOf(r.id);
    expect(await engine.processRun(run!.id)).toBe('failed');
    const after = await t.prisma.automationRun.findUniqueOrThrow({ where: { id: run!.id } });
    expect([after.status, after.reasonCode]).toEqual(['failed', 'action_failed']);
    expect(after.steps).toEqual([{ index: 0, action: 'create_task', status: 'rolled_back' }, { index: 1, action: 'add_tag', status: 'failed', code: 'action_failed' }]);
    expect(await tasksOn(bookingId)).toHaveLength(0);
    expect(JSON.stringify(after)).not.toContain('Injected');
  });

  it('an unexpected error keeps the run pending for a retry, and the retry succeeds once', async () => {
    const r = await ruleOn({}, false);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    let calls = 0;
    engine.beforeAction = () => { calls += 1; if (calls === 1) throw new Error('connection reset'); };
    const [run] = await runsOf(r.id);
    await expect(engine.processRun(run!.id)).rejects.toThrow('connection reset');
    const mid = await t.prisma.automationRun.findUniqueOrThrow({ where: { id: run!.id } });
    expect([mid.status, mid.attempts]).toEqual(['pending', 1]);
    expect(await engine.processRun(run!.id)).toBe('succeeded');
    expect(await tasksOn(bookingId)).toHaveLength(1);
  });

  it(`after ${MAX_RUN_ATTEMPTS} unexpected errors the run fails; a run stuck in pending is failed as stale`, async () => {
    const r = await ruleOn({}, false);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    engine.beforeAction = () => { throw new Error('database gone'); };
    const [run] = await runsOf(r.id);
    for (let i = 1; i < MAX_RUN_ATTEMPTS; i += 1) await expect(engine.processRun(run!.id)).rejects.toThrow();
    expect(await engine.processRun(run!.id)).toBe('failed');
    expect((await t.prisma.automationRun.findUniqueOrThrow({ where: { id: run!.id } })).reasonCode).toBe('transient_error');

    engine.beforeAction = null;
    const { bookingId: b2 } = await newBooking();
    await fire('bookings.booking.requested', b2);
    const stuck = (await runsOf(r.id)).find((x) => x.status === 'pending')!;
    await t.prisma.automationRun.update({ where: { id: stuck.id }, data: { startedAt: new Date(Date.now() - 7 * 3_600_000) } });
    const old = await t.prisma.automationRun.create({ data: { ruleId: r.id, ruleVersion: 1, source: 'manual', testMode: true, status: 'succeeded', finishedAt: new Date(), startedAt: new Date(Date.now() - 91 * 86_400_000) } });
    const res = await engine.maintenance();
    expect(res.stale).toBeGreaterThanOrEqual(1);
    expect((await t.prisma.automationRun.findUniqueOrThrow({ where: { id: stuck.id } })).reasonCode).toBe('stale');
    expect(await t.prisma.automationRun.findUnique({ where: { id: old.id } })).toBeNull();
  });
});

describe('runs that are skipped', () => {
  it('conditions not met; events by an automation; old events; rules switched on after the event', async () => {
    const r = await ruleOn({ conditions: [{ fact: 'status', op: 'is', value: 'approved' }] }, false);
    await t.prisma.automationRule.update({ where: { id: r.id }, data: { enabledAt: new Date(Date.now() - 72 * 3_600_000) } });
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await fire('bookings.booking.requested', bookingId, { actorType: 'automation' });
    await fire('bookings.booking.requested', bookingId, { occurredAt: new Date(Date.now() - 49 * 3_600_000) });
    await runPending();
    expect((await runsOf(r.id)).map((x) => x.reasonCode).sort()).toEqual(['conditions_not_met', 'event_too_old']);

    // Enabled after the event happened: no run at all.
    const late = await createRule(owner);
    const { eventId } = await fire('bookings.booking.requested', bookingId);
    await enable(owner, late.id, false);
    const consumer = t.app.get(ConsumerRegistry).get(AUTOMATIONS_CONSUMER)!;
    const e = await t.prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    await t.prisma.$transaction((tx) => consumer.handle({ ...e, aggregateVersion: e.aggregateVersion }, { tx }));
    expect(await runsOf(late.id)).toHaveLength(0);
    expect(await tasksOn(bookingId)).toHaveLength(0);
  });

  it('rule switched off, changed, or the module switched off before the run', async () => {
    const r = await ruleOn({}, false);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    const cur = (await owner.get(`/admin/automations/${r.id}`)).body;
    await owner.post(`/admin/automations/${r.id}/disable`, { version: cur.version });
    await runPending();
    expect((await runsOf(r.id)).map((x) => x.reasonCode)).toEqual(['rule_disabled']);

    const r2 = await ruleOn({}, false);
    await fire('bookings.booking.requested', bookingId);
    const c2 = (await owner.get(`/admin/automations/${r2.id}`)).body;
    await freshStepUp(owner.staff.id);
    const changed = await owner.patch(`/admin/automations/${r2.id}`, { ...ruleBody({ eventType: 'bookings.booking.approved' }), version: c2.version });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    await runPending();
    const [run2] = await runsOf(r2.id);
    expect([run2!.reasonCode, run2!.ruleVersion]).toEqual(['rule_changed', changed.body.version]);

    const r3 = await ruleOn({}, false);
    await fire('bookings.booking.requested', bookingId);
    await t.prisma.featureFlag.update({ where: { key: 'module.automations' }, data: { enabled: false } });
    try {
      await runPending();
    } finally {
      await t.prisma.featureFlag.update({ where: { key: 'module.automations' }, data: { enabled: true } });
    }
    expect((await runsOf(r3.id)).map((x) => x.reasonCode)).toEqual(['module_disabled']);
    expect(await tasksOn(bookingId)).toHaveLength(0);
  });

  it('customer gone or suppressed, tag gone, webhook gone: those steps are skipped with a code', async () => {
    const tmpTag = await t.prisma.tag.create({ data: { name: `tmp-${randomUUID().slice(0, 8)}`, colour: '#112233', entityTypes: [] } });
    await freshStepUp(owner.staff.id);
    const hook = await owner.post('/admin/integrations/webhooks', { url: 'https://gone.example.test/in', eventTypes: ['automations.rule.fired'] });
    const r = await ruleOn({ actions: [{ type: 'send_email', template: 'customer_notice_1' }, { type: 'add_tag', tagId: tmpTag.id }, { type: 'call_webhook', subscriptionId: hook.body.webhook.id }] }, false);
    await t.prisma.tag.delete({ where: { id: tmpTag.id } });
    await t.prisma.webhookSubscription.update({ where: { id: hook.body.webhook.id }, data: { deletedAt: new Date(), enabled: false } });
    const { bookingId, customerId } = await newBooking();
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    await t.prisma.emailSuppression.create({ data: { emailHash: emailHash(t.config.EMAIL_HASH_KEY, customer.email), reason: 'bounced', scope: 'all' } });
    await fire('bookings.booking.requested', bookingId);
    const { bookingId: b2, customerId: c2 } = await newBooking();
    await t.prisma.customer.update({ where: { id: c2 }, data: { anonymisedAt: new Date() } });
    await fire('bookings.booking.requested', b2);
    await runPending();
    const runs = await runsOf(r.id);
    expect(runs.map((x) => x.status)).toEqual(['succeeded', 'succeeded']);
    expect(runs.map((x) => (x.steps as Array<{ code?: string }>).map((s) => s.code))).toEqual([
      ['recipient_suppressed', 'tag_unavailable', 'webhook_unavailable'],
      ['recipient_unavailable', 'tag_unavailable', 'webhook_unavailable'],
    ]);
    expect(await t.prisma.outboundEmail.count({ where: { customerId: { in: [customerId, c2] } } })).toBe(0);
  });

  it('marketing_withdrawal_keeps_balance_reminders: an unsubscribe from marketing never stops a service email (task 5.5)', async () => {
    // Since 7.fix-2 a notice is a service email only when the rule was switched on with that acknowledgement.
    const r = await ruleOn({ actions: [{ type: 'send_email', template: 'customer_notice_1' }] }, false, owner, true);
    const { bookingId, customerId } = await newBooking();
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    await t.prisma.emailSuppression.create({ data: { emailHash: emailHash(t.config.EMAIL_HASH_KEY, customer.email), reason: 'unsubscribed', scope: 'marketing' } });
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const runs = await runsOf(r.id);
    expect(runs.map((x) => (x.steps as Array<{ status?: string; code?: string }>).map((s) => s.code ?? s.status))).toEqual([['done']]);
    expect(await t.prisma.outboundEmail.count({ where: { customerId, category: 'transactional' } })).toBe(1);
  });

  it(`at most the hourly cap of real runs per rule, then held back with one system task`, async () => {
    const r = await ruleOn({}, false);
    await t.prisma.$executeRawUnsafe(`INSERT INTO automation_runs (id, "ruleId", "ruleVersion", source, "scheduledFor", "testMode", status, "finishedAt", "startedAt")
      SELECT gen_random_uuid(), $1::uuid, 1, 'schedule', now() - (g || ' seconds')::interval, false, 'succeeded', now(), now() - interval '5 minutes' FROM generate_series(1, 100) g`, r.id);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const held = (await runsOf(r.id)).filter((x) => x.source === 'event');
    expect(held.map((x) => x.reasonCode)).toEqual(['rate_limited', 'rate_limited']);
    expect(await t.prisma.task.count({ where: { sourceRef: `automations:rate_limited:${r.id}` } })).toBe(1);
    expect(await tasksOn(bookingId)).toHaveLength(0);
  });
});

describe('catalogue and code', () => {
  it('every registered action declares only allowed permissions and none moves money or changes permissions', () => {
    const actions = t.app.get(AutomationActions).registry.all();
    expect(actions.map((a) => a.type).sort()).toEqual([...AUTOMATION_ACTION_TYPES].sort());
    for (const a of actions) {
      expect([a.movesMoney, a.changesPermissions]).toEqual([false, false]);
      for (const k of a.declaredPermissions) expect(k).not.toMatch(/^(payments|finance|pricing|changes|access|audit|platform|automations)\.|^integrations\.apiKey\.|^bookings\.booking\.(approve|decline|cancel)$/);
    }
  });

  it('the run log route shows ids and codes', async () => {
    const r = await ruleOn({}, true);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const res = await owner.get(`/admin/automations/${r.id}/runs`);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ source: 'event', status: 'succeeded', testMode: true, entityType: 'Booking', entityId: bookingId });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['attempts', 'entityId', 'entityType', 'finishedAt', 'id', 'reasonCode', 'ruleVersion', 'scheduledFor', 'source', 'startedAt', 'status', 'steps', 'testMode', 'triggerEventType']);
  });

  it('the panel needs a staff session with the CSRF header', async () => {
    const s = await createStaff(t, { permissions: ALL });
    const cookie = await signInStaff(t, s);
    expect((await t.http().post('/admin/automations').set('Cookie', cookie).send(ruleBody())).status).toBe(403);
    expect((await t.http().post('/admin/automations').set(STATE_HEADERS).set('Cookie', cookie).send(ruleBody())).status).toBe(201);
  });
});

// ---------------------------------------------------------------- task 7.fix-2 (post-merge review of 7.4)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until some transaction of this database waits on a lock (the interleaving the test needs happened). */
async function lockWaiter(timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [r] = await t.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((r?.n ?? 0) >= 1) return;
    await sleep(25);
  }
  throw new Error('no transaction waited on a lock: the interleaving did not happen');
}

/** Holds a run inside its transaction, after every lock is taken, before its first action. */
function holdRun(): { entered: Promise<void>; release: () => void } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const released = new Promise<void>((r) => (release = r));
  engine.beforeAction = async (index) => {
    if (index !== 0) return;
    enter();
    await released;
  };
  return { entered, release };
}

const notice = (template = 'customer_notice_1') => ({ type: 'send_email', template });
const customerOfBooking = async (customerId: string) => t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
const stepCodes = async (ruleId: string) => (await runsOf(ruleId)).map((x) => (x.steps as Array<{ status: string; code?: string }>).map((s) => s.code ?? s.status));

describe('7.fix-2: per-customer cap across rules', () => {
  it('fifty rules on one event: the customer gets at most the cap, the rest are skipped with customer_rate_limited', async () => {
    const rules = [];
    for (let i = 0; i < MAX_CUSTOMER_NOTICES_PER_WINDOW + 2; i += 1) rules.push(await ruleOn({ name: `Notice ${i}`, actions: [notice(), taskAction(`Task ${i}`)] }, false, owner, true));
    const { bookingId, customerId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    expect(await t.prisma.outboundEmail.count({ where: { customerId } })).toBe(MAX_CUSTOMER_NOTICES_PER_WINDOW);
    const codes = (await Promise.all(rules.map((r) => stepCodes(r.id)))).map((c) => c[0]!);
    expect(codes.filter((c) => c[0] === 'customer_rate_limited')).toHaveLength(2);
    expect(codes.filter((c) => c[0] === 'done')).toHaveLength(MAX_CUSTOMER_NOTICES_PER_WINDOW);
    // The other actions of a held-back notice still run.
    expect(await tasksOn(bookingId)).toHaveLength(MAX_CUSTOMER_NOTICES_PER_WINDOW + 2);
  });

  it('two runs at once for the same customer with one place left: exactly one email', async () => {
    const a = await ruleOn({ name: 'A', actions: [notice()] }, false, owner, true);
    const b = await ruleOn({ name: 'B', actions: [notice('customer_notice_2')] }, false, owner, true);
    const { bookingId, customerId } = await newBooking();
    const customer = await customerOfBooking(customerId);
    const mail = t.app.get(MailService);
    for (let i = 0; i < MAX_CUSTOMER_NOTICES_PER_WINDOW - 1; i += 1) {
      await mail.enqueue({ to: customer.email, templateKey: 'automations.customer_notice_3', templateVersion: 1, locale: 'en-AU', dedupeKey: `earlier:${randomUUID()}`, customerId });
    }
    await fire('bookings.booking.requested', bookingId);
    const pending = await t.prisma.automationRun.findMany({ where: { ruleId: { in: [a.id, b.id] }, status: 'pending' } });
    expect(pending).toHaveLength(2);
    await Promise.all(pending.map((r) => engine.processRun(r.id)));
    expect(await t.prisma.outboundEmail.count({ where: { customerId } })).toBe(MAX_CUSTOMER_NOTICES_PER_WINDOW);
    expect([...(await stepCodes(a.id)), ...(await stepCodes(b.id))].map((c) => c[0]).sort()).toEqual(['customer_rate_limited', 'done']);
  });
});

describe('7.fix-2: customer notices honour unsubscribes unless acknowledged as service messages', () => {
  it('without the acknowledgement: a marketing unsubscribe stops the notice, and others go out as marketing with List-Unsubscribe', async () => {
    const r = await ruleOn({ actions: [notice()] }, false);
    const { bookingId, customerId } = await newBooking();
    const customer = await customerOfBooking(customerId);
    await t.prisma.emailSuppression.create({ data: { emailHash: emailHash(t.config.EMAIL_HASH_KEY, customer.email), reason: 'unsubscribed', scope: 'marketing' } });
    await fire('bookings.booking.requested', bookingId);
    const { bookingId: b2, customerId: c2 } = await newBooking();
    await fire('bookings.booking.requested', b2);
    await runPending();
    expect(await stepCodes(r.id)).toEqual([['recipient_suppressed'], ['done']]);
    expect(await t.prisma.outboundEmail.count({ where: { customerId } })).toBe(0);
    const sent = await t.prisma.outboundEmail.findFirstOrThrow({ where: { customerId: c2 } });
    expect(sent.category).toBe('marketing');
    const before = t.mail.sent.length;
    expect(await t.app.get(MailService).processSend(sent.id)).toBe('sent');
    expect(t.mail.sent.slice(before)[0]?.headers?.['List-Unsubscribe']).toMatch(/\/unsubscribe\//);
  });

  it('an acknowledgement is void once the wording changes, and once the rule is changed', async () => {
    const r = await ruleOn({ actions: [notice()] }, false, owner, true);
    expect((await owner.get(`/admin/automations/${r.id}`)).body.serviceNoticeAckAt).not.toBeNull();
    const { bookingId, customerId } = await newBooking();
    const customer = await customerOfBooking(customerId);
    await t.prisma.emailSuppression.create({ data: { emailHash: emailHash(t.config.EMAIL_HASH_KEY, customer.email), reason: 'unsubscribed', scope: 'marketing' } });
    // The wording in use changes after the acknowledgement.
    await sleep(5);
    await t.prisma.messageTemplate.updateMany({ where: { key: 'automations.customer_notice_1', status: 'active' }, data: { body: 'Hi {{givenName}}, now with news about {{trip}}: {{link}}' } });
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    expect(await stepCodes(r.id)).toEqual([['recipient_suppressed']]);

    const r2 = await ruleOn({ actions: [notice()] }, false, owner, true);
    const cur = (await owner.get(`/admin/automations/${r2.id}`)).body;
    await freshStepUp(owner.staff.id);
    const changed = await owner.patch(`/admin/automations/${r2.id}`, { ...ruleBody({ actions: [notice(), taskAction()] }), version: cur.version });
    expect([changed.status, changed.body.serviceNoticeAckAt]).toEqual([200, null]);
    // Switching it on again without the acknowledgement keeps it void.
    await enable(owner, r2.id, false);
    expect((await owner.get(`/admin/automations/${r2.id}`)).body.serviceNoticeAckAt).toBeNull();
  });
});

describe('7.fix-2: suppression is checked again at send time', () => {
  it('a bounce after the notice was queued stops it at send time (no retry delivers it)', async () => {
    await ruleOn({ actions: [notice()] }, false, owner, true);
    const { bookingId, customerId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const email = await t.prisma.outboundEmail.findFirstOrThrow({ where: { customerId } });
    expect([email.category, email.status]).toEqual(['transactional', 'queued']);
    const customer = await customerOfBooking(customerId);
    await t.app.get(MailService).addSuppression(customer.email, 'bounced', 'all');
    const before = t.mail.sent.length;
    expect(await t.app.get(MailService).processSend(email.id)).toBe('suppressed');
    expect(t.mail.sent.length).toBe(before);
    expect((await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: email.id } })).status).toBe('suppressed');
  });

  it('a marketing unsubscribe after queueing does not stop an acknowledged service notice (task 5.5)', async () => {
    await ruleOn({ actions: [notice()] }, false, owner, true);
    const { bookingId, customerId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    const email = await t.prisma.outboundEmail.findFirstOrThrow({ where: { customerId } });
    await t.app.get(MailService).addSuppression((await customerOfBooking(customerId)).email, 'unsubscribed', 'marketing');
    expect(await t.app.get(MailService).processSend(email.id)).toBe('sent');
  });
});

describe('7.fix-2: the run locks (barrier tests)', () => {
  it('an edit of the rule waits for a run in progress (FOR SHARE on the rule)', async () => {
    const editor = await signedIn(ALL);
    const r = await ruleOn({ actions: [taskAction('Before the edit')] }, false);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    const [run] = await t.prisma.automationRun.findMany({ where: { ruleId: r.id, status: 'pending' } });
    const gate = holdRun();
    const running = engine.processRun(run!.id);
    try {
      await gate.entered;
      const cur = (await editor.get(`/admin/automations/${r.id}`)).body;
      await freshStepUp(editor.staff.id);
      const editing = editor.patch(`/admin/automations/${r.id}`, { ...ruleBody({ actions: [taskAction('After the edit')] }), version: cur.version }).then((x) => x);
      await lockWaiter();
      gate.release();
      const [status, edited] = await Promise.all([running, editing]);
      expect([status, edited.status]).toEqual(['succeeded', 200]);
    } finally {
      gate.release();
      await running.catch(() => undefined);
    }
    // The run acted on the version it locked, not the edit.
    expect((await tasksOn(bookingId)).map((x) => x.title)).toEqual(['Before the edit']);
  });

  it('a permission withdrawal waits for a run in progress (FOR SHARE on the owner)', async () => {
    const holder = await signedIn(ALL);
    const r = await ruleOn({ actions: [taskAction('Under the lock')] }, false, holder);
    const { bookingId } = await newBooking();
    await fire('bookings.booking.requested', bookingId);
    const [run] = await t.prisma.automationRun.findMany({ where: { ruleId: r.id, status: 'pending' } });
    const gate = holdRun();
    const running = engine.processRun(run!.id);
    let withdrawnAt = 0;
    try {
      await gate.entered;
      // As every role change does: lock the users concerned, then change their permissions.
      const withdrawing = t.prisma.$transaction(async (tx) => {
        await t.app.get(AccessService).lockUsers(tx, [holder.staff.id]);
        const roles = await tx.userRole.findMany({ where: { userId: holder.staff.id }, select: { roleId: true } });
        await tx.rolePermission.deleteMany({ where: { roleId: { in: roles.map((x) => x.roleId) }, permissionKey: 'common.task.write' } });
        withdrawnAt = Date.now();
      });
      await lockWaiter();
      const releasedAt = Date.now();
      gate.release();
      await Promise.all([running, withdrawing]);
      expect(withdrawnAt).toBeGreaterThanOrEqual(releasedAt);
    } finally {
      gate.release();
      await running.catch(() => undefined);
    }
    expect(await tasksOn(bookingId)).toHaveLength(1);
    // The next run sees the withdrawal.
    await fire('bookings.booking.requested', bookingId);
    await runPending();
    expect((await runsOf(r.id)).map((x) => x.reasonCode)).toEqual([null, 'automation_cannot_exceed_author_permissions']);
  });
});

describe('7.fix-2: a backlog over the hourly cap acts oldest first', () => {
  it('whatever order the jobs run in, the oldest events act and the newest are held back', async () => {
    const r = await ruleOn({ actions: [{ type: 'close_tasks' }] }, false);
    const { bookingId } = await newBooking();
    const base = Date.now() + 60_000;
    const extra = 3;
    for (let i = 0; i < MAX_REAL_RUNS_PER_HOUR + extra; i += 1) await fire('bookings.booking.requested', bookingId, { occurredAt: new Date(base + i * 1000) });
    const runs = await t.prisma.automationRun.findMany({ where: { ruleId: r.id }, orderBy: { eventOccurredAt: 'desc' } });
    expect(runs).toHaveLength(MAX_REAL_RUNS_PER_HOUR + extra);
    for (const run of runs) await engine.processRun(run.id); // newest first
    const after = await t.prisma.automationRun.findMany({ where: { ruleId: r.id }, orderBy: { eventOccurredAt: 'asc' } });
    expect(after.slice(0, MAX_REAL_RUNS_PER_HOUR).every((x) => x.reasonCode !== 'rate_limited')).toBe(true);
    expect(after.slice(MAX_REAL_RUNS_PER_HOUR).map((x) => x.reasonCode)).toEqual(Array(extra).fill('rate_limited'));
  }, 120_000); // over a hundred events and runs
});

describe('7.fix-2: time zone and the manual test run', () => {
  it('schedules use the business time zone constant, the same as pricing, while no businessTimeZone setting exists', async () => {
    expect(AUTOMATIONS_TIME_ZONE).toBe(BUSINESS_TIME_ZONE);
    // The day a businessTimeZone setting is defined, this fails: automations must then read it (plan 7.fix-2, section 5).
    expect(t.app.get(SettingsService).definitions().map((d) => d.key)).not.toContain('businessTimeZone');
    const r = await ruleOn({ triggerType: 'schedule', eventType: undefined, schedule: { frequency: 'daily', time: '03:00' }, actions: [taskAction('Daily')] }, false);
    const day = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString().slice(0, 10);
    // 03:00 in Brisbane (UTC+10, no daylight saving) is 17:00 UTC the day before; a minute later the tick fires it.
    const at = new Date(`${day}T17:00:00Z`);
    expect(await engine.tick(new Date(at.getTime() + 60_000))).toBe(1);
    expect((await runsOf(r.id)).map((x) => x.scheduledFor?.toISOString())).toEqual([at.toISOString()]);
  });

  it('a PostgreSQL error inside a panel test is recorded as a failed run, not a 500', async () => {
    const r = await createRule(owner, { actions: [taskAction()] });
    const { bookingId } = await newBooking();
    engine.beforeAction = async (_i, tx) => {
      await tx.$executeRawUnsafe('SELECT 1 / 0');
    };
    const res = await owner.post(`/admin/automations/${r.id}/test`, { entityId: bookingId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect([res.body.status, res.body.reasonCode]).toEqual(['failed', 'action_failed']);
    const run = await t.prisma.automationRun.findUniqueOrThrow({ where: { id: res.body.runId } });
    expect([run.status, run.reasonCode, run.source]).toEqual(['failed', 'action_failed', 'manual']);
    expect(await t.prisma.auditLog.count({ where: { action: 'automations.rule.tested', entityId: r.id } })).toBe(1);
  });
});
