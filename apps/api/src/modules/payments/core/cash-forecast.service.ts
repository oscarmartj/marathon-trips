// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md, section 4): expected customer money and supplier payments by
// Brisbane date. What a customer still owes on an item comes from the same allocate() the payment plan uses. Reads only.
import { Inject, Injectable } from '@nestjs/common';
import type { cashForecastQuerySchema } from '@mt/shared';
import type { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service';
import { unprocessable } from '../../../platform/http/api-error';
import { todayInBrisbane } from '../../bookings';
import { allocate } from './allocation';
import { type CurrencyForecast, type ForecastIn, type ForecastOut, type TripForecast, addDays, buildForecast } from './cash-forecast';
import { ProviderGateway } from './gateway';
import { LEDGER_ACCOUNTS } from './ledger';

type Query = z.infer<typeof cashForecastQuerySchema>;

export interface CashForecastReport {
  asOf: Date;
  today: string;
  from: string;
  to: string;
  currencies: Array<CurrencyForecast & { customerDebtMinor: bigint; toGiveBackMinor: bigint; refundsInFlightMinor: bigint }>;
  trips: Array<TripForecast & { trip: string }>;
}

const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const KIND_BY_STATUS: Record<string, ForecastIn['kind']> = { approved: 'tentative', cancelled: 'penalties' };

@Injectable()
export class CashForecastService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
  ) {}

  async forecast(q: Query, now = new Date()): Promise<CashForecastReport> {
    const today = todayInBrisbane(now);
    const from = q.from ?? today;
    const to = q.to ?? addDays(from, 90);
    if (to < from) throw unprocessable('range_invalid', 'The last day is before the first day');
    if (addDays(from, 732) < to) throw unprocessable('range_too_long', 'Choose a range of two years or less');
    const mode = this.gateway.mode;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const items = await tx.$queryRaw<Array<{ bookingId: string; sequence: number; amount: bigint; dueDate: Date; status: string; packageId: string; currency: string }>>`
        SELECT i."bookingId"::text AS "bookingId", i.sequence, i."amountMinor" AS amount, i."dueDate", b.status::text AS status, b."packageId"::text AS "packageId", b.currency
        FROM payment_schedule_items i JOIN bookings b ON b.id = i."bookingId"
        WHERE i.state = 'active' AND b.status IN ('approved', 'deposit_paid', 'confirmed', 'balance_paid', 'cancelled')`;
      const ids = [...new Set(items.map((i) => i.bookingId))];
      // What each booking has collected and not promised back, as bookingCash() reads it, for all of them at once.
      const cash = ids.length === 0 ? [] : await tx.$queryRaw<Array<{ bookingId: string; allocatable: bigint }>>`
        SELECT b.id::text AS "bookingId",
          (COALESCE((SELECT sum("amountMinor") FROM payments p WHERE p."bookingId" = b.id AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded'), 0)
          - COALESCE((SELECT sum("amountMinor") FROM refunds r WHERE r."bookingId" = b.id AND r.mode = ${mode}::"PaymentMode" AND r.status = 'succeeded'), 0)
          - COALESCE((SELECT sum("amountMinor") FROM disputes d WHERE d."bookingId" = b.id AND d.mode = ${mode}::"PaymentMode" AND d."fundsWithdrawnAt" IS NOT NULL AND d."fundsReinstatedAt" IS NULL), 0)
          - COALESCE((SELECT sum("amountMinor") FROM refunds r WHERE r."bookingId" = b.id AND r.mode = ${mode}::"PaymentMode" AND ((r.origin = 'app' AND r.status IN ('requested', 'pending')) OR (r.origin = 'app' AND r.status = 'failed' AND r."failureCode" = 'late_pending_at_gateway'))), 0))::bigint AS allocatable
        FROM bookings b WHERE b.id = ANY(${ids}::uuid[])`;
      const allocatable = new Map(cash.map((c) => [c.bookingId, c.allocatable]));
      const ins: ForecastIn[] = [];
      for (const id of ids) {
        const own = items.filter((i) => i.bookingId === id);
        const alloc = allocate(own.map((i) => ({ sequence: i.sequence, amountMinor: i.amount })), allocatable.get(id) ?? 0n);
        for (const i of own) {
          const paid = alloc.items.find((a) => a.sequence === i.sequence)?.paidMinor ?? 0n;
          const remaining = i.amount - paid;
          if (remaining > 0n && (!q.currency || q.currency === i.currency)) ins.push({ packageId: i.packageId, currency: i.currency, date: iso(i.dueDate), kind: KIND_BY_STATUS[i.status] ?? 'instalments', amountMinor: remaining });
        }
      }
      const costs = await tx.costItem.findMany({
        where: { status: { in: ['planned', 'due'] }, amountMinor: { gt: 0n }, supplier: { deletedAt: null }, ...(q.currency ? { currency: q.currency } : {}) },
        select: { packageId: true, currency: true, dueDate: true, amountMinor: true },
      });
      const outs: ForecastOut[] = costs.map((c) => ({ packageId: c.packageId, currency: c.currency, date: c.dueDate ? iso(c.dueDate) : null, amountMinor: c.amountMinor }));
      const built = buildForecast({ ins, outs, today, from, to });

      const apart = await tx.$queryRaw<Array<{ currency: string; debt: bigint; giveBack: bigint }>>`
        SELECT currency,
          COALESCE(SUM("amountMinor") FILTER (WHERE "accountCode" = ${LEDGER_ACCOUNTS.receivable}), 0)::bigint AS debt,
          COALESCE(-SUM("amountMinor") FILTER (WHERE "accountCode" = ${LEDGER_ACCOUNTS.overpayments}), 0)::bigint AS "giveBack"
        FROM ledger_entries WHERE mode = ${mode}::"PaymentMode" AND "bookingId" IS NOT NULL GROUP BY currency`;
      const flight = await tx.$queryRaw<Array<{ currency: string; amount: bigint }>>`
        SELECT currency, SUM("amountMinor")::bigint AS amount FROM refunds WHERE mode = ${mode}::"PaymentMode" AND origin = 'app'
          AND (status IN ('requested', 'pending') OR (status = 'failed' AND "failureCode" = 'late_pending_at_gateway')) GROUP BY currency`;
      const currencies = [...new Set([...built.currencies.map((c) => c.currency), ...apart.filter((a) => a.debt !== 0n || a.giveBack !== 0n).map((a) => a.currency), ...flight.map((f) => f.currency)])]
        .filter((c) => !q.currency || c === q.currency).sort();
      const empty = (currency: string): CurrencyForecast => buildForecast({ ins: [], outs: [], today, from, to }).currencies.find((c) => c.currency === currency) ?? {
        currency, days: [], overdue: z0(), earlier: z0(), later: z0(), undated: z0(), all: z0(),
      };
      const packageIds = [...new Set(built.trips.map((t) => t.packageId).filter((x): x is string => !!x))];
      const pkgs = await tx.package.findMany({ where: { id: { in: packageIds } }, select: { id: true, name: true, edition: { select: { year: true, race: { select: { name: true } } } } } });
      const names = new Map(pkgs.map((p) => [p.id, `${en(p.edition.race.name)} ${p.edition.year}: ${en(p.name)}`]));
      return {
        asOf: now, today, from, to,
        currencies: currencies.map((currency) => ({
          ...(built.currencies.find((c) => c.currency === currency) ?? empty(currency)),
          customerDebtMinor: apart.find((a) => a.currency === currency)?.debt ?? 0n,
          toGiveBackMinor: apart.find((a) => a.currency === currency)?.giveBack ?? 0n,
          refundsInFlightMinor: flight.find((f) => f.currency === currency)?.amount ?? 0n,
        })),
        trips: built.trips.map((t) => ({ ...t, trip: t.packageId ? (names.get(t.packageId) ?? t.packageId) : '' })),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 });
  }
}

const z0 = () => ({ instalmentsInMinor: 0n, tentativeInMinor: 0n, penaltiesInMinor: 0n, supplierOutMinor: 0n, firmNetMinor: 0n });
