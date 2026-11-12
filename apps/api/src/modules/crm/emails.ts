import { Inject, Injectable } from '@nestjs/common';
import { brand } from '@mt/shared';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import type { DeliveredEvent, ConsumerContext } from '../../platform/events/consumers';
import { AppError } from '../../platform/errors/safe-error';
import { MAIL_NOT_SENDABLE, MailService } from '../../platform/mail/mail.service';
import type { RenderContext, RenderedMail } from '../../platform/mail/templates';

export const QUOTE_SENT_TEMPLATE = { key: 'crm.quote_sent', version: 1 } as const;

/** The booking states that tell the customer something (plan 2.5, section 1, point 4). */
export const BOOKING_MAIL_STATES = ['requested', 'approved', 'declined', 'cancelled', 'expired'] as const;
export type BookingMailState = (typeof BOOKING_MAIL_STATES)[number];
export const bookingTemplate = (state: BookingMailState) => ({ key: `crm.booking_${state}`, version: 1 }) as const;

const PREFIX = 'bookings.booking.';
const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};
/** 123456 in AUD is "A$1,234.56". Only formats a stored amount; nothing is computed. */
export function formatMinor(minor: bigint, currency: string): string {
  const abs = minor < 0n ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'AUD' ? 'A$' : `${currency} `;
  return `${minor < 0n ? '-' : ''}${symbol}${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}
const dateTime = (d: Date): string => new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Australia/Brisbane' }).format(d);

/**
 * The emails that follow a booking's state and a quote's sending. Plain text in Australian English, built from ids at
 * send time. They never say a booking is confirmed (nothing is paid or confirmed yet), never include the staff's reason
 * for a decision, and never carry a payment link (payments are not live).
 */
@Injectable()
export class CrmEmails {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  private url(path: string): string {
    return `${new URL(this.config.WEB_ORIGIN).origin}${path}`;
  }

  /** The consumer of bookings.booking.*: one email per booking and state (the dedupe key). */
  async onBookingEvent(event: DeliveredEvent, { tx }: ConsumerContext): Promise<void> {
    const state = event.type.slice(PREFIX.length) as BookingMailState;
    if (!event.type.startsWith(PREFIX) || !BOOKING_MAIL_STATES.includes(state)) return;
    const bookingId = (event.payload as { bookingId?: string } | null)?.bookingId;
    if (!bookingId) return;
    const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: { id: true, customer: { select: { id: true, email: true, preferredLocale: true, anonymisedAt: true, deletedAt: true } }, quote: { select: { id: true } } } });
    if (!booking || booking.customer.anonymisedAt || booking.customer.deletedAt) return;
    // A booking made by accepting a quote is approved straight away: the customer already has the quote's email.
    if (state === 'requested' && booking.quote) return;
    const t = bookingTemplate(state);
    await this.mail.enqueue({
      to: booking.customer.email, templateKey: t.key, templateVersion: t.version, locale: booking.customer.preferredLocale,
      dedupeKey: `booking:${bookingId}:${state}`, customerId: booking.customer.id, relatedEntityType: 'Booking', relatedEntityId: bookingId,
    }, tx);
  }

  async renderBooking(state: BookingMailState, ctx: RenderContext): Promise<RenderedMail> {
    const id = ctx.email.relatedEntityId;
    if (!id) throw new AppError('mail_missing_reference', 'The email is not linked to a booking');
    const b = await ctx.tx.booking.findUnique({
      where: { id },
      select: {
        reference: true, currency: true, totalMinor: true, departureDate: true, approvedAt: true,
        customer: { select: { givenName: true, anonymisedAt: true } },
        package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } },
      },
    });
    if (!b || b.customer.anonymisedAt) throw new AppError(MAIL_NOT_SENDABLE, 'The booking or its customer is no longer available');
    const trip = `${en(b.package.edition.race.name)} ${b.package.edition.year}: ${en(b.package.name)}`;
    const link = this.url(`/trips/requests/${b.reference}`);
    const total = formatMinor(b.totalMinor, b.currency);
    const body: Record<BookingMailState, { subject: string; lines: string[] }> = {
      requested: {
        subject: `We have your booking request ${b.reference}`,
        lines: [
          `Thanks for your request for ${trip}.`,
          'This is a booking request, not a confirmed booking, and we have not charged you anything. We will check availability and email you.',
          `Total as quoted: ${total}.`,
        ],
      },
      approved: {
        subject: `Your booking request ${b.reference} is approved`,
        lines: [
          `Good news: we have approved your request for ${trip}, and we are holding your places.`,
          `Total: ${total}. We have not charged you anything yet, and the booking is not complete until we write to you about the next steps.`,
        ],
      },
      declined: {
        subject: `About your booking request ${b.reference}`,
        lines: [`We are sorry, but we cannot take your request for ${trip}. We have released the places we were holding and have not charged you anything.`],
      },
      cancelled: {
        subject: `Your booking request ${b.reference} was cancelled`,
        lines: [`Your request for ${trip} has been cancelled and the places we were holding are released.`],
      },
      expired: {
        subject: b.approvedAt ? `Your booking ${b.reference} has expired` : `Your booking request ${b.reference} has expired`,
        // A booking that was approved (a quote's always is) expires because the next steps did not happen, not because we did not look.
        lines: b.approvedAt
          ? [`The hold on your places for ${trip} has ended because the next steps were not completed in time, and the places are released. You are welcome to get in touch or send a new request.`]
          : [`We could not review your request for ${trip} in time, so it has expired and the places we were holding are released. You are welcome to send a new request.`],
      },
    };
    const m = body[state];
    return { subject: m.subject, text: [`Hi ${b.customer.givenName},`, '', ...m.lines.flatMap((l) => [l, '']), `Details: ${link}`, '', brand.name].join('\n') };
  }

  async renderQuote(ctx: RenderContext): Promise<RenderedMail> {
    const id = ctx.email.relatedEntityId;
    if (!id) throw new AppError('mail_missing_reference', 'The email is not linked to a quote');
    const q = await ctx.tx.quote.findUnique({
      where: { id },
      select: {
        reference: true, status: true, currency: true, totalMinor: true, depositMinor: true, expiresAt: true,
        customer: { select: { givenName: true, anonymisedAt: true, deletedAt: true } },
        package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } },
      },
    });
    // Withdrawn or expired before the send step ran: nothing to offer any more.
    if (!q || q.customer.anonymisedAt || q.customer.deletedAt || q.status !== 'sent' || !q.expiresAt) throw new AppError(MAIL_NOT_SENDABLE, 'The quote is no longer open');
    const trip = `${en(q.package.edition.race.name)} ${q.package.edition.year}: ${en(q.package.name)}`;
    return {
      subject: `Your quote ${q.reference} for ${en(q.package.edition.race.name)} ${q.package.edition.year}`,
      text: [
        `Hi ${q.customer.givenName},`, '',
        `We have prepared a quote for you: ${trip}.`, '',
        `Total: ${formatMinor(q.totalMinor, q.currency)}. We hold this price until ${dateTime(q.expiresAt)} (Brisbane time).`, '',
        'Accepting it reserves your places and does not take any payment. We will write to you about the next steps.', '',
        `Review and accept it here: ${this.url(`/quotes/${q.reference}`)}`, '',
        brand.name,
      ].join('\n'),
    };
  }
}
