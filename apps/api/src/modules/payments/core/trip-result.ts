// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md, section 3): the result of one trip, pure and table-tested. Every
// figure is a bigint in the trip's currency. Costs in another currency are never converted: only a payment whose two amounts
// staff typed, that belongs to one trip and whose bank currency is the trip's, enters the result (with the bank's amount).

export interface ResultBooking {
  status: string;
  returnDate: string | null;
  totalMinor: bigint;
  fundsMinor: bigint;
  overpaymentsMinor: bigint;
  receivableMinor: bigint;
  feesMinor: bigint;
  /** What the cancellation keeps owing (6.4), null when the booking was not cancelled. */
  penaltyMinor: bigint | null;
}

/** Costs of the trip in one other currency, with what staff typed for the payments that can be attributed to the trip. */
export interface OtherCurrencyCost {
  currency: string;
  committedMinor: bigint;
  paidMinor: bigint;
  unpaidMinor: bigint;
  /** Items in this currency paid by a payment with a typed bank amount in the trip's currency, all items of this trip. */
  explicitPaidMinor: bigint;
  /** What the bank debited for those payments, in the trip's currency. */
  explicitDebitedMinor: bigint;
}

export interface RefundsByPurpose {
  cancellationMinor: bigint;
  priceReductionMinor: bigint;
  overpaymentReturnMinor: bigint;
  externalMinor: bigint;
}

export interface TripResultInput {
  bookings: ResultBooking[];
  refunds: RefundsByPurpose;
  costCommittedMinor: bigint;
  costPaidMinor: bigint;
  otherCurrencies: OtherCurrencyCost[];
  feesImported: boolean;
  today: string;
}

export interface TripResult {
  bookings: number;
  cancelledBookings: number;
  keptMinor: bigint;
  earnedRevenueMinor: bigint;
  notYetEarnedMinor: bigint;
  penaltiesKeptMinor: bigint;
  refundedMinor: bigint;
  refundedByPurpose: RefundsByPurpose;
  overpaymentsMinor: bigint;
  customerDebtMinor: bigint;
  feesMinor: bigint;
  feesImported: boolean;
  expectedRevenueMinor: bigint;
  costCommittedMinor: bigint;
  costPaidMinor: bigint;
  costUnpaidMinor: bigint;
  otherCurrencies: Array<OtherCurrencyCost & { leftOutMinor: bigint }>;
  costInResultMinor: bigint;
  costPaidInResultMinor: bigint;
  resultCashMinor: bigint;
  resultExpectedMinor: bigint;
  /** Null until every booking has returned or been called off. */
  resultEarnedMinor: bigint | null;
  settled: boolean;
  warnings: { otherCurrencyLeftOut: boolean; feesNotImported: boolean; noSupplierCosts: boolean };
}

const max0 = (v: bigint): bigint => (v < 0n ? 0n : v);
const EARNED_STATUSES = new Set(['cancelled', 'refunded', 'completed']);
const CANCELLED_STATUSES = new Set(['cancelled', 'refunded']);
/** A booking counts towards the expected revenue from its deposit. `approved` can still lapse. */
const COUNTED_STATUSES = new Set(['deposit_paid', 'confirmed', 'balance_paid', 'completed']);

export function tripResult(i: TripResultInput): TripResult {
  let kept = 0n, earned = 0n, penaltiesKept = 0n, over = 0n, debt = 0n, fees = 0n, expected = 0n, cancelled = 0;
  for (const b of i.bookings) {
    const funds = max0(b.fundsMinor);
    kept += funds;
    const isCancelled = CANCELLED_STATUSES.has(b.status);
    const isEarned = EARNED_STATUSES.has(b.status) || (b.returnDate !== null && b.returnDate < i.today);
    if (isEarned) earned += funds;
    if (isCancelled) { penaltiesKept += funds; cancelled += 1; expected += max0(b.penaltyMinor ?? 0n); }
    else if (COUNTED_STATUSES.has(b.status)) expected += b.totalMinor;
    over += max0(b.overpaymentsMinor);
    debt += max0(b.receivableMinor);
    fees += b.feesMinor;
  }
  const settled = i.bookings.length > 0 && i.bookings.every((b) => EARNED_STATUSES.has(b.status) || (b.returnDate !== null && b.returnDate < i.today));
  const other = i.otherCurrencies.map((o) => ({ ...o, leftOutMinor: o.committedMinor - o.explicitPaidMinor }));
  const debited = other.reduce((s, o) => s + o.explicitDebitedMinor, 0n);
  const costInResult = i.costCommittedMinor + debited;
  const costPaidInResult = i.costPaidMinor + debited;
  const r = i.refunds;
  return {
    bookings: i.bookings.length, cancelledBookings: cancelled,
    keptMinor: kept, earnedRevenueMinor: earned, notYetEarnedMinor: kept - earned, penaltiesKeptMinor: penaltiesKept,
    refundedMinor: r.cancellationMinor + r.priceReductionMinor + r.overpaymentReturnMinor + r.externalMinor, refundedByPurpose: r,
    overpaymentsMinor: over, customerDebtMinor: debt, feesMinor: fees, feesImported: i.feesImported, expectedRevenueMinor: expected,
    costCommittedMinor: i.costCommittedMinor, costPaidMinor: i.costPaidMinor, costUnpaidMinor: i.costCommittedMinor - i.costPaidMinor,
    otherCurrencies: other, costInResultMinor: costInResult, costPaidInResultMinor: costPaidInResult,
    resultCashMinor: kept - fees - costPaidInResult,
    resultExpectedMinor: expected - fees - costInResult,
    resultEarnedMinor: settled ? earned - fees - costInResult : null,
    settled,
    warnings: {
      otherCurrencyLeftOut: other.some((o) => o.leftOutMinor > 0n),
      feesNotImported: !i.feesImported,
      noSupplierCosts: i.costCommittedMinor === 0n && other.length === 0,
    },
  };
}

export interface ReconcileLine { name: 'customer_money' | 'fees' | 'supplier_paid' | 'costs'; currency: string; reportedMinor: bigint; ledgerMinor: bigint; matches: boolean }

/** Compares what the report adds up to with what the ledger and the cost items say, per currency and measure. */
export function reconcile(name: ReconcileLine['name'], reported: Map<string, bigint>, ledger: Map<string, bigint>): ReconcileLine[] {
  const currencies = [...new Set([...reported.keys(), ...ledger.keys()])].sort();
  return currencies.map((currency) => {
    const a = reported.get(currency) ?? 0n;
    const b = ledger.get(currency) ?? 0n;
    return { name, currency, reportedMinor: a, ledgerMinor: b, matches: a === b };
  });
}
