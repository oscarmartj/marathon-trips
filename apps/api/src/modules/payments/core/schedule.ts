// The payment plan of a booking (plan 3.1, section 4.1). Pure: the amounts come from the booking's current snapshot,
// which the pricing engine computed with the single rounding rule; payments rounds nothing. The only arithmetic is
// balance = total − deposit, in bigint.
import { AppError } from '../../../platform/errors/safe-error';

export const BUSINESS_TIME_ZONE = 'Australia/Brisbane';

export interface PlanInput {
  totalMinor: bigint;
  depositMinor: bigint;
  /** Calendar date from the engine (@db.Date, UTC midnight). */
  balanceDueDate: Date;
  approvalExpiresAt: Date;
  timeZone?: string;
}

export interface PlannedItem {
  kind: 'deposit' | 'balance';
  sequence: number;
  amountMinor: bigint;
  /** YYYY-MM-DD in the business time zone. */
  dueDate: string;
}

/** The calendar date of an instant in a time zone, as YYYY-MM-DD. */
export const dateIn = (at: Date, timeZone = BUSINESS_TIME_ZONE): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Deposit due the day (business time zone) the approval expires; balance due on the engine's balance date, or with the
 * deposit if that date would already have passed. Zero items are left out; a total of 0 is a plan with no items.
 */
export function planItems(input: PlanInput): PlannedItem[] {
  const { totalMinor, depositMinor } = input;
  if (typeof totalMinor !== 'bigint' || typeof depositMinor !== 'bigint') throw new AppError('plan_amounts_not_integers', 'Plan amounts must be integers in minor units');
  if (depositMinor < 0n || totalMinor < 0n || depositMinor > totalMinor) throw new AppError('plan_amounts_invalid', 'The deposit must be between 0 and the total');
  const depositDue = dateIn(input.approvalExpiresAt, input.timeZone);
  const balanceDate = ymd(input.balanceDueDate);
  const balanceDue = balanceDate > depositDue ? balanceDate : depositDue;
  const items: PlannedItem[] = [];
  if (depositMinor > 0n) items.push({ kind: 'deposit', sequence: items.length + 1, amountMinor: depositMinor, dueDate: depositDue });
  const balance = totalMinor - depositMinor;
  if (balance > 0n) items.push({ kind: 'balance', sequence: items.length + 1, amountMinor: balance, dueDate: balanceDue });
  const sum = items.reduce((s, i) => s + i.amountMinor, 0n);
  if (sum !== totalMinor) throw new AppError('plan_sum_mismatch', 'The plan does not add up to the total');
  for (let i = 1; i < items.length; i++) if (items[i]!.dueDate < items[i - 1]!.dueDate) throw new AppError('plan_dates_out_of_order', 'Plan due dates go backwards');
  return items;
}
