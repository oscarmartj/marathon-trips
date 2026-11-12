// Calendar dates for pricing (plan 0.1, 1.2): days, never money. This file and rounding.ts are the only ones in the
// pricing module allowed to divide; a test checks that this one holds no bigint.

/** The business time zone (plan 0.1, assumption 1). A constant until Setting.businessTimeZone exists. */
export const BUSINESS_TIME_ZONE = 'Australia/Brisbane';

const MS_PER_DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function calendarDateIn(instant: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f.format(instant);
}

const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map((x) => +x) as [number, number, number];
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
};

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** `iso` plus `days` calendar days. */
export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * MS_PER_DAY).toISOString().slice(0, 10);
}
