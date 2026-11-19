// Payment links (task 5.1, plan docs/plans/5.1-customer-area.md, sections 5 and 7, review round 1): a single-use
// capability that staff email to the booking's own address, which pays one plan item without a session. Simulator only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tokenHash } from '../../../src/platform/auth/tokens';
import { MailService } from '../../../src/platform/mail/mail.service';
import { EntityRegistry } from '../../../src/platform/entities/entity-registry';
import { runTransaction } from '../../../src/platform/database/transaction';
import { PaymentAttemptsService } from '../../../src/modules/payments';
import { BookingStateMachine } from '../../../src/modules/bookings';
import { SYSTEM_ACTOR } from '../../../src/platform/audit/audit.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents, staffCancel } from '../../support/bookings';
import { CATALOGUE_AND_PRICING, staffClient } from '../../support/catalogue';
import { closeCatalogue } from '../../support/catalogue';
import { walkTo } from '../../support/customer-portal';
import { pricedWorld } from '../../support/pricing';
import { PayingCustomer, SimAccount, approvedBooking, cleanPayments, ensureTerms, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount } from '../../support/payments';

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
  await ensureTerms(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'mail.send'`);
  await closeCatalogue(t);
});

const TOKEN_IN_MAIL = /\/pay#token=([A-Za-z0-9_-]{43})/;
const booked = async (opts: { acceptTerms?: boolean } = {}) => approvedBooking(t, admin, await pricedWorld(admin), c, opts);
const send = (bookingId: string, who = admin) => who.post(`/admin/payments/bookings/${bookingId}/payment-links`, {});
const revoke = (linkId: string) => admin.post(`/admin/payments/payment-links/${linkId}/revoke`, {});
const view = (token: string) => t.http().post('/payment-links/view').set(STATE_HEADERS).send({ token });
const refresh = (token: string) => t.http().post('/payment-links/refresh').set(STATE_HEADERS).send({ token });
const pay = (token: string, body: object = {}, key: string = randomUUID()) => t.http().post('/payment-links/payments').set(STATE_HEADERS).set('Idempotency-Key', key).send({ token, method: 'card', ...body });
const paymentsOf = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
const emailOf = (linkId: string) => t.prisma.outboundEmail.findUniqueOrThrow({ where: { dedupeKey: `payment-link:${linkId}` } });
const sql = (q: string, ...v: unknown[]) => t.prisma.$executeRawUnsafe(q, ...v);
/** Staff cancel through the state machine (the plan follows the booking). */
async function cancel(bookingId: string) {
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { version: true } });
  const res = await staffCancel(admin, bookingId, { version: b.version, reason: 'Test' });
  if (res.status !== 200) throw new Error(`cancel failed: ${res.status} ${JSON.stringify(res.body)}`);
}
/** The deposit deadline passes, and the approval expiry runs through the state machine. */
async function lapse(bookingId: string, expire: boolean) {
  await sql(`UPDATE bookings SET "approvalExpiresAt" = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, bookingId);
  if (expire) await runTransaction(t.prisma, (tx) => t.app.get(BookingStateMachine).transition(tx, bookingId, 'expire_approval', { actor: SYSTEM_ACTOR }));
}

/** Runs the send step of the link's email and returns the token from the captured message. */
async function deliver(linkId: string): Promise<string> {
  const before = t.mail.sent.length;
  await t.app.get(MailService).processSend((await emailOf(linkId)).id);
  const m = t.mail.sent.slice(before).find((x) => TOKEN_IN_MAIL.test(x.text));
  if (!m) throw new Error('no payment link email was sent');
  return TOKEN_IN_MAIL.exec(m.text)![1]!;
}

/** An approved booking (terms accepted) with a link delivered: its token. */
async function linked(opts: { acceptTerms?: boolean } = {}) {
  const b = await booked(opts);
  const res = await send(b.bookingId);
  expect(res.status).toBe(201);
  const token = await deliver(res.body.id);
  return { ...b, linkId: res.body.id as string, token };
}

/** The gateway says the latest attempt of the booking succeeded; the link's refresh records it. */
async function succeedLatest(bookingId: string, token: string) {
  const p = (await paymentsOf(bookingId)).at(-1)!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  return refresh(token);
}

describe('sending and revoking (staff)', () => {
  it('payment_link_send_requires_permission: without payments.paymentLink.send it is 403 and nothing is written', async () => {
    const { bookingId } = await booked();
    const reader = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, 'payments.payment.read']);
    expect((await send(bookingId, reader)).status).toBe(403);
    expect(await t.prisma.paymentLink.count({ where: { bookingId } })).toBe(0);
  });

  it('send_targets_the_next_item, never shows a token, and the panel lists the link without its hash', async () => {
    const { bookingId } = await booked();
    const res = await send(bookingId);
    expect(res.status).toBe(201);
    const deposit = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId, state: 'active', sequence: 1 } });
    const row = await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: res.body.id } });
    expect([row.targetScheduleItemId, row.status, row.tokenHash]).toEqual([deposit.id, 'active', null]);
    expect(res.body).toMatchObject({ id: row.id, status: 'active', sent: false, expired: false, targetSequence: 1 });
    expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'expired', 'expiresAt', 'id', 'revokedAt', 'sent', 'status', 'targetSequence', 'usedAt']);
    const panel = await admin.get(`/admin/payments/bookings/${bookingId}`);
    expect(panel.body.links).toHaveLength(1);
    expect(JSON.stringify(panel.body)).not.toMatch(/tokenHash/);
    // An approved booking's link never outlives the deposit deadline.
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { approvalExpiresAt: true } });
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(b.approvalExpiresAt!.getTime());
  });

  it('send_rejected_when_not_payable: requested, cancelled, approval lapsed and nothing to pay', async () => {
    const w = await pricedWorld(admin);
    const req = await c.request((await import('../../support/bookings')).requestBody(w));
    const requested = await t.prisma.booking.findUniqueOrThrow({ where: { reference: req.body.reference } });
    expect([(await send(requested.id)).status, (await send(requested.id)).body.code]).toEqual([409, 'booking_not_payable']);

    const cancelled = await booked();
    await cancel(cancelled.bookingId);
    expect((await send(cancelled.bookingId)).body.code).toBe('booking_not_payable');

    const lapsed = await booked();
    await lapse(lapsed.bookingId, false);
    expect((await send(lapsed.bookingId)).body.code).toBe('approval_expired');

    const paid = await booked();
    await walkTo(t, paid.bookingId, 'balance_paid', 'approved');
    expect((await send(paid.bookingId)).body.code).toBe('nothing_to_pay');
    expect(await t.prisma.paymentLink.count({ where: { bookingId: { in: [requested.id, cancelled.bookingId, lapsed.bookingId, paid.bookingId] } } })).toBe(0);
  });

  it('new_link_revokes_previous: the old token is 404, the new one works', async () => {
    const first = await linked();
    const again = await send(first.bookingId);
    const second = await deliver(again.body.id);
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: first.linkId } })).status).toBe('revoked');
    expect([(await view(first.token)).status, (await view(first.token)).body.code]).toEqual([404, 'payment_link_not_found']);
    expect((await view(second)).status).toBe(200);
  });

  it('send_vs_send and send_vs_revoke concurrent: at most one active link, no deadlock', async () => {
    const { bookingId } = await booked();
    const [a, b] = await Promise.all([send(bookingId), send(bookingId)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await t.prisma.paymentLink.count({ where: { bookingId, status: 'active' } })).toBe(1);
    const active = await t.prisma.paymentLink.findFirstOrThrow({ where: { bookingId, status: 'active' } });
    const [s, r] = await Promise.all([send(bookingId), revoke(active.id)]);
    // Whichever runs first (both lock the booking first), the old link ends revoked and the new one is the only active.
    expect([s.status, s.body.status, r.status, r.body.status]).toEqual([201, 'active', 200, 'revoked']);
    const after = await t.prisma.paymentLink.findMany({ where: { bookingId }, select: { id: true, status: true } });
    expect(after.filter((x) => x.status === 'active').map((x) => x.id)).toEqual([s.body.id]);
    expect(after.find((x) => x.id === active.id)!.status).toBe('revoked');
  });

  it('revoke is audited, idempotent, and a revoked link is 404', async () => {
    const l = await linked();
    const r1 = await revoke(l.linkId);
    expect([r1.status, r1.body.status]).toEqual([200, 'revoked']);
    expect((await revoke(l.linkId)).body.status).toBe('revoked');
    expect(await t.prisma.auditLog.count({ where: { entityType: 'PaymentLink', entityId: l.linkId, action: 'payments.paymentLink.revoked' } })).toBe(1);
    expect((await view(l.token)).status).toBe(404);
    expect((await admin.post(`/admin/payments/payment-links/${randomUUID()}/revoke`, {})).status).toBe(404);
  });
});

describe('the token', () => {
  it('token_minted_in_send_step_only: never stored in clear, not in the email row or job, and a failed send retried mints a fresh one', async () => {
    const { bookingId } = await booked();
    const res = await send(bookingId);
    const email = await emailOf(res.body.id);
    const spy = vi.spyOn(t.mail, 'send').mockRejectedValueOnce(new Error('smtp down'));
    await expect(t.app.get(MailService).processSend(email.id)).rejects.toThrow();
    spy.mockRestore();
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: res.body.id } })).tokenHash).toBeNull();
    const token = await deliver(res.body.id);
    const row = await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.tokenHash).toBe(tokenHash(token));
    const stored = JSON.stringify(await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: email.id } }));
    expect(stored).not.toContain(token);
    const jobs = await t.prisma.$queryRawUnsafe<Array<{ data: unknown }>>(`SELECT data FROM pgboss.job WHERE name = 'mail.send'`);
    expect(JSON.stringify(jobs)).not.toContain(token);
    const audit = await t.prisma.auditLog.findMany({ where: { entityId: res.body.id } });
    expect(JSON.stringify(audit)).not.toContain(token);
    // A second send step for the same email does nothing (the row is no longer queued).
    expect(await t.app.get(MailService).processSend(email.id)).toBe('noop');
  });

  it('send_refused_when_booking_not_payable: the send step fails the email and mints nothing', async () => {
    const { bookingId } = await booked();
    const res = await send(bookingId);
    await cancel(bookingId);
    expect(await t.app.get(MailService).processSend((await emailOf(res.body.id)).id)).toBe('failed');
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: res.body.id } })).tokenHash).toBeNull();
  });

  it('revoked_expired_unknown_link_same_404, and a malformed token is 422 without echoing it', async () => {
    const l = await linked();
    const unknown = 'A'.repeat(43);
    const answers = [await view(unknown)];
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE payment_links DISABLE TRIGGER payment_links_guard');
      await owner.query(`UPDATE payment_links SET "expiresAt" = "createdAt" + interval '1 millisecond' WHERE id = $1::uuid`, [l.linkId]);
      await owner.query('ALTER TABLE payment_links ENABLE TRIGGER payment_links_guard');
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    answers.push(await view(l.token), await refresh(l.token), await pay(l.token));
    // A revoked link, and a used one, answer exactly the same.
    const r = await linked();
    await revoke(r.linkId);
    const u = await linked();
    expect((await pay(u.token)).status).toBe(201);
    expect((await succeedLatest(u.bookingId, u.token)).body.used).toBe(true);
    answers.push(await view(r.token), await pay(r.token), await view(u.token), await pay(u.token));
    for (const a of answers) expect([a.status, a.body]).toEqual([404, { code: 'payment_link_not_found', message: 'This payment link is not valid. It may have been used, replaced or expired.' }]);
    const bad = await t.http().post('/payment-links/view').set(STATE_HEADERS).send({ token: 'short-secret-value' });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).not.toContain('short-secret-value');
  });

  it('link_view_exact_keys: the trip, the dates and the amount due now, nothing personal', async () => {
    const l = await linked();
    const res = await view(l.token);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['amountDueMinor', 'currency', 'departureDate', 'editionYear', 'expiresAt', 'liveAttempt', 'methods', 'package', 'payable', 'race', 'reference', 'returnDate', 'termsAccepted']);
    const deposit = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: l.bookingId, sequence: 1 } });
    expect([res.body.amountDueMinor, res.body.payable, res.body.termsAccepted, res.body.liveAttempt, res.body.methods.includes('card')]).toEqual([deposit.amountMinor.toString(), true, true, null, true]);
    const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: c.userId } });
    const all = JSON.stringify(res.body);
    for (const personal of [customer.email, customer.givenName, customer.familyName, customer.id, l.bookingId]) expect(all).not.toContain(personal);
  });

  it('payment_link_rate_limited_429 per token', async () => {
    const l = await linked();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await view(l.token)).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  }, 300_000);
});

describe('paying through a link', () => {
  it('payment_links_respect_rules (task 4.2): the link offers what the rules allow for its amount, and paying follows them', async () => {
    const l = await linked();
    const due = BigInt((await view(l.token)).body.amountDueMinor);
    const card = await t.prisma.routingRule.findFirstOrThrow({ where: { providerAccountId: acc.id, method: 'card' } });
    await t.prisma.routingRule.update({ where: { id: card.id }, data: { maxAmountMinor: due - 1n } });
    try {
      const res = await view(l.token);
      expect(res.status).toBe(200);
      expect(res.body.methods).not.toContain('card');
      const r = await pay(l.token);
      expect([r.status, r.body.code]).toEqual([409, 'no_payment_method_available']);
    } finally {
      await t.prisma.routingRule.update({ where: { id: card.id }, data: { maxAmountMinor: card.maxAmountMinor } });
    }
    expect((await view(l.token)).body.methods).toContain('card');
  });

  it('link_payment_body_with_amount_or_sequence_422: the strict body takes only the token and the method', async () => {
    const l = await linked();
    for (const extra of [{ amountMinor: '1' }, { upToSequence: 2 }, { replaceLiveAttempt: true }, { reference: 'MT-000000' }]) {
      const res = await pay(l.token, extra);
      expect([JSON.stringify(extra), res.status]).toEqual([JSON.stringify(extra), 422]);
    }
    expect(await paymentsOf(l.bookingId)).toHaveLength(0);
    expect((await t.http().post('/payment-links/payments').set(STATE_HEADERS).send({ token: l.token, method: 'card' })).body.code).toBe('idempotency_key_required');
  });

  it('link_payment_requires_prior_terms_acceptance: 409, no attempt and no idempotency record', async () => {
    const l = await linked({ acceptTerms: false });
    expect((await view(l.token)).body.termsAccepted).toBe(false);
    const key = randomUUID();
    const res = await pay(l.token, {}, key);
    expect([res.status, res.body.code]).toEqual([409, 'terms_not_accepted']);
    expect(await paymentsOf(l.bookingId)).toHaveLength(0);
    expect(await t.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
  });

  it('link_cannot_pay_beyond_target and link_used_after_success_404: the deposit only, then the link is spent', async () => {
    const l = await linked();
    const payKey = randomUUID();
    const res = await pay(l.token, {}, payKey);
    expect(res.status).toBe(201);
    const [p] = await paymentsOf(l.bookingId);
    const deposit = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: l.bookingId, sequence: 1 } });
    expect([p!.amountMinor, p!.targetScheduleItemId, p!.paymentLinkId]).toEqual([deposit.amountMinor, deposit.id, l.linkId]);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: p!.id, action: 'payments.payment.created' } });
    expect([audit.actorType, audit.actorId]).toEqual(['payment_link', l.linkId]);
    const done = await succeedLatest(l.bookingId, l.token);
    expect([done.status, done.body.used, done.body.attempt.status]).toEqual([200, true, 'succeeded']);
    const row = await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: l.linkId } });
    expect([row.status, row.usedAt !== null]).toEqual(['used', true]);
    expect((await view(l.token)).status).toBe(404);
    expect((await pay(l.token)).status).toBe(404);
    // Even the key that started the paid attempt gets 404 once the link has served: the link is checked before the
    // idempotency record is read, so a spent link replays nothing.
    const replay = await pay(l.token, {}, payKey);
    expect([replay.status, replay.body.code]).toEqual([404, 'payment_link_not_found']);
    // The balance is still due, and the spent link cannot reach it.
    expect((await c.plan(l.reference)).body.payable).toBe(true);
    expect(await paymentsOf(l.bookingId)).toHaveLength(1);
  });

  it('a link whose target was paid at checkout is 404 (target paid)', async () => {
    const l = await linked();
    expect((await c.pay(l.reference, { method: 'card' })).status).toBe(201);
    const p = (await paymentsOf(l.bookingId)).at(-1)!;
    sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
    await t.http().post(`/booking-requests/${l.reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});
    expect((await view(l.token)).status).toBe(404);
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: l.linkId } })).status).toBe('active');
  });

  it('link_404_after_booking_cancelled, _expired, _approval_lapsed and _fully_paid', async () => {
    const cases: Array<[string, (id: string) => Promise<unknown>]> = [
      ['cancelled', (id) => cancel(id)],
      ['expired', (id) => lapse(id, true)],
      ['approval_lapsed', (id) => lapse(id, false)],
      ['fully_paid', (id) => walkTo(t, id, 'balance_paid', 'approved')],
    ];
    for (const [name, move] of cases) {
      const l = await linked();
      expect([name, (await view(l.token)).status]).toEqual([name, 200]);
      await move(l.bookingId);
      expect([name, (await view(l.token)).status, (await pay(l.token)).status]).toEqual([name, 404, 404]);
    }
  });

  it('link_payment_same_key_same_attempt, and the same key on another link is another record', async () => {
    const l = await linked();
    const key = randomUUID();
    const a = await pay(l.token, {}, key);
    const b = await pay(l.token, {}, key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await paymentsOf(l.bookingId)).toHaveLength(1);
    const m = await linked();
    expect((await pay(m.token, {}, key)).status).toBe(201);
    expect(await paymentsOf(m.bookingId)).toHaveLength(1);
  });

  it('link_return_url_is_pay_return and checkout_return_url_unchanged', async () => {
    const svc = t.app.get(PaymentAttemptsService);
    expect(svc.returnUrlOf({ paymentLinkId: randomUUID(), booking: { reference: 'MT-ABCDEF' } })).toBe(`${t.config.WEB_ORIGIN}/pay/return`);
    expect(svc.returnUrlOf({ paymentLinkId: null, booking: { reference: 'MT-ABCDEF' } })).toBe(`${t.config.WEB_ORIGIN}/payments/return?ref=MT-ABCDEF`);
    const l = await linked();
    const res = await pay(l.token);
    const page = await t.http().get(new URL(res.body.nextAction.url).pathname.replace(/^\/api/, ''));
    expect(page.text).toContain(`${t.config.WEB_ORIGIN}/pay/return`);
    expect(page.text).not.toContain('return?ref=');
  });

  it('checkout_does_not_resume_link_attempt and link_does_not_resume_checkout_attempt (409)', async () => {
    const l = await linked();
    expect((await pay(l.token)).status).toBe(201);
    const fromCheckout = await c.pay(l.reference, { method: 'card' });
    expect([fromCheckout.status, fromCheckout.body.code]).toEqual([409, 'payment_attempt_in_progress']);
    const m = await linked();
    expect((await c.pay(m.reference, { method: 'card' })).status).toBe(201);
    const fromLink = await pay(m.token);
    expect([fromLink.status, fromLink.body.code]).toEqual([409, 'payment_attempt_in_progress']);
    expect((await view(m.token)).body.liveAttempt).toEqual({ status: 'requires_action', method: 'card' });
    expect(await paymentsOf(m.bookingId)).toHaveLength(1);
  });

  it('a regenerated plan (target item superseded) makes the link not found, also in the payment transaction', async () => {
    const l = await linked();
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    try {
      // The plan replaced by one with the same amounts: the link's item is superseded, a new one takes its sequence.
      await owner.query('BEGIN');
      const items = (await owner.query(`SELECT id, "scheduleId", kind, sequence, "amountMinor", "dueDate", currency FROM payment_schedule_items WHERE "bookingId" = $1::uuid ORDER BY sequence`, [l.bookingId])).rows;
      await owner.query(`UPDATE payment_schedule_items SET state = 'superseded', "supersededInVersion" = 2 WHERE "bookingId" = $1::uuid`, [l.bookingId]);
      await owner.query(`UPDATE payment_schedules SET version = 2 WHERE "bookingId" = $1::uuid`, [l.bookingId]);
      for (const i of items) {
        await owner.query(`INSERT INTO payment_schedule_items (id, "scheduleId", "bookingId", currency, kind, sequence, "planVersion", "amountMinor", "dueDate", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 2, $6, $7, now())`,
          [i.scheduleId, l.bookingId, i.currency, i.kind, i.sequence, i.amountMinor, i.dueDate]);
      }
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    expect((await view(l.token)).status).toBe(404);
    // The transaction's own check, reached directly (the route stops earlier).
    const svc = t.app.get(PaymentAttemptsService);
    await expect(svc.createOrResume(l.bookingId, { method: 'card', upToSequence: 1 }, { type: 'payment_link', id: l.linkId }, undefined, l.linkId)).rejects.toMatchObject({ code: 'payment_link_not_found' });
    expect(await paymentsOf(l.bookingId)).toHaveLength(0);
  });

  it('link_vs_checkout_concurrent_one_live_attempt', async () => {
    const l = await linked();
    const [a, b] = await Promise.all([pay(l.token), c.pay(l.reference, { method: 'card' })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const live = (await paymentsOf(l.bookingId)).filter((p) => p.liveBookingId !== null);
    expect(live).toHaveLength(1);
  });

  it('revoke_with_attempt_in_flight_records_money_keeps_revoked', async () => {
    const l = await linked();
    expect((await pay(l.token)).status).toBe(201);
    expect((await revoke(l.linkId)).status).toBe(200);
    const p = (await paymentsOf(l.bookingId)).at(-1)!;
    sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
    // The owner's refresh records the money; the revoked link stays revoked and cannot be used to look.
    const r = await t.http().post(`/booking-requests/${l.reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});
    expect(r.body.attempt.status).toBe('succeeded');
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: l.linkId } })).status).toBe('revoked');
    expect((await refresh(l.token)).status).toBe(404);
  });
});

describe('the email wording (review round 1, point 1)', () => {
  const tpl = async (subject: string, body: string) => {
    await t.prisma.messageTemplate.updateMany({ where: { channel: 'email', key: 'payments.payment_link', status: 'active' }, data: { status: 'archived' } });
    const last = await t.prisma.messageTemplate.aggregate({ where: { channel: 'email', key: 'payments.payment_link', locale: 'en-AU' }, _max: { revision: true } });
    // Written straight to the table, as if an older check had let it through: the send step is the last guard.
    return t.prisma.messageTemplate.create({ data: { channel: 'email', key: 'payments.payment_link', locale: 'en-AU', revision: (last._max.revision ?? 0) + 1, status: 'active', subject, body } });
  };
  const retire = (id: string) => t.prisma.messageTemplate.update({ where: { id }, data: { status: 'archived' } });
  const templatesStaff = () => staffClient(t, ['templates.template.read', 'templates.template.manage', 'templates.template.publish']);

  it('the panel refuses {{link}} in the subject and a body without {{link}}', async () => {
    const staff = await templatesStaff();
    const inSubject = await staff.post('/admin/templates/email', { key: 'payments.payment_link', subject: 'Pay {{reference}} {{link}}', body: 'Pay here: {{link}}' });
    expect([inSubject.status, inSubject.body.code]).toEqual([422, 'template_wording_invalid']);
    const noLink = await staff.post('/admin/templates/email', { key: 'payments.payment_link', subject: 'Pay {{reference}}', body: 'Sign in to pay.' });
    expect([noLink.status, noLink.body.code]).toEqual([422, 'template_wording_invalid']);
    const preview = await staff.post('/admin/templates/email/preview', { key: 'payments.payment_link', subject: 'Pay {{link}}', body: 'Nothing' });
    expect(preview.body.problems).toEqual([{ field: 'subject', kind: 'body_only_variable', name: 'link' }, { field: 'body', kind: 'missing_variable', name: 'link' }]);
  });

  it('an active revision with {{link}} in the subject: the send fails, no token is minted and the subject keeps no token', async () => {
    const row = await tpl('Pay {{reference}} {{link}}', 'Pay here: {{link}}');
    try {
      const { bookingId } = await booked();
      const res = await send(bookingId);
      const email = await emailOf(res.body.id);
      const before = t.mail.sent.length;
      expect(await t.app.get(MailService).processSend(email.id)).toBe('failed');
      expect(t.mail.sent.length).toBe(before);
      expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: res.body.id } })).tokenHash).toBeNull();
      const stored = await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: email.id } });
      expect(JSON.stringify(stored)).not.toMatch(/token=/);
    } finally {
      await retire(row.id);
    }
  });

  it('an active revision without {{link}} in the body: the send fails and no token is minted', async () => {
    const row = await tpl('Pay {{reference}}', 'Sign in to pay {{reference}}.');
    try {
      const { bookingId } = await booked();
      const res = await send(bookingId);
      expect(await t.app.get(MailService).processSend((await emailOf(res.body.id)).id)).toBe('failed');
      expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: res.body.id } })).tokenHash).toBeNull();
    } finally {
      await retire(row.id);
    }
  });

  it('a valid active revision is used, with the link in the body only', async () => {
    const row = await tpl('Pay for {{reference}}', 'Hello {{givenName}}, pay here: {{link}} before {{expiresAt}}.');
    try {
      const { bookingId, reference } = await booked();
      const res = await send(bookingId);
      const before = t.mail.sent.length;
      await t.app.get(MailService).processSend((await emailOf(res.body.id)).id);
      const m = t.mail.sent.slice(before)[0]!;
      expect(m.subject).toBe(`Pay for ${reference}`);
      expect(m.text).toMatch(TOKEN_IN_MAIL);
    } finally {
      await retire(row.id);
    }
  });
});

describe('the table and erasure', () => {
  it('payment_links_update_trigger: every forbidden change is rejected for the API role', async () => {
    const l = await linked();
    const other = await booked();
    const forbidden = [
      `UPDATE payment_links SET "bookingId" = '${other.bookingId}' WHERE id = $1::uuid`,
      `UPDATE payment_links SET "expiresAt" = "expiresAt" + interval '1 day' WHERE id = $1::uuid`,
      `UPDATE payment_links SET "createdById" = gen_random_uuid() WHERE id = $1::uuid`,
      `UPDATE payment_links SET "tokenHash" = repeat('a', 64) WHERE id = $1::uuid`,
      `UPDATE payment_links SET "tokenHash" = NULL WHERE id = $1::uuid`,
      `DELETE FROM payment_links WHERE id = $1::uuid`,
    ];
    for (const q of forbidden) await expect(sql(q, l.linkId), q).rejects.toThrow();
    await sql(`UPDATE payment_links SET status = 'revoked', "revokedAt" = clock_timestamp() WHERE id = $1::uuid`, l.linkId);
    await expect(sql(`UPDATE payment_links SET status = 'active', "revokedAt" = NULL WHERE id = $1::uuid`, l.linkId)).rejects.toThrow();
    await expect(sql(`UPDATE payment_links SET status = 'used', "usedAt" = clock_timestamp(), "revokedAt" = NULL WHERE id = $1::uuid`, l.linkId)).rejects.toThrow();
    await sql(`UPDATE payment_links SET "tokenHash" = NULL WHERE id = $1::uuid`, l.linkId);
    // A payment's link never changes either, and a link of another booking cannot be named.
    const p = await t.prisma.payment.findFirst({ where: { bookingId: other.bookingId } });
    expect(p).toBeNull();
    await expect(sql(`INSERT INTO payment_links (id, "bookingId", "targetScheduleItemId", "expiresAt", "createdById", "tokenHash") SELECT gen_random_uuid(), $1::uuid, id, now() + interval '1 day', gen_random_uuid(), repeat('b', 64) FROM payment_schedule_items WHERE "bookingId" = $1::uuid LIMIT 1`, other.bookingId)).rejects.toThrow();
  });

  it('a payment cannot name the link of another booking, and its link is fixed', async () => {
    const l = await linked();
    expect((await pay(l.token)).status).toBe(201);
    const [p] = await paymentsOf(l.bookingId);
    const other = await linked();
    await expect(sql(`UPDATE payments SET "paymentLinkId" = $2::uuid WHERE id = $1::uuid`, p!.id, other.linkId)).rejects.toThrow();
    await expect(sql(`UPDATE payments SET "paymentLinkId" = NULL WHERE id = $1::uuid`, p!.id)).rejects.toThrow();
  });

  it('erasure_handler_revokes_links: active links are revoked, every hash is dropped, and the export lists them', async () => {
    const l = await linked();
    const def = t.app.get(EntityRegistry).get('PaymentLink')!;
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: l.bookingId }, select: { customerId: true } });
    const exported = await runTransaction(t.prisma, (tx) => def.handlers!.export(tx, b.customerId)) as Array<Record<string, unknown>>;
    expect(exported.find((x) => x.bookingId === l.bookingId)).toMatchObject({ status: 'active' });
    expect(JSON.stringify(exported)).not.toMatch(/tokenHash/);
    await runTransaction(t.prisma, (tx) => def.handlers!.anonymise(tx, b.customerId));
    const rows = await t.prisma.paymentLink.findMany({ where: { booking: { customerId: b.customerId } } });
    expect(rows.every((r) => r.status !== 'active' && r.tokenHash === null)).toBe(true);
    expect((await view(l.token)).status).toBe(404);
  });
});

describe('limits', () => {
  it('payment_link_rate_limited_429 per IP: unknown tokens from one address are cut off too', async () => {
    const own = await makeApp();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 301; i++) statuses.push((await own.http().post('/payment-links/view').set(STATE_HEADERS).send({ token: randomUUID().replace(/-/g, '').padEnd(43, 'x') })).status);
      expect(statuses.slice(0, 300).every((x) => x === 404)).toBe(true);
      expect(statuses[300]).toBe(429);
    } finally {
      await own.close();
    }
  }, 300_000);
});

describe('payment starts through a link (review round 2)', () => {
  it('payment_link_starts_rate_limited_like_customer_starts: past the hourly start limit per token it is 429', async () => {
    const own = await makeApp({ PAYMENT_ATTEMPTS_PER_HOUR_PER_USER: '3' });
    try {
      const staff = await paymentsStaff(own);
      const b = await approvedBooking(own, staff, await pricedWorld(staff), await payingCustomer(own));
      const res = await staff.post(`/admin/payments/bookings/${b.bookingId}/payment-links`, {});
      const before = own.mail.sent.length;
      await own.app.get(MailService).processSend((await own.prisma.outboundEmail.findUniqueOrThrow({ where: { dedupeKey: `payment-link:${res.body.id}` } })).id);
      const token = TOKEN_IN_MAIL.exec(own.mail.sent.slice(before).map((m) => m.text).join('\n'))![1]!;
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await own.http().post('/payment-links/payments').set(STATE_HEADERS).set('Idempotency-Key', randomUUID()).send({ token, method: 'card' })).status);
      expect(statuses).toEqual([201, 201, 201, 429]);
      // Viewing is not a start: it still works.
      expect((await own.http().post('/payment-links/view').set(STATE_HEADERS).send({ token })).status).toBe(200);
    } finally {
      await own.close();
    }
  });
});

describe('logs', () => {
  it('link_token_never_logged_or_echoed: logs, audit and every 4xx body of /payment-links/*', async () => {
    const loud = await makeApp({}, { allLogs: true });
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), out(chunk as never, ...(rest as [])))) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), err(chunk as never, ...(rest as [])))) as typeof process.stderr.write;
    try {
      const b = await approvedBooking(loud, await paymentsStaff(loud), await pricedWorld(await paymentsStaff(loud)), await payingCustomer(loud));
      const staff = await paymentsStaff(loud);
      const res = await staff.post(`/admin/payments/bookings/${b.bookingId}/payment-links`, {});
      const before = loud.mail.sent.length;
      await loud.app.get(MailService).processSend((await loud.prisma.outboundEmail.findUniqueOrThrow({ where: { dedupeKey: `payment-link:${res.body.id}` } })).id);
      const token = TOKEN_IN_MAIL.exec(loud.mail.sent.slice(before).map((m) => m.text).join('\n'))![1]!;
      const bodies: string[] = [];
      const post = (path: string, body: object, key?: string) => {
        let r = loud.http().post(path).set(STATE_HEADERS);
        if (key) r = r.set('Idempotency-Key', key);
        return r.send(body);
      };
      for (const r of [
        await post('/payment-links/view', { token }), await post('/payment-links/view', { token, extra: 1 }), await post('/payment-links/refresh', { token, more: true }),
        await post('/payment-links/payments', { token, method: 'card', amountMinor: '5' }, randomUUID()), await post('/payment-links/payments', { token, method: 'card' }),
        await post('/payment-links/payments', { token, method: 'nonsense' }, randomUUID()), await loud.http().post('/payment-links/view').send({ token }),
      ]) bodies.push(JSON.stringify(r.body));
      const audit = JSON.stringify(await loud.prisma.auditLog.findMany({ where: { entityType: 'PaymentLink' } }));
      for (const where of [written.join(''), bodies.join('\n'), audit]) expect(where).not.toContain(token);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      await loud.close();
    }
  }, 300_000);
});
