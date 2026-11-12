import { createHmac, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import { createServer as createNetServer, Server as NetServer, Socket } from 'node:net';
import { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOGUE_PERMISSIONS } from '../../src/modules/catalogue/manifest';
import { ConsumerRegistry } from '../../src/platform/events/consumers';
import { EventsService } from '../../src/platform/events/events.service';
import { OutboxService } from '../../src/platform/events/outbox.service';
import { WEBHOOK_CONSUMER } from '../../src/platform/integrations/integrations.module';
import { INTEGRATIONS_PERMISSIONS as IP } from '../../src/platform/integrations/permissions';
import {
  AUTO_DISABLE_AFTER_FAILURES, DELIVERY_ERROR_CODES, MAX_ATTEMPTS, RETRY_SCHEDULE_SECONDS, WebhookDeliveryService,
} from '../../src/platform/integrations/webhook-delivery.service';
import { postWebhook } from '../../src/platform/integrations/webhook-http';
import { SystemMonitorService } from '../../src/platform/monitor/system-monitor.service';
import { STATE_HEADERS, TestApp, createStaff, makeApp, signInStaff } from '../support/auth';

// ---- A local receiver (allow-listed outside production) ----
interface Received { path: string; headers: IncomingMessage['headers']; body: string }
const received: Received[] = [];
let server: Server;
let drip: NetServer;
let origin = '';
let dripOrigin = '';
const dripSockets = new Set<Socket>();

async function startReceivers() {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      const p = req.url ?? '';
      if (p.startsWith('/ok')) res.writeHead(204).end();
      else if (p.startsWith('/fail')) res.writeHead(500).end('internal details 10.0.0.1');
      else if (p.startsWith('/redirect')) res.writeHead(302, { location: `${origin}/redirected` }).end();
      else if (p.startsWith('/slow')) setTimeout(() => res.writeHead(200).end(), 2_000);
      else if (p.startsWith('/big')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024, 120);
        let sent = 0;
        const pump = () => {
          while (sent < 10 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        res.on('close', () => (sent = Number.MAX_SAFE_INTEGER));
        pump();
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Answers one byte every 150 ms: the status line itself drips, so only a whole-exchange timer stops it.
  drip = createNetServer((socket) => {
    dripSockets.add(socket);
    socket.on('error', () => undefined);
    const text = 'HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n';
    let i = 0;
    const timer = setInterval(() => {
      if (i >= text.length || socket.destroyed) return clearInterval(timer);
      socket.write(text[i++]!);
    }, 150);
    socket.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((r) => drip.listen(0, '127.0.0.1', r));
  dripOrigin = `http://127.0.0.1:${(drip.address() as AddressInfo).port}`;
}

let t: TestApp;
let svc: WebhookDeliveryService;
let owner: { id: string; cookie: string };

beforeAll(async () => {
  await startReceivers();
  t = await makeApp({ WEBHOOK_DEV_ALLOWLIST: `${origin},${dripOrigin},http://internal.test` });
  svc = t.app.get(WebhookDeliveryService);
  const s = await createStaff(t, { owner: true });
  owner = { id: s.id, cookie: await signInStaff(t, s) };
}, 60_000);

afterAll(async () => {
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name IN ('webhooks.send', 'events.deliver')`);
  await t.close();
  for (const s of dripSockets) s.destroy();
  await new Promise((r) => server.close(r));
  await new Promise((r) => drip.close(r));
}, 60_000);

beforeEach(async () => {
  received.length = 0;
  svc.timeoutMs = 1_000;
  // At most 20 live webhooks exist at once (plan 11.9): each test starts with none.
  await t.prisma.$executeRawUnsafe(`UPDATE webhook_subscriptions SET "deletedAt" = now(), enabled = false, url = '', "secretCiphertext" = '' WHERE "deletedAt" IS NULL`);
});

const setIntegrations = (enabled: boolean) => t.prisma.featureFlag.update({ where: { key: 'module.integrations' }, data: { enabled } });
const freshStepUp = (userId: string) => t.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { mfaVerifiedAt: new Date() } });

async function createHook(url: string, eventTypes = ['catalogue.package.sale_status_changed']) {
  await freshStepUp(owner.id);
  const res = await t.http().post('/admin/integrations/webhooks').set(STATE_HEADERS).set('Cookie', owner.cookie).send({ url, eventTypes, description: 'Test receiver' });
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { webhook: { id: string; version: number; urlDisplay: string }; secret: string };
}

const ids = () => ({ packageId: randomUUID(), editionId: randomUUID(), raceId: randomUUID() });

/** Publishes an outbox event and runs the webhook consumer on it (as the event delivery job would). */
async function publish(payload: Record<string, unknown> = { ...ids(), fromStatus: 'coming_soon', toStatus: 'open' }, type = 'catalogue.package.sale_status_changed') {
  const eventId = await t.prisma.$transaction((tx) => t.app.get(OutboxService).publish(tx, {
    type, aggregateType: 'Package', aggregateId: (payload.packageId as string) ?? randomUUID(), aggregateVersion: 1, payload, actorType: 'staff', actorId: owner.id,
  }));
  const e = await t.prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
  const consumer = t.app.get(ConsumerRegistry).get(WEBHOOK_CONSUMER)!;
  const event = { id: e.id, type: e.type, schemaVersion: e.schemaVersion, aggregateType: e.aggregateType, aggregateId: e.aggregateId, aggregateVersion: e.aggregateVersion, payload: e.payload, actorType: e.actorType, actorId: e.actorId, occurredAt: e.occurredAt };
  return { eventId, event, run: () => t.prisma.$transaction((tx) => consumer.handle(event, { tx })) };
}

const deliveryFor = (subscriptionId: string, eventId: string) => t.prisma.webhookDelivery.findUniqueOrThrow({ where: { subscriptionId_eventId: { subscriptionId, eventId } } });
const far = () => new Date(Date.now() + 10 * 86400_000);

describe('administration (C3)', () => {
  it('webhook_manage_requires_step_up', async () => {
    const hook = await createHook(`${origin}/ok`);
    await t.prisma.session.updateMany({ where: { userId: owner.id }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const calls = [
      t.http().post('/admin/integrations/webhooks').send({ url: `${origin}/ok`, eventTypes: ['catalogue.race.published'] }),
      t.http().patch(`/admin/integrations/webhooks/${hook.webhook.id}`).send({ version: 0, description: 'x' }),
      t.http().post(`/admin/integrations/webhooks/${hook.webhook.id}/rotate-secret`).send({}),
      t.http().post(`/admin/integrations/webhooks/${hook.webhook.id}/test`).send({}),
      t.http().delete(`/admin/integrations/webhooks/${hook.webhook.id}`),
      t.http().post(`/admin/integrations/webhook-deliveries/${randomUUID()}/retry`).send({}),
    ];
    for (const c of calls) {
      const res = await c.set(STATE_HEADERS).set('Cookie', owner.cookie);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('step_up_required');
    }
  });

  it('webhook_secret_shown_once_and_encrypted_at_rest', async () => {
    const hook = await createHook(`${origin}/ok?token=abc`);
    expect(hook.secret).toMatch(/^whsec_/);
    const row = await t.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: hook.webhook.id } });
    expect(row.secretCiphertext).not.toContain(hook.secret.slice(6));
    expect(t.box.decrypt(row.secretCiphertext, row.keyVersion, `webhook_subscription:${row.id}`)).toBe(hook.secret);
    expect(() => t.box.decrypt(row.secretCiphertext, row.keyVersion, `webhook_subscription:${randomUUID()}`)).toThrow();
    const list = await t.http().get('/admin/integrations/webhooks').set('Cookie', owner.cookie);
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(hook.secret);
    expect(text).not.toContain('token=abc');
    expect(list.body.find((w: { id: string }) => w.id === row.id).urlDisplay).toBe(`${origin}/…`);
  });

  it('webhook_event_types_must_be_in_catalogue, and readable by the creator', async () => {
    await freshStepUp(owner.id);
    for (const eventTypes of [['auth.user.logged_in'], ['catalogue.*'], ['*']]) {
      const res = await t.http().post('/admin/integrations/webhooks').set(STATE_HEADERS).set('Cookie', owner.cookie).send({ url: `${origin}/ok`, eventTypes });
      expect(res.status, eventTypes.join()).toBe(422);
    }
    const limited = await createStaff(t, { permissions: [IP.webhookManage, CATALOGUE_PERMISSIONS.raceRead] });
    const cookie = await signInStaff(t, limited);
    const res = await t.http().post('/admin/integrations/webhooks').set(STATE_HEADERS).set('Cookie', cookie).send({ url: `${origin}/ok`, eventTypes: ['suppliers.allotment.released'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('event_type_not_readable');
    const ok = await t.http().post('/admin/integrations/webhooks').set(STATE_HEADERS).set('Cookie', cookie).send({ url: `${origin}/ok`, eventTypes: ['catalogue.race.published'] });
    expect(ok.status).toBe(201);
    const events = await t.http().get('/admin/integrations/webhook-events').set('Cookie', owner.cookie);
    expect(events.body.map((e: { type: string }) => e.type)).toContain('catalogue.race.published');
  });

  it('webhook URL is validated by the API (private addresses, credentials, fragments)', async () => {
    await freshStepUp(owner.id);
    for (const url of ['https://10.0.0.5/x', 'https://169.254.169.254/x', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com/x#f', 'ftp://hooks.example.com/x', 'http://localhost:3000/api']) {
      const res = await t.http().post('/admin/integrations/webhooks').set(STATE_HEADERS).set('Cookie', owner.cookie).send({ url, eventTypes: ['catalogue.race.published'] });
      expect(res.status, url).toBe(422);
      expect(res.body.code, url).toBe('invalid_url');
    }
  });

  it('webhook_subscription_changes_audited_with_url_in_pii; delete empties the address and secrets', async () => {
    const hook = await createHook(`${origin}/ok?token=first`);
    const id = hook.webhook.id;
    const created = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: 'integrations.webhook.created' }, include: { piiValues: true } });
    expect((created.changes as Record<string, unknown>).url).toBe('[pii]');
    expect((created.changes as Record<string, unknown>).secretCiphertext).toBe('[changed]');
    expect(created.piiValues.find((p) => p.field === 'url')?.after).toBe(`${origin}/ok?token=first`);
    await freshStepUp(owner.id);
    const patched = await t.http().patch(`/admin/integrations/webhooks/${id}`).set(STATE_HEADERS).set('Cookie', owner.cookie).send({ version: hook.webhook.version, description: 'Renamed' });
    expect(patched.status).toBe(200);
    expect(await t.prisma.auditLog.count({ where: { entityId: id, action: 'integrations.webhook.updated' } })).toBe(1);
    expect((await t.http().delete(`/admin/integrations/webhooks/${id}`).set(STATE_HEADERS).set('Cookie', owner.cookie)).status).toBe(204);
    const row = await t.prisma.webhookSubscription.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ url: '', secretCiphertext: '', previousSecretCiphertext: null, enabled: false });
    expect(row.deletedAt).not.toBeNull();
    expect(await t.prisma.auditLog.count({ where: { entityId: id, action: 'integrations.webhook.deleted' } })).toBe(1);
    expect((await t.http().get('/admin/integrations/webhooks').set('Cookie', owner.cookie)).body.some((w: { id: string }) => w.id === id)).toBe(false);
  });

  it('webhook_max_active_subscriptions: twenty at most, even in parallel', async () => {
    await freshStepUp(owner.id);
    const results = await Promise.all(Array.from({ length: 23 }, (_, i) =>
      t.http().post('/admin/integrations/webhooks').set(STATE_HEADERS).set('Cookie', owner.cookie).send({ url: `${origin}/ok/${i}`, eventTypes: ['catalogue.race.published'] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.code === 'too_many_webhooks')).toBe(true);
  });

  it('changing the address cancels what was queued and returns a new secret once', async () => {
    const hook = await createHook(`${origin}/ok`);
    const p = await publish();
    await p.run();
    await freshStepUp(owner.id);
    const res = await t.http().patch(`/admin/integrations/webhooks/${hook.webhook.id}`).set(STATE_HEADERS).set('Cookie', owner.cookie).send({ version: hook.webhook.version, url: `${origin}/ok/new` });
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^whsec_/);
    expect(res.body.secret).not.toBe(hook.secret);
    expect(await deliveryFor(hook.webhook.id, p.eventId)).toMatchObject({ status: 'cancelled', lastErrorCode: 'url_changed' });
    const stale = await t.http().patch(`/admin/integrations/webhooks/${hook.webhook.id}`).set(STATE_HEADERS).set('Cookie', owner.cookie).send({ version: hook.webhook.version, description: 'x' });
    expect(stale.body.code).toBe('version_conflict');
  });
});

describe('fan-out (plan 4.3)', () => {
  it('webhook_fan_out_creates_one_delivery_per_subscription_once', async () => {
    const a = await createHook(`${origin}/ok/a`);
    const b = await createHook(`${origin}/ok/b`);
    const p = await publish();
    await p.run();
    await p.run();
    expect(await t.prisma.webhookDelivery.count({ where: { eventId: p.eventId, subscriptionId: { in: [a.webhook.id, b.webhook.id] } } })).toBe(2);
    const d = await deliveryFor(a.webhook.id, p.eventId);
    expect(d.status).toBe('pending');
    expect(JSON.stringify(d.body)).not.toMatch(/actor/);
  });

  it('webhook_subscription_created_after_event_not_delivered', async () => {
    const p = await publish();
    const late = await createHook(`${origin}/ok/late`);
    await p.run();
    expect(await t.prisma.webhookDelivery.count({ where: { subscriptionId: late.webhook.id } })).toBe(0);
  });

  it('webhook_disabled_or_deleted_subscription_gets_nothing', async () => {
    const off = await createHook(`${origin}/ok/off`);
    await freshStepUp(owner.id);
    await t.http().patch(`/admin/integrations/webhooks/${off.webhook.id}`).set(STATE_HEADERS).set('Cookie', owner.cookie).send({ version: off.webhook.version, enabled: false });
    const p = await publish();
    await p.run();
    expect(await t.prisma.webhookDelivery.count({ where: { subscriptionId: off.webhook.id } })).toBe(0);
  });

  it('webhook_payload_missing_field_fails_consumer (retryable, then failed and visible)', async () => {
    await createHook(`${origin}/ok/contract`);
    const p = await publish({ ...ids(), fromStatus: 'coming_soon' });
    await expect(p.run()).rejects.toMatchObject({ code: 'webhook_payload_contract_mismatch' });
    expect(await t.prisma.webhookDelivery.count({ where: { eventId: p.eventId } })).toBe(0);
  });

  it('webhook_module_off_skips_events and webhook_events_older_than_max_age_skipped (event delivery level)', async () => {
    const hook = await createHook(`${origin}/ok/skip`);
    const events = t.app.get(EventsService);
    const p = await publish();
    const delivery = await t.prisma.eventDelivery.create({ data: { eventId: p.eventId, consumer: WEBHOOK_CONSUMER } });
    await setIntegrations(false);
    try {
      expect(await events.processDelivery(delivery.id)).toBe('skipped');
    } finally {
      await setIntegrations(true);
    }
    const old = await publish();
    const d2 = await t.prisma.eventDelivery.create({ data: { eventId: old.eventId, consumer: WEBHOOK_CONSUMER } });
    expect(await events.processDelivery(d2.id, new Date(Date.now() + 49 * 3600_000))).toBe('skipped');
    expect(await t.prisma.webhookDelivery.count({ where: { subscriptionId: hook.webhook.id } })).toBe(0);
  });
});

describe('sending (C4, C5)', () => {
  it('webhook_delivered_2xx_marked_succeeded, signed so an independent check verifies it', async () => {
    const hook = await createHook(`${origin}/ok/signed`);
    const p = await publish();
    await p.run();
    const d = await deliveryFor(hook.webhook.id, p.eventId);
    expect(await svc.processSend(d.id)).toBe('succeeded');
    expect(await deliveryFor(hook.webhook.id, p.eventId)).toMatchObject({ status: 'succeeded', attempts: 1, lastResponseStatus: 204, lastErrorCode: null });
    const got = received.find((r) => r.path === '/ok/signed')!;
    expect(got.headers['webhook-id']).toBe(d.id);
    expect(got.headers['content-type']).toBe('application/json');
    const ts = Number(got.headers['webhook-timestamp']);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(30);
    // Independent verification, as a receiver would write it.
    const key = Buffer.from(hook.secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key).update(`${d.id}.${ts}.${got.body}`).digest('base64');
    expect(String(got.headers['webhook-signature']).split(' ')).toContain(`v1,${expected}`);
    const body = JSON.parse(got.body);
    expect(body).toMatchObject({ type: 'catalogue.package.sale_status_changed', data: { eventId: p.eventId } });
    expect(got.body).not.toMatch(/actor|email/);
  });

  it('webhook_rotation_signs_with_both_secrets_for_24h (rotation needs step-up and shows the secret once)', async () => {
    const hook = await createHook(`${origin}/ok/rotate`);
    await freshStepUp(owner.id);
    const rot = await t.http().post(`/admin/integrations/webhooks/${hook.webhook.id}/rotate-secret`).set(STATE_HEADERS).set('Cookie', owner.cookie);
    expect(rot.status).toBe(200);
    const fresh = rot.body.secret as string;
    expect(fresh).not.toBe(hook.secret);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: hook.webhook.id, action: 'integrations.webhook.secretRotated' } });
    expect((audit.changes as Record<string, unknown>).secretCiphertext).toBe('[changed]');
    const sigOf = (secret: string, r: Received) => `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${r.headers['webhook-id']}.${r.headers['webhook-timestamp']}.${r.body}`).digest('base64')}`;
    const p = await publish();
    await p.run();
    await svc.processSend((await deliveryFor(hook.webhook.id, p.eventId)).id);
    const first = received.find((r) => r.path === '/ok/rotate')!;
    expect(String(first.headers['webhook-signature']).split(' ')).toEqual([sigOf(fresh, first), sigOf(hook.secret, first)]);
    // After 24 hours only the new secret signs.
    await t.prisma.webhookSubscription.update({ where: { id: hook.webhook.id }, data: { previousExpiresAt: new Date(Date.now() - 1000) } });
    received.length = 0;
    const p2 = await publish();
    await p2.run();
    await svc.processSend((await deliveryFor(hook.webhook.id, p2.eventId)).id);
    const second = received.find((r) => r.path === '/ok/rotate')!;
    expect(String(second.headers['webhook-signature']).split(' ')).toEqual([sigOf(fresh, second)]);
  });

  it('webhook_5xx_retried_with_backoff_then_failed_after_max_attempts', async () => {
    const hook = await createHook(`${origin}/fail`);
    const p = await publish();
    await p.run();
    const id = (await deliveryFor(hook.webhook.id, p.eventId)).id;
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
      const before = Date.now();
      const outcome = await svc.processSend(id, far());
      const row = await t.prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.attempts).toBe(n);
      expect(row.lastResponseStatus).toBe(500);
      expect(row.lastErrorCode).toBe('http_error');
      if (n < MAX_ATTEMPTS) {
        expect(outcome).toBe('retry');
        const wait = (row.nextAttemptAt!.getTime() - before) / 1000;
        expect(wait).toBeGreaterThanOrEqual(RETRY_SCHEDULE_SECONDS[n]! - 1);
        expect(wait).toBeLessThanOrEqual(RETRY_SCHEDULE_SECONDS[n]! + 5);
        // Not due yet: a job arriving early does nothing.
        if (RETRY_SCHEDULE_SECONDS[n]! > 0) expect(await svc.processSend(id)).toBe('noop');
      } else {
        expect(outcome).toBe('failed');
        expect(row.status).toBe('failed');
      }
    }
    expect(received.filter((r) => r.path === '/fail')).toHaveLength(MAX_ATTEMPTS);
  });

  it('webhook_timeout_counts_as_failure', async () => {
    const hook = await createHook(`${origin}/slow`);
    const p = await publish();
    await p.run();
    svc.timeoutMs = 300;
    expect(await svc.processSend((await deliveryFor(hook.webhook.id, p.eventId)).id)).toBe('retry');
    expect(await deliveryFor(hook.webhook.id, p.eventId)).toMatchObject({ lastErrorCode: 'timeout', lastResponseStatus: null });
  });

  it('webhook_slow_drip_response_hits_total_timeout', async () => {
    const started = Date.now();
    const r = await postWebhook(new URL(`${dripOrigin}/drip`), { address: '127.0.0.1', family: 4 }, {}, '{}', { timeoutMs: 600 });
    expect(r).toMatchObject({ ok: false, errorCode: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('webhook_redirect_not_followed', async () => {
    const hook = await createHook(`${origin}/redirect`);
    const p = await publish();
    await p.run();
    await svc.processSend((await deliveryFor(hook.webhook.id, p.eventId)).id);
    expect(await deliveryFor(hook.webhook.id, p.eventId)).toMatchObject({ lastErrorCode: 'http_redirect', lastResponseStatus: 302 });
    expect(received.some((r) => r.path === '/redirected')).toBe(false);
  });

  it('webhook_large_response_not_read_beyond_cap', async () => {
    const started = Date.now();
    const r = await postWebhook(new URL(`${origin}/big`), { address: '127.0.0.1', family: 4 }, {}, '{}', { timeoutMs: 5_000 });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('webhook_dns_rebinding_connects_to_validated_address', async () => {
    // The name is never resolved by the HTTP client: the connection goes to the pinned address.
    const r = await postWebhook(new URL(`http://rebind.test:${new URL(origin).port}/ok/pinned`), { address: '127.0.0.1', family: 4 }, {}, '{}', { timeoutMs: 2_000 });
    expect(r.ok).toBe(true);
    expect(received.find((x) => x.path === '/ok/pinned')?.headers.host).toBe(`rebind.test:${new URL(origin).port}`);
    // And the service resolves once, checks every answer, then sends: a resolver that answers private is refused.
    const calls: string[] = [];
    const saved = svc.resolver;
    svc.resolver = async (host) => {
      calls.push(host);
      return [{ address: '10.0.0.5', family: 4 }];
    };
    try {
      const hook = await createHook('http://internal.test/hook');
      const p = await publish();
      await p.run();
      expect(await svc.processSend((await deliveryFor(hook.webhook.id, p.eventId)).id)).toBe('failed');
      expect(await deliveryFor(hook.webhook.id, p.eventId)).toMatchObject({ status: 'failed', lastErrorCode: 'blocked_address' });
      expect(calls).toEqual(['internal.test']);
    } finally {
      svc.resolver = saved;
    }
  });

  it('webhook_duplicate_job_does_not_send_twice', async () => {
    const hook = await createHook(`${origin}/ok/dup`);
    const p = await publish();
    await p.run();
    const id = (await deliveryFor(hook.webhook.id, p.eventId)).id;
    const outcomes = await Promise.all([svc.processSend(id), svc.processSend(id), svc.processSend(id)]);
    expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(1);
    expect(received.filter((r) => r.path === '/ok/dup')).toHaveLength(1);
  });

  it('webhook_lease_expired_resent_with_same_webhook_id', async () => {
    const hook = await createHook(`${origin}/ok/lease`);
    const p = await publish();
    await p.run();
    const id = (await deliveryFor(hook.webhook.id, p.eventId)).id;
    // The API died after claiming: the row is "sending" with an old lease.
    await t.prisma.webhookDelivery.update({ where: { id }, data: { status: 'sending', attempts: 1, leaseUntil: new Date(Date.now() - 1000) } });
    const m = await svc.maintenance();
    expect(m.requeued).toBeGreaterThanOrEqual(1);
    expect(await svc.processSend(id)).toBe('succeeded');
    expect(received.find((r) => r.path === '/ok/lease')?.headers['webhook-id']).toBe(id);
    expect((await t.prisma.webhookDelivery.findUniqueOrThrow({ where: { id } })).attempts).toBe(2);
  });

  it('webhook_late_result_does_not_overwrite_newer_attempt', async () => {
    const hook = await createHook(`${origin}/ok/late-result`);
    const p = await publish();
    await p.run();
    const id = (await deliveryFor(hook.webhook.id, p.eventId)).id;
    await t.prisma.webhookDelivery.update({ where: { id }, data: { status: 'sending', attempts: 3 } });
    const record = (svc as unknown as { record: (...a: unknown[]) => Promise<string> }).record.bind(svc);
    expect(await record(id, 2, hook.webhook.id, { ok: true, status: 200, durationMs: 1, errorCode: null }, new Date())).toBe('noop');
    expect(await t.prisma.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'sending', attempts: 3 });
  });

  it('webhook_suppressed_outside_production_unless_allowlisted', async () => {
    const hook = await createHook('https://hooks.example.com/not-listed');
    const p = await publish();
    await p.run();
    expect(await svc.processSend((await deliveryFor(hook.webhook.id, p.eventId)).id)).toBe('suppressed');
    expect(await deliveryFor(hook.webhook.id, p.eventId)).toMatchObject({ status: 'suppressed', lastErrorCode: 'not_allow_listed' });
    expect(received).toHaveLength(0);
  });

  it('test endpoint sends an integrations.ping', async () => {
    const hook = await createHook(`${origin}/ok/ping`);
    await freshStepUp(owner.id);
    const res = await t.http().post(`/admin/integrations/webhooks/${hook.webhook.id}/test`).set(STATE_HEADERS).set('Cookie', owner.cookie);
    expect(res.status).toBe(202);
    expect(await svc.processSend(res.body.deliveryId)).toBe('succeeded');
    expect(JSON.parse(received.find((r) => r.path === '/ok/ping')!.body)).toMatchObject({ type: 'integrations.ping', data: { subscriptionId: hook.webhook.id } });
  });
});

describe('failure handling', () => {
  it('webhook_auto_disabled_after_consecutive_failures_and_audited (once)', async () => {
    const hook = await createHook(`${origin}/fail`);
    const p1 = await publish();
    const p2 = await publish();
    await p1.run();
    await p2.run();
    await t.prisma.webhookSubscription.update({ where: { id: hook.webhook.id }, data: { consecutiveFailures: AUTO_DISABLE_AFTER_FAILURES - 1 } });
    await svc.processSend((await deliveryFor(hook.webhook.id, p1.eventId)).id);
    const sub = await t.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: hook.webhook.id } });
    expect(sub).toMatchObject({ enabled: false, disabledReason: 'consecutive_failures' });
    expect(await deliveryFor(hook.webhook.id, p2.eventId)).toMatchObject({ status: 'cancelled', lastErrorCode: 'subscription_disabled' });
    expect(await deliveryFor(hook.webhook.id, p1.eventId)).toMatchObject({ status: 'cancelled' });
    expect(await t.prisma.auditLog.count({ where: { entityId: hook.webhook.id, action: 'integrations.webhook.autoDisabled', actorType: 'system' } })).toBe(1);
    const monitor = await t.app.get(SystemMonitorService).status();
    expect(monitor.webhooks.autoDisabledSubscriptions).toBeGreaterThanOrEqual(1);
    expect(monitor.reasons).toContain('webhooks_auto_disabled');
    // Re-enabling resets the counter.
    await freshStepUp(owner.id);
    const on = await t.http().patch(`/admin/integrations/webhooks/${hook.webhook.id}`).set(STATE_HEADERS).set('Cookie', owner.cookie).send({ version: sub.version, enabled: true });
    expect(on.status).toBe(200);
    expect((await t.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: hook.webhook.id } })).consecutiveFailures).toBe(0);
  });

  it('webhook_success_resets_consecutive_failures', async () => {
    const hook = await createHook(`${origin}/ok/reset`);
    await t.prisma.webhookSubscription.update({ where: { id: hook.webhook.id }, data: { consecutiveFailures: 7 } });
    const p = await publish();
    await p.run();
    await svc.processSend((await deliveryFor(hook.webhook.id, p.eventId)).id);
    expect((await t.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: hook.webhook.id } })).consecutiveFailures).toBe(0);
  });

  it('webhook_secret_unavailable_fails_without_retry', async () => {
    const hook = await createHook(`${origin}/ok/nokey`);
    await t.prisma.webhookSubscription.update({ where: { id: hook.webhook.id }, data: { keyVersion: 99 } });
    const p = await publish();
    await p.run();
    const id = (await deliveryFor(hook.webhook.id, p.eventId)).id;
    expect(await svc.processSend(id)).toBe('failed');
    expect(await t.prisma.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'failed', lastErrorCode: 'secret_unavailable', nextAttemptAt: null });
    expect(received).toHaveLength(0);
  });

  it('webhook_module_off_stops_pending_and_retry_sends (G4)', async () => {
    const hook = await createHook(`${origin}/ok/off`);
    const p = await publish();
    await p.run();
    const id = (await deliveryFor(hook.webhook.id, p.eventId)).id;
    await setIntegrations(false);
    try {
      expect((await svc.maintenance()).requeued).toBe(0);
      expect(await svc.processSend(id)).toBe('cancelled');
    } finally {
      await setIntegrations(true);
    }
    expect(await t.prisma.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'cancelled', lastErrorCode: 'module_disabled' });
    expect(received).toHaveLength(0);
  });

  it('webhook_errors_store_codes_only', async () => {
    const hook = await createHook(`${origin}/fail?token=very-secret-token`);
    const p = await publish();
    await p.run();
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((l) => vi.spyOn(Logger.prototype, l).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))));
    try {
      await svc.processSend((await deliveryFor(hook.webhook.id, p.eventId)).id);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = await t.prisma.webhookDelivery.findMany({ where: { lastErrorCode: { not: null } }, select: { lastErrorCode: true } });
    for (const d of all) expect(DELIVERY_ERROR_CODES as readonly string[]).toContain(d.lastErrorCode);
    const row = await deliveryFor(hook.webhook.id, p.eventId);
    expect(JSON.stringify(row)).not.toMatch(/127\.0\.0\.1|very-secret-token|internal details/);
    expect(lines.join('\n')).not.toMatch(/127\.0\.0\.1|very-secret-token|internal details/);
  });

  it('webhook_manual_retry_requires_step_up_and_audited, at most five a day', async () => {
    const hook = await createHook(`${origin}/fail`);
    const p = await publish();
    await p.run();
    const id = (await deliveryFor(hook.webhook.id, p.eventId)).id;
    await t.prisma.webhookDelivery.update({ where: { id }, data: { status: 'failed', attempts: MAX_ATTEMPTS } });
    for (let i = 0; i < 5; i += 1) {
      await freshStepUp(owner.id);
      const res = await t.http().post(`/admin/integrations/webhook-deliveries/${id}/retry`).set(STATE_HEADERS).set('Cookie', owner.cookie);
      expect(res.status).toBe(202);
      expect(await t.prisma.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'pending', attempts: 0 });
      await t.prisma.webhookDelivery.update({ where: { id }, data: { status: 'failed', attempts: MAX_ATTEMPTS } });
    }
    const sixth = await t.http().post(`/admin/integrations/webhook-deliveries/${id}/retry`).set(STATE_HEADERS).set('Cookie', owner.cookie);
    expect(sixth.status).toBe(429);
    expect(await t.prisma.auditLog.count({ where: { entityId: id, action: 'integrations.webhookDelivery.retried', actorType: 'staff' } })).toBe(5);
  });

  it('webhook_purge_finished_after_30_days', async () => {
    const hook = await createHook(`${origin}/ok/purge`);
    const p = await publish();
    await p.run();
    const id = (await deliveryFor(hook.webhook.id, p.eventId)).id;
    await svc.processSend(id);
    await svc.maintenance(new Date(Date.now() + 29 * 86400_000));
    expect(await t.prisma.webhookDelivery.count({ where: { id } })).toBe(1);
    await svc.maintenance(new Date(Date.now() + 31 * 86400_000));
    expect(await t.prisma.webhookDelivery.count({ where: { id } })).toBe(0);
  });

  it('monitor_reports_webhook_health', async () => {
    const hook = await createHook(`${origin}/fail`);
    const p = await publish();
    await p.run();
    await t.prisma.webhookDelivery.updateMany({ where: { subscriptionId: hook.webhook.id }, data: { status: 'failed', lastAttemptAt: new Date(), lastErrorCode: 'http_error' } });
    const s = await t.app.get(SystemMonitorService).status();
    expect(s.webhooks.failedLast24h).toBeGreaterThanOrEqual(1);
    expect(s.reasons).toContain('webhook_deliveries_failed');
    expect(JSON.stringify(s.webhooks)).not.toContain('127.0.0.1');
  });
});
