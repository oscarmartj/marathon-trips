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
  /** Task 6.2: paid to suppliers for the trip's cost items in the trip's currency (active items, environment mode). */
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
  /** Task 6.2: paid to suppliers for this trip in its currency. */
  paidToSuppliersMinor: bigint;
  /** Task 6.2: what was paid to suppliers beyond the customer money applied to the trip (the business's own money). */
  paidBeyondCustomerMoneyMinor: bigint;
  tripTravelled: boolean;
}

const TOTAL_KEYS = ['heldMinor', 'overpaymentsMinor', 'customerDebtMinor', 'owedToSuppliersMinor', 'marginNotEarnedMinor', 'marginEarnedMinor', 'keepSeparateMinor', 'feesMinor', 'paidToSuppliersMinor', 'paidBeyondCustomerMoneyMinor'] as const;
type TotalKey = (typeof TOTAL_KEYS)[number];

const max0 = (v: bigint): bigint => (v < 0n ? 0n : v);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * The rules of the report, pure (table-tested). Task 6.2 (plan 6.2, section 6): customer money already spent on this
 * trip's suppliers, S = min(paid, applied), is no longer money to keep aside; what was paid beyond it is the business's
 * own money and is shown, never netted. With nothing paid the numbers are exactly task 4.6's.
 */
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
  // A missing return date counts as a trip not travelled; a trip with no bookings (a prepayment only) has not travelled.
  const travelled = t.bookings.length > 0 && t.bookings.every((b) => b.returnDate !== null && b.returnDate < t.today);
  const paid = max0(t.paidToSuppliersMinor);
  const spent = min(paid, applied);
  const beyond = paid - spent;
  const remaining = applied - spent;
  if (t.supplierCostMinor === null) {
    return {
      heldMinor: held, overpaymentsMinor: over, customerDebtMinor: debt, owedToSuppliersMinor: null, marginNotEarnedMinor: null, marginEarnedMinor: 0n,
      keepSeparateMinor: held - spent, feesMinor: fees, paidToSuppliersMinor: paid, paidBeyondCustomerMoneyMinor: beyond, tripTravelled: travelled,
    };
  }
  const owed = min(remaining, max0(t.supplierCostMinor - paid));
  const margin = remaining - owed;
  const earned = travelled ? margin : 0n;
  return {
    heldMinor: held, overpaymentsMinor: over, customerDebtMinor: debt, owedToSuppliersMinor: owed, marginNotEarnedMinor: margin - earned, marginEarnedMinor: earned,
    keepSeparateMinor: held - earned - spent, feesMinor: fees, paidToSuppliersMinor: paid, paidBeyondCustomerMoneyMinor: beyond, tripTravelled: travelled,
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
  /** Task 6.2: paid to suppliers for this trip's cost items in other currencies: shown, never netted or converted. */
  otherCurrencyPaid: Array<{ currency: string; amountMinor: bigint }>;
}

/** Task 6.2: supplier costs with no trip, per currency; they never reduce any trip's money to keep aside. */
export interface UnlinkedSupplierCosts {
  currency: string;
  costMinor: bigint;
  paidMinor: bigint;
  unpaidMinor: bigint;
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

  async report(now = new Date()): Promise<{ asOf: Date; today: string; rows: ClientMoneyRow[]; totals: Array<{ currency: string } & Record<TotalKey, bigint | null>>; unlinked: UnlinkedSupplierCosts[] }> {
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
      // Task 6.2: what recorded supplier payments of this environment's mode paid, per trip and cost currency.
      const paid = await tx.$queryRaw<Array<{ packageId: string | null; currency: string; paid: bigint }>>`
        SELECT c."packageId"::text AS "packageId", i.currency, SUM(i."amountMinor")::bigint AS paid
        FROM supplier_payment_items i JOIN supplier_payments sp ON sp.id = i."supplierPaymentId" JOIN cost_items c ON c.id = i."costItemId"
        WHERE i.active AND sp.status = 'recorded' AND sp.mode = ${mode}::"PaymentMode" AND i.mode = ${mode}::"PaymentMode"
        GROUP BY c."packageId", i.currency`;
      const byPackage = new Map<string, typeof rows>();
      for (const r of rows) byPackage.set(`${r.packageId}:${r.currency}`, [...(byPackage.get(`${r.packageId}:${r.currency}`) ?? []), r]);
      // Plan review, point 2: a trip with supplier payments but no customer money yet (a prepayment) is a row too.
      const paidPackages = [...new Set(paid.filter((p) => p.packageId).map((p) => p.packageId!))];
      if (paidPackages.length) {
        const pkgs = await tx.package.findMany({ where: { id: { in: paidPackages } }, select: { id: true, currency: true } });
        for (const p of pkgs) if (!byPackage.has(`${p.id}:${p.currency}`)) byPackage.set(`${p.id}:${p.currency}`, []);
      }
      const out: ClientMoneyRow[] = [];
      for (const [key, list] of [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const [packageId, currency] = key.split(':') as [string, string];
        const costs = await tx.costItem.findMany({ where: { packageId, status: { not: 'cancelled' } }, select: { amountMinor: true, currency: true } });
        const comparable = costs.length > 0 && costs.every((c) => c.currency === currency);
        const pkg = await tx.package.findUnique({ where: { id: packageId }, select: { name: true, edition: { select: { year: true, race: { select: { name: true } } } } } });
        const money = tripMoney({
          bookings: list.map((b) => ({ fundsMinor: b.funds, overpaymentsMinor: b.over, receivableMinor: b.receivable, feesMinor: b.fees, returnDate: b.returnDate ? b.returnDate.toISOString().slice(0, 10) : null })),
          supplierCostMinor: comparable ? costs.reduce((s, c) => s + c.amountMinor, 0n) : null,
          paidToSuppliersMinor: paid.find((p) => p.packageId === packageId && p.currency === currency)?.paid ?? 0n,
          today,
        });
        out.push({
          packageId, currency, bookings: list.length, money, feesImported: !list.some((b) => b.unimportedFees),
          trip: pkg ? `${en(pkg.edition.race.name)} ${pkg.edition.year}: ${en(pkg.name)}` : packageId,
          costsNote: costs.length === 0 ? 'no_supplier_costs' : comparable ? 'ok' : 'costs_in_other_currency',
          otherCurrencyPaid: paid.filter((p) => p.packageId === packageId && p.currency !== currency).map((p) => ({ currency: p.currency, amountMinor: p.paid })).sort((a, b) => a.currency.localeCompare(b.currency)),
        });
      }
      const totals = new Map<string, { currency: string } & Record<TotalKey, bigint | null>>();
      for (const r of out) {
        const t = totals.get(r.currency) ?? { currency: r.currency, ...Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0n])) } as { currency: string } & Record<TotalKey, bigint | null>;
        for (const k of TOTAL_KEYS) t[k] = (t[k] ?? 0n) + (r.money[k] ?? 0n);
        totals.set(r.currency, t);
      }
      // Task 6.2: supplier costs with no trip, per currency (not cancelled; paid by active items of this mode).
      const unlinkedRows = await tx.$queryRaw<Array<{ currency: string; cost: bigint; unpaid: bigint }>>`
        SELECT currency, SUM("amountMinor")::bigint AS cost, COALESCE(SUM("amountMinor") FILTER (WHERE status IN ('planned', 'due')), 0)::bigint AS unpaid
        FROM cost_items WHERE "packageId" IS NULL AND status <> 'cancelled' GROUP BY currency ORDER BY currency`;
      const unlinkedPaid = new Map(paid.filter((p) => !p.packageId).map((p) => [p.currency, p.paid]));
      const currencies = [...new Set([...unlinkedRows.map((u) => u.currency), ...unlinkedPaid.keys()])].sort();
      const unlinked = currencies.map((c) => {
        const u = unlinkedRows.find((x) => x.currency === c);
        return { currency: c, costMinor: u?.cost ?? 0n, paidMinor: unlinkedPaid.get(c) ?? 0n, unpaidMinor: u?.unpaid ?? 0n };
      });
      return { asOf: now, today, rows: out, totals: [...totals.values()], unlinked };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 });
  }
}
