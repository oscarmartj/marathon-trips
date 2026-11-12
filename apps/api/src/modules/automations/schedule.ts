import type { AutomationSchedule } from '@mt/shared';

// Pure date arithmetic for scheduled rules (task 7.4, plan section 5, point 13). One occurrence per local calendar
// date. A wall time that does not exist (daylight saving gap) moves forward by the gap (02:30 becomes 03:30); a wall time
// that happens twice (the repeated hour) is the earlier instant.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local wall time of an instant, as a UTC timestamp number (the "wall clock as if it were UTC"). */
function wallOf(ms: number, timeZone: string): number {
  const p = Object.fromEntries(partsFormatter(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** The zone's offset from UTC at an instant, in milliseconds (whole seconds). */
export function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallOf(whole, timeZone) - whole;
}

/** The instant at which the zone's clocks show this wall time (see the rules above). */
export function instantOfWall(wall: number, timeZone: string): number {
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const valid = [...new Set([wall - before, wall - after])].filter((c) => offsetAt(c, timeZone) === wall - c);
  if (valid.length > 0) return Math.min(...valid);
  return wall - before; // in the gap: the old offset puts it after the jump, shifted forward by the gap
}

/** YYYY-MM-DD in the zone. */
export function localDate(at: Date, timeZone: string): string {
  return new Date(wallOf(at.getTime(), timeZone)).toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday) of a YYYY-MM-DD date. */
const isoWeekday = (date: string): number => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

/** The latest occurrence of the schedule at or before `now`, looking back at most eight days. */
export function latestOccurrence(schedule: AutomationSchedule, now: Date, timeZone: string): Date | null {
  const [hh, mm] = schedule.time.split(':').map(Number) as [number, number];
  const today = localDate(now, timeZone);
  for (let back = 0; back <= 8; back += 1) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) - back * DAY).toISOString().slice(0, 10);
    if (schedule.frequency === 'weekly' && !(schedule.weekdays ?? []).includes(isoWeekday(date))) continue;
    const at = instantOfWall(Date.parse(`${date}T00:00:00Z`) + hh * HOUR + mm * 60_000, timeZone);
    if (at <= now.getTime()) return new Date(at);
  }
  return null;
}

/** How long after its time a missed occurrence may still run (an outage longer than this is not caught up). */
export const SCHEDULE_GRACE_MS = 6 * HOUR;
