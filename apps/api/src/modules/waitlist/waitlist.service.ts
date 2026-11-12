import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { listWaitlistQuerySchema } from '@mt/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { unprocessable } from '../../platform/http/api-error';
import { WAITLIST_EVENTS } from './manifest';

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
  ) {}

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
    const live = await tx.waitlistEntry.findFirst({
      where: { customerId: input.customerId, packageId: input.packageId, reason: 'non_resident', status: { in: ['waiting', 'offered'] } },
      select: { id: true, travellers: true, countryOfResidence: true, version: true },
    });
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
        email: input.email, customerId: input.customerId, reason: 'non_resident', packageId: input.packageId, countryOfResidence: input.countryOfResidence,
        travellers: input.travellers, requestKeyHash: input.requestKeyHash, requestConfigHash: input.requestConfigHash, requestContactHmac: input.requestContactHmac,
      },
      select: { id: true, position: true },
    });
    await this.audit.record(tx, {
      actor: input.actor, action: 'waitlist.entry.joined', entityType: 'WaitlistEntry', entityId: entry.id, model: 'WaitlistEntry',
      after: { status: 'waiting', reason: 'non_resident', customerId: input.customerId, packageId: input.packageId, travellers: input.travellers, countryOfResidence: input.countryOfResidence, position: entry.position },
    });
    await this.outbox.publish(tx, {
      type: WAITLIST_EVENTS.joined, aggregateType: 'WaitlistEntry', aggregateId: entry.id, aggregateVersion: 0,
      payload: { entryId: entry.id, packageId: input.packageId, customerId: input.customerId, reason: 'non_resident' }, actorType: input.actor.type, actorId: input.actor.id ?? undefined,
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
        status: true, travellers: true, createdAt: true,
        package: { select: { id: true, slug: true, name: true, edition: { select: { year: true, race: { select: { slug: true, name: true } } } } } },
      },
    });
    if (!e) return null;
    return {
      outcome: 'waitlisted' as const, status: e.status, joinedAt: iso(e.createdAt), travellers: e.travellers,
      package: { id: e.package.id, slug: e.package.slug, name: e.package.name, editionYear: e.package.edition.year, race: e.package.edition.race },
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
        id: true, position: true, status: true, reason: true, packageId: true, travellers: true, countryOfResidence: true, email: true, createdAt: true, version: true,
        customer: { select: { id: true, givenName: true, familyName: true } },
      },
    });
    const page = rows.slice(0, q.limit);
    return { items: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), nextCursor: rows.length > q.limit ? `${page[page.length - 1]!.packageId}:${page[page.length - 1]!.position}` : null };
  }
}
