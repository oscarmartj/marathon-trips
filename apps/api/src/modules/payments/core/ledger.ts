// The pure part of the ledger (plan docs/plans/3.3-stripe-adapter-ledger.md, sections 1.4 and 12.7): account codes, the
// customer side of a posting and the content fingerprint. Positive amounts are debits, negative credits.
import { createHash } from 'node:crypto';

export type LedgerAccountKindName = 'asset' | 'liability' | 'revenue' | 'expense';

export const LEDGER_ACCOUNTS = {
  funds: 'customer_funds',
  overpayments: 'customer_overpayments',
  receivable: 'customer_receivable',
  clearing: (providerAccountId: string) => `provider_clearing:${providerAccountId}`,
} as const;

/** The customer accounts whose balances, per booking, are the customer money the ledger holds. */
export const CUSTOMER_ACCOUNTS: readonly string[] = [LEDGER_ACCOUNTS.funds, LEDGER_ACCOUNTS.overpayments, LEDGER_ACCOUNTS.receivable];

export function accountKind(code: string): LedgerAccountKindName {
  if (code.startsWith('provider_clearing:') || code === LEDGER_ACCOUNTS.receivable) return 'asset';
  if (code === LEDGER_ACCOUNTS.funds || code === LEDGER_ACCOUNTS.overpayments) return 'liability';
  throw new RangeError(`unknown ledger account ${code}`);
}

export interface LedgerLine {
  accountCode: string;
  amountMinor: bigint;
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
  reversesTransactionId: string | null;
  description: string;
  lines: readonly LedgerLine[];
}

/** SHA-256 of the canonical content: a retry gives the same, a different posting under the same key does not. */
export function contentSha256(c: PostingContent): string {
  const lines = [...c.lines].map((l) => [l.accountCode, l.amountMinor.toString()]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  // The dispute joins the fingerprint only when there is one, so every posting made before task 4.5 keeps its hash.
  const canonical = JSON.stringify([c.kind, c.mode, c.currency, c.bookingId, c.paymentId, c.refundId, c.reversesTransactionId, c.description, lines, ...(c.disputeId ? [c.disputeId] : [])]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Checks a posting before it is written (the database checks again at commit). */
export function assertBalanced(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) throw new RangeError('a ledger posting needs at least two lines');
  if (lines.some((l) => l.amountMinor === 0n)) throw new RangeError('a ledger line is never 0');
  if (lines.reduce((s, l) => s + l.amountMinor, 0n) !== 0n) throw new RangeError('a ledger posting must balance');
}

/** The key of the reallocation a plan change posts (plan 0.1, P5): one per version of the plan. */
export const scheduleReallocationKey = (bookingId: string, version: number): string => `schedule:${bookingId}:v${version}:reallocation`;
