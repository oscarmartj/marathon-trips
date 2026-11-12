import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { listBookingsQuerySchema } from '@mt/shared';
import type { AuditActor } from '../../platform/audit/audit.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { runTransaction } from '../../platform/database/transaction';
import { notFound } from '../../platform/http/api-error';
import { REQUEST_TX_OPTIONS, mapLoadError } from './request.service';
import { BookingEvent, BookingStateMachine } from './state-machine';
import { jsonOf } from './support';
import { staffView } from './views';

/** The panel's API for bookings (plan 2.4, section 7). The inbox with screens is task 2.5. */
@Injectable()
export class BookingAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BookingStateMachine) private readonly machine: BookingStateMachine,
  ) {}

  async list(q: z.infer<typeof listBookingsQuerySchema>) {
    const rows = await this.prisma.booking.findMany({
      where: { status: q.status, packageId: q.packageId, editionId: q.editionId, ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
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

  async get(id: string) {
    const v = await staffView(this.prisma, id);
    if (!v) throw notFound('booking_not_found', 'Booking not found');
    return v;
  }

  async transition(id: string, event: Exclude<BookingEvent, 'expire_request'>, input: { actor: AuditActor; version: number; reason?: string }) {
    try {
      await runTransaction(this.prisma, (tx) => this.machine.transition(tx, id, event, input), REQUEST_TX_OPTIONS);
    } catch (err) {
      throw mapLoadError(err);
    }
    return this.get(id);
  }
}
