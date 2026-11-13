// Automatic balance reminders (task 5.6). Money is parked: they read the payment plan and queue one email per plan item and
// offset, through the single-use payment link of task 5.1. Real database, simulator gateway, capturing mail sender.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAYMENT_SETTINGS } from '../../../src/modules/payments/core/settings';
import { PaymentRemindersService, REMINDER_HOURS, reminderDedupeKey, reminderOffset } from '../../../src/modules/payments/core/reminders.service';
import { formatMinor } from '../../../src/modules/payments/core/format';
import { MailService } from '../../../src/platform/mail/mail.service';
import { SettingsService } from '../../../src/platform/flags/flags.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { cleanBookingEvents } from '../../support/bookings';
import { closeCatalogue, staffClient } from '../../support/catalogue';
import { pricedWorld } from '../../support/pricing';
import { PayingCustomer, SimAccount, approvedBooking, cleanPayments, ensureTerms, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount } from '../../support/payments';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

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
  await t.app.get(SettingsService).set(PAYMENT_SETTINGS.balanceReminderOffsetsDays.key, PAYMENT_SETTINGS.balanceReminderOffsetsDays.fallback);
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'mail.send'`);
  await closeCatalogue(t);
});

const reminders = () => t.app.get(PaymentRemindersService);
const TOKEN_IN_MAIL = /\/pay#token=([A-Za-z0-9_-]{43})/;
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** 10:00 in Brisbane, `daysBefore` days before the date. */
const at = (dueDate: string, daysBefore: number, hour = 10): Date => new Date(`${addDays(dueDate, -daysBefore)}T${String(hour).padStart(2, '0')}:00:00+10:00`);
const day = (d: Date) => d.toISOString().slice(0, 10);

const setOffsets = (v: number[]) => t.app.get(SettingsService).set(PAYMENT_SETTINGS.balanceReminderOffsetsDays.key, v);
const sendLink = (bookingId: string) => admin.post(`/admin/payments/bookings/${bookingId}/payment-links`, {});
const emailOf = (linkId: string) => t.prisma.outboundEmail.findUniqueOrThrow({ where: { dedupeKey: `payment-link:${linkId}` } });
const view = (token: string) => t.http().post('/payment-links/view').set(STATE_HEADERS).send({ token });
const payVia = (token: string) => t.http().post('/payment-links/payments').set(STATE_HEADERS).set('Idempotency-Key', randomUUID()).send({ token, method: 'card' });
const refresh = (token: string) => t.http().post('/payment-links/refresh').set(STATE_HEADERS).send({ token });
const remindersOf = (itemId: string) => t.prisma.outboundEmail.findMany({ where: { dedupeKey: { startsWith: `balance-reminder:${itemId}:` } }, orderBy: { createdAt: 'asc' } });
const sentNow = async (emailId: string) => {
  const before = t.mail.sent.length;
  const outcome = await t.app.get(MailService).processSend(emailId);
  return { outcome, mail: t.mail.sent.slice(before)[0] };
};

/** A staff-sent link delivered and paid until the money is in: the token it used. */
async function payNext(bookingId: string): Promise<void> {
  const res = await sendLink(bookingId);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const before = t.mail.sent.length;
  await t.app.get(MailService).processSend((await emailOf(res.body.id)).id);
  const token = TOKEN_IN_MAIL.exec(t.mail.sent.slice(before).find((x) => TOKEN_IN_MAIL.test(x.text))!.text)![1]!;
  expect((await payVia(token)).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } })).at(-1)!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await refresh(token)).body.used).toBe(true);
}

/** A booking whose deposit is paid, so the balance is the next item owed. */
async function depositPaid() {
  const b = await approvedBooking(t, admin, await pricedWorld(admin), c);
  await payNext(b.bookingId);
  const booking = await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId }, select: { status: true, customerId: true } });
  expect(['deposit_paid', 'confirmed']).toContain(booking.status);
  const balance = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: b.bookingId, state: 'active', kind: 'balance' } });
  return { ...b, balance, due: day(balance.dueDate), customerId: booking.customerId };
}

describe('when a reminder is due (pure)', () => {
  it.each([
    [[14, 3], 20, null], [[14, 3], 14, 14], [[14, 3], 10, 14], [[14, 3], 4, 14], [[14, 3], 3, 3], [[14, 3], 1, 3], [[14, 3], 0, 3],
    [[14, 3], -1, null], [[7], 8, null], [[], 5, null], [[0], 0, 0], [[0], 1, null],
  ])('reminder_offset_table offsets %j, %i days to go -> %s', (offsets, daysUntil, expected) => {
    expect(reminderOffset(offsets, daysUntil)).toBe(expected);
  });

  it('the dedupe key names the item and the offset', () => {
    expect(reminderDedupeKey('abc', 3)).toBe('balance-reminder:abc:3');
  });

  it('the offsets setting is a short list of distinct whole days', () => {
    const { schema } = PAYMENT_SETTINGS.balanceReminderOffsetsDays;
    for (const ok of [[], [14, 3], [0]]) expect(schema.safeParse(ok).success).toBe(true);
    for (const bad of [[3, 3], [-1], [91], [1.5], [1, 2, 3, 4, 5, 6], ['a']]) expect(schema.safeParse(bad).success).toBe(false);
  });
});

describe('queueing', () => {
  it('reminder_once_per_item_and_offset: repeated sweeps and later days queue each offset once', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    const first = await reminders().run(at(w.due, 14));
    expect(first).toMatchObject({ idle: null });
    expect(await remindersOf(w.balance.id)).toHaveLength(1);
    for (const days of [14, 14, 12, 5]) await reminders().run(at(w.due, days));
    expect(await remindersOf(w.balance.id)).toHaveLength(1);
    await reminders().run(at(w.due, 3));
    await reminders().run(at(w.due, 3, 16));
    await reminders().run(at(w.due, 0));
    const rows = await remindersOf(w.balance.id);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual([reminderDedupeKey(w.balance.id, 14), reminderDedupeKey(w.balance.id, 3)].sort());
    expect(rows.every((r) => r.category === 'transactional' && r.relatedEntityType === 'PaymentLink' && r.templateKey === 'payments.balance_reminder')).toBe(true);
    // One active link at most, and every reminder link was opened by the system.
    expect(await t.prisma.paymentLink.count({ where: { bookingId: w.bookingId, status: 'active' } })).toBeLessThanOrEqual(1);
    const links = await t.prisma.paymentLink.findMany({ where: { id: { in: rows.map((r) => r.relatedEntityId!) } } });
    expect(links.every((l) => l.createdById === '00000000-0000-0000-0000-000000000000' && l.targetScheduleItemId === w.balance.id)).toBe(true);
    expect(await t.prisma.auditLog.count({ where: { entityType: 'PaymentLink', entityId: { in: links.map((l) => l.id) }, action: 'payments.paymentLink.sent', actorType: 'system' } })).toBe(2);
  });

  it('reminder_catch_up: after downtime only the latest offset reached is queued', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await reminders().run(at(w.due, 2));
    expect((await remindersOf(w.balance.id)).map((r) => r.dedupeKey)).toEqual([reminderDedupeKey(w.balance.id, 3)]);
  });

  it('reminder_not_before_the_window and not after the due date', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await reminders().run(at(w.due, 15));
    await reminders().run(at(w.due, -1));
    expect(await remindersOf(w.balance.id)).toHaveLength(0);
  });

  it('reminder_concurrent_sweeps: five at once queue it once and leave one active link', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await Promise.all(Array.from({ length: 5 }, () => reminders().run(at(w.due, 3))));
    expect(await remindersOf(w.balance.id)).toHaveLength(1);
    expect(await t.prisma.paymentLink.count({ where: { bookingId: w.bookingId, status: 'active' } })).toBe(1);
    expect(await t.prisma.paymentLink.count({ where: { bookingId: w.bookingId, createdById: '00000000-0000-0000-0000-000000000000' } })).toBe(1);
  });

  it('reminder_only_in_business_hours, and nothing when the setting is empty', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    expect((await reminders().run(at(w.due, 3, REMINDER_HOURS.from - 1))).idle).toBe('outside_hours');
    expect((await reminders().run(at(w.due, 3, REMINDER_HOURS.to))).idle).toBe('outside_hours');
    expect(await remindersOf(w.balance.id)).toHaveLength(0);
    await setOffsets([]);
    expect((await reminders().run(at(w.due, 3))).idle).toBe('turned_off');
    expect(await remindersOf(w.balance.id)).toHaveLength(0);
    await setOffsets([14, 3]);
    expect((await reminders().run(at(w.due, 3, REMINDER_HOURS.from))).queued).toBeGreaterThanOrEqual(1);
    expect(await remindersOf(w.balance.id)).toHaveLength(1);
  });

  it('reminder_skips: approved (deposit unpaid), a payment on its way, a suppressed or closed customer', async () => {
    await setOffsets([14, 3]);
    // Deposit not paid: the balance is not the next item owed.
    const approved = await approvedBooking(t, admin, await pricedWorld(admin), c);
    const bal = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: approved.bookingId, kind: 'balance' } });
    await reminders().run(at(day(bal.dueDate), 3));
    expect(await remindersOf(bal.id)).toHaveLength(0);

    // A payment is in flight.
    const live = await depositPaid();
    const link = await sendLink(live.bookingId);
    const sent = await sentNow((await emailOf(link.body.id)).id);
    expect(sent.outcome).toBe('sent');
    expect((await payVia(TOKEN_IN_MAIL.exec(sent.mail!.text)![1]!)).status).toBe(201);
    const run = await reminders().run(at(live.due, 3));
    expect(run.skipped.payment_in_progress).toBeGreaterThanOrEqual(1);
    expect(await remindersOf(live.balance.id)).toHaveLength(0);

    // The address bounced or complained (scope all).
    const sup = await depositPaid();
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { id: sup.customerId }, select: { email: true } });
    await t.app.get(MailService).addSuppression(customer.email, 'bounced', 'all');
    try {
      const out = await reminders().run(at(sup.due, 3));
      expect(out.skipped.recipient_suppressed).toBeGreaterThanOrEqual(1);
      expect(await remindersOf(sup.balance.id)).toHaveLength(0);
    } finally {
      await t.prisma.emailSuppression.deleteMany({});
    }

    // A closed account.
    const closed = await depositPaid();
    await t.prisma.$executeRawUnsafe(`UPDATE customers SET "deletedAt" = clock_timestamp() WHERE id = $1::uuid`, closed.customerId);
    try {
      await reminders().run(at(closed.due, 3));
      expect(await remindersOf(closed.balance.id)).toHaveLength(0);
    } finally {
      await t.prisma.$executeRawUnsafe(`UPDATE customers SET "deletedAt" = NULL WHERE id = $1::uuid`, closed.customerId);
    }
  });

  it('reminder_stops_for_a_booking_that_is_no_longer_payable', async () => {
    await setOffsets([14, 3]);
    for (const status of ['cancelled', 'completed'] as const) {
      const w = await depositPaid();
      // Cancelling supersedes the plan (the booking and its plan are checked together at commit); completing does not.
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE bookings SET status = $2::"BookingStatus", version = version + 1, "cancelledAt" = CASE WHEN $2 = 'cancelled' THEN clock_timestamp() ELSE "cancelledAt" END WHERE id = $1::uuid`, w.bookingId, status);
        if (status === 'cancelled') {
          await tx.$executeRawUnsafe(`UPDATE payment_schedule_items SET state = 'superseded', "supersededInVersion" = 2 WHERE "bookingId" = $1::uuid AND state = 'active'`, w.bookingId);
          await tx.$executeRawUnsafe(`UPDATE payment_schedules SET version = 2 WHERE "bookingId" = $1::uuid`, w.bookingId);
        }
      });
      await reminders().run(at(w.due, 3));
      expect([status, (await remindersOf(w.balance.id)).length]).toEqual([status, 0]);
    }
  });
});

describe('the email', () => {
  it('reminder_email: amount from the plan, the link only in the body, a single-use link that opens the pay page', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await reminders().run(at(w.due, 3));
    const [row] = await remindersOf(w.balance.id);
    expect(row).toBeDefined();
    // Queued with no token anywhere: it is minted when the email is sent.
    const link = await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: row!.relatedEntityId! } });
    expect(link.tokenHash).toBeNull();
    const jobs = await t.prisma.$queryRawUnsafe<Array<{ data: unknown }>>(`SELECT data FROM pgboss.job WHERE name = 'mail.send'`);
    expect(JSON.stringify(jobs)).not.toMatch(/token=/);

    const { outcome, mail } = await sentNow(row!.id);
    expect(outcome).toBe('sent');
    const token = TOKEN_IN_MAIL.exec(mail!.text)![1]!;
    expect(mail!.subject).not.toContain(token);
    expect(mail!.subject).not.toMatch(/token=/);
    expect(mail!.text).toContain(formatMinor(w.balance.amountMinor, w.balance.currency));
    expect(mail!.to).toBe((await t.prisma.customer.findUniqueOrThrow({ where: { id: w.customerId } })).email);
    const stored = await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: row!.id } });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.subject).toBe(mail!.subject);

    // The page shows the same amount, from the API.
    const page = await view(token);
    expect([page.status, page.body.amountDueMinor]).toEqual([200, w.balance.amountMinor.toString()]);
    // A second send step does nothing and the sweep does not queue another.
    expect(await t.app.get(MailService).processSend(row!.id)).toBe('noop');
    await reminders().run(at(w.due, 3));
    expect(await remindersOf(w.balance.id)).toHaveLength(1);
  });

  it('reminder_retry_after_a_failed_send: the next attempt mints a fresh token, still one email', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await reminders().run(at(w.due, 3));
    const [row] = await remindersOf(w.balance.id);
    const spy = vi.spyOn(t.mail, 'send').mockRejectedValueOnce(new Error('smtp down'));
    await expect(t.app.get(MailService).processSend(row!.id)).rejects.toThrow();
    spy.mockRestore();
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: row!.relatedEntityId! } })).tokenHash).toBeNull();
    expect((await sentNow(row!.id)).outcome).toBe('sent');
    await reminders().run(at(w.due, 3));
    expect(await remindersOf(w.balance.id)).toHaveLength(1);
  });

  it('reminder_not_sent_once_paid: the send step fails the email, mints no token and sends nothing', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await reminders().run(at(w.due, 3));
    const [row] = await remindersOf(w.balance.id);
    await payNext(w.bookingId);
    const before = t.mail.sent.length;
    expect(await t.app.get(MailService).processSend(row!.id)).toBe('failed');
    expect(t.mail.sent.length).toBe(before);
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: row!.relatedEntityId! } })).tokenHash).toBeNull();
  });

  it('marketing_suppression_does_not_block_balance_reminder: an unsubscribe from marketing still gets the reminder', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { id: w.customerId }, select: { email: true } });
    await t.app.get(MailService).addSuppression(customer.email, 'unsubscribed', 'marketing');
    try {
      await reminders().run(at(w.due, 3));
      const [row] = await remindersOf(w.balance.id);
      expect(row).toBeDefined();
      expect((await sentNow(row!.id)).outcome).toBe('sent');
    } finally {
      await t.prisma.emailSuppression.deleteMany({});
    }
  });

  it('all_suppression_blocks_it: reminder_not_sent_to_a_suppressed_address even if it was queued before', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await reminders().run(at(w.due, 3));
    const [row] = await remindersOf(w.balance.id);
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { id: w.customerId }, select: { email: true } });
    await t.app.get(MailService).addSuppression(customer.email, 'bounced', 'all');
    try {
      const before = t.mail.sent.length;
      expect(await t.app.get(MailService).processSend(row!.id)).toBe('failed');
      expect(t.mail.sent.length).toBe(before);
    } finally {
      await t.prisma.emailSuppression.deleteMany({});
    }
  });

  it('reminder_replaces_the_active_link: the staff link stops working, the reminder link works', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    const staff = await sendLink(w.bookingId);
    const staffMail = await sentNow((await emailOf(staff.body.id)).id);
    const staffToken = TOKEN_IN_MAIL.exec(staffMail.mail!.text)![1]!;
    await reminders().run(at(w.due, 3));
    const [row] = await remindersOf(w.balance.id);
    const reminderToken = TOKEN_IN_MAIL.exec((await sentNow(row!.id)).mail!.text)![1]!;
    expect((await view(staffToken)).status).toBe(404);
    expect((await view(reminderToken)).status).toBe(200);
  });

  it('reminder_wording_is_a_template: uses the revision in use, and a revision without the link, or with it in the subject, is refused', async () => {
    await setOffsets([14, 3]);
    const staff = await staffClient(t, ['templates.template.read', 'templates.template.manage', 'templates.template.publish']);
    const key = 'payments.balance_reminder';
    const inSubject = await staff.post('/admin/templates/email', { key, subject: 'Pay {{link}}', body: 'Pay here: {{link}}' });
    expect([inSubject.status, inSubject.body.code]).toEqual([422, 'template_wording_invalid']);
    const noLink = await staff.post('/admin/templates/email', { key, subject: 'Pay {{reference}}', body: 'Please pay {{amountDue}}.' });
    expect([noLink.status, noLink.body.code]).toEqual([422, 'template_wording_invalid']);
    const unknown = await staff.post('/admin/templates/email', { key, subject: 'Pay {{reference}}', body: '{{link}} {{total}}' });
    expect(unknown.status).toBe(422);

    const draft = await staff.post('/admin/templates/email', { key, subject: 'Balance for {{reference}}: {{amountDue}} by {{dueDate}}', body: 'G\'day {{givenName}}, pay {{amountDue}} for {{trip}} here: {{link}}\n{{brandName}}' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const on = await staff.post(`/admin/templates/email/${draft.body.id}/activate`, { version: draft.body.version });
    expect(on.status).toBe(200);
    try {
      const w = await depositPaid();
      await reminders().run(at(w.due, 3));
      const [row] = await remindersOf(w.balance.id);
      const { mail } = await sentNow(row!.id);
      const money = formatMinor(w.balance.amountMinor, w.balance.currency);
      expect(mail!.subject).toMatch(new RegExp(`^Balance for MT-?[A-Z0-9]+: ${money.replace('$', '\\$')} by `));
      expect(mail!.text).toMatch(/^G'day /);
      expect(mail!.text).toMatch(TOKEN_IN_MAIL);
      expect(mail!.subject).not.toMatch(/token=/);
    } finally {
      await t.prisma.messageTemplate.updateMany({ where: { channel: 'email', key }, data: { status: 'archived' } });
    }
  });
});
