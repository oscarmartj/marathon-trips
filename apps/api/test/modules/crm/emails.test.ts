// Emails that follow a booking's state (plan docs/plans/2.5-booking-crm.md, sections 1 and 2, points 8). Real events, the
// real consumer and the real send step, with a capturing mail sender: nothing leaves the machine.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingExpiryService } from '../../../src/modules/bookings/expiry.service';
import { formatMinor } from '../../../src/modules/crm/emails';
import { EventsService } from '../../../src/platform/events/events.service';
import { MailService } from '../../../src/platform/mail/mail.service';
import { TestApp, makeApp } from '../../support/auth';
import { closeCatalogue } from '../../support/catalogue';
import { cleanBookingEvents, requestBody } from '../../support/bookings';
import { acceptQuote, crmStaff, linkedCustomer, makeQuote, sendQuote } from '../../support/crm';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof crmStaff>>;
let w: PricedWorld;
beforeAll(async () => {
  t = await makeApp();
  admin = await crmStaff(t);
  w = await pricedWorld(admin);
  for (const id of [w.roomPoolId, w.entryPoolId, w.extraPoolId]) {
    const p = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } });
    await admin.patch(`/admin/catalogue/pools/${id}`, { capacity: 500, version: p.version });
  }
});
afterAll(async () => {
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'crm.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'crm.%'`);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

/** Delivers the recorded events to the email consumer, then runs the send step for what it queued; returns what was sent. */
async function deliverAndSend(customerId: string): Promise<Array<{ subject: string; text: string; to: string }>> {
  const events = t.app.get(EventsService);
  await events.dispatchPending(1000);
  const pending = await t.prisma.eventDelivery.findMany({ where: { consumer: 'crm.booking_emails', status: 'pending' }, select: { id: true } });
  for (const d of pending) await events.processDelivery(d.id);
  const queued = await t.prisma.outboundEmail.findMany({ where: { customerId, status: 'queued' }, orderBy: { createdAt: 'asc' } });
  const before = t.mail.sent.length;
  for (const e of queued) await t.app.get(MailService).processSend(e.id);
  return t.mail.sent.slice(before);
}
const emailsOf = (customerId: string) => t.prisma.outboundEmail.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' }, select: { templateKey: true, status: true, dedupeKey: true } });
const bookingOf = (reference: string) => t.prisma.booking.findUniqueOrThrow({ where: { reference } });

describe('state_change_sends_one_email_each', () => {
  it('a request gets an acknowledgement that says it is a request; approving, declining and cancelling each send theirs', async () => {
    const a = await linkedCustomer(t);
    const req = (await a.client.request(requestBody(w))).body;
    const [ack] = await deliverAndSend(a.customerId);
    expect(ack!.to).toBe(a.client.email);
    expect(ack!.subject).toContain(req.reference);
    expect(ack!.text).toContain('This is a booking request, not a confirmed booking');
    expect(ack!.text).toContain(`/trips/requests/${req.reference}`);
    expect(ack!.text).toContain(formatMinor(BigInt(req.totalMinor), 'AUD'));

    const b = await bookingOf(req.reference);
    expect((await admin.post(`/admin/bookings/${b.id}/approve`, { version: b.version })).status).toBe(200);
    const [approved] = await deliverAndSend(a.customerId);
    expect(approved!.subject).toContain('approved');
    expect(approved!.text).toMatch(/not been charged|not charged/i);
    expect(approved!.text).not.toMatch(/booking is confirmed|confirmed booking|pay now|payment link/i);

    const c = await bookingOf(req.reference);
    expect((await admin.post(`/admin/bookings/${c.id}/cancel`, { version: c.version, reason: 'SECRET-REASON-cancel' })).status).toBe(200);
    const [cancelled] = await deliverAndSend(a.customerId);
    expect(cancelled!.subject).toContain('cancelled');
    expect(cancelled!.text).not.toContain('SECRET-REASON');
    expect((await emailsOf(a.customerId)).map((e) => e.templateKey)).toEqual(['crm.booking_requested', 'crm.booking_approved', 'crm.booking_cancelled']);
  });

  it('declining sends one email without the staff reason; the places are released', async () => {
    const a = await linkedCustomer(t);
    const req = (await a.client.request(requestBody(w))).body;
    await deliverAndSend(a.customerId);
    const b = await bookingOf(req.reference);
    expect((await admin.post(`/admin/bookings/${b.id}/decline`, { version: b.version, reason: 'SECRET-REASON-decline' })).status).toBe(200);
    const sent = await deliverAndSend(a.customerId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('About your booking request');
    expect(sent[0]!.text).toMatch(/cannot take your request/);
    expect(JSON.stringify(sent)).not.toContain('SECRET-REASON');
  });

  it('an expired request sends the expiry email', async () => {
    const a = await linkedCustomer(t);
    const req = (await a.client.request(requestBody(w))).body;
    await deliverAndSend(a.customerId);
    await t.prisma.$executeRaw`UPDATE bookings SET "requestExpiresAt" = "requestedAt" + interval '1 millisecond' WHERE reference = ${req.reference}`;
    await t.app.get(BookingExpiryService).run();
    expect((await bookingOf(req.reference)).status).toBe('expired');
    const sent = await deliverAndSend(a.customerId);
    expect(sent.map((m) => m.subject)).toEqual([`Your booking request ${req.reference} has expired`]);
    expect(sent[0]!.text).toContain('We could not review your request');
  });

  it('delivering the same events again, or the consumer running twice, sends nothing more', async () => {
    const a = await linkedCustomer(t);
    await a.client.request(requestBody(w));
    expect(await deliverAndSend(a.customerId)).toHaveLength(1);
    expect(await deliverAndSend(a.customerId)).toHaveLength(0);
    const delivery = await t.prisma.eventDelivery.findFirstOrThrow({ where: { consumer: 'crm.booking_emails', event: { payload: { path: ['customerId'], equals: a.customerId } } } });
    await t.app.get(EventsService).processDelivery(delivery.id);
    expect(await emailsOf(a.customerId)).toHaveLength(1);
    expect(await t.prisma.outboundEmail.count({ where: { dedupeKey: { startsWith: 'booking:' }, customerId: a.customerId } })).toBe(1);
  });

  it('anonymised_customer_gets_no_email, and a customer closed before the send step is not written to', async () => {
    const a = await linkedCustomer(t);
    const req = (await a.client.request(requestBody(w))).body;
    await t.prisma.customer.update({ where: { id: a.customerId }, data: { anonymisedAt: new Date(), givenName: '[redacted]' } });
    expect(await deliverAndSend(a.customerId)).toEqual([]);
    expect(await emailsOf(a.customerId)).toEqual([]);
    expect(req.reference).toBeTruthy();

    const b = await linkedCustomer(t);
    await b.client.request(requestBody(w));
    const events = t.app.get(EventsService);
    await events.dispatchPending(1000);
    for (const d of await t.prisma.eventDelivery.findMany({ where: { consumer: 'crm.booking_emails', status: 'pending' } })) await events.processDelivery(d.id);
    expect(await emailsOf(b.customerId)).toHaveLength(1);
    await t.prisma.customer.update({ where: { id: b.customerId }, data: { anonymisedAt: new Date() } });
    const queued = await t.prisma.outboundEmail.findFirstOrThrow({ where: { customerId: b.customerId } });
    const before = t.mail.sent.length;
    await t.app.get(MailService).processSend(queued.id).catch(() => undefined);
    expect(t.mail.sent.length).toBe(before);
  });

  it('quote_booking_skips_request_ack: accepting a quote sends the quote email and the approval, not a second "we have your request"', async () => {
    const a = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, a.customerId, w));
    const quoteMail = await deliverAndSend(a.customerId);
    expect(quoteMail.map((m) => m.subject)).toEqual([expect.stringContaining(`Your quote ${q.reference}`)]);
    expect(await acceptQuote(t, a.client, q.reference).then((r) => r.status)).toBe(200);
    const sent = await deliverAndSend(a.customerId);
    expect(sent.map((m) => m.subject.replace(/MT-\w+/, 'REF'))).toEqual(['Your booking request REF is approved']);
    expect((await emailsOf(a.customerId)).map((e) => e.templateKey).sort()).toEqual(['crm.booking_approved', 'crm.quote_sent']);
  });

  it('expiry_text_matches_the_story: the expired email of an approved booking (the state machine has no way to expire one before task 3.2, so the email is queued directly) is not told "we could not review your request"', async () => {
    const a = await linkedCustomer(t);
    const q = await sendQuote(admin, await makeQuote(admin, a.customerId, w));
    await deliverAndSend(a.customerId);
    const accepted = await acceptQuote(t, a.client, q.reference);
    expect(accepted.status).toBe(200);
    await deliverAndSend(a.customerId);
    const booking = await bookingOf(accepted.body.bookingReference);
    expect(booking.approvedAt).not.toBeNull();
    await t.app.get(MailService).enqueue({
      to: a.client.email, templateKey: 'crm.booking_expired', templateVersion: 1, locale: 'en-AU', dedupeKey: `booking:${booking.id}:expired`,
      customerId: a.customerId, relatedEntityType: 'Booking', relatedEntityId: booking.id,
    });
    const sent = await deliverAndSend(a.customerId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe(`Your booking ${booking.reference} has expired`);
    expect(sent[0]!.text).toContain('next steps were not completed in time');
    expect(sent[0]!.text).not.toContain('could not review your request');
  });

  it('a quote email for a customer whose account was deleted before the send step is not sent', async () => {
    const a = await linkedCustomer(t);
    await sendQuote(admin, await makeQuote(admin, a.customerId, w));
    await t.prisma.customer.update({ where: { id: a.customerId }, data: { deletedAt: new Date() } });
    const queued = await t.prisma.outboundEmail.findFirstOrThrow({ where: { customerId: a.customerId, templateKey: 'crm.quote_sent' } });
    const before = t.mail.sent.length;
    // A closed account is permanent: the first attempt fails the email for good, and nothing is retried or sent.
    const first = await t.app.get(MailService).processSend(queued.id);
    expect(first).toBe('failed');
    const row = await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: queued.id } });
    expect([row.status, row.attempts]).toEqual(['failed', 1]);
    expect(row.error).toBeTruthy();
    expect(await t.app.get(MailService).processSend(queued.id)).toBe('noop');
    expect(t.mail.sent.length).toBe(before);
  });
});

describe('formatMinor only formats a stored amount', () => {
  it.each([
    [0n, 'AUD', 'A$0.00'], [5n, 'AUD', 'A$0.05'], [100n, 'AUD', 'A$1.00'], [123456n, 'AUD', 'A$1,234.56'], [100000000n, 'AUD', 'A$1,000,000.00'],
    [-250n, 'AUD', '-A$2.50'], [1999n, 'NZD', 'NZD 19.99'],
  ])('%s %s is %s', (minor, currency, text) => {
    expect(formatMinor(minor, currency)).toBe(text);
  });
});
