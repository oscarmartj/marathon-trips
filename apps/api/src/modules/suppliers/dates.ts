// Calendar dates in the business time zone (plan 0.1, 1.2): Australia/Brisbane, UTC+10 all year (no daylight saving).
// A supplier payment due on day D is due until the end of D in Brisbane, so it is overdue from D 14:00:00Z.

export const SUPPLIERS_TIME_ZONE = 'Australia/Brisbane';

/** Today in Brisbane as YYYY-MM-DD. */
export const todayInBrisbane = (now: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: SUPPLIERS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** A calendar date plus a number of days (negative goes back). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The last instant of a Brisbane calendar day (the next day's 00:00 in Brisbane, minus 1 ms). */
export const endOfBrisbaneDay = (date: string): Date => new Date(new Date(`${addDays(date, 1)}T00:00:00.000+10:00`).getTime() - 1);

export const longDate = (date: string): string => new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

export type DueBucket = 'overdue' | 'due_today' | 'upcoming' | 'later' | 'undated';

/** Days of notice before a supplier payment is due (task 6.2, like task 7.3's key dates). */
export const SUPPLIER_PAYMENT_LEAD_DAYS = 7;

/** Which bucket of the schedule an unpaid cost item falls in (plan 6.2, section 3.5). */
export function dueBucket(dueDate: string | null, today: string): DueBucket {
  if (!dueDate) return 'undated';
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'due_today';
  if (dueDate <= addDays(today, SUPPLIER_PAYMENT_LEAD_DAYS)) return 'upcoming';
  return 'later';
}
