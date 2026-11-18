// Erasure against money, the waiting list and mail (task 5.5, plan docs/plans/5.5-privacy-export-erase.md, sections 2.2,
// 5 and 10.5): live payments and money that may be owed refuse an erasure; payment starts, waiting list promotions and
// mail sends that run at the same moment are forced to interleave with barriers.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErasureService } from '../../../src/modules/privacy';
import { PaymentRouting } from '../../../src/modules/payments/core/routing';
import { WaitlistService } from '../../../src/modules/waitlist/waitlist.service';
import { MailService } from '../../../src/platform/mail/mail.service';
import { isRetryableTransactionError } from '../../../src/platform/database/transaction';
import { MailTemplateRegistry } from '../../../src/platform/mail/templates';
import { TestApp, makeApp } from '../../support/auth';
import { bookingStaff, cleanBookingEvents, customerClient } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import { PayingCustomer, SimAccount, approvedBooking, cleanPayments, deliver, ensureTerms, eventFor, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount } from '../../support/payments';
import { STATE_HEADERS } from '../../support/auth';
import { cancelHolder, joinList, soldOutWorld } from '../../support/waitlist';
import { privacyStaff } from '../../support/privacy';
import type { StaffHttp } from '../../support/privacy';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let owner: StaffHttp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let acc: SimAccount;
let w: PricedWorld;
beforeAll(async () => {
  t = await makeApp();
  owner = await privacyStaff(t, { owner: true });
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  await ensureTerms(t);
  w = await pricedWorld(admin);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const erase = (id: string) => owner.post(`/admin/privacy/customers/${id}/erasure`).then((r) => r);
const customerOf = async (bookingId: string) => (await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).customerId;
const reason = (id: string) => t.app.get(ErasureService).blockedBy(t.prisma, id);

function barrier() {
  let inside!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (inside = r));
  const gate = new Promise<void>((r) => (release = r));
  return { entered, gate, inside, release };
}

/** Sets a booking's status as the tables' owner, with the bookings triggers off for that one transaction. */
async function forceStatus(bookingId: string, status: 'declined' | 'cancelled' | 'expired'): Promise<void> {
  const { default: pg } = await import('pg');
  const ownerDb = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await ownerDb.connect();
  try {
    await ownerDb.query('BEGIN');
    await ownerDb.query('ALTER TABLE bookings DISABLE TRIGGER USER');
    await ownerDb.query(`UPDATE bookings SET status = $2::"BookingStatus", "declinedAt" = CASE WHEN $2 = 'declined' THEN clock_timestamp() END,
      "cancelledAt" = CASE WHEN $2 = 'cancelled' THEN clock_timestamp() END, "expiredAt" = CASE WHEN $2 = 'expired' THEN clock_timestamp() END WHERE id = $1::uuid`, [bookingId, status]);
    await ownerDb.query('ALTER TABLE bookings ENABLE TRIGGER USER');
    await ownerDb.query('COMMIT');
  } catch (err) {
    await ownerDb.query('ROLLBACK');
    throw err;
  } finally {
    await ownerDb.end();
  }
}

/** A deposit paid through checkout and the simulator, recorded by the refresh. */
async function payDeposit(c: PayingCustomer, ref: string, bookingId: string): Promise<void> {
  expect((await c.pay(ref, { method: 'card' })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } })).at(-1)!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await t.http().post(`/booking-requests/${ref}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({})).status).toBe(200);
}

describe('money that is moving or may be owed', () => {
  it('live_payment, then refund_may_be_due once the booking is cancelled with a deposit paid', async () => {
    const c = await payingCustomer(t);
    const b = await approvedBooking(t, admin, w, c);
    expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
    const customerId = await customerOf(b.bookingId);
    expect(await reason(customerId)).toBe('open_booking');
    // The API refuses to close a booking under a live attempt or with money paid (cancellation with money is parked), so
    // the shared rule's last two branches are reached by forcing the status as the tables' owner.
    await forceStatus(b.bookingId, 'declined');
    expect(await t.prisma.payment.count({ where: { bookingId: b.bookingId, status: { in: ['created', 'pending', 'requires_action'] } } })).toBe(1);
    expect(await reason(customerId)).toBe('live_payment');
    expect((await erase(customerId)).status).toBe(409);

    const c2 = await payingCustomer(t);
    const b2 = await approvedBooking(t, admin, w, c2);
    await payDeposit(c2, b2.reference, b2.bookingId);
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: b2.bookingId } })).status).not.toBe('approved');
    await forceStatus(b2.bookingId, 'cancelled');
    const c2Id = await customerOf(b2.bookingId);
    expect(await reason(c2Id)).toBe('refund_may_be_due');
    const r = await erase(c2Id);
    expect(r.status).toBe(409);
    expect(await t.prisma.customer.findUniqueOrThrow({ where: { id: c2Id } })).toMatchObject({ anonymisedAt: null });

    // Review m5: declined and expired bookings with money collected count too, and so does money the customer paid as
    // payer on someone else's closed booking.
    for (const status of ['declined', 'expired'] as const) {
      const c3 = await payingCustomer(t);
      const b3 = await approvedBooking(t, admin, w, c3);
      await payDeposit(c3, b3.reference, b3.bookingId);
      await forceStatus(b3.bookingId, status);
      expect(await reason(await customerOf(b3.bookingId)), status).toBe('refund_may_be_due');
    }
    const c4 = await payingCustomer(t);
    const b4 = await approvedBooking(t, admin, w, c4);
    await payDeposit(c4, b4.reference, b4.bookingId);
    await forceStatus(b4.bookingId, 'cancelled');
    const payer = (await t.prisma.customer.create({ data: { email: `payer-${Date.now()}@example.test`, givenName: 'Payer', familyName: 'Other', countryOfResidence: 'AU', source: 'panel' } })).id;
    const { default: pg } = await import('pg');
    const ownerDb = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await ownerDb.connect();
    try {
      await ownerDb.query('BEGIN');
      await ownerDb.query('ALTER TABLE payments DISABLE TRIGGER USER');
      await ownerDb.query(`UPDATE payments SET "payerCustomerId" = $2::uuid WHERE "bookingId" = $1::uuid AND status = 'succeeded'`, [b4.bookingId, payer]);
      await ownerDb.query('ALTER TABLE payments ENABLE TRIGGER USER');
      await ownerDb.query('COMMIT');
    } finally {
      await ownerDb.end();
    }
    expect(await reason(payer)).toBe('refund_may_be_due');
  });

  it('(b) a payment start holding the booking makes the erasure wait, and then refuse it: nothing changes', async () => {
    const c = await payingCustomer(t);
    const b = await approvedBooking(t, admin, w, c);
    const customerId = await customerOf(b.bookingId);
    const bar = barrier();
    const original = PaymentRouting.prototype.candidates;
    const spy = vi.spyOn(PaymentRouting.prototype, 'candidates').mockImplementation(async function (this: PaymentRouting, ...a: Parameters<typeof original>) {
      bar.inside();
      await bar.gate;
      return original.apply(this, a);
    });
    try {
      const paying = c.pay(b.reference, { method: 'card' }).then((r) => r);
      await bar.entered; // the payment start holds the booking FOR UPDATE
      const erasing = erase(customerId);
      await new Promise((r) => setTimeout(r, 400)); // the erasure waits on the booking
      bar.release();
      const [p, e] = await Promise.all([paying, erasing]);
      expect(p.status).toBe(201);
      expect(e.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
    expect(await t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).toMatchObject({ anonymisedAt: null });
    expect(await t.prisma.payment.count({ where: { bookingId: b.bookingId } })).toBe(1);
  });

  it('a webhook matched after an erasure keeps no raw body (review point 9)', async () => {
    const c = await payingCustomer(t);
    const b = await approvedBooking(t, admin, w, c);
    expect((await c.pay(b.reference, { method: 'card' })).status).toBe(201);
    const p = (await t.prisma.payment.findMany({ where: { bookingId: b.bookingId } })).at(-1)!;
    // The customer is anonymised directly (the executor would refuse while the payment is live): the payments path alone.
    await t.prisma.customer.update({ where: { id: await customerOf(b.bookingId) }, data: { anonymisedAt: new Date() } });
    const ev = await eventFor(t, acc, p.id, { status: 'pending' });
    const out = await deliver(t, acc, ev);
    expect(out.status).toBe(200);
    const stored = await t.prisma.webhookEvent.findUniqueOrThrow({ where: { providerAccountId_providerEventId: { providerAccountId: acc.id, providerEventId: ev.eventId } } });
    expect(stored.paymentId).toBe(p.id);
    expect(stored.rawBody).toBeNull();
  });
});

describe('the waiting list and mail', () => {
  it('(c) erasing a customer while a cancellation is offering them a place: withdrawn, nothing held', async () => {
    const s = await soldOutWorld(t, await bookingStaff(t));
    const a = await customerClient(t);
    const entryId = await joinList(t, a, s.w);
    const customerId = (await t.prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } })).customerId;
    const bar = barrier();
    const original = WaitlistService.prototype.offerIn;
    const spy = vi.spyOn(WaitlistService.prototype, 'offerIn').mockImplementation(async function (this: WaitlistService, ...args: Parameters<typeof original>) {
      bar.inside();
      await bar.gate;
      return original.apply(this, args);
    });
    try {
      const cancel = cancelHolder(t, s);
      await bar.entered;
      const erasing = erase(customerId);
      await new Promise((r) => setTimeout(r, 400));
      bar.release();
      const [, e] = await Promise.all([cancel, erasing]);
      expect(e.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const entry = await t.prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(entry.status).toBe('withdrawn');
    expect(entry.email).toBe(`erased+${customerId}@invalid`);
    expect(await t.prisma.inventoryClaim.count({ where: { waitlistEntryId: entryId, status: 'held' } })).toBe(0);
  });

  it('(d) a send in progress for the customer: the erasure waits (or retries a deadlock) and the row ends redacted; nothing is sent after it', async () => {
    const c = await customerClient(t);
    expect((await c.request((await import('../../support/bookings')).requestBody(w))).status).toBe(201);
    const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: c.userId } });
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'declined', "declinedAt" = clock_timestamp(), version = version + 1 WHERE "customerId" = $1::uuid`, customer.id);
    const mail = t.app.get(MailService);
    const registry = t.app.get(MailTemplateRegistry);
    if (!registry.get('test.privacy_notice', 1)) registry.register({ key: 'test.privacy_notice', version: 1, render: async () => ({ subject: 'Notice', text: 'Hello' }) });
    const m = await t.prisma.$transaction((tx) => mail.enqueue({ to: customer.email, templateKey: 'test.privacy_notice', templateVersion: 1, locale: 'en-AU', dedupeKey: `d:${customer.id}`, customerId: customer.id }, tx));
    const bar = barrier();
    const send = t.mail.send.bind(t.mail);
    const spy = vi.spyOn(t.mail, 'send').mockImplementation(async (msg) => {
      bar.inside();
      await bar.gate;
      return send(msg);
    });
    try {
      // The send may finish first, or lose a deadlock against the erasure (it locks the email, the erasure the booking
      // and then the email): then it throws a retryable error and its job runs again. Any other error fails the test.
      const sending = mail.processSend(m.id).then((r) => r, (err: unknown) => {
        if (!isRetryableTransactionError(err)) throw err;
        return 'retried';
      });
      await bar.entered; // the send step holds the email row
      const erasing = erase(customer.id);
      await new Promise((r) => setTimeout(r, 400));
      bar.release();
      const [, e] = await Promise.all([sending, erasing]);
      expect(e.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const row = await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.to).toBe(`erased+${m.id}@invalid`);
    expect(['sent', 'suppressed']).toContain(row.status);
    const afterwards = t.mail.sent.length;
    await mail.processSend(m.id);
    expect(t.mail.sent.length).toBe(afterwards);
  });
});
