// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md, section 3): the result per trip, read in one snapshot of the
// environment's mode, with the checks against the ledger and the cost items, and the read of fx_conversion. Reads only.
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service';
import { todayInBrisbane } from '../../bookings';
import { ProviderGateway } from './gateway';
import { impliedRateE9 } from './fx';
import { LEDGER_ACCOUNTS } from './ledger';
import { type OtherCurrencyCost, type ReconcileLine, type RefundsByPurpose, type ResultBooking, type TripResult, reconcile, tripResult } from './trip-result';

export interface TripResultRow { packageId: string; trip: string; currency: string; result: TripResult }
export interface FxPair {
  supplierCurrency: string;
  bankCurrency: string;
  payments: number;
  supplierAmountMinor: bigint;
  bankAmountMinor: bigint;
  /** Of the two sums: an average, for information only. */
  averageRateE9: bigint;
}
export interface FxCurrencyCheck { currency: string; fxFromPaymentsMinor: bigint; fxInLedgerMinor: bigint; matches: boolean }
export interface TripResultReport {
  asOf: Date;
  today: string;
  rows: TripResultRow[];
  totals: Array<Record<string, bigint | string | number>>;
  unlinked: Array<{ currency: string; costMinor: bigint; paidMinor: bigint; unpaidMinor: bigint }>;
  reconciliation: ReconcileLine[];
  fx: { pairs: FxPair[]; ledger: FxCurrencyCheck[] };
}

const en = (v: unknown): string => {
  const o = (v ?? {}) as Record<string, string>;
  return o['en-AU'] ?? Object.values(o)[0] ?? '';
};
const EMPTY_REFUNDS = (): RefundsByPurpose => ({ cancellationMinor: 0n, priceReductionMinor: 0n, overpaymentReturnMinor: 0n, externalMinor: 0n });
const TOTAL_KEYS = ['keptMinor', 'earnedRevenueMinor', 'notYetEarnedMinor', 'penaltiesKeptMinor', 'refundedMinor', 'overpaymentsMinor', 'customerDebtMinor', 'feesMinor', 'expectedRevenueMinor', 'costCommittedMinor', 'costPaidMinor', 'costUnpaidMinor', 'costInResultMinor', 'costPaidInResultMinor', 'resultCashMinor', 'resultExpectedMinor'] as const;

@Injectable()
export class TripResultService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
  ) {}

  report(now = new Date()): Promise<TripResultReport> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return this.reportIn(tx, now);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 });
  }

  /** Inside a transaction the caller opened (the export reads the report and writes its audit entry in one, so this does not make it read-only). */
  async reportIn(tx: Prisma.TransactionClient, now: Date): Promise<TripResultReport> {
    const mode = this.gateway.mode;
    const today = todayInBrisbane(now);
    const withoutSettlements = this.gateway.registry.all().filter((p) => p.manifest.key !== 'manual' && !p.manifest.capabilities.reconciliation?.settlements).map((p) => p.manifest.key);
    const bookings = await tx.$queryRaw<Array<{ id: string; packageId: string; currency: string; status: string; returnDate: Date | null; total: bigint; funds: bigint; over: bigint; receivable: bigint; fees: bigint; penalty: bigint | null; unimportedFees: boolean }>>`
      SELECT b.id::text AS id, b."packageId"::text AS "packageId", b.currency, b.status::text AS status, b."returnDate", b."totalMinor" AS total,
        COALESCE(-SUM(e."amountMinor") FILTER (WHERE e."accountCode" = ${LEDGER_ACCOUNTS.funds}), 0)::bigint AS funds,
        COALESCE(-SUM(e."amountMinor") FILTER (WHERE e."accountCode" = ${LEDGER_ACCOUNTS.overpayments}), 0)::bigint AS over,
        COALESCE(SUM(e."amountMinor") FILTER (WHERE e."accountCode" = ${LEDGER_ACCOUNTS.receivable}), 0)::bigint AS receivable,
        COALESCE(SUM(e."amountMinor") FILTER (WHERE e."accountCode" = ${LEDGER_ACCOUNTS.fees}), 0)::bigint AS fees,
        (SELECT c."penaltyMinor" FROM cancellations c WHERE c."bookingId" = b.id) AS penalty,
        EXISTS (SELECT 1 FROM payments p JOIN provider_accounts a ON a.id = p."providerAccountId"
                WHERE p."bookingId" = b.id AND p.mode = ${mode}::"PaymentMode" AND p.status = 'succeeded' AND a."adapterKey" = ANY(${withoutSettlements}::text[])) AS "unimportedFees"
      FROM bookings b LEFT JOIN ledger_entries e ON e."bookingId" = b.id AND e.mode = ${mode}::"PaymentMode" AND e.currency = b.currency
      WHERE EXISTS (SELECT 1 FROM ledger_entries x WHERE x."bookingId" = b.id AND x.mode = ${mode}::"PaymentMode")
      GROUP BY b.id ORDER BY b."packageId", b.id`;

    const refundRows = await tx.$queryRaw<Array<{ packageId: string; currency: string; purpose: string | null; amount: bigint }>>`
      SELECT b."packageId"::text AS "packageId", r.currency, r.purpose::text AS purpose, SUM(r."amountMinor")::bigint AS amount
      FROM refunds r JOIN bookings b ON b.id = r."bookingId" WHERE r.status = 'succeeded' AND r.mode = ${mode}::"PaymentMode" GROUP BY 1, 2, 3`;

    const costRows = await tx.$queryRaw<Array<{ packageId: string | null; currency: string; committed: bigint; paid: bigint }>>`
      SELECT c."packageId"::text AS "packageId", c.currency, SUM(c."amountMinor")::bigint AS committed,
        COALESCE(SUM(i."amountMinor"), 0)::bigint AS paid
      FROM cost_items c LEFT JOIN supplier_payment_items i ON i."costItemId" = c.id AND i.active AND i.mode = ${mode}::"PaymentMode"
        AND EXISTS (SELECT 1 FROM supplier_payments sp WHERE sp.id = i."supplierPaymentId" AND sp.status = 'recorded' AND sp.mode = ${mode}::"PaymentMode")
      WHERE c.status <> 'cancelled' GROUP BY 1, 2`;

    // Payments with a typed bank amount, with the trip when every item belongs to the same one.
    const typed = await tx.$queryRaw<Array<{ id: string; currency: string; amount: bigint; baseCurrency: string; baseAmount: bigint; packageId: string | null; trips: number; unlinked: boolean }>>`
      SELECT sp.id::text AS id, sp.currency, sp."amountMinor" AS amount, sp."baseCurrency" AS "baseCurrency", sp."baseAmountMinor" AS "baseAmount",
        min(c."packageId"::text) AS "packageId", count(DISTINCT c."packageId")::int AS trips, bool_or(c."packageId" IS NULL) AS unlinked
      FROM supplier_payments sp JOIN supplier_payment_items i ON i."supplierPaymentId" = sp.id AND i.active JOIN cost_items c ON c.id = i."costItemId"
      WHERE sp.status = 'recorded' AND sp.mode = ${mode}::"PaymentMode" AND sp."baseAmountMinor" IS NOT NULL GROUP BY sp.id`;

    const packageIds = [...new Set([...bookings.map((b) => b.packageId), ...costRows.filter((c) => c.packageId).map((c) => c.packageId!)])];
    const packages = await tx.package.findMany({ where: { id: { in: packageIds } }, select: { id: true, currency: true, name: true, edition: { select: { year: true, race: { select: { name: true } } } } } });

    const rows: TripResultRow[] = [];
    for (const p of packages) {
      const bs = bookings.filter((b) => b.packageId === p.id);
      const costs = costRows.filter((c) => c.packageId === p.id);
      if (bs.length === 0 && costs.length === 0) continue;
      const own = costs.find((c) => c.currency === p.currency);
      const refunds = EMPTY_REFUNDS();
      for (const r of refundRows.filter((x) => x.packageId === p.id && x.currency === p.currency)) {
        if (r.purpose === 'cancellation') refunds.cancellationMinor += r.amount;
        else if (r.purpose === 'price_reduction') refunds.priceReductionMinor += r.amount;
        else if (r.purpose === 'overpayment_return') refunds.overpaymentReturnMinor += r.amount;
        else refunds.externalMinor += r.amount;
      }
      const other: OtherCurrencyCost[] = costs.filter((c) => c.currency !== p.currency).sort((a, b) => a.currency.localeCompare(b.currency)).map((c) => {
        const attributable = typed.filter((t) => t.packageId === p.id && t.trips === 1 && !t.unlinked && t.currency === c.currency && t.baseCurrency === p.currency);
        return {
          currency: c.currency, committedMinor: c.committed, paidMinor: c.paid, unpaidMinor: c.committed - c.paid,
          explicitPaidMinor: attributable.reduce((s, t) => s + t.amount, 0n), explicitDebitedMinor: attributable.reduce((s, t) => s + t.baseAmount, 0n),
        };
      });
      const input: ResultBooking[] = bs.map((b) => ({
        status: b.status, returnDate: b.returnDate ? b.returnDate.toISOString().slice(0, 10) : null, totalMinor: b.total, fundsMinor: b.funds, overpaymentsMinor: b.over,
        receivableMinor: b.receivable, feesMinor: b.fees, penaltyMinor: b.penalty,
      }));
      rows.push({
        packageId: p.id, currency: p.currency, trip: `${en(p.edition.race.name)} ${p.edition.year}: ${en(p.name)}`,
        result: tripResult({ bookings: input, refunds, costCommittedMinor: own?.committed ?? 0n, costPaidMinor: own?.paid ?? 0n, otherCurrencies: other, feesImported: !bs.some((b) => b.unimportedFees), today }),
      });
    }
    rows.sort((a, b) => a.trip.localeCompare(b.trip) || a.currency.localeCompare(b.currency) || a.packageId.localeCompare(b.packageId));

    const totals = new Map<string, Record<string, bigint | string | number>>();
    for (const r of rows) {
      const t = totals.get(r.currency) ?? { currency: r.currency, trips: 0, settledTrips: 0, resultEarnedMinor: 0n, ...Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0n])) };
      t.trips = (t.trips as number) + 1;
      for (const k of TOTAL_KEYS) t[k] = (t[k] as bigint) + r.result[k];
      if (r.result.resultEarnedMinor !== null) { t.settledTrips = (t.settledTrips as number) + 1; t.resultEarnedMinor = (t.resultEarnedMinor as bigint) + r.result.resultEarnedMinor; }
      totals.set(r.currency, t);
    }

    const unlinkedCosts = costRows.filter((c) => c.packageId === null);
    const unlinked = unlinkedCosts.map((c) => ({ currency: c.currency, costMinor: c.committed, paidMinor: c.paid, unpaidMinor: c.committed - c.paid })).sort((a, b) => a.currency.localeCompare(b.currency));
    const unpaidUnlinked = await tx.$queryRaw<Array<{ currency: string; unpaid: bigint }>>`
      SELECT currency, SUM("amountMinor")::bigint AS unpaid FROM cost_items WHERE "packageId" IS NULL AND status IN ('planned', 'due') GROUP BY currency`;
    for (const u of unlinked) u.unpaidMinor = unpaidUnlinked.find((x) => x.currency === u.currency)?.unpaid ?? 0n;

    // ---- Checks against the ledger and the cost items (the criterion "cuadra con el libro y con los costes") ----
    const sum = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
    const repMoney = new Map<string, bigint>(), repFees = new Map<string, bigint>(), repPaid = new Map<string, bigint>(), repCost = new Map<string, bigint>();
    for (const b of bookings) { sum(repMoney, b.currency, b.funds + b.over); sum(repFees, b.currency, b.fees); }
    for (const r of rows) {
      sum(repPaid, r.currency, r.result.costPaidMinor); sum(repCost, r.currency, r.result.costCommittedMinor);
      for (const o of r.result.otherCurrencies) { sum(repPaid, o.currency, o.paidMinor); sum(repCost, o.currency, o.committedMinor); }
    }
    for (const u of unlinked) { sum(repPaid, u.currency, u.paidMinor); sum(repCost, u.currency, u.costMinor); }
    const ledgerRows = await tx.$queryRaw<Array<{ account: string; currency: string; total: bigint }>>`
      SELECT CASE WHEN "accountCode" IN (${LEDGER_ACCOUNTS.funds}, ${LEDGER_ACCOUNTS.overpayments}) THEN 'money' ELSE "accountCode" END AS account, currency, SUM("amountMinor")::bigint AS total
      FROM ledger_entries WHERE mode = ${mode}::"PaymentMode" AND "accountCode" IN (${LEDGER_ACCOUNTS.funds}, ${LEDGER_ACCOUNTS.overpayments}, ${LEDGER_ACCOUNTS.fees}, ${LEDGER_ACCOUNTS.supplierPayable}, ${LEDGER_ACCOUNTS.fxConversion})
      GROUP BY 1, 2`;
    const ledgerMap = (account: string, sign: bigint) => new Map(ledgerRows.filter((l) => l.account === account).map((l) => [l.currency, l.total * sign]));
    const costItems = await tx.$queryRaw<Array<{ currency: string; total: bigint }>>`SELECT currency, SUM("amountMinor")::bigint AS total FROM cost_items WHERE status <> 'cancelled' GROUP BY currency`;
    const reconciliation = [
      ...reconcile('customer_money', repMoney, ledgerMap('money', -1n)),
      ...reconcile('fees', repFees, ledgerMap(LEDGER_ACCOUNTS.fees, 1n)),
      ...reconcile('supplier_paid', repPaid, ledgerMap(LEDGER_ACCOUNTS.supplierPayable, 1n)),
      // Not a ledger check: both sides come from cost_items, one grouped by trip and the other by currency, so it catches a cost
      // counted twice or left out of every row (a duplicate or a lost item), not a difference with the ledger.
      ...reconcile('costs', repCost, new Map(costItems.map((c) => [c.currency, c.total]))),
    ];

    // ---- The fx_conversion read (finding 3) ----
    const pairMap = new Map<string, FxPair>();
    for (const t of typed) {
      const k = `${t.currency}|${t.baseCurrency}`;
      const p = pairMap.get(k) ?? { supplierCurrency: t.currency, bankCurrency: t.baseCurrency, payments: 0, supplierAmountMinor: 0n, bankAmountMinor: 0n, averageRateE9: 0n };
      p.payments += 1; p.supplierAmountMinor += t.amount; p.bankAmountMinor += t.baseAmount;
      pairMap.set(k, p);
    }
    const pairs = [...pairMap.values()].sort((a, b) => a.supplierCurrency.localeCompare(b.supplierCurrency) || a.bankCurrency.localeCompare(b.bankCurrency));
    for (const p of pairs) p.averageRateE9 = impliedRateE9(p.supplierAmountMinor, p.supplierCurrency, p.bankAmountMinor, p.bankCurrency);
    const expectedFx = new Map<string, bigint>();
    for (const p of pairs) { sum(expectedFx, p.bankCurrency, p.bankAmountMinor); sum(expectedFx, p.supplierCurrency, -p.supplierAmountMinor); }
    const inLedger = ledgerMap(LEDGER_ACCOUNTS.fxConversion, 1n);
    const fxCurrencies = [...new Set([...expectedFx.keys(), ...inLedger.keys()])].sort();
    const fxLedger = fxCurrencies.map((currency) => {
      const a = expectedFx.get(currency) ?? 0n;
      const b = inLedger.get(currency) ?? 0n;
      return { currency, fxFromPaymentsMinor: a, fxInLedgerMinor: b, matches: a === b };
    });
    return { asOf: now, today, rows, totals: [...totals.values()].sort((a, b) => String(a.currency).localeCompare(String(b.currency))), unlinked, reconciliation, fx: { pairs, ledger: fxLedger } };
  }
}
