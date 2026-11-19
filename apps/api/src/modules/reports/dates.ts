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

/** The first instant of a Brisbane calendar day (Brisbane has no daylight saving, so this is exact). */
export const startOfBusinessDay = (date: string): Date => instant(date, '00:00');

/** The latest scheduled instant strictly before `at`: for a send at `at`, the one before it. */
export const previousOccurrence = (schedule: ReportSchedule, at: Date): Date => latestOccurrence(schedule, new Date(at.getTime() - 1));

export type ReportRange = { kind: 'last_days'; days: number } | { kind: 'dates'; from: string; to: string };

/**
 * The first and last Brisbane day of a report range. On screen a `last_days` range is the last `days` days up to and
 * including today. For a scheduled send (`schedule` given, `now` the scheduled time) a `last_days` range is the whole
 * days from the day of the previous scheduled time up to the day before this one, whatever `days` is: consecutive sends
 * then cover every day exactly once, also when months have 28 to 31 days. A `dates` range is always as given.
 */
export function resolveRange(range: ReportRange, now: Date, opts: { schedule?: ReportSchedule } = {}): { from: string; to: string } {
  if (range.kind === 'dates') return { from: range.from, to: range.to };
  const today = todayInBusinessZone(now);
  if (opts.schedule) return { from: todayInBusinessZone(previousOccurrence(opts.schedule, now)), to: addDays(today, -1) };
  return { from: addDays(today, -(range.days - 1)), to: today };
}
