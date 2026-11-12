import { KEYDATES_TIME_ZONE } from './manifest';

/** Today's calendar date in the business time zone, as YYYY-MM-DD. */
export const todayInBusinessZone = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: KEYDATES_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The instant a business-zone day starts (Brisbane is UTC+10 all year). Used as the due time of a task. */
export const startOfBusinessDay = (date: string): Date => new Date(`${date}T00:00:00+10:00`);

export const longDate = (date: string): string => new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
