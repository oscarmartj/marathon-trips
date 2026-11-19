import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../platform/database/prisma.service';
import { ProviderGateway } from './gateway';
import { payable } from './payable';
import { PAYABLE_STATES } from './payable-states';

/** How far ahead "falls due soon" looks, in days. */
export const PENDING_HORIZON_DAYS = 14;
const CANDIDATES = 500;
const dayMs = 86_400_000;

export interface PendingCollection {
  bookingId: string;
  reference: string;
  kind: 'deposit' | 'balance' | 'instalment' | 'adjustment' | 'penalty';
  sequence: number;
  /** YYYY-MM-DD */
  dueDate: string;
  /** The amount a payment up to this item would be, as the payment page states it (minor units, a string of digits). */
  amountDueMinor: string;
  currency: string;
  overdue: boolean;
}

export interface PendingCollections {
  overdue: number;
  dueSoon: number;
  /** The first `limit` by due date. */
  items: PendingCollection[];
  /** More bookings were due than the sweep looks at, so the counts are a floor. */
  truncated: boolean;
}

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);

/**
 * What customers still owe soon, for the staff start page (task 5.6). Money is parked, so this only reads the payment plan
 * and the payments that succeeded; the amount per booking is `payable()`, the same function the payment page and the
 * payment links use, and nothing is added up in the browser.
 */
@Injectable()
export class PaymentPendingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
  ) {}

  async collections(today: string, limit: number): Promise<PendingCollections> {
    const horizon = addDays(today, PENDING_HORIZON_DAYS);
    // Only lines the money collected does not cover yet count (a paid deposit must not crowd out the balance), so the
    // limit applies to work that is still owed.
    const candidates = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH collected AS (
        SELECT "bookingId", sum("amountMinor") AS paid FROM payments WHERE status = 'succeeded' AND mode = ${this.gateway.mode}::"PaymentMode" GROUP BY "bookingId"
      ), lines AS (
        SELECT i."bookingId", i."dueDate", sum(i."amountMinor") OVER (PARTITION BY i."bookingId" ORDER BY i.sequence) AS cumulative
        FROM payment_schedule_items i WHERE i.state = 'active'
      )
      SELECT b.id::text AS id FROM bookings b
      JOIN lines l ON l."bookingId" = b.id LEFT JOIN collected c ON c."bookingId" = b.id
      WHERE b.status::text = ANY(${[...PAYABLE_STATES]}::text[]) AND l."dueDate" <= ${horizon}::date AND l.cumulative > COALESCE(c.paid, 0)
      GROUP BY b.id ORDER BY min(l."dueDate"), b.id LIMIT ${CANDIDATES + 1}`;
    const truncated = candidates.length > CANDIDATES;
    const ids = candidates.slice(0, CANDIDATES).map((c) => c.id);
    if (ids.length === 0) return { overdue: 0, dueSoon: 0, items: [], truncated: false };
    const [bookings, items, paid] = await Promise.all([
      this.prisma.booking.findMany({ where: { id: { in: ids } }, select: { id: true, reference: true, currency: true } }),
      this.prisma.paymentScheduleItem.findMany({ where: { bookingId: { in: ids }, state: 'active' }, select: { bookingId: true, kind: true, sequence: true, amountMinor: true, dueDate: true } }),
      this.prisma.payment.groupBy({ by: ['bookingId'], where: { bookingId: { in: ids }, mode: this.gateway.mode, status: 'succeeded' }, _sum: { amountMinor: true } }),
    ]);
    const collected = new Map(paid.map((p) => [p.bookingId, p._sum.amountMinor ?? 0n]));
    const out: PendingCollection[] = [];
    for (const b of bookings) {
      const own = items.filter((i) => i.bookingId === b.id);
      const next = payable(own, collected.get(b.id) ?? 0n).next;
      const item = next ? own.find((i) => i.sequence === next.sequence) : undefined;
      if (!next || !item) continue;
      const dueDate = item.dueDate.toISOString().slice(0, 10);
      if (dueDate > horizon) continue;
      out.push({ bookingId: b.id, reference: b.reference, kind: item.kind, sequence: item.sequence, dueDate, amountDueMinor: next.amountMinor.toString(), currency: b.currency, overdue: dueDate < today });
    }
    out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.reference.localeCompare(b.reference));
    return { overdue: out.filter((o) => o.overdue).length, dueSoon: out.filter((o) => !o.overdue).length, items: out.slice(0, limit), truncated };
  }
}
