// Checkout: the booking terms with version and date, and the customer's "where is my payment" (task 3.5; plan
// docs/plans/3.5-checkout-simulator.md, sections 2, 3 and 5). Simulator only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingCoverage } from '../../../src/modules/bookings/coverage';
import { ProviderGateway } from '../../../src/modules/payments/core/gateway';
import { ProviderError } from '../../../src/modules/payments/core/provider';
import { conflict } from '../../../src/platform/http/api-error';
import { AppError } from '../../../src/platform/errors/safe-error';
import { termsDigest } from '../../../src/modules/payments/core/terms.service';
import { STATE_HEADERS } from '../../support/auth';
import { TestApp, makeApp } from '../../support/auth';
import { cleanBookingEvents, customerClient, requestBody } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
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
  await closeCatalogue(t);
});

const unaccepted = async () => approvedBooking(t, admin, await pricedWorld(admin), c, { acceptTerms: false });
const termsOf = (ref: string, who: { cookie: string } = c) => t.http().get(`/booking-requests/${ref}/checkout-terms`).set('Cookie', who.cookie);
const accept = (ref: string, body: object, who: { cookie: string } = c) => t.http().post(`/booking-requests/${ref}/terms-acceptance`).set(STATE_HEADERS).set('Cookie', who.cookie).send(body);
const acceptCurrent = async (ref: string) => {
  const v = (await termsOf(ref)).body;
  return accept(ref, { version: v.version, digest: v.digest });
};
const refresh = (ref: string, who: { cookie: string } = c) => t.http().post(`/booking-requests/${ref}/payments/refresh`).set(STATE_HEADERS).set('Cookie', who.cookie).send({});
const rowsOf = (bookingId: string) => t.prisma.termsAcceptance.findMany({ where: { bookingId } });
const paymentsOf = (bookingId: string) => t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } });
const pageStatus = (status: 'published' | 'draft') => t.prisma.contentPage.update({ where: { locale_slug: { locale: 'en-AU', slug: 'terms' } }, data: { status, publishedAt: status === 'published' ? new Date() : null } });

describe('booking terms with version and date', () => {
  it('terms_view_gives_the_published_text_its_version_and_digest', async () => {
    const page = await ensureTerms(t, { title: 'Terms of booking', intro: 'Read these before you pay.', body: 'One.\n\nTwo.' });
    const { reference } = await unaccepted();
    const res = await termsOf(reference);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      slug: 'terms', version: page.version, title: 'Terms of booking', intro: 'Read these before you pay.', body: 'One.\n\nTwo.', acceptedAt: null,
      // Task 6.4: the booking's cancellation policy is shown with the terms (none for this package).
      cancellationPolicy: null,
      digest: termsDigest({ slug: 'terms', locale: 'en-AU', title: 'Terms of booking', intro: 'Read these before you pay.', body: 'One.\n\nTwo.' }),
    });
  });

  it('terms_unavailable_without_a_published_page: nothing can be accepted or paid', async () => {
    const { reference, bookingId } = await unaccepted();
    await pageStatus('draft');
    try {
      expect([(await termsOf(reference)).status, (await termsOf(reference)).body.code]).toEqual([409, 'terms_unavailable']);
      expect((await accept(reference, { version: 1, digest: 'a'.repeat(64) })).body.code).toBe('terms_unavailable');
      const res = await c.pay(reference, { method: 'card' });
      expect([res.status, res.body.code]).toEqual([409, 'terms_unavailable']);
      expect(await paymentsOf(bookingId)).toHaveLength(0);
    } finally {
      await pageStatus('published');
    }
  });

  it('accepting_stores_the_snapshot_with_version_and_date, and the view then says when', async () => {
    const page = await ensureTerms(t, { title: 'Terms v-snapshot', intro: 'Intro.', body: 'The words that were accepted.' });
    const { reference, bookingId } = await unaccepted();
    const before = Date.now();
    const res = await acceptCurrent(reference);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(page.version);
    const [row] = await rowsOf(bookingId);
    await expect(rowsOf(bookingId)).resolves.toHaveLength(1);
    const owner = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { customerId: true } });
    expect(row).toMatchObject({ customerId: owner.customerId, documentSlug: 'terms', locale: 'en-AU', contentVersion: page.version, title: 'Terms v-snapshot', intro: 'Intro.', body: 'The words that were accepted.' });
    expect(row!.textDigest).toBe(termsDigest({ slug: 'terms', locale: 'en-AU', title: 'Terms v-snapshot', intro: 'Intro.', body: 'The words that were accepted.' }));
    expect(row!.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 2_000);
    expect(res.body.acceptedAt).toBe(row!.acceptedAt.toISOString());
    expect((await termsOf(reference)).body.acceptedAt).toBe(row!.acceptedAt.toISOString());
    // The audit log has it, without the words themselves.
    const audit = await t.prisma.auditLog.findFirst({ where: { action: 'payments.termsAcceptance.created', entityId: row!.id } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain('The words that were accepted.');
  });

  it('accepting_twice_keeps_the_first_row_and_date; two at once make one row', async () => {
    const { reference, bookingId } = await unaccepted();
    const v = (await termsOf(reference)).body;
    const first = await accept(reference, { version: v.version, digest: v.digest });
    const again = await accept(reference, { version: v.version, digest: v.digest });
    expect([first.status, again.status, again.body.acceptedAt]).toEqual([200, 200, first.body.acceptedAt]);
    expect(await rowsOf(bookingId)).toHaveLength(1);
    const other = await unaccepted();
    const results = await Promise.all(Array.from({ length: 6 }, () => accept(other.reference, { version: v.version, digest: v.digest })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.acceptedAt)).size).toBe(1);
    expect(await rowsOf(other.bookingId)).toHaveLength(1);
  });

  it('accept_refuses_a_stale_or_made_up_version_or_digest (409 terms_changed) and a malformed body (422)', async () => {
    const { reference, bookingId } = await unaccepted();
    const v = (await termsOf(reference)).body;
    for (const body of [{ version: v.version + 1, digest: v.digest }, { version: v.version, digest: 'b'.repeat(64) }, { version: v.version - 1, digest: 'b'.repeat(64) }]) {
      const res = await accept(reference, body);
      expect([res.status, res.body.code]).toEqual([409, 'terms_changed']);
    }
    for (const body of [{}, { version: v.version }, { digest: v.digest }, { version: v.version, digest: 'XYZ' }, { version: '1', digest: v.digest }, { version: v.version, digest: v.digest, acceptedAt: '2020-01-01' }, { version: v.version, digest: v.digest, title: 'My own terms' }]) {
      expect((await accept(reference, body)).status).toBe(422);
    }
    expect(await rowsOf(bookingId)).toHaveLength(0);
  });

  it('terms_changed_while_the_page_was_open: edited in place, the old digest is refused', async () => {
    const { reference, bookingId } = await unaccepted();
    const seen = (await termsOf(reference)).body;
    await ensureTerms(t, { body: `Edited at ${randomUUID()}.` });
    const res = await accept(reference, { version: seen.version, digest: seen.digest });
    expect([res.status, res.body.code]).toEqual([409, 'terms_changed']);
    expect(await rowsOf(bookingId)).toHaveLength(0);
    expect((await acceptCurrent(reference)).status).toBe(200);
  });

  it('paying_without_acceptance_is_409_and_stores_nothing', async () => {
    const { reference, bookingId } = await unaccepted();
    const key = randomUUID();
    const res = await c.pay(reference, { method: 'card' }, key);
    expect([res.status, res.body.code]).toEqual([409, 'terms_not_accepted']);
    expect(await paymentsOf(bookingId)).toHaveLength(0);
    expect(await t.prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
    // After accepting, the same key works.
    expect((await acceptCurrent(reference)).status).toBe(200);
    const ok = await c.pay(reference, { method: 'card' }, key);
    expect([ok.status, ok.body.status]).toEqual([201, 'requires_action']);
    expect(await paymentsOf(bookingId)).toHaveLength(1);
  });

  it('same_key_retry_replays_the_created_payment_even_if_the_terms_changed_or_were_unpublished', async () => {
    const { reference, bookingId } = await unaccepted();
    await acceptCurrent(reference);
    const key = randomUUID();
    const first = await c.pay(reference, { method: 'card' }, key);
    expect(first.status).toBe(201);
    await ensureTerms(t, { body: `Changed after paying ${randomUUID()}.` });
    const edited = await c.pay(reference, { method: 'card' }, key);
    expect([edited.status, edited.body.status, edited.body.nextAction?.url]).toEqual([201, 'requires_action', first.body.nextAction.url]);
    await pageStatus('draft');
    try {
      const unpublished = await c.pay(reference, { method: 'card' }, key);
      expect([unpublished.status, unpublished.body.nextAction?.url]).toEqual([201, first.body.nextAction.url]);
      // A different key is a new request and is refused.
      expect((await c.pay(reference, { method: 'card' })).body.code).toBe('terms_unavailable');
    } finally {
      await pageStatus('published');
    }
    expect(await paymentsOf(bookingId)).toHaveLength(1);
  });

  it('editing_the_terms_after_acceptance_asks_again_before_the_next_payment', async () => {
    const { reference, bookingId } = await unaccepted();
    await acceptCurrent(reference);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    await ensureTerms(t, { body: `A new clause ${randomUUID()}.` });
    expect((await termsOf(reference)).body.acceptedAt).toBeNull();
    // The attempt in progress can still be resumed only with the new acceptance too: nothing starts without it.
    const refused = await c.pay(reference, { method: 'card' });
    expect([refused.status, refused.body.code]).toEqual([409, 'terms_not_accepted']);
    expect((await acceptCurrent(reference)).status).toBe(200);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    expect(await rowsOf(bookingId)).toHaveLength(2);
  });

  it('a_booking_that_takes_no_payment_cannot_accept: a request (409 booking_not_payable)', async () => {
    const w = await pricedWorld(admin);
    const res = await c.request(requestBody(w));
    expect(res.status).toBe(201);
    const v = (await termsOf(res.body.reference)).body;
    const refused = await accept(res.body.reference, { version: v.version, digest: v.digest });
    expect([refused.status, refused.body.code]).toEqual([409, 'booking_not_payable']);
  });

  it('another_customer_and_a_signed_out_visitor_cannot_read_or_accept (404 and 401)', async () => {
    const { reference, bookingId } = await unaccepted();
    const other = await customerClient(t);
    const v = (await termsOf(reference)).body;
    expect((await termsOf(reference, other)).status).toBe(404);
    expect((await accept(reference, { version: v.version, digest: v.digest }, other)).status).toBe(404);
    expect((await refresh(reference, other)).status).toBe(404);
    expect((await t.http().get(`/booking-requests/${reference}/checkout-terms`)).status).toBe(401);
    expect((await t.http().post(`/booking-requests/${reference}/terms-acceptance`).set(STATE_HEADERS).send({ version: v.version, digest: v.digest })).status).toBe(401);
    expect(await rowsOf(bookingId)).toHaveLength(0);
  });

  it('with_every_gateway_off_the_plan_says_so_and_terms_still_work: a request without a charge, no error', async () => {
    const { reference } = await unaccepted();
    await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'paused' } });
    try {
      const plan = await c.plan(reference);
      expect([plan.status, plan.body.payable, plan.body.notPayableReason, plan.body.methods]).toEqual([200, false, 'no_payment_method_available', []]);
      expect((await acceptCurrent(reference)).status).toBe(200);
      const res = await c.pay(reference, { method: 'card' });
      expect([res.status, res.body.code]).toEqual([409, 'no_payment_method_available']);
    } finally {
      await t.prisma.providerAccount.update({ where: { id: acc.id }, data: { status: 'active' } });
    }
  });

  it('accepted_terms_cannot_be_changed_or_removed, by the API role or the owner', async () => {
    const { reference, bookingId } = await unaccepted();
    await acceptCurrent(reference);
    const [row] = await rowsOf(bookingId);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE terms_acceptances SET body = 'x' WHERE id = $1::uuid`, row!.id)).rejects.toThrow(/append-only/);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM terms_acceptances WHERE id = $1::uuid`, row!.id)).rejects.toThrow(/append-only/);
    await expect(t.prisma.$executeRawUnsafe(`TRUNCATE terms_acceptances`)).rejects.toThrow();
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    try {
      await expect(owner.query(`UPDATE terms_acceptances SET "acceptedAt" = now() WHERE id = $1::uuid`, [row!.id])).rejects.toThrow(/append-only/);
      await expect(owner.query(`DELETE FROM terms_acceptances WHERE id = $1::uuid`, [row!.id])).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
    expect(await rowsOf(bookingId)).toHaveLength(1);
  });
});

describe('where does my payment stand (POST payments/refresh)', () => {
  it('refresh_with_no_attempt_creates_nothing', async () => {
    const { reference, bookingId } = await unaccepted();
    const res = await refresh(reference);
    expect([res.status, res.body]).toEqual([200, { bookingStatus: 'approved', attempt: null }]);
    expect(await paymentsOf(bookingId)).toHaveLength(0);
  });

  it('refresh_after_the_hosted_page_paid_but_the_webhook_is_unprocessed: the booking moves, once', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const [p] = await paymentsOf(bookingId);
    const waiting = await refresh(reference);
    expect([waiting.body.bookingStatus, waiting.body.attempt.status]).toEqual(['approved', 'requires_action']);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    const paid = await refresh(reference);
    expect(paid.status).toBe(200);
    expect(paid.body.attempt).toMatchObject({ status: 'succeeded', method: 'card', amountMinor: p!.amountMinor.toString(), currency: p!.currency });
    expect(paid.body.bookingStatus).toMatch(/^(deposit_paid|confirmed|balance_paid)$/);
    const again = await refresh(reference);
    expect(again.body).toEqual(paid.body);
    expect((await paymentsOf(bookingId)).map((x) => x.status)).toEqual(['succeeded']);
  });

  it('refresh_after_a_decline: the attempt is failed and the booking is still payable', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'failed');
    const res = await refresh(reference);
    expect([res.body.bookingStatus, res.body.attempt.status]).toEqual(['approved', 'failed']);
    expect((await c.plan(reference)).body.payable).toBe(true);
  });

  it('refresh_when_the_gateway_cannot_be_read is the neutral 503 and changes nothing', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    await c.pay(reference, { method: 'card' });
    const spy = vi.spyOn(t.app.get(ProviderGateway), 'call').mockRejectedValue(new ProviderError('provider_unavailable', true));
    try {
      const res = await refresh(reference);
      expect([res.status, res.body.code]).toEqual([503, 'provider_unavailable']);
    } finally {
      spy.mockRestore();
    }
    expect((await paymentsOf(bookingId))[0]!.status).toBe('requires_action');
  });

  it('refresh_when_the_gateway_wrapper_refuses (a 409 of its own) is the neutral 409, never the internal reason', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    await c.pay(reference, { method: 'card' });
    const spy = vi.spyOn(t.app.get(ProviderGateway), 'call').mockRejectedValue(conflict('provider_account_blocked', 'internal reason: adapter blocked'));
    try {
      const res = await refresh(reference);
      expect([res.status, res.body.code]).toEqual([409, 'payment_attempt_in_progress']);
      expect(JSON.stringify(res.body)).not.toContain('blocked');
    } finally {
      spy.mockRestore();
    }
    expect((await paymentsOf(bookingId))[0]!.status).toBe('requires_action');
  });

  it('refresh_when_coverage_fails is 503 payment_processing_delayed, and while the task is open it is not retried', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    await c.pay(reference, { method: 'card' });
    const [p] = await paymentsOf(bookingId);
    sim.settle(acc.id, p!.providerPaymentRef!, 'succeeded');
    const cover = vi.spyOn(t.app.get(BookingCoverage), 'apply').mockRejectedValue(new AppError('boom', 'injected'));
    try {
      const first = await refresh(reference);
      expect([first.status, first.body.code]).toEqual([503, 'payment_processing_delayed']);
      expect((await paymentsOf(bookingId))[0]!.status).toBe('requires_action');
      expect(await t.prisma.task.count({ where: { sourceRef: `payments:coverage_failed:${p!.id}`, status: 'open' } })).toBe(1);
      const calls = cover.mock.calls.length;
      const again = await refresh(reference);
      expect([again.status, again.body.attempt.status]).toEqual([200, 'requires_action']);
      expect(cover.mock.calls.length).toBe(calls);
    } finally {
      cover.mockRestore();
    }
  });

  it('refresh_takes_no_body_that_matters: an amount in the body is ignored, not used', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    await c.pay(reference, { method: 'card' });
    const res = await t.http().post(`/booking-requests/${reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({ amountMinor: '1', status: 'succeeded' });
    expect(res.status).toBe(200);
    expect((await paymentsOf(bookingId))[0]!.status).toBe('requires_action');
  });
});
