// Incoming gateway webhooks, secrets and the SQL nets of the payments tables
// (plan docs/plans/3.1-payment-provider-core.md, sections 2.4, 3, 6, 8, 10 and 14).
import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAYMENT_STATUS_PAIRS, PaymentStateMachine } from '../../../src/modules/payments/core/attempt-state';
import { PaymentAttemptsService } from '../../../src/modules/payments/core/attempts.service';
import { SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { PaymentsMaintenanceService } from '../../../src/modules/payments/core/maintenance.service';
import { PaymentWebhooksService } from '../../../src/modules/payments/core/webhooks.service';
import { PAYMENT_ENTITIES } from '../../../src/modules/payments/entities';
import { TRANSACTION_RETRIES } from '../../../src/platform/database/transaction';
import { RawBodyRoutes } from '../../../src/platform/http/raw-body';
import { TestApp, makeApp } from '../../support/auth';
import { closeCatalogue } from '../../support/catalogue';
import { cleanBookingEvents, staffCancel } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import {
  PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, eventFor, onlyAccount, payingCustomer, paymentsStaff, sendWebhook, sim, simulatorAccount,
} from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const svc = () => t.app.get(PaymentWebhooksService);
/** An approved booking with a live card attempt (requires_action) at the simulator. */
async function attempt() {
  const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
  const res = await c.pay(reference, { method: 'card' });
  if (res.status !== 201) throw new Error(`pay failed ${res.status}`);
  const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
  return { reference, bookingId, p };
}
const statusOf = async (id: string) => (await t.prisma.payment.findUniqueOrThrow({ where: { id } })).status;
const eventRow = (eventId: string, accountId = acc.id) => t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: accountId, providerEventId: eventId } } });

describe('webhook_duplicate_out_of_order_bad_signature (plan 0.1, P6)', () => {
  it('a duplicate changes nothing twice; a late "pending" after "succeeded" does not go back; "failed" then "succeeded": the money wins', async () => {
    const { p } = await attempt();
    const ok = await eventFor(t, acc, p.id, { status: 'succeeded' });
    expect(await deliver(t, acc, ok)).toEqual({ status: 200, outcome: 'processed' });
    const dup = await sendWebhook(t, acc, ok);
    expect([dup.status, dup.body]).toEqual([200, { received: true, duplicate: true }]);
    expect(await t.prisma.webhookEvent.count({ where: { providerAccountId: acc.id, providerEventId: ok.eventId } })).toBe(1);
    expect((await deliver(t, acc, await eventFor(t, acc, p.id, { status: 'pending' }))).outcome).toBe('processed');
    expect(await statusOf(p.id)).toBe('succeeded');
    // created → requires_action when it started, requires_action → succeeded once; the duplicate and the late event add nothing.
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.payment.status_changed', entityId: p.id } })).toBe(2);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.payment.succeeded', aggregateId: p.id } })).toBe(1);

    const second = await attempt();
    await deliver(t, acc, await eventFor(t, acc, second.p.id, { status: 'failed' }));
    expect(await statusOf(second.p.id)).toBe('failed');
    await deliver(t, acc, await eventFor(t, acc, second.p.id, { status: 'succeeded' }));
    expect(await statusOf(second.p.id)).toBe('succeeded');
  });

  it('a bad signature is a 400, stored as a rejection without its body, and changes nothing', async () => {
    const { p } = await attempt();
    const w = await eventFor(t, acc, p.id);
    const forged = { ...w, headers: { ...w.headers, 'x-sim-signature': w.headers['x-sim-signature']!.replace(/v1=.{4}/, 'v1=0000') } };
    const res = await sendWebhook(t, acc, forged);
    expect([res.status, res.body.code]).toEqual([400, 'webhook_rejected']);
    expect(await t.prisma.webhookEvent.count({ where: { providerEventId: w.eventId } })).toBe(0);
    const rej = await t.prisma.webhookRejection.findFirstOrThrow({ where: { claimedEventId: w.eventId } });
    expect(rej).toMatchObject({ reason: 'bad_signature', sizeBytes: w.body.length, providerAccountId: acc.id });
    expect(Object.keys(rej)).not.toContain('rawBody');
    expect(rej.headers).toEqual({ 'content-type': 'application/json', 'content-length': String(w.body.length), 'x-sim-signature': '[present]' });
    expect(await statusOf(p.id)).toBe('requires_action');
  });

  it('stale_timestamp_webhook_rejected: a replay signed more than five minutes ago', async () => {
    const { p } = await attempt();
    const w = sim.paymentEvent(acc.secret, { ref: p.providerPaymentRef!, status: 'succeeded', amountMinor: p.amountMinor, currency: p.currency, paymentId: p.id }, { signedAt: new Date(Date.now() - 6 * 60_000) });
    expect((await sendWebhook(t, acc, w)).status).toBe(400);
    expect((await t.prisma.webhookRejection.findFirstOrThrow({ where: { claimedEventId: w.eventId } })).reason).toBe('stale_timestamp');
    expect(await statusOf(p.id)).toBe('requires_action');
  });

  it('invalid_then_valid_same_event_id_processed_once', async () => {
    const { p } = await attempt();
    const w = await eventFor(t, acc, p.id);
    expect((await sendWebhook(t, acc, { ...w, headers: { ...w.headers, 'x-sim-signature': 't=1,v1=' + '0'.repeat(64) } })).status).toBe(400);
    expect((await deliver(t, acc, w)).outcome).toBe('processed');
    expect((await sendWebhook(t, acc, w)).body.duplicate).toBe(true);
    expect(await statusOf(p.id)).toBe('succeeded');
  });

  it('concurrent_duplicate_webhooks_transition_once', async () => {
    const { p } = await attempt();
    const w = await eventFor(t, acc, p.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => sendWebhook(t, acc, w)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    const ev = await eventRow(w.eventId);
    const outcomes = await Promise.allSettled([svc().process(ev.id), svc().process(ev.id), svc().process(ev.id)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled' && o.value === 'processed')).toHaveLength(1);
    // Two different events for the same success, at once: one change of state.
    const other = await eventFor(t, acc, p.id);
    await deliver(t, acc, other);
    expect(await t.prisma.auditLog.count({ where: { action: 'payments.payment.status_changed', entityId: p.id } })).toBe(2);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.payment.succeeded', aggregateId: p.id } })).toBe(1);
  });
});

describe('matching events to payments (plan 0.1, P5)', () => {
  it('webhook_before_provider_response_matches_app_payment: the reference is filled in from the event', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    sim.queue(acc.id, 'timeout_after_create');
    expect((await c.pay(reference, { method: 'card' })).status).toBe(503);
    const p = await t.prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(p.providerPaymentRef).toBeNull();
    const remote = sim.settle(acc.id, sim.find(acc.id, { paymentId: p.id })!.ref, 'succeeded');
    expect((await deliver(t, acc, sim.paymentEvent(acc.secret, { ref: remote.ref, status: 'succeeded', amountMinor: p.amountMinor, currency: 'AUD', paymentId: p.id }))).outcome).toBe('processed');
    const after = await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect([after.status, after.providerPaymentRef]).toEqual(['succeeded', remote.ref]);
  });

  it('webhook_metadata_id_from_other_account_not_matched', async () => {
    const { p } = await attempt();
    const other = await simulatorAccount(t);
    await t.prisma.providerAccount.update({ where: { id: other.id }, data: { status: 'paused' } });
    const w = sim.paymentEvent(other.secret, { ref: 'sim_pay_elsewhere', status: 'succeeded', amountMinor: p.amountMinor, currency: 'AUD', paymentId: p.id });
    expect((await deliver(t, other, w)).outcome).toBe('ignored');
    expect((await eventRow(w.eventId, other.id)).errorCode).toBe('unknown_payment');
    expect(await statusOf(p.id)).toBe('requires_action');
  });

  it('provider_amount_or_currency_mismatch_not_posted', async () => {
    const { p } = await attempt();
    for (const over of [{ amountMinor: p.amountMinor - 1n }, { currency: 'NZD' }]) {
      const w = await eventFor(t, acc, p.id, over);
      expect((await deliver(t, acc, w)).outcome).toBe('ignored');
      expect((await eventRow(w.eventId)).errorCode).toBe('amount_or_currency_mismatch');
    }
    expect(await statusOf(p.id)).toBe('requires_action');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:mismatch:${p.id}`, status: 'open' } })).toBe(1);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'payments.payment.succeeded', aggregateId: p.id } })).toBe(0);
  });

  it('unknown_payment_event_ignored_with_task: no attempt is ever created from an event', async () => {
    const before = await t.prisma.payment.count();
    const w = sim.paymentEvent(acc.secret, { ref: 'sim_pay_nobody', status: 'succeeded', amountMinor: 999n, currency: 'AUD' });
    expect((await deliver(t, acc, w)).outcome).toBe('ignored');
    const ev = await eventRow(w.eventId);
    expect(ev.errorCode).toBe('unknown_payment');
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:unknown_event:${ev.id}` } })).toBe(1);
    expect(await t.prisma.payment.count()).toBe(before);
  });

  it('an unsupported event type is stored and ignored', async () => {
    const w = sim.paymentEvent(acc.secret, { ref: 'x', status: 'succeeded', amountMinor: 1n, currency: 'AUD' }, { type: 'payout.paid' });
    expect((await deliver(t, acc, w)).outcome).toBe('ignored');
    expect(await eventRow(w.eventId)).toMatchObject({ errorCode: 'unsupported', type: 'payout.paid' });
  });

  it('webhook_processing_failure_retried_and_visible', async () => {
    const { p } = await attempt();
    const w = await eventFor(t, acc, p.id);
    expect((await sendWebhook(t, acc, w)).status).toBe(200);
    const ev = await eventRow(w.eventId);
    const spy = vi.spyOn(t.app.get(PaymentStateMachine), 'apply').mockRejectedValueOnce(new Error('database went away'));
    await expect(svc().process(ev.id)).rejects.toThrow();
    spy.mockRestore();
    const failed = await eventRow(w.eventId);
    expect([failed.status, failed.attempts]).toEqual(['failed', 1]);
    expect(failed.errorCode).toBeTruthy();
    expect(await statusOf(p.id)).toBe('requires_action');
    // A failure that stays is visible: the sweep opens one task for it (review M2).
    const flagged = await t.app.get(PaymentsMaintenanceService).run(new Date(Date.now() + 31 * 60_000));
    expect(flagged.failedFlagged).toContain(ev.id);
    // Already flagged: left out of the next batch, so a backlog never starves newer failures (review round 2, 3b).
    expect((await t.app.get(PaymentsMaintenanceService).run(new Date(Date.now() + 41 * 60_000))).failedFlagged).not.toContain(ev.id);
    expect(await t.prisma.task.count({ where: { sourceRef: `payments:webhook_failed:${ev.id}` } })).toBe(1);
    expect(await svc().process(ev.id)).toBe('processed');
    expect(await statusOf(p.id)).toBe('succeeded');
    // Processed after all: the task is closed (review round 2, point 3a).
    expect((await t.prisma.task.findFirstOrThrow({ where: { sourceRef: `payments:webhook_failed:${ev.id}` } })).status).toBe('done');
  });

  it('paused_account_still_processes_webhook', async () => {
    const { p } = await attempt();
    await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'paused' } });
    try {
      expect((await deliver(t, acc, await eventFor(t, acc, p.id))).outcome).toBe('processed');
      expect(await statusOf(p.id)).toBe('succeeded');
    } finally {
      await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'active' } });
    }
  });
});

describe('raw events, retention and erasure (plan 3.1, 6 and 7)', () => {
  it('raw_body_stored_headers_sanitised', async () => {
    const { p } = await attempt();
    const w = await eventFor(t, acc, p.id);
    const res = await sendWebhook(t, acc, w).set('Authorization', 'Bearer secret').set('Cookie', 'a=b').set('X-Forwarded-For', '10.0.0.1');
    expect(res.status).toBe(200);
    const ev = await eventRow(w.eventId);
    expect(Buffer.from(ev.rawBody!).equals(w.body)).toBe(true);
    expect(ev.headers).toEqual({ 'content-type': 'application/json', 'content-length': String(w.body.length), 'x-sim-signature': '[present]' });
    expect(ev.status).toBe('received');
    expect(ev.type).toBe('payment.updated');
  });

  it('erasure_clears_matched_webhook_raw_body', async () => {
    const { p, bookingId } = await attempt();
    const w = await eventFor(t, acc, p.id);
    await deliver(t, acc, w);
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const handler = PAYMENT_ENTITIES.find((e) => e.entityType === 'WebhookEvent')!.handlers!;
    await t.prisma.$transaction((tx) => handler.anonymise(tx, b.customerId));
    expect((await eventRow(w.eventId)).rawBody).toBeNull();
    await expect(t.prisma.$executeRawUnsafe(`UPDATE webhook_events SET "rawBody" = '\\x00' WHERE id = $1::uuid`, (await eventRow(w.eventId)).id)).rejects.toThrow(/never edited/);
  });

  it('raw_body_purged_after_180_days, rejections_purged_after_30_days and stuck_received_webhook_requeued', async () => {
    const { p } = await attempt();
    const w = await eventFor(t, acc, p.id);
    await sendWebhook(t, acc, w);
    const ev = await eventRow(w.eventId);
    const m = t.app.get(PaymentsMaintenanceService);
    const soon = await m.run(new Date(Date.now() + 11 * 60_000));
    expect(soon.requeued).toContain(ev.id);
    expect((await eventRow(w.eventId)).rawBody).not.toBeNull();
    await sendWebhook(t, acc, { ...w, headers: { ...w.headers, 'x-sim-signature': 't=1,v1=' + '1'.repeat(64) } });
    const later = await m.run(new Date(Date.now() + 181 * 86_400_000));
    expect(later.bodiesPurged).toBeGreaterThanOrEqual(1);
    expect(later.rejectionsPurged).toBeGreaterThanOrEqual(1);
    expect((await eventRow(w.eventId)).rawBody).toBeNull();
    expect(await svc().process(ev.id)).toBe('ignored');
    expect((await eventRow(w.eventId)).errorCode).toBe('body_purged');
  });
});

describe('abuse (plan 3.1, 14.5)', () => {
  it('oversized_and_unknown_requests_rate_limited_without_db_rows', async () => {
    const rejections = await t.prisma.webhookRejection.count();
    const events = await t.prisma.webhookEvent.count();
    const big = await t.http().post(`/payments/webhooks/${acc.pathToken}`).set('content-type', 'application/json').send('x'.repeat(300 * 1024));
    expect([big.status, big.body.code]).toEqual([413, 'payload_too_large']);
    const unknown = await t.http().post(`/payments/webhooks/${randomBytes(32).toString('base64url')}`).set('content-type', 'application/json').send('{}');
    expect(unknown.status).toBe(404);
    expect((await t.http().post('/payments/webhooks/short').send('{}')).status).toBe(404);
    expect(await t.prisma.webhookRejection.count()).toBe(rejections);
    expect(await t.prisma.webhookEvent.count()).toBe(events);

    const t2 = await makeApp({ PAYMENT_WEBHOOKS_PER_MINUTE_PER_IP: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await t2.http().post(`/payments/webhooks/${randomBytes(32).toString('base64url')}`).send('x'.repeat(i % 2 ? 300 * 1024 : 10))).status);
      expect(statuses).toEqual([404, 413, 404, 429, 429]);
      expect(t2.app.get(RawBodyRoutes).counters.rateLimited).toBe(2);
      expect(await t2.prisma.webhookRejection.count()).toBe(rejections);
    } finally {
      await t2.close();
    }
  });

  it('webhook_path_token_redacted_in_logs: the token never reaches a log line', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(capture)),
      ...(['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(capture)),
    ];
    try {
      const token = randomBytes(32).toString('base64url');
      await t.http().post(`/payments/webhooks/${token}`).send('{}');
      await t.http().post(`/payments/webhooks/${acc.pathToken}`).set('x-sim-signature', 'bad').send('{"id":"sim_evt_x"}');
      expect(lines.join('\n')).toContain('unknown_account');
      expect(lines.join('\n')).not.toContain(token);
      expect(lines.join('\n')).not.toContain(acc.pathToken);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('secrets (plan 0.1, 4.7; plan 3.1, 2.4)', () => {
  it('provider_credentials_never_in_logs_or_errors: an adapter error carrying a secret becomes a code', async () => {
    const lines: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; });
    let seen = '';
    try {
      const failure = await t.app.get(ProviderGateway).call(acc.id, 'retrieve', async (_p, ctx) => {
        seen = ctx.credentials.apiKey!;
        throw new Error(`gateway said no to ${ctx.credentials.apiKey} with ${ctx.webhookSecret}`);
      }).catch((e: unknown) => e as Error);
      expect(failure).toMatchObject({ name: 'ProviderError', code: 'provider_unavailable' });
      expect(failure.message).not.toContain(seen);
      expect(failure.message).not.toContain(acc.secret);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(seen).toMatch(/^sim_test_/);
    expect(lines.join('\n')).not.toContain(seen);
    const res = await admin.get('/admin/payments/provider-accounts');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/Ciphertext|Hash|sim_test_/);
    expect(res.body.items.find((a: { id: string }) => a.id === acc.id)).toMatchObject({ adapterKey: 'simulator', mode: 'test', adapterStatus: 'experimental', adapterTestOnly: true });
  });

  it('credentials_aad_bound_to_account: a ciphertext copied to another account does not decrypt', async () => {
    const other = await simulatorAccount(t);
    await t.prisma.providerAccount.update({ where: { id: other.id }, data: { status: 'paused' } });
    const a = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: acc.id } });
    // credentialsChangedAt moves with the ciphertext (task 4.1, migration 0034's trigger).
    await t.prisma.providerAccount.update({ where: { id: other.id }, data: { credentialsCiphertext: a.credentialsCiphertext, credentialsChangedAt: new Date(Date.now() + 60_000) } });
    await expect(t.app.get(ProviderGateway).call(other.id, 'retrieve', async () => 'reached')).rejects.toThrow(/could not be decrypted/);
  });

  it('the panel reads the payments of a booking without bodies, headers or secrets', async () => {
    const { p, bookingId } = await attempt();
    await deliver(t, acc, await eventFor(t, acc, p.id));
    const res = await admin.get(`/admin/payments/bookings/${bookingId}`);
    expect(res.status).toBe(200);
    expect(res.body.payments[0]).toMatchObject({ status: 'succeeded', amountMinor: p.amountMinor.toString() });
    expect(res.body.schedule.items.length).toBe(2);
    expect(JSON.stringify(res.body)).not.toMatch(/rawBody|headers|Ciphertext/);
  });
});

describe('SQL nets (plan 3.1, section 3)', () => {
  it('provider_account_mode_is_test_only and provider_account_mode_is_immutable', async () => {
    await expect(t.prisma.$executeRawUnsafe(`UPDATE provider_accounts SET mode = 'live' WHERE id = $1::uuid`, acc.id)).rejects.toThrow(/mode and adapter|test_mode_only/);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE provider_accounts SET "adapterKey" = 'stripe' WHERE id = $1::uuid`, acc.id)).rejects.toThrow(/never change/);
    const a = await t.prisma.providerAccount.findUniqueOrThrow({ where: { id: acc.id } });
    await expect(t.prisma.providerAccount.create({ data: { ...a, id: crypto.randomUUID(), mode: 'live', webhookPathTokenHash: 'f'.repeat(64) } })).rejects.toThrow(/test_mode_only/);
  });

  it('payment_identity_columns_immutable', async () => {
    const { p } = await attempt();
    for (const set of [`"amountMinor" = 1`, `currency = 'NZD'`, `"bookingId" = gen_random_uuid()`, `method = 'apple_pay'`, `"idempotencyKey" = 'x'`, `"pendingExpiresAt" = now() + interval '1 day'`, `"providerPaymentRef" = 'sim_pay_other'`, `mode = 'live'`]) {
      await expect(t.prisma.$executeRawUnsafe(`UPDATE payments SET ${set} WHERE id = $1::uuid`, p.id)).rejects.toThrow();
    }
  });

  it('payment_status_trigger_matrix: every pair, as the API role', async () => {
    const STATES = ['created', 'requires_action', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'voided'] as const;
    // These payments came through a gateway: `succeeded > voided` is only for a confirmed bank transfer (origin 'inbound',
    // task 3.4), so the trigger must refuse it here. The inbound case is tested in manual.test.ts.
    const ALLOWED = new Set(PAYMENT_STATUS_PAIRS.map((x) => x.join('>')).filter((x) => x !== 'succeeded>voided'));
    const STEP = `UPDATE payments SET status = $2::"PaymentStatus", version = version + 1,
      "liveBookingId" = CASE WHEN $2 IN ('created', 'requires_action', 'pending') THEN "bookingId" END,
      "providerPaymentRef" = COALESCE("providerPaymentRef", 'sim_pay_matrix_' || left(id::text, 8)),
      "succeededAt" = CASE WHEN $2 = 'succeeded' THEN COALESCE("succeededAt", now()) ELSE "succeededAt" END WHERE id = $1::uuid`;
    // One attempt still `created` (never sent to the gateway) and one at `requires_action`; every other state is one
    // allowed step from requires_action, taken inside the same rolled-back transaction.
    const created = await approvedBooking(t, admin, await pricedWorld(admin), c);
    const createdId = await t.app.get(PaymentAttemptsService).createOrResume(created.bookingId, { method: 'card' }, SYSTEM_ACTOR);
    const { p } = await attempt();
    const start: Record<string, { id: string; path: string[] }> = {
      created: { id: createdId, path: [] }, requires_action: { id: p.id, path: [] },
      pending: { id: p.id, path: ['pending'] }, succeeded: { id: p.id, path: ['succeeded'] }, failed: { id: p.id, path: ['failed'] },
      cancelled: { id: p.id, path: ['cancelled'] }, expired: { id: p.id, path: ['expired'] },
    };
    const wrong: string[] = [];
    for (const [from, { id, path }] of Object.entries(start)) {
      for (const to of STATES) {
        if (to === from) continue;
        let ok = true;
        try {
          await t.prisma.$transaction(async (tx) => {
            for (const s of path) await tx.$executeRawUnsafe(STEP, id, s);
            await tx.$executeRawUnsafe(STEP, id, to);
            throw new Error('rollback');
          });
        } catch (e) {
          ok = String(e).includes('rollback');
        }
        if (ok !== ALLOWED.has(`${from}>${to}`)) wrong.push(`${from}>${to}: ${ok ? 'passed' : 'refused'}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(await statusOf(p.id)).toBe('requires_action');
  });

  it('payments_tables_reject_delete_and_truncate', async () => {
    const { p } = await attempt();
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM payments WHERE id = $1::uuid`, p.id)).rejects.toThrow(/never deleted/);
    // Task 4.1: mt_app no longer has DELETE on provider_accounts (0034); the trigger still refuses the owner (provider-accounts.test.ts).
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM provider_accounts WHERE id = $1::uuid`, acc.id)).rejects.toThrow(/permission denied/);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM webhook_events`)).rejects.toThrow(/never deleted/);
    for (const table of ['payments', 'payment_schedules', 'payment_schedule_items', 'provider_accounts', 'webhook_events']) {
      await expect(t.prisma.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`)).rejects.toThrow();
    }
  });

  it('opposite_order_webhook_and_cancel_do_not_deadlock', async () => {
    const before = TRANSACTION_RETRIES.deadlock;
    for (let i = 0; i < 3; i++) {
      const { p, bookingId } = await attempt();
      const w = await eventFor(t, acc, p.id, { status: 'failed' });
      await sendWebhook(t, acc, w);
      const ev = await eventRow(w.eventId);
      const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      const [r1, r2] = await Promise.allSettled([svc().process(ev.id), staffCancel(admin, bookingId, { version: b.version, reason: 'x' })]);
      expect(r1.status).toBe('fulfilled');
      expect(r2.status === 'fulfilled' && [200, 409].includes(r2.value.status)).toBe(true);
    }
    expect(TRANSACTION_RETRIES.deadlock - before).toBe(0);
  });
});
