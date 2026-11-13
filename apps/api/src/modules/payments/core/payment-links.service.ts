import { Inject, Injectable } from '@nestjs/common';
import { brand } from '@mt/shared';
import type { PaymentAttemptView, PaymentLinkRefreshView, PaymentLinkView, PaymentMethod, StartPayment } from '@mt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuditActor } from '../../../platform/audit/audit.service';
import { newToken, tokenHash } from '../../../platform/auth/tokens';
import type { AppConfig } from '../../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../../platform/database/prisma.service';
import { runTransaction } from '../../../platform/database/transaction';
import { AppError } from '../../../platform/errors/safe-error';
import { SettingsService } from '../../../platform/flags/flags.service';
import { conflict, notFound } from '../../../platform/http/api-error';
import { MAIL_NOT_SENDABLE, MailService } from '../../../platform/mail/mail.service';
import type { RenderContext, RenderedMail } from '../../../platform/mail/templates';
import { readBookingForPayments } from '../../bookings';
import type { BookingForPayments } from '../../bookings';
import { TemplatesService } from '../../templates';
import { PaymentAttemptSyncService } from './attempt-sync.service';
import { PaymentAttemptsService } from './attempts.service';
import { ProviderGateway } from './gateway';
import { payable, succeededPaymentsSource } from './payable';
import { PAYABLE_STATES, PAYMENT_TX_OPTIONS } from './payable-states';
import { PaymentRouting } from './routing';
import { PAYMENT_SETTINGS } from './settings';
import { TermsService } from './terms.service';

type Tx = Prisma.TransactionClient;
type Mode = 'test' | 'live';

export const PAYMENT_LINK_TEMPLATE = { key: 'payments.payment_link', version: 1 } as const;

const linkNotFound = () => notFound('payment_link_not_found', 'This payment link is not valid. It may have been used, replaced or expired.');
const day = (d: Date) => d.toISOString().slice(0, 10);
const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};
const dateTime = (d: Date): string => new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Australia/Brisbane' }).format(d);

interface LinkRow {
  id: string;
  bookingId: string;
  targetScheduleItemId: string;
  tokenHash: string | null;
  status: 'active' | 'used' | 'revoked';
  expiresAt: Date;
}

/** Why a booking cannot take a link's payment right now, or null when it can (the same order as checkout). */
function bookingRefusal(b: BookingForPayments, at: Date): 'nothing_to_pay' | 'booking_not_payable' | 'approval_expired' | null {
  if (b.status === 'balance_paid') return 'nothing_to_pay';
  if (!PAYABLE_STATES.includes(b.status)) return 'booking_not_payable';
  if (b.status === 'approved' && (!b.approvalExpiresAt || b.approvalExpiresAt.getTime() <= at.getTime())) return 'approval_expired';
  return null;
}

/**
 * Whether a link can still pay: active and in date, its booking able to pay, its target item still in the plan and not
 * fully paid (plan 5.1, section 5, review M1). Returns the target and the amount due up to it, from the plan.
 */
async function usable(db: Tx, link: LinkRow, b: BookingForPayments, at: Date, mode: Mode): Promise<{ targetSequence: number; amountDueMinor: bigint } | null> {
  if (link.status !== 'active' || link.expiresAt.getTime() <= at.getTime() || link.bookingId !== b.id) return null;
  if (bookingRefusal(b, at)) return null;
  const items = await db.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { id: true, sequence: true, amountMinor: true } });
  const target = items.find((i) => i.id === link.targetScheduleItemId);
  if (!target) return null;
  const collected = await succeededPaymentsSource.collected(db, b.id, mode);
  const due = payable(items, collected, target.sequence).next;
  return due ? { targetSequence: target.sequence, amountDueMinor: due.amountMinor } : null;
}

const LINK_SELECT = { id: true, bookingId: true, targetScheduleItemId: true, tokenHash: true, status: true, expiresAt: true } as const;

/**
 * Mints the token of a link inside the email's send step (plan 0.1, 4.6): booking locked first, then the link (lock
 * order Booking → PaymentLink, review M2). Refuses unless the link can still pay and its customer's account is open.
 * Only the hash is stored; the token goes into the email body and nowhere else. A failed send rolls the hash back.
 * The e2e script calls this same function (review m6).
 */
export async function mintPaymentLinkToken(tx: Tx, linkId: string, mode: Mode): Promise<{ token: string; bookingId: string; expiresAt: Date }> {
  const head = await tx.paymentLink.findUnique({ where: { id: linkId }, select: { bookingId: true } });
  if (!head) throw new AppError(MAIL_NOT_SENDABLE, 'The payment link does not exist');
  const b = await readBookingForPayments(tx, { id: head.bookingId }, true);
  const rows = await tx.$queryRaw<LinkRow[]>`
    SELECT id::text AS id, "bookingId"::text AS "bookingId", "targetScheduleItemId"::text AS "targetScheduleItemId", "tokenHash", status::text AS status, "expiresAt"
    FROM payment_links WHERE id = ${linkId}::uuid FOR UPDATE`;
  const link = rows[0];
  const [{ at }] = (await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`) as [{ at: Date }];
  if (!b || !link || link.tokenHash !== null || !(await usable(tx, link, b, at, mode))) throw new AppError(MAIL_NOT_SENDABLE, 'The payment link can no longer pay');
  const customer = await tx.customer.findUnique({ where: { id: b.customerId }, select: { anonymisedAt: true, deletedAt: true } });
  if (!customer || customer.anonymisedAt || customer.deletedAt) throw new AppError(MAIL_NOT_SENDABLE, 'The customer account is closed');
  const token = newToken();
  await tx.paymentLink.update({ where: { id: linkId }, data: { tokenHash: tokenHash(token) } });
  return { token, bookingId: b.id, expiresAt: link.expiresAt };
}

/**
 * Payment links (task 5.1, plan docs/plans/5.1-customer-area.md, section 5): a single-use capability issued by staff and
 * emailed to the booking's own address, which pays one plan item without a session, never more than the signed-in owner
 * could at checkout. The amount is always the plan's; the token never reaches a log, a URL the server sees or the panel.
 */
@Injectable()
export class PaymentLinksService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentRouting) private readonly routing: PaymentRouting,
    @Inject(TermsService) private readonly terms: TermsService,
    @Inject(PaymentAttemptsService) private readonly attempts: PaymentAttemptsService,
    @Inject(PaymentAttemptSyncService) private readonly sync: PaymentAttemptSyncService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---- Staff ----

  /** Sends a link for the next payable item; any active link of the booking is revoked in the same transaction. */
  async send(bookingId: string, actor: AuditActor) {
    const days = await this.settings.get(PAYMENT_SETTINGS.paymentLinkValidDays.key, PAYMENT_SETTINGS.paymentLinkValidDays.fallback);
    const id = await runTransaction(this.prisma, async (tx) => {
      const b = await readBookingForPayments(tx, { id: bookingId }, true);
      if (!b) throw notFound('booking_not_found', 'Booking not found');
      const [{ at }] = (await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`) as [{ at: Date }];
      const refusal = bookingRefusal(b, at);
      if (refusal === 'nothing_to_pay') throw conflict('nothing_to_pay', 'There is nothing to pay on this booking right now');
      if (refusal === 'approval_expired') throw conflict('approval_expired', 'The time to pay the deposit for this booking has run out');
      if (refusal) throw conflict('booking_not_payable', 'This booking cannot take a payment in its current state');
      const items = await tx.paymentScheduleItem.findMany({ where: { bookingId: b.id, state: 'active' }, select: { id: true, sequence: true, amountMinor: true } });
      const collected = await succeededPaymentsSource.collected(tx, b.id, this.gateway.mode);
      const due = payable(items, collected).next;
      if (!due) throw conflict('nothing_to_pay', 'There is nothing to pay on this booking right now');
      const target = items.find((i) => i.sequence === due.sequence)!;
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: b.customerId }, select: { id: true, email: true, preferredLocale: true, anonymisedAt: true, deletedAt: true } });
      if (customer.anonymisedAt || customer.deletedAt) throw conflict('customer_closed', 'This customer account is closed');

      const revoked = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE payment_links SET status = 'revoked', "revokedAt" = clock_timestamp()
        WHERE "bookingId" = ${b.id}::uuid AND status = 'active' RETURNING id::text AS id`;
      for (const r of revoked) {
        await this.audit.record(tx, { actor, action: 'payments.paymentLink.revoked', entityType: 'PaymentLink', entityId: r.id, before: { status: 'active' }, after: { status: 'revoked' }, context: { bookingId: b.id, reason: 'replaced' } });
      }
      let expiresAt = new Date(at.getTime() + days * 86_400_000);
      if (b.status === 'approved' && b.approvalExpiresAt && b.approvalExpiresAt < expiresAt) expiresAt = b.approvalExpiresAt;
      const link = await tx.paymentLink.create({ data: { bookingId: b.id, targetScheduleItemId: target.id, expiresAt, createdById: actor.id! }, select: { id: true } });
      await this.audit.record(tx, {
        actor, action: 'payments.paymentLink.sent', entityType: 'PaymentLink', entityId: link.id,
        after: { status: 'active', expiresAt: expiresAt.toISOString(), targetSequence: target.sequence }, context: { bookingId: b.id },
      });
      await this.mail.enqueue({
        to: customer.email, templateKey: PAYMENT_LINK_TEMPLATE.key, templateVersion: PAYMENT_LINK_TEMPLATE.version, locale: customer.preferredLocale,
        dedupeKey: `payment-link:${link.id}`, customerId: customer.id, relatedEntityType: 'PaymentLink', relatedEntityId: link.id,
      }, tx);
      return link.id;
    }, PAYMENT_TX_OPTIONS);
    return (await this.adminLinks(bookingId)).find((l) => l.id === id)!;
  }

  /** Revokes a link (booking locked first). A live attempt started through it is left alone: its money counts if it arrives. */
  async revoke(linkId: string, actor: AuditActor) {
    const head = await this.prisma.paymentLink.findUnique({ where: { id: linkId }, select: { bookingId: true } });
    if (!head) throw notFound('payment_link_not_found', 'Payment link not found');
    await runTransaction(this.prisma, async (tx) => {
      await readBookingForPayments(tx, { id: head.bookingId }, true);
      const n = await tx.$executeRaw`
        UPDATE payment_links SET status = 'revoked', "revokedAt" = clock_timestamp() WHERE id = ${linkId}::uuid AND status = 'active'`;
      if (n === 1) await this.audit.record(tx, { actor, action: 'payments.paymentLink.revoked', entityType: 'PaymentLink', entityId: linkId, before: { status: 'active' }, after: { status: 'revoked' }, context: { bookingId: head.bookingId, reason: 'staff' } });
    }, PAYMENT_TX_OPTIONS);
    return (await this.adminLinks(head.bookingId)).find((l) => l.id === linkId)!;
  }

  /** The panel's view of a booking's links: never the hash. */
  async adminLinks(bookingId: string) {
    const now = Date.now();
    const rows = await this.prisma.paymentLink.findMany({
      where: { bookingId }, orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, expiresAt: true, createdAt: true, usedAt: true, revokedAt: true, tokenHash: true, targetScheduleItem: { select: { sequence: true } } },
    });
    return rows.map(({ tokenHash: hash, targetScheduleItem, ...r }) => ({ ...r, sent: hash !== null, expired: r.expiresAt.getTime() <= now, targetSequence: targetScheduleItem.sequence }));
  }

  // ---- The send step ----

  async renderEmail(ctx: RenderContext): Promise<RenderedMail> {
    const linkId = ctx.email.relatedEntityId;
    if (!linkId || ctx.email.relatedEntityType !== 'PaymentLink') throw new AppError(MAIL_NOT_SENDABLE, 'The email is not linked to a payment link');
    const minted = await mintPaymentLinkToken(ctx.tx, linkId, this.gateway.mode);
    const b = await ctx.tx.booking.findUniqueOrThrow({
      where: { id: minted.bookingId },
      select: { reference: true, customer: { select: { givenName: true } }, package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } } },
    });
    const trip = `${en(b.package.edition.race.name)} ${b.package.edition.year}: ${en(b.package.name)}`;
    const link = `${new URL(this.config.WEB_ORIGIN).origin}/pay#token=${minted.token}`;
    const values = { givenName: b.customer.givenName, reference: b.reference, trip, expiresAt: dateTime(minted.expiresAt), link };
    const custom = await this.templates.renderEmail(ctx.tx, PAYMENT_LINK_TEMPLATE.key, ctx.email.locale, values);
    if (custom) return { subject: custom.subject, text: custom.text };
    return {
      subject: `Your payment link for booking ${b.reference}`,
      text: [
        `Hi ${b.customer.givenName},`, '',
        `Here is a link to make the next payment for your booking ${b.reference}: ${trip}.`, '',
        `It works once, until ${values.expiresAt} (Brisbane time). The page shows the amount due; you pay on our payment provider's secure page.`, '',
        link, '',
        'Please do not forward this email: anyone with the link can make this payment. You can also pay from your account.', '',
        brand.name,
      ].join('\n'),
    };
  }

  // ---- Public, by token ----

  private async byToken(token: string): Promise<LinkRow | null> {
    return this.prisma.paymentLink.findUnique({ where: { tokenHash: tokenHash(token) }, select: LINK_SELECT }) as Promise<LinkRow | null>;
  }

  private async resolve(token: string): Promise<{ link: LinkRow; booking: BookingForPayments; targetSequence: number; amountDueMinor: bigint }> {
    const link = await this.byToken(token);
    if (!link) throw linkNotFound();
    const booking = await readBookingForPayments(this.prisma, { id: link.bookingId });
    const ok = booking ? await usable(this.prisma, link, booking, new Date(), this.gateway.mode) : null;
    if (!booking || !ok) throw linkNotFound();
    return { link, booking, ...ok };
  }

  async view(token: string): Promise<PaymentLinkView> {
    const { link, booking: b, amountDueMinor } = await this.resolve(token);
    const pkg = await this.prisma.booking.findUniqueOrThrow({ where: { id: b.id }, select: { departureDate: true, returnDate: true, package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } } } });
    const methods = await this.routing.methods(this.prisma, { currency: b.currency, country: b.residenceCountry });
    const terms = await this.terms.current();
    const accepted = terms ? await this.prisma.termsAcceptance.findUnique({
      where: { bookingId_documentSlug_locale_textDigest: { bookingId: b.id, documentSlug: terms.slug, locale: terms.locale, textDigest: terms.digest } }, select: { id: true },
    }) : null;
    const live = await this.prisma.payment.findUnique({ where: { liveBookingId: b.id }, select: { status: true, method: true } });
    return {
      reference: b.reference,
      package: { name: pkg.package.name as Record<string, string> },
      race: { name: pkg.package.edition.race.name as Record<string, string> },
      editionYear: pkg.package.edition.year,
      departureDate: day(pkg.departureDate), returnDate: day(pkg.returnDate),
      currency: b.currency, amountDueMinor: amountDueMinor.toString(),
      payable: methods.length > 0, ...(methods.length === 0 ? { notPayableReason: 'no_payment_method_available' } : {}),
      methods, termsAccepted: accepted !== null,
      liveAttempt: live ? { status: live.status, method: live.method as PaymentMethod } : null,
      expiresAt: link.expiresAt.toISOString(),
    };
  }

  async pay(token: string, method: StartPayment['method'], key: string): Promise<PaymentAttemptView> {
    const { link, targetSequence } = await this.resolve(token);
    return this.attempts.startViaLink({ id: link.id, bookingId: link.bookingId, tokenHash: link.tokenHash!, targetSequence }, method, key);
  }

  /** Where this link's latest attempt stands, asking the gateway while it is live. Works on a used link while in date. */
  async refresh(token: string): Promise<PaymentLinkRefreshView> {
    const link = await this.byToken(token);
    if (!link || link.status === 'revoked' || link.expiresAt.getTime() <= Date.now()) throw linkNotFound();
    const live = await this.prisma.payment.findFirst({ where: { liveBookingId: link.bookingId, paymentLinkId: link.id }, select: { id: true } });
    if (live) {
      const waiting = await this.prisma.task.count({ where: { sourceRef: `payments:coverage_failed:${live.id}`, status: 'open', deletedAt: null } });
      if (waiting === 0) {
        try {
          await this.sync.run(live.id, 'sync');
        } catch (err) {
          throw this.attempts.forCustomer(err);
        }
      }
    }
    const latest = await this.prisma.payment.findFirst({ where: { paymentLinkId: link.id }, orderBy: { attemptNumber: 'desc' }, select: { status: true, method: true, amountMinor: true, currency: true } });
    const after = await this.prisma.paymentLink.findUniqueOrThrow({ where: { id: link.id }, select: { status: true } });
    return {
      used: after.status === 'used',
      attempt: latest ? { status: latest.status, method: latest.method as PaymentMethod, amountMinor: latest.amountMinor.toString(), currency: latest.currency } : null,
    };
  }
}
