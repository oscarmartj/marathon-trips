import { Inject, Injectable } from '@nestjs/common';
import { brand } from '@mt/shared';
import type { z } from 'zod';
import type { listWaitlistQuerySchema } from '@mt/shared';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { conflict, unprocessable } from '../../platform/http/api-error';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { AppError } from '../../platform/errors/safe-error';
import { MAIL_NOT_SENDABLE, MailService } from '../../platform/mail/mail.service';
import type { RenderContext, RenderedMail } from '../../platform/mail/templates';
import { WAITLIST_EVENTS } from './manifest';
import { OFFER_TEMPLATE, WAITLIST_SETTINGS } from './tokens';

type Tx = Prisma.TransactionClient;

export interface JoinWaitlistInput {
  customerId: string;
  email: string;
  countryOfResidence: string;
  packageId: string;
  /** People the request was for: a count, not their names. */
  travellers: number;
  requestKeyHash: string;
  requestConfigHash: string;
  /** HMAC of the contact sent with the request (as for booking requests): the same key with another contact is refused. */
  requestContactHmac: string;
  actor: AuditActor;
  /** Why the person waits. Default `non_resident` (task 2.6); `sold_out` (task 6.5) also keeps the request to price. */
  reason?: 'non_resident' | 'sold_out';
  /** The request (rooms, extra nights, extras; no contact, no code) a sold out entry is offered a place for. */
  configuration?: Prisma.InputJsonObject;
}

export interface JoinedWaitlist {
  entryId: string;
  created: boolean;
}

/** `<packageId>:<position>`, as the schema checked it. */
function parseCursor(cursor: string): { packageId: string; position: number } {
  const [packageId, position] = cursor.split(':');
  return { packageId: packageId!, position: Number(position) };
}

/** JSON-safe copy: instants as ISO strings. */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The waiting list (task 2.6). Someone who does not live in a country we sell to joins the list for a package instead of
 * sending a booking request: no price is kept, no stock is held, nothing is charged. The caller (bookings) has already
 * locked the customer FOR UPDATE, so two requests of one customer reach this one after the other; the unique indexes in
 * migration 0016 are the net behind that lock. Offers and promotion arrive with task 6.5.
 */
@Injectable()
export class WaitlistService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Set by bookings (it owns the claims): closes an offered entry, giving its places back and offering them on. */
  private offerCloser: ((tx: Tx, entryId: string, to: 'withdrawn', actor: AuditActor) => Promise<unknown>) | null = null;
  registerOfferCloser(fn: (tx: Tx, entryId: string, to: 'withdrawn', actor: AuditActor) => Promise<unknown>): void {
    this.offerCloser = fn;
  }
  async closeHeldOffer(tx: Tx, entryId: string, actor: AuditActor): Promise<void> {
    if (!this.offerCloser) throw new AppError('waitlist_offer_closer_missing', 'The bookings module has not registered how an offer is closed');
    await this.offerCloser(tx, entryId, 'withdrawn', actor);
  }

  /** The entry this customer made with this Idempotency-Key, if any (bookings checks it before it decides what a request becomes). */
  findByKey(tx: Tx, customerId: string, requestKeyHash: string) {
    return tx.waitlistEntry.findUnique({
      where: { customerId_requestKeyHash: { customerId, requestKeyHash } },
      select: { id: true, requestConfigHash: true, requestContactHmac: true },
    });
  }

  /** Joins in the caller's transaction. Idempotent per Idempotency-Key, and one live entry per customer and package. */
  async joinIn(tx: Tx, input: JoinWaitlistInput): Promise<JoinedWaitlist> {
    // The same Idempotency-Key again (a retry after the commit): the same entry, or 422 if the body or contact changed.
    const sameKey = await this.findByKey(tx, input.customerId, input.requestKeyHash);
    if (sameKey) {
      if (sameKey.requestConfigHash === input.requestConfigHash && sameKey.requestContactHmac === input.requestContactHmac) return { entryId: sameKey.id, created: false };
      throw unprocessable('idempotency_key_reused', 'This Idempotency-Key was used with a different request body');
    }

    // Asking again for the same package does not queue twice: the place in the queue is kept, the head count refreshed.
    const reason = input.reason ?? 'non_resident';
    const live = await tx.waitlistEntry.findFirst({
      where: { customerId: input.customerId, packageId: input.packageId, reason, status: { in: ['waiting', 'offered'] } },
      select: { id: true, travellers: true, countryOfResidence: true, version: true, requestConfigHash: true },
    });
    if (live && reason === 'sold_out') {
      // The request an entry waits for never changes (it is what the offer is priced from): another choice means leaving first.
      if (live.requestConfigHash !== input.requestConfigHash) throw conflict('already_on_waitlist', 'You are already on the waiting list for this trip with a different choice. Leave the list first to change it.');
      return { entryId: live.id, created: false };
    }
    if (live) {
      if (live.travellers !== input.travellers || live.countryOfResidence !== input.countryOfResidence) {
        await tx.waitlistEntry.update({ where: { id: live.id }, data: { travellers: input.travellers, countryOfResidence: input.countryOfResidence, version: { increment: 1 } } });
        // The country is personal data: the audit service keeps it out of `changes` and in the personal values table.
        await this.audit.record(tx, {
          actor: input.actor, action: 'waitlist.entry.updated', entityType: 'WaitlistEntry', entityId: live.id, model: 'WaitlistEntry',
          before: { travellers: live.travellers, countryOfResidence: live.countryOfResidence }, after: { travellers: input.travellers, countryOfResidence: input.countryOfResidence },
        });
      }
      return { entryId: live.id, created: false };
    }

    const entry = await tx.waitlistEntry.create({
      data: {
        email: input.email, customerId: input.customerId, reason, packageId: input.packageId, countryOfResidence: input.countryOfResidence,
        travellers: input.travellers, ...(input.configuration ? { configuration: input.configuration } : {}), requestKeyHash: input.requestKeyHash, requestConfigHash: input.requestConfigHash, requestContactHmac: input.requestContactHmac,
      },
      select: { id: true, position: true },
    });
    await this.audit.record(tx, {
      actor: input.actor, action: 'waitlist.entry.joined', entityType: 'WaitlistEntry', entityId: entry.id, model: 'WaitlistEntry',
      after: { status: 'waiting', reason, customerId: input.customerId, packageId: input.packageId, travellers: input.travellers, countryOfResidence: input.countryOfResidence, position: entry.position },
    });
    await this.outbox.publish(tx, {
      type: WAITLIST_EVENTS.joined, aggregateType: 'WaitlistEntry', aggregateId: entry.id, aggregateVersion: 0,
      payload: { entryId: entry.id, packageId: input.packageId, customerId: input.customerId, reason }, actorType: input.actor.type, actorId: input.actor.id ?? undefined,
    });
    return { entryId: entry.id, created: true };
  }

  /**
   * What the person sees after joining: that they are on the list for this package, and nothing else. No place in the
   * queue (it is a sequence with gaps), no address and no internal id.
   */
  async customerView(entryId: string) {
    const e = await this.prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: {
        status: true, reason: true, travellers: true, createdAt: true,
        package: { select: { id: true, slug: true, name: true, edition: { select: { year: true, race: { select: { slug: true, name: true } } } } } },
      },
    });
    if (!e) return null;
    return {
      outcome: 'waitlisted' as const, status: e.status, reason: e.reason, joinedAt: iso(e.createdAt), travellers: e.travellers,
      package: { id: e.package.id, slug: e.package.slug, name: e.package.name, editionYear: e.package.edition.year, race: e.package.edition.race },
    };
  }

  // ---- Offers (task 6.5) ----

  /** Hours an offer lasts: read inside the caller's transaction (the settings service uses another connection). */
  async offerHours(tx: Tx): Promise<number> {
    const row = await tx.setting.findUnique({ where: { key: WAITLIST_SETTINGS.offerHours.key }, select: { value: true } });
    const parsed = WAITLIST_SETTINGS.offerHours.schema.safeParse(row?.value);
    return parsed.success ? parsed.data : WAITLIST_SETTINGS.offerHours.fallback;
  }

  /**
   * The entries waiting for a place in this package, in queue order, locked FOR UPDATE SKIP LOCKED: a promotion never
   * waits for an entry that a customer is accepting or that another promotion is offering.
   */
  lockWaiting(tx: Tx, packageId: string, limit: number) {
    return tx.$queryRaw<Array<{ id: string; customerId: string; email: string; configuration: Prisma.JsonValue }>>`
      SELECT id, "customerId", email::text AS email, configuration FROM waitlist_entries
      WHERE "packageId" = ${packageId}::uuid AND reason = 'sold_out' AND status = 'waiting'
      ORDER BY position LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
  }

  /** One entry, locked (customer-side actions and the expiry task). `skipLocked` makes a busy entry read as absent. */
  async lockEntry(tx: Tx, id: string, opts: { customerId?: string; skipLocked?: boolean } = {}) {
    const rows = await tx.$queryRaw<Array<{ id: string; customerId: string; packageId: string; status: string; reason: string; email: string; configuration: Prisma.JsonValue; offerExpiresAt: Date | null; bookingId: string | null }>>`
      SELECT id, "customerId", "packageId", status::text AS status, reason::text AS reason, email::text AS email, configuration, "offerExpiresAt", "bookingId"
      FROM waitlist_entries WHERE id = ${id}::uuid AND (${opts.customerId ?? null}::uuid IS NULL OR "customerId" = ${opts.customerId ?? null}::uuid)
      FOR UPDATE ${opts.skipLocked ? Prisma.sql`SKIP LOCKED` : Prisma.empty}`;
    return rows[0] ?? null;
  }

  /** waiting → offered. The caller has held the places. Queues the offer email in the same transaction. */
  async offerIn(tx: Tx, entry: { id: string; customerId: string; email: string }, packageId: string, at: Date, actor: AuditActor): Promise<Date> {
    const expiresAt = new Date(at.getTime() + (await this.offerHours(tx)) * 3_600_000);
    const n = await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: 'waiting' }, data: { status: 'offered', offeredAt: at, offerExpiresAt: expiresAt, version: { increment: 1 } } });
    if (n.count !== 1) throw conflict('waitlist_entry_changed', 'This waiting list entry changed');
    await this.audit.record(tx, { actor, action: 'waitlist.entry.offered', entityType: 'WaitlistEntry', entityId: entry.id, model: 'WaitlistEntry', before: { status: 'waiting' }, after: { status: 'offered', offerExpiresAt: expiresAt.toISOString() } });
    await this.outbox.publish(tx, {
      type: WAITLIST_EVENTS.offered, aggregateType: 'WaitlistEntry', aggregateId: entry.id,
      payload: { entryId: entry.id, packageId, customerId: entry.customerId }, actorType: actor.type, actorId: actor.id ?? undefined,
    });
    await this.mail.enqueue({
      to: entry.email, templateKey: OFFER_TEMPLATE.key, templateVersion: OFFER_TEMPLATE.version, locale: 'en-AU',
      dedupeKey: `waitlist:offer:${entry.id}`, relatedEntityType: 'WaitlistEntry', relatedEntityId: entry.id, customerId: entry.customerId,
    }, tx);
    return expiresAt;
  }

  /**
   * Ends an entry (the caller holds its lock and has given the places back): waiting or offered → withdrawn, expired or
   * converted. A compare-and-set on the status, so it happens once.
   */
  async closeIn(tx: Tx, entry: { id: string; packageId: string; customerId: string }, from: 'waiting' | 'offered', to: 'withdrawn' | 'expired' | 'converted', at: Date, actor: AuditActor, extra: { bookingId?: string; reason?: string } = {}): Promise<void> {
    const times = to === 'withdrawn' ? { withdrawnAt: at } : to === 'expired' ? { expiredAt: at } : { convertedAt: at, bookingId: extra.bookingId };
    const n = await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: from }, data: { status: to, ...times, version: { increment: 1 } } });
    if (n.count !== 1) throw conflict('waitlist_entry_changed', 'This waiting list entry changed');
    await this.audit.record(tx, {
      actor, action: `waitlist.entry.${to}`, entityType: 'WaitlistEntry', entityId: entry.id, model: 'WaitlistEntry', before: { status: from }, after: { status: to, ...(extra.bookingId ? { bookingId: extra.bookingId } : {}) },
      ...(extra.reason ? { reason: extra.reason } : {}),
    });
    await this.outbox.publish(tx, {
      type: WAITLIST_EVENTS[to], aggregateType: 'WaitlistEntry', aggregateId: entry.id,
      payload: { entryId: entry.id, packageId: entry.packageId, customerId: entry.customerId }, actorType: actor.type, actorId: actor.id ?? undefined,
    });
  }

  /** Offers past their time, oldest first (ids only; each is closed in its own transaction). */
  async dueOffers(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM waitlist_entries WHERE status = 'offered' AND "offerExpiresAt" <= clock_timestamp() ORDER BY "offerExpiresAt", id LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  /** What the customer sees of their own entry. No place in the queue, no address, no internal ids other than the entry's. */
  async entryView(entryId: string) {
    const e = await this.prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: {
        id: true, status: true, reason: true, travellers: true, createdAt: true, offerExpiresAt: true, configuration: true,
        booking: { select: { reference: true } },
        package: { select: { id: true, slug: true, name: true, edition: { select: { year: true, race: { select: { slug: true, name: true } } } } } },
      },
    });
    if (!e) return null;
    return {
      id: e.id, status: e.status, reason: e.reason, joinedAt: iso(e.createdAt), travellers: e.travellers,
      offerExpiresAt: e.status === 'offered' ? iso(e.offerExpiresAt) : null, bookingReference: e.booking?.reference ?? null,
      package: { id: e.package.id, slug: e.package.slug, name: e.package.name, editionYear: e.package.edition.year, race: e.package.edition.race },
      /** For the bookings module to price an offer; not part of the answer. */
      configuration: e.configuration,
    };
  }

  /** The offer email. It is not sent if the offer has ended since it was queued. */
  async renderOffer(ctx: RenderContext): Promise<RenderedMail> {
    const id = ctx.email.relatedEntityId;
    const e = id ? await ctx.tx.waitlistEntry.findUnique({ where: { id }, select: { status: true, offerExpiresAt: true, package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } } } }) : null;
    if (!e || e.status !== 'offered' || !e.offerExpiresAt || e.offerExpiresAt.getTime() <= Date.now()) throw new AppError(MAIL_NOT_SENDABLE, 'The offer is no longer open');
    const en = (v: unknown): string => {
      const o = (v ?? {}) as Record<string, string>;
      return o['en-AU'] ?? Object.values(o)[0] ?? '';
    };
    const what = `${en(e.package.edition.race.name)} ${e.package.edition.year}: ${en(e.package.name)}`;
    const until = new Intl.DateTimeFormat('en-AU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Australia/Brisbane' }).format(e.offerExpiresAt);
    return {
      subject: `A place has come up for ${what}`,
      text: [
        'Hi,', '',
        `A place has come up for ${what}, and we are holding it for you until ${until} (Brisbane time).`, '',
        'To take it, sign in and accept the offer. Accepting sends us a booking request, which we then review as usual. It is not a confirmed booking and you will not be charged now:', '',
        `${new URL(this.config.WEB_ORIGIN).origin}/waitlist/${id}`, '',
        'If you no longer want it, you can decline there so that the next person can have it. If we do not hear from you by then, the offer ends and the place goes to the next person on the list.', '',
        brand.name,
      ].join('\n'),
    };
  }

  /** The panel's list (permission waitlist.entry.read), in queue order within a package. */
  async list(q: z.infer<typeof listWaitlistQuerySchema>) {
    const cursor = q.cursor ? parseCursor(q.cursor) : null;
    const rows = await this.prisma.waitlistEntry.findMany({
      where: {
        packageId: q.packageId, status: q.status,
        // Keyset on (packageId, position), the order of the list: both are fixed when an entry is made and position is unique.
        ...(cursor ? { OR: [{ packageId: { gt: cursor.packageId } }, { packageId: cursor.packageId, position: { gt: cursor.position } }] } : {}),
      },
      orderBy: [{ packageId: 'asc' }, { position: 'asc' }],
      take: q.limit + 1,
      select: {
        id: true, position: true, status: true, reason: true, packageId: true, travellers: true, countryOfResidence: true, email: true, createdAt: true, offerExpiresAt: true, version: true,
        customer: { select: { id: true, givenName: true, familyName: true } },
      },
    });
    const page = rows.slice(0, q.limit);
    return { items: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), offerExpiresAt: iso(r.offerExpiresAt) })), nextCursor: rows.length > q.limit ? `${page[page.length - 1]!.packageId}:${page[page.length - 1]!.position}` : null };
  }
}
