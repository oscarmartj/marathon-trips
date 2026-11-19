// The customer money report (plan docs/plans/4.6-reconciliation-receipts.md, section 5 and review R2, R12 h): per trip
// (package) and currency, what customers paid that is still owed to suppliers, the margin not yet earned (trip not
// travelled), the overpayments to give back and the margin earned. Conservative by construction: one customer's debt
// never offsets another's money, margin is never negative, and without comparable supplier costs there is no margin.
// No currency is converted. Read in one snapshot, environment's mode only (plan 0.1, P11).
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service';
import { todayInBrisbane } from '../../bookings';
import { ProviderGateway } from './gateway';
import { LEDGER_ACCOUNTS } from './ledger';

export interface BookingMoney {
  fundsMinor: bigint;
  overpaymentsMinor: bigint;
  receivableMinor: bigint;
  feesMinor: bigint;
  returnDate: string | null;
}

export interface TripMoneyInput {
  bookings: BookingMoney[];
  /** Supplier costs of the trip in its currency, or null when none are recorded or some are in another currency. */
  supplierCostMinor: bigint | null;
  /** Paid to suppliers for the trip: 0 until task 6.2 records supplier payments. */
  paidToSuppliersMinor: bigint;
  today: string;
}

export interface TripMoney {
  heldMinor: bigint;
  overpaymentsMinor: bigint;
  customerDebtMinor: bigint;
  owedToSuppliersMinor: bigint | null;
  marginNotEarnedMinor: bigint | null;
  marginEarnedMinor: bigint;
  keepSeparateMinor: bigint;
  feesMinor: bigint;
  tripTravelled: boolean;
}

const max0 = (v: bigint): bigint => (v < 0n ? 0n : v);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The rules of the report, pure (table-tested). */
export function tripMoney(t: TripMoneyInput): TripMoney {
  let held = 0n;
  let applied = 0n;
  let over = 0n;
  let debt = 0n;
  let fees = 0n;
  for (const b of t.bookings) {
    // Review R2: per booking, clamped; a debt is its own column and never subtracts.
    held += max0(b.fundsMinor + b.overpaymentsMinor);
    applied += max0(b.fundsMinor);
    over += max0(b.overpaymentsMinor);
    debt += max0(b.receivableMinor);
    fees += b.feesMinor;
  }
  // A missing return date counts as a trip not travelled.
  const travelled = t.bookings.length > 0 && t.bookings.every((b) => b.returnDate !== null && b.returnDate < t.today);
  if (t.supplierCostMinor === null) {
    return { heldMinor: held, overpaymentsMinor: over, customerDebtMinor: debt, owedToSuppliersMinor: null, marginNotEarnedMinor: null, marginEarnedMinor: 0n, keepSeparateMinor: held, feesMinor: fees, tripTravelled: travelled };
  }
  const paid = max0(t.paidToSuppliersMinor);
  const owed = min(applied, max0(t.supplierCostMinor - paid));
  const margin = max0(applied - owed - paid);
  const earned = travelled ? margin : 0n;
  return {
    heldMinor: held, overpaymentsMinor: over, customerDebtMinor: debt, owedToSuppliersMinor: owed, marginNotEarnedMinor: margin - earned, marginEarnedMinor: earned,
    keepSeparateMinor: held - earned, feesMinor: fees, tripTravelled: travelled,
  };
}

export interface ClientMoneyRow {
  packageId: string;
  trip: string;
  currency: string;
  bookings: number;
  costsNote: 'ok' | 'no_supplier_costs' | 'costs_in_other_currency';
  feesImported: boolean;
  money: TripMoney;
}

const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};

@Injectable()
export class ClientMoneyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
  ) {}

  async report(now = new Date()): Promise<{ asOf: Date; today: string; rows: ClientMoneyRow[]; totals: Array<{ currency: string } & Record<Exclude<keyof TripMoney, 'tripTravelled'>, bigint | null>> }> {
    const mode = this.gateway.mode;
    const today = todayInBrisbane(now);
    const withoutSettlements = this.gateway.registry.all().filter((p) => p.manifest.key !== 'manual' && !p.manifest.capabilities.reconciliation?.settlements).map((p) => p.manifest.key);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const rows = await tx.$queryRaw<Array<{ id: string; packageId: string; currency: string; returnDate: Date | null; funds: bigint; over: bigint; receivable: bigint; fees: bigint; unimportedFees: boolean }>>`
        SELECT b.id::text AS id, b."packageId"::text AS "packageId", b.currency, b."returnDate",
          COALESCE(-SUM(e."amountMinor") FILTER (WHERE e."accountCode" = ${LEDGER_ACCOUNTS.funds}), 0)::bigint AS funds,
          COALESCE(-SUM(e."amountMinor") FILTER (WHERE e."accountCode" = ${LEDGER_ACCOUNTS.overpayments}), 0)::bigint AS over,
          COALESCE(SUM(e."amountMinor") FILTER (WHERE e."accountCode" = ${LEDGER_ACCOUNTS.receivable}), 0)::bigint AS receivable,
          COALESCE(SUM(e."amountMinor") FILTER (WHERE e."accountCode" = ${LEDGER_ACCOUNTS.fees}), 0)::bigint AS fees,
          EXISTS (SELECT 1 FROM payments p JOIN provider_accounts a ON a.id = p."providerAccountId"
                  WHERE p."bookingId" = b.id AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded' AND a."adapterKey" = ANY(${withoutSettlements}::text[])) AS "unimportedFees"
        FROM bookings b JOIN ledger_entries e ON e."bookingId" = b.id AND e.mode = ${mode}::"PaymentMode" AND e.currency = b.currency
        GROUP BY b.id ORDER BY b."packageId", b.id`;
      const byPackage = new Map<string, typeof rows>();
      for (const r of rows) byPackage.set(`${r.packageId}:${r.currency}`, [...(byPackage.get(`${r.packageId}:${r.currency}`) ?? []), r]);
      const out: ClientMoneyRow[] = [];
      for (const [key, list] of byPackage) {
        const [packageId, currency] = key.split(':') as [string, string];
        const costs = await tx.costItem.findMany({ where: { packageId, status: { not: 'cancelled' } }, select: { amountMinor: true, currency: true } });
        const comparable = costs.length > 0 && costs.every((c) => c.currency === currency);
        const pkg = await tx.package.findUnique({ where: { id: packageId }, select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } });
        const money = tripMoney({
          bookings: list.map((b) => ({ fundsMinor: b.funds, overpaymentsMinor: b.over, receivableMinor: b.receivable, feesMinor: b.fees, returnDate: b.returnDate ? b.returnDate.toISOString().slice(0, 10) : null })),
          supplierCostMinor: comparable ? costs.reduce((s, c) => s + c.amountMinor, 0n) : null,
          paidToSuppliersMinor: 0n,
          today,
        });
        out.push({
          packageId, currency, bookings: list.length, money, feesImported: !list.some((b) => b.unimportedFees),
          trip: pkg ? `${en(pkg.edition.race.name)} ${pkg.edition.year}: ${en(pkg.name)}` : packageId,
          costsNote: costs.length === 0 ? 'no_supplier_costs' : comparable ? 'ok' : 'costs_in_other_currency',
        });
      }
      const totals = new Map<string, { currency: string } & Record<Exclude<keyof TripMoney, 'tripTravelled'>, bigint | null>>();
      for (const r of out) {
        const t = totals.get(r.currency) ?? { currency: r.currency, heldMinor: 0n, overpaymentsMinor: 0n, customerDebtMinor: 0n, owedToSuppliersMinor: 0n, marginNotEarnedMinor: 0n, marginEarnedMinor: 0n, keepSeparateMinor: 0n, feesMinor: 0n };
        for (const k of ['heldMinor', 'overpaymentsMinor', 'customerDebtMinor', 'owedToSuppliersMinor', 'marginNotEarnedMinor', 'marginEarnedMinor', 'keepSeparateMinor', 'feesMinor'] as const) {
          t[k] = (t[k] ?? 0n) + (r.money[k] ?? 0n);
        }
        totals.set(r.currency, t);
      }
      return { asOf: now, today, rows: out, totals: [...totals.values()] };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 });
  }
}
