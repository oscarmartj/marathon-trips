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
  kind: 'deposit' | 'balance' | 'instalment' | 'adjustment';
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

/** An active item of a plan as an amendment finds it (dueDate as YYYY-MM-DD). */
export interface ActivePlanItem {
  kind: PlannedItem['kind'];
  sequence: number;
  amountMinor: bigint;
  dueDate: string;
}

/**
 * The plan after a change of the booking's total (task 6.3; plan docs/plans/6.3-booking-amendments.md, section 6). Pure,
 * bigint only, no rounding. Returns null when the total does not change (the plan stays as it is). Otherwise the items of
 * the next plan version, which always add up to the new total:
 * - a higher total keeps every item (kind, amount, due date) and adds an `adjustment` item for the difference, due on
 *   `adjustmentDue` but never before the last deposit item, so what "deposit covered" asks for never goes up; an
 *   adjustment already due that day takes the difference instead (one adjustment per due date);
 * - a lower total takes the difference from the last item backwards and leaves out items that reach 0.
 * Items are ordered by due date (deposit items first on a tie, then their old order) and numbered from 1.
 */
export function amendedPlanItems(active: readonly ActivePlanItem[], newTotalMinor: bigint, adjustmentDue: string): PlannedItem[] | null {
  if (typeof newTotalMinor !== 'bigint' || newTotalMinor < 0n) throw new AppError('plan_amounts_invalid', 'The new total must be a whole number of minor units, not negative');
  const old = [...active].sort((a, b) => a.sequence - b.sequence);
  const oldTotal = old.reduce((s, i) => s + i.amountMinor, 0n);
  if (newTotalMinor === oldTotal) return null;
  let items = old.map((i, idx) => ({ kind: i.kind, amountMinor: i.amountMinor, dueDate: i.dueDate, order: idx }));
  if (newTotalMinor > oldTotal) {
    const lastDeposit = old.filter((i) => i.kind === 'deposit').reduce((d, i) => (i.dueDate > d ? i.dueDate : d), '');
    const due = lastDeposit > adjustmentDue ? lastDeposit : adjustmentDue;
    // One adjustment per due date (code review round 3, point 2): a second rise falling due the same day adds to it, so
    // two items never share a reminder key (booking, kind, due date).
    const same = items.find((i) => i.kind === 'adjustment' && i.dueDate === due);
    if (same) same.amountMinor += newTotalMinor - oldTotal;
    else items.push({ kind: 'adjustment', amountMinor: newTotalMinor - oldTotal, dueDate: due, order: items.length });
  } else {
    let cut = oldTotal - newTotalMinor;
    for (let i = items.length - 1; i >= 0 && cut > 0n; i--) {
      const take = items[i]!.amountMinor < cut ? items[i]!.amountMinor : cut;
      items[i]!.amountMinor -= take;
      cut -= take;
    }
    items = items.filter((i) => i.amountMinor > 0n);
  }
  const rank = (k: PlannedItem['kind']) => (k === 'deposit' ? 0 : 1);
  items.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : rank(a.kind) - rank(b.kind) || a.order - b.order));
  const out = items.map((i, idx) => ({ kind: i.kind, sequence: idx + 1, amountMinor: i.amountMinor, dueDate: i.dueDate }));
  if (out.reduce((s, i) => s + i.amountMinor, 0n) !== newTotalMinor) throw new AppError('plan_sum_mismatch', 'The plan does not add up to the total');
  return out;
}
