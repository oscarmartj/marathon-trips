import type { ReportSchedule } from '@mt/shared';
import { REPORTS_TIME_ZONE, REPORTS_UTC_OFFSET_HOURS } from './manifest';

const HOUR = 3_600_000;
/** Missed occurrences older than this are not sent late (no flood after an outage). */
export const SCHEDULE_WINDOW_MS = 6 * HOUR;

export const todayInBusinessZone = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: REPORTS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The instant a Brisbane calendar day and time occur. */
const instant = (date: string, time: string): Date => new Date(Date.parse(`${date}T${time}:00.000Z`) - REPORTS_UTC_OFFSET_HOURS * HOUR);

/**
 * The latest scheduled instant at or before `now`. Weekly: the weekday (1 = Monday); monthly: the day of the month (1 to 28).
 * Pure, so it is table-tested.
 */
export function latestOccurrence(schedule: ReportSchedule, now: Date): Date {
  const local = new Date(now.getTime() + REPORTS_UTC_OFFSET_HOURS * HOUR);
  const today = local.toISOString().slice(0, 10);
  let candidate: Date;
  if (schedule.frequency === 'weekly') {
    const todayWeekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
    const back = (todayWeekday - schedule.weekday! + 7) % 7;
    candidate = instant(addDays(today, -back), schedule.time);
    if (candidate > now) candidate = instant(addDays(today, -back - 7), schedule.time);
  } else {
    const [y, m] = [local.getUTCFullYear(), local.getUTCMonth()];
    const of = (year: number, month: number) => instant(new Date(Date.UTC(year, month, schedule.dayOfMonth!)).toISOString().slice(0, 10), schedule.time);
    candidate = of(y, m);
    if (candidate > now) candidate = of(y, m - 1);
  }
  return candidate;
}

/** The first and last Brisbane day of a report range. */
export function resolveRange(range: { kind: 'last_days'; days: number } | { kind: 'dates'; from: string; to: string }, now: Date): { from: string; to: string } {
  if (range.kind === 'dates') return { from: range.from, to: range.to };
  const to = todayInBusinessZone(now);
  return { from: addDays(to, -(range.days - 1)), to };
}
