// Automatic balance reminders (task 5.6). Money is parked: they read the payment plan and queue one email per plan item and
// offset, through the single-use payment link of task 5.1. Real database, simulator gateway, capturing mail sender.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAYMENT_SETTINGS } from '../../../src/modules/payments/core/settings';
import { PaymentRemindersService, REMINDER_HOURS, reminderDedupeKey, reminderOffset } from '../../../src/modules/payments/core/reminders.service';
import { PaymentPendingService } from '../../../src/modules/payments';
import { formatMinor } from '../../../src/modules/payments/core/format';
import { MailService } from '../../../src/platform/mail/mail.service';
import { SettingsService } from '../../../src/platform/flags/flags.service';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { walkTo } from '../../support/customer-portal';
import { cleanBookingEvents, insertBareCancellation } from '../../support/bookings';
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
/** One sweep restricted to this booking, so counts are exact on a database shared with other tests. */
const runFor = (w: { bookingId: string }, now: Date) => reminders().run(now, { bookingId: w.bookingId });
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
// Task 6.3: a reminder is keyed by the booking, the kind and the due date of its item (not the item id), so a restated plan
// does not send it again.
const remindersOf = (item: { bookingId: string; kind: string; dueDate: Date }) =>
  t.prisma.outboundEmail.findMany({ where: { dedupeKey: { startsWith: `balance-reminder:${item.bookingId}:${item.kind}:${item.dueDate.toISOString().slice(0, 10)}:` } }, orderBy: { createdAt: 'asc' } });
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

  it('the dedupe key names the booking, the kind and due date of the item, and the offset (task 6.3: never the item id)', () => {
    expect(reminderDedupeKey({ bookingId: 'abc', kind: 'balance', dueDate: '2027-04-18' }, 3)).toBe('balance-reminder:abc:balance:2027-04-18:3');
    expect(reminderDedupeKey({ bookingId: 'abc', kind: 'adjustment', dueDate: new Date('2026-11-25T00:00:00Z') }, 0)).toBe('balance-reminder:abc:adjustment:2026-11-25:0');
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
    const first = await runFor(w, at(w.due, 14));
    expect(first).toMatchObject({ idle: null, errors: 0 });
    expect([first.examined, first.queued]).toEqual([1, 1]);
    expect(await remindersOf(w.balance)).toHaveLength(1);
    for (const days of [14, 14, 12, 5]) await runFor(w, at(w.due, days));
    expect(await remindersOf(w.balance)).toHaveLength(1);
    // The first reminder is delivered; the next offset replaces its link (it is ours, not staff's) and goes out once.
    const [firstRow] = await remindersOf(w.balance);
    expect((await sentNow(firstRow!.id)).outcome).toBe('sent');
    const second = await runFor(w, at(w.due, 3));
    expect([second.examined, second.queued, second.errors]).toEqual([1, 1, 0]);
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: firstRow!.relatedEntityId! } })).status).toBe('revoked');
    await runFor(w, at(w.due, 3));
    await runFor(w, at(w.due, 3, 16));
    await runFor(w, at(w.due, 0));
    const rows = await remindersOf(w.balance);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual([reminderDedupeKey(w.balance, 14), reminderDedupeKey(w.balance, 3)].sort());
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
    await runFor(w, at(w.due, 2));
    expect((await remindersOf(w.balance)).map((r) => r.dedupeKey)).toEqual([reminderDedupeKey(w.balance, 3)]);
  });

  it('reminder_not_before_the_window and not after the due date', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    const early = await runFor(w, at(w.due, 15));
    const late = await runFor(w, at(w.due, -1));
    expect([early.errors, late.errors]).toEqual([0, 0]);
    expect(await remindersOf(w.balance)).toHaveLength(0);
  });

  it('reminder_concurrent_sweeps: five at once queue it once and leave one active link', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await Promise.all(Array.from({ length: 5 }, () => runFor(w, at(w.due, 3))));
    expect(await remindersOf(w.balance)).toHaveLength(1);
    expect(await t.prisma.paymentLink.count({ where: { bookingId: w.bookingId, status: 'active' } })).toBe(1);
    expect(await t.prisma.paymentLink.count({ where: { bookingId: w.bookingId, createdById: '00000000-0000-0000-0000-000000000000' } })).toBe(1);
  });

  it('reminder_only_in_business_hours, and nothing when the setting is empty', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    expect(await runFor(w, at(w.due, 3, REMINDER_HOURS.from - 1))).toEqual({ idle: 'outside_hours', examined: 0, queued: 0, errors: 0, skipped: {} });
    expect(await runFor(w, at(w.due, 3, REMINDER_HOURS.to))).toEqual({ idle: 'outside_hours', examined: 0, queued: 0, errors: 0, skipped: {} });
    expect(await remindersOf(w.balance)).toHaveLength(0);
    await setOffsets([]);
    expect(await runFor(w, at(w.due, 3))).toEqual({ idle: 'turned_off', examined: 0, queued: 0, errors: 0, skipped: {} });
    expect(await remindersOf(w.balance)).toHaveLength(0);
    await setOffsets([14, 3]);
    expect(await runFor(w, at(w.due, 3, REMINDER_HOURS.from))).toMatchObject({ examined: 1, queued: 1, errors: 0 });
    expect(await remindersOf(w.balance)).toHaveLength(1);
  });

  it('reminder_skips: approved (deposit unpaid), a payment on its way, a suppressed or closed customer', async () => {
    await setOffsets([14, 3]);
    // Deposit not paid: the balance is not the next item owed.
    const approved = await approvedBooking(t, admin, await pricedWorld(admin), c);
    const bal = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: approved.bookingId, kind: 'balance' } });
    const early = await reminders().run(at(day(bal.dueDate), 3), { bookingId: approved.bookingId });
    expect(early.errors).toBe(0);
    expect(await remindersOf(bal)).toHaveLength(0);
    // The line is not even looked at: the SQL leaves out bookings that are still waiting for the deposit.
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: approved.bookingId } })).status).toBe('approved');

    // A payment is in flight.
    const live = await depositPaid();
    const link = await sendLink(live.bookingId);
    const sent = await sentNow((await emailOf(link.body.id)).id);
    expect(sent.outcome).toBe('sent');
    expect((await payVia(TOKEN_IN_MAIL.exec(sent.mail!.text)![1]!)).status).toBe(201);
    const run = await runFor(live, at(live.due, 3));
    expect([run.examined, run.skipped]).toEqual([1, { payment_in_progress: 1 }]);
    expect(await remindersOf(live.balance)).toHaveLength(0);

    // The address bounced or complained (scope all).
    const sup = await depositPaid();
    const customer = await t.prisma.customer.findUniqueOrThrow({ where: { id: sup.customerId }, select: { email: true } });
    await t.app.get(MailService).addSuppression(customer.email, 'bounced', 'all');
    try {
      const out = await runFor(sup, at(sup.due, 3));
      expect([out.examined, out.skipped]).toEqual([1, { recipient_suppressed: 1 }]);
      expect(await remindersOf(sup.balance)).toHaveLength(0);
    } finally {
      await t.prisma.emailSuppression.deleteMany({});
    }

    // A closed account.
    const closed = await depositPaid();
    await t.prisma.$executeRawUnsafe(`UPDATE customers SET "deletedAt" = clock_timestamp() WHERE id = $1::uuid`, closed.customerId);
    try {
      const out = await runFor(closed, at(closed.due, 3));
      expect(out.errors).toBe(0);
      expect([out.examined, out.skipped]).toEqual([1, { customer_closed: 1 }]);
      expect(await remindersOf(closed.balance)).toHaveLength(0);
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
        // Task 6.4: a cancellation has its record (deferred trigger of 0038).
        if (status === 'cancelled') await insertBareCancellation(tx, w.bookingId);
        await tx.$executeRawUnsafe(
          `UPDATE bookings SET status = $2::"BookingStatus", version = version + 1, "cancelledAt" = CASE WHEN $2 = 'cancelled' THEN clock_timestamp() ELSE "cancelledAt" END WHERE id = $1::uuid`, w.bookingId, status);
        if (status === 'cancelled') {
          await tx.$executeRawUnsafe(`UPDATE payment_schedule_items SET state = 'superseded', "supersededInVersion" = 2 WHERE "bookingId" = $1::uuid AND state = 'active'`, w.bookingId);
          await tx.$executeRawUnsafe(`UPDATE payment_schedules SET version = 2 WHERE "bookingId" = $1::uuid`, w.bookingId);
        }
      });
      const out = await runFor(w, at(w.due, 3));
      expect([status, out.errors, (await remindersOf(w.balance)).length]).toEqual([status, 0, 0]);
    }
  });
});

describe('the checks inside the lock (a line can change between the list and the lock)', () => {
  const today = (w: { due: string }) => day(at(w.due, 3));

  it('item_changed: a line superseded, or not a balance or instalment, is left alone', async () => {
    const w = await depositPaid();
    const deposit = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: w.bookingId, kind: 'deposit' } });
    expect(await reminders().remind(deposit.id, w.bookingId, [14, 3], today(w))).toBe('item_changed');
    expect(await reminders().remind(randomUUID(), w.bookingId, [14, 3], today(w))).toBe('item_changed');
    expect(await remindersOf(w.balance)).toHaveLength(0);
  });

  it('booking_not_payable: the state is checked again under the lock, for completed and cancelled alike', async () => {
    const w = await depositPaid();
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'completed', version = version + 1 WHERE id = $1::uuid`, w.bookingId);
    expect(await reminders().remind(w.balance.id, w.bookingId, [14, 3], today(w))).toBe('booking_not_payable');
    expect(await remindersOf(w.balance)).toHaveLength(0);
    expect(await t.prisma.paymentLink.count({ where: { bookingId: w.bookingId, createdById: '00000000-0000-0000-0000-000000000000' } })).toBe(0);
  });

  it('not_next_item: the line is not the first one owed (an earlier one is still unpaid), so nothing is queued', async () => {
    const b = await approvedBooking(t, admin, await pricedWorld(admin), c);
    await walkTo(t, b.bookingId, 'deposit_paid', 'approved');
    const bal = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: b.bookingId, kind: 'balance' } });
    expect(await reminders().remind(bal.id, b.bookingId, [14, 3], day(at(day(bal.dueDate), 3)))).toBe('not_next_item');
    expect(await remindersOf(bal)).toHaveLength(0);
  });

  it('not_next_item: a line already paid in full is not reminded', async () => {
    const w = await depositPaid();
    await payNext(w.bookingId);
    // The booking moved on to balance paid; put it back in a remindable state only to prove the plan check on its own.
    // A booking can only be in a remindable state with a covered line by SQL; that is exactly the plan check on its own.
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'confirmed', version = version + 1 WHERE id = $1::uuid`, w.bookingId);
    expect(await reminders().remind(w.balance.id, w.bookingId, [14, 3], today(w))).toBe('not_next_item');
    expect(await remindersOf(w.balance)).toHaveLength(0);
  });

  it('queued lines are left out of the next list in SQL, so they never use up the limit', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    const first = await runFor(w, at(w.due, 3));
    expect([first.examined, first.queued]).toEqual([1, 1]);
    const again = await runFor(w, at(w.due, 3));
    expect(again.errors).toBe(0);
    expect(again.skipped.already_queued ?? 0).toBe(0);
    expect(await remindersOf(w.balance)).toHaveLength(1);
  });
});

describe('the start page list agrees with the reminders', () => {
  it('pending_collections_skip_paid_lines: a paid deposit is not listed, the balance is, with the plan\'s amount', async () => {
    const w = await depositPaid();
    const list = await t.app.get(PaymentPendingService).collections(day(at(w.due, 3)), 1000);
    const mine = list.items.filter((i) => i.bookingId === w.bookingId);
    expect(mine).toEqual([expect.objectContaining({ kind: 'balance', sequence: 2, amountDueMinor: w.balance.amountMinor.toString(), overdue: false })]);
  });
});

describe('the email', () => {
  it('reminder_email: amount from the plan, the link only in the body, a single-use link that opens the pay page', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await runFor(w, at(w.due, 3));
    const [row] = await remindersOf(w.balance);
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
    await runFor(w, at(w.due, 3));
    expect(await remindersOf(w.balance)).toHaveLength(1);
  });

  it('reminder_retry_after_a_failed_send: the next attempt mints a fresh token, still one email', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await runFor(w, at(w.due, 3));
    const [row] = await remindersOf(w.balance);
    const spy = vi.spyOn(t.mail, 'send').mockRejectedValueOnce(new Error('smtp down'));
    await expect(t.app.get(MailService).processSend(row!.id)).rejects.toThrow();
    spy.mockRestore();
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: row!.relatedEntityId! } })).tokenHash).toBeNull();
    expect((await sentNow(row!.id)).outcome).toBe('sent');
    await runFor(w, at(w.due, 3));
    expect(await remindersOf(w.balance)).toHaveLength(1);
  });

  it('reminder_not_sent_once_paid: the send step fails the email, mints no token and sends nothing', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await runFor(w, at(w.due, 3));
    const [row] = await remindersOf(w.balance);
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
      await runFor(w, at(w.due, 3));
      const [row] = await remindersOf(w.balance);
      expect(row).toBeDefined();
      expect((await sentNow(row!.id)).outcome).toBe('sent');
    } finally {
      await t.prisma.emailSuppression.deleteMany({});
    }
  });

  it('all_suppression_blocks_it: reminder_not_sent_to_a_suppressed_address even if it was queued before', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await runFor(w, at(w.due, 3));
    const [row] = await remindersOf(w.balance);
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

  it('link_active: a link the customer already holds is never revoked by a reminder (staff on a call)', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    const staff = await sendLink(w.bookingId);
    const staffToken = TOKEN_IN_MAIL.exec((await sentNow((await emailOf(staff.body.id)).id)).mail!.text)![1]!;
    const run = await runFor(w, at(w.due, 3));
    expect(run.errors).toBe(0);
    expect([run.examined, run.skipped]).toEqual([1, { link_active: 1 }]);
    expect(await remindersOf(w.balance)).toHaveLength(0);
    expect((await view(staffToken)).status).toBe(200);
    // Once that link is used up or revoked, the next sweep sends the reminder.
    await admin.post(`/admin/payments/payment-links/${staff.body.id}/revoke`, {});
    await runFor(w, at(w.due, 3));
    const [row] = await remindersOf(w.balance);
    const reminderToken = TOKEN_IN_MAIL.exec((await sentNow(row!.id)).mail!.text)![1]!;
    expect((await view(reminderToken)).status).toBe(200);
  });

  it('link_active: a staff link whose email is still queued is not revoked either, and that email still goes out', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    const staff = await sendLink(w.bookingId);
    const run = await runFor(w, at(w.due, 3));
    expect(run.errors).toBe(0);
    expect([run.examined, run.skipped]).toEqual([1, { link_active: 1 }]);
    expect(await remindersOf(w.balance)).toHaveLength(0);
    const sent = await sentNow((await emailOf(staff.body.id)).id);
    expect(sent.outcome).toBe('sent');
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: staff.body.id } })).status).toBe('active');
  });

  it('previous_reminder_link_is_replaced: offsets [3,1] with the first reminder\'s link still valid still send the second', async () => {
    await setOffsets([3, 1]);
    const w = await depositPaid();
    expect(await runFor(w, at(w.due, 3))).toMatchObject({ examined: 1, queued: 1 });
    const [first] = await remindersOf(w.balance);
    expect((await sentNow(first!.id)).outcome).toBe('sent');
    const link = await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: first!.relatedEntityId! } });
    expect(link.status).toBe('active');
    expect(await runFor(w, at(w.due, 1))).toMatchObject({ examined: 1, queued: 1, skipped: {} });
    expect((await remindersOf(w.balance)).map((r) => r.dedupeKey).sort()).toEqual([reminderDedupeKey(w.balance, 3), reminderDedupeKey(w.balance, 1)].sort());
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: first!.relatedEntityId! } })).status).toBe('revoked');
    await setOffsets([14, 3]);
  });

  it('failed_reminder_link_never_blocks: the previous reminder\'s email failed, its token-less link is replaced', async () => {
    await setOffsets([3, 1]);
    try {
      const w = await depositPaid();
      await runFor(w, at(w.due, 3));
      const [first] = await remindersOf(w.balance);
      // The address bounces, so the send step fails the email for good and leaves an active link with no token.
      const customer = await t.prisma.customer.findUniqueOrThrow({ where: { id: w.customerId }, select: { email: true } });
      await t.app.get(MailService).addSuppression(customer.email, 'bounced', 'all');
      expect(await t.app.get(MailService).processSend(first!.id)).toBe('failed');
      await t.prisma.emailSuppression.deleteMany({});
      const stale = await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: first!.relatedEntityId! } });
      expect([stale.status, stale.tokenHash]).toEqual(['active', null]);
      expect(await runFor(w, at(w.due, 1))).toMatchObject({ examined: 1, queued: 1, skipped: {} });
      expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: first!.relatedEntityId! } })).status).toBe('revoked');
    } finally {
      await t.prisma.emailSuppression.deleteMany({});
      await setOffsets([14, 3]);
    }
  });

  it('staff_link_still_protected: a delivered staff link is kept, and a staff link whose email failed is not', async () => {
    await setOffsets([3, 1]);
    const w = await depositPaid();
    const staff = await sendLink(w.bookingId);
    await sentNow((await emailOf(staff.body.id)).id);
    expect(await runFor(w, at(w.due, 3))).toMatchObject({ examined: 1, queued: 0, skipped: { link_active: 1 } });
    // A staff link that was never delivered and whose email failed holds no token and protects nothing.
    const x = await depositPaid();
    const lone = await sendLink(x.bookingId);
    await t.prisma.$executeRawUnsafe(`UPDATE outbound_emails SET status = 'failed' WHERE id = $1::uuid`, (await emailOf(lone.body.id)).id);
    expect(await runFor(x, at(x.due, 3))).toMatchObject({ examined: 1, queued: 1, skipped: {} });
    await setOffsets([14, 3]);
  });

  it('reminder_not_sent_while_the_customer_is_paying: a payment in progress at send time fails the email, no token', async () => {
    await setOffsets([14, 3]);
    const w = await depositPaid();
    await runFor(w, at(w.due, 3));
    const [row] = await remindersOf(w.balance);
    const started = await c.pay(w.reference, { method: 'card' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const before = t.mail.sent.length;
    expect(await t.app.get(MailService).processSend(row!.id)).toBe('failed');
    expect(t.mail.sent.length).toBe(before);
    expect((await t.prisma.paymentLink.findUniqueOrThrow({ where: { id: row!.relatedEntityId! } })).tokenHash).toBeNull();
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
      await runFor(w, at(w.due, 3));
      const [row] = await remindersOf(w.balance);
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
