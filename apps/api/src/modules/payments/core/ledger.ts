// The pure part of the ledger (plan docs/plans/3.3-stripe-adapter-ledger.md, sections 1.4 and 12.7): account codes, the
// customer side of a posting and the content fingerprint. Positive amounts are debits, negative credits.
import { createHash } from 'node:crypto';

export type LedgerAccountKindName = 'asset' | 'liability' | 'revenue' | 'expense';

export const LEDGER_ACCOUNTS = {
  funds: 'customer_funds',
  overpayments: 'customer_overpayments',
  receivable: 'customer_receivable',
  clearing: (providerAccountId: string) => `provider_clearing:${providerAccountId}`,
  /** Task 4.6: the gateways' fees, an expense of the business, taken from the clearing account by a settlement. */
  fees: 'payment_fees',
  /**
   * Task 6.2: what suppliers are owed, debited when a payment to a supplier is recorded. Cash basis for now: the credit
   * side (the obligation, on accrual) is task 6.6's, so its balance is what was paid to suppliers and not voided.
   */
  supplierPayable: 'supplier_payable',
  /**
   * Task 6.2: the business's bank account. Until task 6.6 posts the gateways' payouts only supplier payments post here,
   * so its balance is NOT a bank balance and nothing reads it as one.
   */
  bank: 'bank',
  /** Task 6.2: the bridge of a payment that left the bank in another currency; each currency balances on its own. */
  fxConversion: 'fx_conversion',
} as const;

/** The customer accounts whose balances, per booking, are the customer money the ledger holds. */
export const CUSTOMER_ACCOUNTS: readonly string[] = [LEDGER_ACCOUNTS.funds, LEDGER_ACCOUNTS.overpayments, LEDGER_ACCOUNTS.receivable];

export function accountKind(code: string): LedgerAccountKindName {
  if (code.startsWith('provider_clearing:') || code === LEDGER_ACCOUNTS.receivable) return 'asset';
  if (code === LEDGER_ACCOUNTS.funds || code === LEDGER_ACCOUNTS.overpayments) return 'liability';
  if (code === LEDGER_ACCOUNTS.fees) return 'expense';
  if (code === LEDGER_ACCOUNTS.supplierPayable) return 'liability';
  if (code === LEDGER_ACCOUNTS.bank || code === LEDGER_ACCOUNTS.fxConversion) return 'asset';
  throw new RangeError(`unknown ledger account ${code}`);
}

export interface LedgerLine {
  accountCode: string;
  amountMinor: bigint;
  /** Task 6.2: a supplier payment's lines may be in two currencies; booking postings leave it out (the booking's). */
  currency?: string;
}

/** Customer balances of one booking as liabilities (credit balances as positive numbers). */
export interface CustomerBalances {
  fundsMinor: bigint;
  overpaymentsMinor: bigint;
  /** Task 4.5: what the customer owes beyond the plan (an asset, as a positive number). Absent is 0. */
  receivableMinor?: bigint;
}

/**
 * The customer side of a posting (plan 3.3, 12.7). `target` is the allocation after the fact (funds = what the active
 * items hold, overpayments = the rest); `balances` what the ledger holds now; `cashInMinor` what the cash side moves in
 * (+ money in, − money out, 0 for a reallocation). Funds go to their target; overpayments take the rest, so the posting
 * always balances, and any drift between ledger and allocation is corrected by the next posting. Zero lines are dropped.
 */
export function customerSide(target: CustomerBalances, balances: CustomerBalances, cashInMinor: bigint): LedgerLine[] {
  const fundsDelta = target.fundsMinor - balances.fundsMinor;
  // Task 4.5: the receivable goes to its target too (a debit when it grows); overpayments still take the rest.
  const receivableDelta = (target.receivableMinor ?? 0n) - (balances.receivableMinor ?? 0n);
  const overDelta = cashInMinor - fundsDelta + receivableDelta;
  return [
    { accountCode: LEDGER_ACCOUNTS.funds, amountMinor: -fundsDelta },
    { accountCode: LEDGER_ACCOUNTS.overpayments, amountMinor: -overDelta },
    { accountCode: LEDGER_ACCOUNTS.receivable, amountMinor: receivableDelta },
  ].filter((l) => l.amountMinor !== 0n);
}

export interface PostingContent {
  kind: string;
  mode: string;
  currency: string;
  bookingId: string | null;
  paymentId: string | null;
  refundId: string | null;
  /** Task 4.5; absent (older postings) hashes as before. */
  disputeId?: string | null;
  /** Task 6.2; absent (every other posting) hashes as before. */
  supplierPaymentId?: string | null;
  reversesTransactionId: string | null;
  description: string;
  lines: readonly LedgerLine[];
}

/** SHA-256 of the canonical content: a retry gives the same, a different posting under the same key does not. */
export function contentSha256(c: PostingContent): string {
  const lines = [...c.lines].map((l) => [l.accountCode, l.amountMinor.toString()]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  // The dispute joins the fingerprint only when there is one, so every posting made before task 4.5 keeps its hash.
  // Task 6.2: a supplier payment adds itself and the currency of every line, so every earlier posting keeps its hash.
  const supplier = c.supplierPaymentId
    ? [c.supplierPaymentId, [...c.lines].map((l) => [l.accountCode, l.currency ?? c.currency, l.amountMinor.toString()]).sort((a, b) => (a.join('|') < b.join('|') ? -1 : a.join('|') > b.join('|') ? 1 : 0))]
    : [];
  const canonical = JSON.stringify([c.kind, c.mode, c.currency, c.bookingId, c.paymentId, c.refundId, c.reversesTransactionId, c.description, lines, ...(c.disputeId ? [c.disputeId] : []), ...supplier]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Checks a posting before it is written (the database checks again at commit). */
export function assertBalanced(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) throw new RangeError('a ledger posting needs at least two lines');
  if (lines.some((l) => l.amountMinor === 0n)) throw new RangeError('a ledger line is never 0');
  const byCurrency = new Map<string, bigint>();
  for (const l of lines) byCurrency.set(l.currency ?? '', (byCurrency.get(l.currency ?? '') ?? 0n) + l.amountMinor);
  if ([...byCurrency.values()].some((v) => v !== 0n)) throw new RangeError('a ledger posting must balance');
}

/** Task 6.2: what a recorded supplier payment posts (plan 6.2, section 5). Each currency balances on its own; no rate. */
export function supplierPaymentLines(p: { amountMinor: bigint; currency: string; baseAmountMinor: bigint | null; baseCurrency: string | null }): LedgerLine[] {
  if (p.amountMinor <= 0n) throw new RangeError('a supplier payment is above 0');
  if (p.baseAmountMinor === null || p.baseCurrency === null) {
    return [
      { accountCode: LEDGER_ACCOUNTS.supplierPayable, currency: p.currency, amountMinor: p.amountMinor },
      { accountCode: LEDGER_ACCOUNTS.bank, currency: p.currency, amountMinor: -p.amountMinor },
    ];
  }
  if (p.baseAmountMinor <= 0n || p.baseCurrency === p.currency) throw new RangeError('a bank amount is above 0 and in another currency');
  return [
    { accountCode: LEDGER_ACCOUNTS.supplierPayable, currency: p.currency, amountMinor: p.amountMinor },
    { accountCode: LEDGER_ACCOUNTS.fxConversion, currency: p.currency, amountMinor: -p.amountMinor },
    { accountCode: LEDGER_ACCOUNTS.fxConversion, currency: p.baseCurrency, amountMinor: p.baseAmountMinor },
    { accountCode: LEDGER_ACCOUNTS.bank, currency: p.baseCurrency, amountMinor: -p.baseAmountMinor },
  ];
}

/** The keys of a supplier payment's postings (plan 0.1, P5). */
export const supplierPaymentKey = (id: string): string => `supplier_payment:${id}`;
export const supplierPaymentVoidedKey = (id: string): string => `supplier_payment:${id}:voided`;

/** The key of the reallocation a plan change posts (plan 0.1, P5): one per version of the plan. */
export const scheduleReallocationKey = (bookingId: string, version: number): string => `schedule:${bookingId}:v${version}:reallocation`;

/** The key of a settlement line's fee posting (plan 0.1, P5): one per line. */
export const settlementFeeKey = (lineId: string): string => `fee:${lineId}`;
