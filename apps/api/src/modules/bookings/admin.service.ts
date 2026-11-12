import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { listBookingsQuerySchema } from '@mt/shared';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { notFound } from '../../platform/http/api-error';
import { REQUEST_TX_OPTIONS, mapLoadError } from './request.service';
import { BookingStateMachine } from './state-machine';
import type { StaffBookingEvent } from './state-machine';
import { jsonOf } from './support';
import { staffView } from './views';

/** Words of a search box matched against the customer's names and address (every word must match one of them). */
const searchCustomer = (text: string) => [{ customer: { is: { AND: text.split(/\s+/).filter(Boolean).map((w) => ({ OR: [{ givenName: { contains: w, mode: 'insensitive' as const } }, { familyName: { contains: w, mode: 'insensitive' as const } }, { email: { contains: w, mode: 'insensitive' as const } }] })) } } }];

/** The panel's API for bookings (plan 2.4, section 7), with the inbox's search and counts (task 2.5). */
@Injectable()
export class BookingAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BookingStateMachine) private readonly machine: BookingStateMachine,
  ) {}

  async list(q: z.infer<typeof listBookingsQuerySchema>) {
    const rows = await this.prisma.booking.findMany({
      where: {
        status: q.status, packageId: q.packageId, editionId: q.editionId, customerId: q.customerId,
        ...(q.q ? { OR: [{ reference: { contains: q.q, mode: 'insensitive' as const } }, ...searchCustomer(q.q)] } : {}),
        ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      select: {
        id: true, reference: true, status: true, packageId: true, editionId: true, currency: true, totalMinor: true, requestedAt: true, requestExpiresAt: true, version: true,
        customer: { select: { id: true, givenName: true, familyName: true, email: true } },
      },
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items: jsonOf(items), nextCursor: more ? items[items.length - 1]!.id : null };
  }

  /** How many bookings are in each state, for the inbox's tabs. */
  async summary() {
    const rows = await this.prisma.booking.groupBy({ by: ['status'], _count: { _all: true } });
    return { counts: Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number> };
  }

  async get(id: string) {
    const v = await staffView(this.prisma, id);
    if (!v) throw notFound('booking_not_found', 'Booking not found');
    return v;
  }

  async transition(id: string, event: StaffBookingEvent, input: { actor: AuditActor; version: number; reason?: string }) {
    try {
      await runTransaction(this.prisma, (tx) => this.machine.transition(tx, id, event, input), REQUEST_TX_OPTIONS);
    } catch (err) {
      throw mapLoadError(err);
    }
    return this.get(id);
  }
}
