import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { CreateQuote, listQuotesQuerySchema } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService, SYSTEM_ACTOR } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { OutboxService } from '../../platform/events/outbox.service';
import { SettingsService } from '../../platform/flags/flags.service';
import { conflict, notFound } from '../../platform/http/api-error';
import { MailService } from '../../platform/mail/mail.service';
import { ReferenceGenerator, dbNow, jsonOf, snapshotBreakdownSchema, snapshotConfigurationSchema, type SnapshotConfiguration, startOfDayInBrisbane, todayInBrisbane } from '../bookings';
import { QuoteService as PricingQuoteService, REDEEM_TX_OPTIONS, publicPromoStatus } from '../pricing';
import { safeError } from '../../platform/errors/safe-error';
import { QUOTE_SENT_TEMPLATE } from './emails';
import { CRM_EVENTS } from './manifest';
import { CRM_SETTINGS } from './settings';

export const QUOTE_TX_OPTIONS = { ...REDEEM_TX_OPTIONS, timeout: 15_000, maxWait: 5_000 } as const;

/** What the staff panel sees: the quote with its customer, the price it holds (with the rule trace) and its booking. */
const STAFF_SELECT = {
  id: true, reference: true, status: true, currency: true, totalMinor: true, depositMinor: true, balanceDueDate: true, departureDate: true, returnDate: true, validForDays: true,
  expiresAt: true, sentAt: true, acceptedAt: true, expiredAt: true, withdrawnAt: true, version: true, createdAt: true, priceBreakdown: true, configuration: true, packageId: true, createdById: true,
  customer: { select: { id: true, givenName: true, familyName: true, email: true } },
  package: { select: { id: true, name: true, edition: { select: { year: true, race: { select: { name: true } } } } } },
  booking: { select: { id: true, reference: true, status: true } },
} as const;

/**
 * Quotes (plan 2.5): staff prepare a configuration for a customer, the engine prices it (the request has no amount), the
 * result is kept as it was offered, and the quote is held until it expires. Accepting it is QuoteAcceptanceService.
 */
/** The request that prices a stored, priced configuration again: choices only, as the public site sends them. */
function requestOf(c: SnapshotConfiguration) {
  return {
    packageId: c.packageId,
    rooms: c.rooms.map((r) => ({ roomOptionId: r.roomOptionId, travellers: r.travellers.map((t) => (t.raceDistanceId ? { participationType: t.participationType, raceDistanceId: t.raceDistanceId } : { participationType: t.participationType })) })),
    extraNightsBefore: c.extraNightsBefore,
    extraNightsAfter: c.extraNightsAfter,
    extras: c.extras.map((e) => (e.travellerSlots.length > 0 ? { extraId: e.extraId, travellerSlots: e.travellerSlots } : { extraId: e.extraId, quantity: e.quantity })),
  };
}

@Injectable()
export class QuoteService {
  private readonly logger = new Logger('Crm');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PricingQuoteService) private readonly pricing: PricingQuoteService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(ReferenceGenerator) private readonly references: ReferenceGenerator,
  ) {}

  async create(actor: AuditActor, body: CreateQuote) {
    const validForDays = body.validForDays ?? (await this.settings.get(CRM_SETTINGS.quoteValidityDays.key, CRM_SETTINGS.quoteValidityDays.fallback));
    const id = await runTransaction(this.prisma, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: body.customerId, deletedAt: null, anonymisedAt: null }, select: { id: true } });
      if (!customer) throw notFound('customer_not_found', 'Customer not found');
      // The package, shared: its sale status and price versions cannot change until this commits (as for a request).
      const pkg = await tx.$queryRaw<Array<{ editionId: string }>>`SELECT "editionId" FROM packages WHERE id = ${body.configuration.packageId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
      if (pkg.length === 0) throw notFound('package_not_found', 'Package not found');
      const at = await dbNow(tx);
      const { breakdown } = await this.pricing.priceWithPromoRef(tx, body.configuration, { audience: 'public', now: at });
      if (breakdown.depositMinor === null || breakdown.balanceMinor === null) throw conflict('deposit_not_configured', 'This package is not ready for sale');
      if (breakdown.departureDate <= todayInBrisbane(at)) throw conflict('package_departed', 'This trip has already started');
      // Ids, slots, codes, dates and amounts only: checked before it is stored, like a booking snapshot.
      const configuration = snapshotConfigurationSchema.parse(jsonOf(breakdown.configuration));
      const priceBreakdown = snapshotBreakdownSchema.parse(jsonOf(breakdown));
      const data = {
        customerId: customer.id, packageId: body.configuration.packageId, editionId: pkg[0]!.editionId, configuration, priceBreakdown: priceBreakdown as unknown as Prisma.InputJsonObject,
        totalMinor: breakdown.totalMinor, depositMinor: breakdown.depositMinor, currency: breakdown.currency, priceVersionId: breakdown.priceVersionId, engineVersion: breakdown.engineVersion,
        departureDate: new Date(`${breakdown.departureDate}T00:00:00.000Z`), returnDate: new Date(`${breakdown.returnDate}T00:00:00.000Z`), balanceDueDate: new Date(`${breakdown.balanceDueDate}T00:00:00.000Z`),
        validForDays, createdById: actor.id!,
      };
      let quoteId: string | null = null;
      for (let attempt = 0; attempt < 5 && !quoteId; attempt++) {
        const rows = await tx.quote.createManyAndReturn({ data: [{ ...data, reference: this.references.next().replace(/^MT-/, 'QT-') }], skipDuplicates: true, select: { id: true } });
        quoteId = rows[0]?.id ?? null;
      }
      if (!quoteId) throw conflict('busy_try_again', 'Many people are doing this at once. Try again.');
      await this.audit.record(tx, {
        actor, action: 'crm.quote.created', entityType: 'Quote', entityId: quoteId, model: 'Quote',
        after: { status: 'draft', customerId: customer.id, packageId: data.packageId, totalMinor: breakdown.totalMinor.toString(), depositMinor: breakdown.depositMinor.toString(), currency: breakdown.currency, validForDays },
      });
      return quoteId;
    }, QUOTE_TX_OPTIONS);
    return this.get(id);
  }

  async list(q: z.infer<typeof listQuotesQuerySchema>) {
    const rows = await this.prisma.quote.findMany({
      where: { status: q.status, customerId: q.customerId, ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
      orderBy: { id: 'desc' }, take: q.limit + 1,
      select: { id: true, reference: true, status: true, currency: true, totalMinor: true, expiresAt: true, version: true, createdAt: true, customer: { select: { id: true, givenName: true, familyName: true, email: true } }, package: { select: { name: true } } },
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items: jsonOf(items), nextCursor: more ? items[items.length - 1]!.id : null };
  }

  async get(id: string) {
    const q = await this.prisma.quote.findUnique({ where: { id }, select: STAFF_SELECT });
    if (!q) throw notFound('quote_not_found', 'Quote not found');
    return jsonOf(q);
  }

  /** draft → sent: sets the expiry (the database clock, never past the departure day) and queues the email, in one transaction. */
  async send(actor: AuditActor, id: string, version: number) {
    await runTransaction(this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string; version: number; customerId: string; validForDays: number; departureDate: Date; balanceDueDate: Date; reference: string; packageId: string; configuration: unknown; priceBreakdown: unknown; totalMinor: bigint; depositMinor: bigint; priceVersionId: string }>>`
        SELECT id, status::text AS status, version, "customerId", "validForDays", "departureDate", "balanceDueDate", reference, "packageId", configuration, "priceBreakdown", "totalMinor", "depositMinor", "priceVersionId" FROM quotes WHERE id = ${id}::uuid FOR UPDATE`;
      const q = rows[0];
      if (!q) throw notFound('quote_not_found', 'Quote not found');
      if (q.status !== 'draft') throw conflict('transition_not_allowed', 'Only a draft quote can be sent');
      if (q.version !== version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      const customer = await tx.customer.findFirst({ where: { id: q.customerId, deletedAt: null, anonymisedAt: null }, select: { id: true, email: true, preferredLocale: true } });
      if (!customer) throw conflict('customer_closed', 'This account is closed');
      const at = await dbNow(tx);
      const departure = q.departureDate.toISOString().slice(0, 10);
      if (departure <= todayInBrisbane(at)) throw conflict('package_departed', 'This trip has already started');
      // The price was worked out when the draft was made; the offer starts now, so it is worked out again and must be the same.
      await tx.$queryRaw`SELECT 1 FROM packages WHERE id = ${q.packageId}::uuid FOR SHARE`;
      const fresh = await this.pricing.priceIn(tx, requestOf(q.configuration as SnapshotConfiguration), { audience: 'public', now: at });
      const held = q.priceBreakdown as { discountsMinor: string; surchargesMinor: string; fullPaymentDue: boolean };
      if (fresh.totalMinor !== q.totalMinor || fresh.depositMinor !== q.depositMinor || fresh.priceVersionId !== q.priceVersionId || fresh.discountsMinor.toString() !== held.discountsMinor || fresh.surchargesMinor.toString() !== held.surchargesMinor) {
        throw conflict('quote_price_changed', 'The price has changed since this draft was made. Create a new quote.');
      }
      // Until the balance date the deposit is smaller than the total; accepting after it would keep a stale deposit and date.
      const balanceDue = q.balanceDueDate.toISOString().slice(0, 10);
      let limit = startOfDayInBrisbane(departure).getTime();
      if (!held.fullPaymentDue) {
        const balanceStart = startOfDayInBrisbane(balanceDue).getTime();
        if (balanceStart <= at.getTime()) throw conflict('quote_price_changed', 'The balance date has passed. Create a new quote.');
        limit = Math.min(limit, balanceStart);
      }
      const expiresAt = new Date(Math.min(at.getTime() + q.validForDays * 86_400_000, limit));
      const n = await tx.$executeRaw`
        UPDATE quotes SET status = 'sent', "sentAt" = ${at}, "expiresAt" = ${expiresAt}, version = version + 1, "updatedAt" = ${at}
        WHERE id = ${id}::uuid AND status = 'draft' AND version = ${version}`;
      if (n !== 1) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      await this.mail.enqueue({
        to: customer.email, templateKey: QUOTE_SENT_TEMPLATE.key, templateVersion: QUOTE_SENT_TEMPLATE.version, locale: customer.preferredLocale,
        dedupeKey: `quote:${id}:sent`, customerId: customer.id, relatedEntityType: 'Quote', relatedEntityId: id,
      }, tx);
      await this.audit.record(tx, {
        actor, action: 'crm.quote.status_changed', entityType: 'Quote', entityId: id, model: 'Quote',
        before: { status: 'draft' }, after: { status: 'sent', expiresAt: expiresAt.toISOString() }, context: { event: 'send' },
      });
      await this.outbox.publish(tx, {
        type: CRM_EVENTS.quoteSent, aggregateType: 'Quote', aggregateId: id, aggregateVersion: version + 1,
        payload: { quoteId: id, customerId: q.customerId }, actorType: actor.type, actorId: actor.id ?? undefined,
      });
    }, QUOTE_TX_OPTIONS);
    return this.get(id);
  }

  /** draft | sent → withdrawn. A quote that was accepted or has expired is final. */
  async withdraw(actor: AuditActor, id: string, version: number) {
    await runTransaction(this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string; version: number }>>`SELECT status::text AS status, version FROM quotes WHERE id = ${id}::uuid FOR UPDATE`;
      const q = rows[0];
      if (!q) throw notFound('quote_not_found', 'Quote not found');
      if (q.status !== 'draft' && q.status !== 'sent') throw conflict('transition_not_allowed', 'This quote can no longer be withdrawn');
      if (q.version !== version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      const at = await dbNow(tx);
      const n = await tx.$executeRaw`
        UPDATE quotes SET status = 'withdrawn', "withdrawnAt" = ${at}, version = version + 1, "updatedAt" = ${at}
        WHERE id = ${id}::uuid AND status IN ('draft', 'sent') AND version = ${version}`;
      if (n !== 1) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      await this.audit.record(tx, {
        actor, action: 'crm.quote.status_changed', entityType: 'Quote', entityId: id, model: 'Quote',
        before: { status: q.status }, after: { status: 'withdrawn' }, context: { event: 'withdraw' },
      });
    }, QUOTE_TX_OPTIONS);
    return this.get(id);
  }

  /** The customer's view of a quote they were sent: the price as offered (no rule trace, no internal ids). */
  async customerView(reference: string) {
    const q = await this.prisma.quote.findUnique({
      where: { reference },
      select: {
        reference: true, status: true, currency: true, totalMinor: true, depositMinor: true, departureDate: true, returnDate: true, balanceDueDate: true, expiresAt: true,
        priceBreakdown: true, package: { select: { slug: true, name: true, edition: { select: { year: true, race: { select: { slug: true, name: true } } } } } },
        booking: { select: { reference: true } },
      },
    });
    if (!q || q.status === 'draft') throw notFound('not_found', 'Not found');
    const at = await this.prisma.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
    const held = q.priceBreakdown as unknown as z.infer<typeof snapshotBreakdownSchema>;
    const acceptable = q.status === 'sent' && q.expiresAt !== null && q.expiresAt.getTime() > at[0]!.at.getTime();
    return jsonOf({
      reference: q.reference, status: q.status, acceptable, expiresAt: q.expiresAt, departureDate: q.departureDate, returnDate: q.returnDate, balanceDueDate: q.balanceDueDate,
      currency: q.currency, totalMinor: q.totalMinor, depositMinor: q.depositMinor, bookingReference: q.booking?.reference ?? null,
      package: { slug: q.package.slug, name: q.package.name, editionYear: q.package.edition.year, race: q.package.edition.race },
      // A list of what the customer may see: no ids, no rule trace, no configuration.
      price: {
        subtotals: held.subtotals, surchargesMinor: held.surchargesMinor, discountsMinor: held.discountsMinor, totalMinor: held.totalMinor,
        depositMinor: held.depositMinor, balanceMinor: held.balanceMinor, balanceDueDate: held.balanceDueDate, fullPaymentDue: held.fullPaymentDue,
        promo: { status: publicPromoStatus(held.promo.status) },
      },
    });
  }

  /** Marks sent quotes past their expiry as expired. Each in its own transaction; one failure does not stop the rest. */
  async expireDue(limit = 100): Promise<{ expired: number; failed: number }> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM quotes WHERE status = 'sent' AND "expiresAt" <= clock_timestamp() ORDER BY "expiresAt", id LIMIT ${limit}`;
    let expired = 0;
    let failed = 0;
    for (const { id } of due) {
      try {
        const done = await runTransaction(this.prisma, async (tx) => {
          const rows = await tx.$queryRaw<Array<{ version: number }>>`
            SELECT version FROM quotes WHERE id = ${id}::uuid AND status = 'sent' AND "expiresAt" <= clock_timestamp() FOR UPDATE SKIP LOCKED`;
          if (rows.length === 0) return false;
          const at = await dbNow(tx);
          await tx.$executeRaw`UPDATE quotes SET status = 'expired', "expiredAt" = ${at}, version = version + 1, "updatedAt" = ${at} WHERE id = ${id}::uuid AND status = 'sent'`;
          await this.audit.record(tx, { actor: SYSTEM_ACTOR, action: 'crm.quote.status_changed', entityType: 'Quote', entityId: id, model: 'Quote', before: { status: 'sent' }, after: { status: 'expired' }, context: { event: 'expire' } });
          await this.outbox.publish(tx, { type: CRM_EVENTS.quoteExpired, aggregateType: 'Quote', aggregateId: id, aggregateVersion: rows[0]!.version + 1, payload: { quoteId: id }, actorType: 'system' });
          return true;
        }, QUOTE_TX_OPTIONS);
        if (done) expired++;
      } catch (err) {
        failed++;
        this.logger.error(`quote expiry failed: ${safeError(err).code}`);
      }
    }
    return { expired, failed };
  }
}
