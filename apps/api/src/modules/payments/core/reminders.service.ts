import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { brand } from '@mt/shared';
import { NIL_UUID } from '../../../platform/audit/audit.service';
import { emailHash } from '../../../platform/crypto/hmac';
import type { AppConfig } from '../../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { AppError, safeError } from '../../../platform/errors/safe-error';
import { SettingsService } from '../../../platform/flags/flags.service';
import { JobsService } from '../../../platform/jobs/jobs.service';
import { QUEUES } from '../../../platform/jobs/queues';
import { MAIL_NOT_SENDABLE } from '../../../platform/mail/mail.service';
import type { RenderContext, RenderedMail } from '../../../platform/mail/templates';
import { readBookingForPayments, todayInBrisbane } from '../../bookings';
import { TemplatesService } from '../../templates';
import { ProviderGateway } from './gateway';
import { formatMinor } from './format';
import { mintPaymentLinkToken, PaymentLinksService } from './payment-links.service';
import { payable, succeededPaymentsSource } from './payable';
import { PAYMENT_TX_OPTIONS } from './payable-states';
import { PAYMENT_SETTINGS } from './settings';

export const PAYMENT_REMINDER_TEMPLATE = { key: 'payments.balance_reminder', version: 1 } as const;

/** Booking states whose later payments can be reminded: the deposit is in, so the next item is a balance or instalment. */
const REMINDABLE_STATES = ['deposit_paid', 'confirmed'] as const;
/** Reminders go out during Brisbane business hours only (from 8:00 up to, not including, 18:00). */
export const REMINDER_HOURS = { from: 8, to: 18 } as const;
const MAX_PER_RUN = 500;

export type ReminderSkip =
  | 'not_due_yet' | 'already_queued' | 'not_next_item' | 'item_changed' | 'booking_not_payable' | 'payment_in_progress' | 'customer_closed' | 'recipient_suppressed' | 'link_active';

export interface ReminderRun {
  /** The sweep did nothing because it is outside business hours, or reminders are turned off. */
  idle: 'outside_hours' | 'turned_off' | null;
  examined: number;
  queued: number;
  /** Lines whose reminder threw (the next sweep tries them again). */
  errors: number;
  skipped: Partial<Record<ReminderSkip, number>>;
}

const dayMs = 86_400_000;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
const brisbaneHour = (at: Date): number => Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', hourCycle: 'h23' }).format(at));
const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};
const dateTime = (d: Date): string => new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Australia/Brisbane' }).format(d);
const longDay = (iso: string): string => new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

/** The offset that applies to an item `daysUntil` days from falling due: the smallest configured offset that has been reached. */
export function reminderOffset(offsets: readonly number[], daysUntil: number): number | null {
  if (daysUntil < 0) return null;
  const reached = offsets.filter((o) => o >= daysUntil);
  return reached.length === 0 ? null : Math.min(...reached);
}

export const reminderDedupeKey = (itemId: string, offset: number): string => `balance-reminder:${itemId}:${offset}`;

/**
 * Automatic balance reminders (task 5.6). Money is parked: this only reads the payment plan that exists and queues an
 * email. Each reminder is one outbound email whose dedupe key names the plan item and the offset, queued under the
 * booking's lock, so a retry or a concurrent sweep cannot send it twice. It stops when the item is covered, the booking
 * is no longer payable (cancelled, expired, completed...), a payment is on its way, or the customer is closed or
 * suppressed. The link is the single-use link of task 5.1, minted when the email is sent, and the amount is the plan's.
 */
@Injectable()
export class PaymentRemindersService implements OnApplicationBootstrap {
  private readonly logger = new Logger('PaymentReminders');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(PaymentLinksService) private readonly links: PaymentLinksService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.paymentsReminders, async () => void (await this.run()));
    await this.jobs.schedule(QUEUES.paymentsReminders, '*/30 * * * *');
  }

  /** One sweep. `now` and `only` (one booking) are parameters for tests only. */
  async run(now: Date = new Date(), only: { bookingId?: string } = {}): Promise<ReminderRun> {
    const result: ReminderRun = { idle: null, examined: 0, queued: 0, errors: 0, skipped: {} };
    const offsets = [...(await this.settings.get(PAYMENT_SETTINGS.balanceReminderOffsetsDays.key, PAYMENT_SETTINGS.balanceReminderOffsetsDays.fallback))].sort((a, b) => b - a);
    if (offsets.length === 0) return { ...result, idle: 'turned_off' };
    const hour = brisbaneHour(now);
    if (hour < REMINDER_HOURS.from || hour >= REMINDER_HOURS.to) return { ...result, idle: 'outside_hours' };
    const today = todayInBrisbane(now);
    // Lines whose reminder for the offset now in force is already queued are left out in SQL, so a long list of them never
    // starves the ones still to do (the limit applies to work, not to history).
    const rows = await this.prisma.$queryRaw<Array<{ id: string; bookingId: string }>>`
      SELECT i.id::text AS id, i."bookingId"::text AS "bookingId"
      FROM payment_schedule_items i JOIN bookings b ON b.id = i."bookingId"
      CROSS JOIN LATERAL (SELECT min(o) AS off FROM unnest(${offsets}::int[]) AS o WHERE o >= (i."dueDate" - ${today}::date)) AS w
      WHERE i.state = 'active' AND i.kind IN ('balance', 'instalment')
        AND i."dueDate" >= ${today}::date AND i."dueDate" <= ${addDays(today, Math.max(...offsets))}::date
        AND b.status::text = ANY(${[...REMINDABLE_STATES]}::text[])
        AND w.off IS NOT NULL
        AND (${only.bookingId ?? null}::uuid IS NULL OR i."bookingId" = ${only.bookingId ?? null}::uuid)
        AND NOT EXISTS (SELECT 1 FROM outbound_emails e WHERE e."dedupeKey" = 'balance-reminder:' || i.id::text || ':' || w.off::text)
      ORDER BY i."dueDate", i.id LIMIT ${MAX_PER_RUN}`;
    for (const row of rows) {
      result.examined += 1;
      try {
        const outcome = await this.remind(row.id, row.bookingId, offsets, today);
        if (outcome === 'queued') result.queued += 1;
        else result.skipped[outcome] = (result.skipped[outcome] ?? 0) + 1;
      } catch (err) {
        // One bad booking must not stop the others; the next sweep tries it again.
        result.errors += 1;
        this.logger.warn(`reminder for item ${row.id} failed: ${safeError(err).code}`);
      }
    }
    return result;
  }

  /** One line's reminder in its own transaction (public for tests of the failure paths). */
  async remind(itemId: string, bookingId: string, offsets: readonly number[], today: string): Promise<'queued' | ReminderSkip> {
    return runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: bookingId }, true);
      if (!b || !(REMINDABLE_STATES as readonly string[]).includes(b.status)) return 'booking_not_payable';
      const item = await tx.paymentScheduleItem.findUnique({ where: { id: itemId }, select: { id: true, bookingId: true, state: true, kind: true, sequence: true, dueDate: true } });
      if (!item || item.bookingId !== b.id || item.state !== 'active' || (item.kind !== 'balance' && item.kind !== 'instalment')) return 'item_changed';
      const offset = reminderOffset(offsets, daysBetween(today, item.dueDate.toISOString().slice(0, 10)));
      if (offset === null) return 'not_due_yet';
      const dedupeKey = reminderDedupeKey(item.id, offset);
      if (await tx.outboundEmail.findUnique({ where: { dedupeKey }, select: { id: true } })) return 'already_queued';
      // The plan's own figure: this item must be the first one the money collected does not cover.
      const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { id: true, sequence: true, amountMinor: true } });
      const collected = await succeededPaymentsSource.collected(tx, b.id, this.gateway.mode);
      if (payable(items, collected).next?.sequence !== item.sequence) return 'not_next_item';
      if (await tx.payment.findUnique({ where: { liveBookingId: b.id }, select: { id: true } })) return 'payment_in_progress';
      // A link staff sent is protected while it may be in use: it has been delivered (its token exists) or its email is
      // still queued. A link an earlier reminder minted is ours, so the new reminder replaces it; and a link whose email
      // failed has no token and never blocks anything.
      const [{ now }] = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`) as [{ now: Date }];
      const staffLinks = await tx.paymentLink.findMany({ where: { bookingId: b.id, targetScheduleItemId: item.id, status: 'active', expiresAt: { gt: now }, createdById: { not: NIL_UUID } }, select: { id: true, tokenHash: true } });
      for (const l of staffLinks) {
        if (l.tokenHash !== null || (await tx.outboundEmail.findUnique({ where: { dedupeKey: `payment-link:${l.id}` }, select: { status: true } }))?.status === 'queued') return 'link_active';
      }
      const customer = await tx.customer.findUnique({ where: { id: b.customerId }, select: { id: true, email: true, preferredLocale: true, anonymisedAt: true, deletedAt: true } });
      if (!customer || customer.anonymisedAt || customer.deletedAt) return 'customer_closed';
      if (await tx.emailSuppression.findUnique({ where: { emailHash: emailHash(this.config.EMAIL_HASH_KEY, customer.email), scope: 'all' }, select: { id: true } })) return 'recipient_suppressed';
      try {
        await this.links.openForReminder(tx, b, { id: item.id, sequence: item.sequence }, { email: customer.email, customerId: customer.id, locale: customer.preferredLocale }, dedupeKey, PAYMENT_REMINDER_TEMPLATE.key, PAYMENT_REMINDER_TEMPLATE.version);
      } catch (err) {
        if (err instanceof AppError && err.code === 'reminder_already_queued') return 'already_queued';
        throw err;
      }
      return 'queued';
    }, PAYMENT_TX_OPTIONS);
  }

  // ---- The send step ----

  /**
   * Renders the reminder when the email is sent. Everything is read again: if the item was paid, the booking left the
   * payable states or the customer was suppressed (bounce or complaint) or closed since it was queued, the email never goes out. The token is
   * minted here (so it commits with the send) and goes into the body only.
   */
  async renderEmail(ctx: RenderContext): Promise<RenderedMail> {
    const linkId = ctx.email.relatedEntityId;
    if (!linkId || ctx.email.relatedEntityType !== 'PaymentLink') throw new AppError(MAIL_NOT_SENDABLE, 'The email is not linked to a payment link');
    const head = await ctx.tx.paymentLink.findUnique({ where: { id: linkId }, select: { targetScheduleItemId: true } });
    if (!head) throw new AppError(MAIL_NOT_SENDABLE, 'The payment link does not exist');
    if (!(await this.isReminderStillWanted(ctx, head.targetScheduleItemId))) throw new AppError(MAIL_NOT_SENDABLE, 'The reminder is no longer needed');
    if (await ctx.tx.emailSuppression.findUnique({ where: { emailHash: emailHash(this.config.EMAIL_HASH_KEY, ctx.email.to), scope: 'all' }, select: { id: true } })) throw new AppError(MAIL_NOT_SENDABLE, 'The recipient is suppressed');

    const minted = await mintPaymentLinkToken(ctx.tx, linkId, this.gateway.mode);
    const item = await ctx.tx.paymentScheduleItem.findUniqueOrThrow({ where: { id: head.targetScheduleItemId }, select: { sequence: true, dueDate: true, currency: true } });
    const items = await ctx.tx.paymentScheduleItem.findMany({ where: { bookingId: minted.bookingId, state: 'active' }, select: { sequence: true, amountMinor: true } });
    const collected = await succeededPaymentsSource.collected(ctx.tx, minted.bookingId, this.gateway.mode);
    const due = payable(items, collected, item.sequence).next;
    if (!due) throw new AppError(MAIL_NOT_SENDABLE, 'There is nothing left to pay on this item');
    const b = await ctx.tx.booking.findUniqueOrThrow({
      where: { id: minted.bookingId },
      select: { reference: true, customer: { select: { givenName: true } }, package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } } },
    });
    const trip = `${en(b.package.edition.race.name)} ${b.package.edition.year}: ${en(b.package.name)}`;
    const link = `${new URL(this.config.WEB_ORIGIN).origin}/pay#token=${minted.token}`;
    const values = {
      givenName: b.customer.givenName, reference: b.reference, trip, amountDue: formatMinor(due.amountMinor, item.currency),
      dueDate: longDay(item.dueDate.toISOString().slice(0, 10)), expiresAt: dateTime(minted.expiresAt), link,
    };
    const custom = await this.templates.renderEmail(ctx.tx, PAYMENT_REMINDER_TEMPLATE.key, ctx.email.locale, values);
    if (custom) {
      // As for the payment link (task 5.1): the subject is stored and shown in the panel, so the token never goes in it,
      // and the body has to carry the link. Throwing rolls the minted token back.
      if (custom.subject.includes(minted.token) || !custom.text.includes(link)) throw new AppError(MAIL_NOT_SENDABLE, 'The reminder wording must put the link in the body and never in the subject');
      return { subject: custom.subject, text: custom.text };
    }
    return {
      subject: `A payment for booking ${b.reference} is due on ${values.dueDate}`,
      text: [
        `Hi ${b.customer.givenName},`, '',
        `A friendly reminder that the next payment for your booking ${b.reference} (${trip}) of ${values.amountDue} is due on ${values.dueDate}.`, '',
        `You can pay with this link, which works once and until ${values.expiresAt} (Brisbane time). The page shows the amount due.`, '',
        link, '',
        'If you have already paid, thank you, and you can ignore this email. Please do not forward it: anyone with the link can make this payment.', '',
        brand.name,
      ].join('\n'),
    };
  }

  /** The item is still active, uncovered and the first one owed, its booking can still take a payment, and no payment is in progress. */
  private async isReminderStillWanted(ctx: RenderContext, itemId: string): Promise<boolean> {
    const item = await ctx.tx.paymentScheduleItem.findUnique({ where: { id: itemId }, select: { bookingId: true, state: true, sequence: true } });
    if (!item || item.state !== 'active') return false;
    const b = await readBookingForPayments(ctx.tx, { id: item.bookingId });
    if (!b || !(REMINDABLE_STATES as readonly string[]).includes(b.status)) return false;
    const items = await ctx.tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { sequence: true, amountMinor: true } });
    const collected = await succeededPaymentsSource.collected(ctx.tx, b.id, this.gateway.mode);
    if (payable(items, collected).next?.sequence !== item.sequence) return false;
    // Never write to someone while they are paying.
    return !(await ctx.tx.payment.findUnique({ where: { liveBookingId: b.id }, select: { id: true } }));
  }
}
