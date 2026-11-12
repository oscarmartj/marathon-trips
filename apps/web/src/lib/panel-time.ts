// Pure helpers for the instants the pricing panel sends and shows (task 2.2b). A <input type="datetime-local"> holds
// text such as "2027-03-01T09:30" in the browser's own time; the API wants an instant. The offset is passed in, so
// the functions give the same answer on every machine and are easy to test.

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The offset from UTC, in minutes east, that the browser has at the moment named by this local text. */
export const offsetAtLocal = (local: string): number => -new Date(local).getTimezoneOffset();

/** The offset from UTC, in minutes east, that the browser has at this instant. */
export const offsetAtInstant = (iso: string): number => -new Date(iso).getTimezoneOffset();

/** A fixed offset, or a function that picks it from the text (a browser zone with daylight saving has a different offset in summer). */
export type Offset = number | ((text: string) => number);
export const resolveOffset = (offset: Offset, text: string): number => (typeof offset === 'function' ? offset(text) : offset);

/** "2027-03-01T09:30" at an offset (minutes east of UTC) to an ISO instant in UTC. Null when it is not a real date and time. */
export function localToIso(local: string, offsetMinutes: number): string | null {
  const m = LOCAL.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(ms);
  // Date.UTC rolls 31 February over to March: a date that changes when read back is not a date.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return new Date(ms - offsetMinutes * 60_000).toISOString();
}

/** An ISO instant to the text a datetime-local input holds, at an offset (minutes east of UTC). Empty for null or nonsense. */
export function isoToLocal(iso: string | null | undefined, offsetMinutes: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t + offsetMinutes * 60_000).toISOString().slice(0, 16);
}

/** True when two ISO instants are the same moment (the API may write the same instant in another form). */
export const sameInstant = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
};

/** An instant for people: "1 Mar 2027, 9:30 am AEST" in the browser's time zone. */
export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' }).format(new Date(iso));
}
