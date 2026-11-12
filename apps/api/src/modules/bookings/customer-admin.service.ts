import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { createCustomerSchema, listCustomersQuerySchema, updateCustomerSchema } from '@mt/shared';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { conflict, notFound } from '../../platform/http/api-error';
import { jsonOf } from './support';

const SUMMARY = { id: true, givenName: true, familyName: true, email: true, countryOfResidence: true, source: true, createdAt: true } as const;
const words = (text: string) => text.split(/\s+/).filter(Boolean);

/** The panel's customers (task 2.5): add one, change the contact, and the record with its whole history. */
@Injectable()
export class CustomerAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(q: z.infer<typeof listCustomersQuerySchema>) {
    const rows = await this.prisma.customer.findMany({
      where: {
        deletedAt: null, anonymisedAt: null,
        ...(q.q ? { AND: words(q.q).map((w) => ({ OR: [{ givenName: { contains: w, mode: 'insensitive' as const } }, { familyName: { contains: w, mode: 'insensitive' as const } }, { email: { contains: w, mode: 'insensitive' as const } }] })) } : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      select: { ...SUMMARY, _count: { select: { bookings: true } } },
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items: jsonOf(items.map(({ _count, ...c }) => ({ ...c, bookingCount: _count.bookings }))), nextCursor: more ? items[items.length - 1]!.id : null };
  }

  /** The record: contact, then everything that happened with this customer, newest first. Payments arrive with task 3.2. */
  async get(id: string) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      select: { ...SUMMARY, phone: true, preferredLocale: true, userId: true, anonymisedAt: true, deletedAt: true, version: true },
    });
    if (!c) throw notFound('customer_not_found', 'Customer not found');
    const [bookings, quotes, emails, alerts] = await Promise.all([
      this.prisma.booking.findMany({
        where: { customerId: id }, orderBy: { id: 'desc' }, take: 100,
        select: { id: true, reference: true, status: true, departureDate: true, currency: true, totalMinor: true, requestedAt: true, package: { select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } } },
      }),
      this.prisma.quote.findMany({
        where: { customerId: id }, orderBy: { id: 'desc' }, take: 100,
        select: { id: true, reference: true, status: true, expiresAt: true, currency: true, totalMinor: true, createdAt: true, package: { select: { name: true } } },
      }),
      this.prisma.outboundEmail.findMany({
        where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, templateKey: true, subject: true, status: true, sentAt: true, createdAt: true },
      }),
      this.prisma.alertSubscription.findMany({
        where: { OR: [{ customerId: id }, { email: c.email }] }, orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, status: true, scope: true, confirmedAt: true, createdAt: true, race: { select: { name: true } } },
      }),
    ]);
    const { userId, ...contact } = c;
    return jsonOf({ ...contact, signedUp: userId !== null, bookings, quotes, emails, alerts });
  }

  async create(actor: AuditActor, body: z.infer<typeof createCustomerSchema>) {
    const id = await runTransaction(this.prisma, async (tx) => {
      // ON CONFLICT keeps a clash with an existing address from aborting the transaction.
      const made = await tx.customer.createManyAndReturn({
        data: [{ email: body.email, givenName: body.givenName, familyName: body.familyName, phone: body.phone ?? null, countryOfResidence: body.countryOfResidence, source: 'panel' }],
        skipDuplicates: true, select: { id: true },
      });
      if (made.length === 0) throw conflict('customer_exists', 'A customer with this email address already exists');
      const id = made[0]!.id;
      await this.audit.record(tx, {
        actor, action: 'bookings.customer.created', entityType: 'Customer', entityId: id, model: 'Customer',
        after: { email: body.email, givenName: body.givenName, familyName: body.familyName, phone: body.phone ?? null, countryOfResidence: body.countryOfResidence },
      });
      return id;
    });
    return this.get(id);
  }

  async update(actor: AuditActor, id: string, body: z.infer<typeof updateCustomerSchema>) {
    await runTransaction(this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; version: number; givenName: string; familyName: string; phone: string | null; countryOfResidence: string; anonymisedAt: Date | null; deletedAt: Date | null }>>`
        SELECT id, version, "givenName", "familyName", phone, "countryOfResidence", "anonymisedAt", "deletedAt" FROM customers WHERE id = ${id}::uuid FOR UPDATE`;
      const c = rows[0];
      if (!c) throw notFound('customer_not_found', 'Customer not found');
      if (c.anonymisedAt || c.deletedAt) throw conflict('customer_closed', 'This account is closed');
      if (c.version !== body.version) throw conflict('version_conflict', 'Someone else changed this. Reload and try again.');
      const next = {
        givenName: body.givenName ?? c.givenName, familyName: body.familyName ?? c.familyName,
        phone: body.phone === undefined ? c.phone : body.phone, countryOfResidence: body.countryOfResidence ?? c.countryOfResidence,
      };
      const before = { givenName: c.givenName, familyName: c.familyName, phone: c.phone, countryOfResidence: c.countryOfResidence };
      if (Object.keys(next).every((k) => next[k as keyof typeof next] === before[k as keyof typeof before])) return;
      await tx.customer.update({ where: { id }, data: { ...next, version: { increment: 1 } } });
      await this.audit.record(tx, { actor, action: 'bookings.customer.updated', entityType: 'Customer', entityId: id, model: 'Customer', before, after: next });
    });
    return this.get(id);
  }
}
