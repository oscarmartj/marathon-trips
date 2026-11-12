import { KEY_DATE_KINDS } from '@mt/shared';
import type { CalendarItem } from '@mt/shared';

// Helpers for the key dates panel (task 7.3). Display only: every date, count and task comes from the API.

export type { CalendarItem };

/** Only a date staff added can be changed or deleted here; the others are read from suppliers and bookings. */
export const isStored = (item: CalendarItem): boolean => item.keyDateId !== undefined;

/** The trip as one short line, such as "Polar Circle Marathon 2026". */
export const tripLabel = (e: { raceName: string; year: number }): string => `${e.raceName} ${e.year}`;

/** The path of the calendar, with an optional edition. */
export const calendarPath = (editionId: string): string => `/admin/key-dates${editionId ? `?${new URLSearchParams({ editionId }).toString()}` : ''}`;

/** The body for adding a date: a label only goes with a custom date, and a date picker yields YYYY-MM-DD. */
export function createBody(v: Record<string, string | boolean>): Record<string, unknown> {
  const kind = String(v.kind);
  const label = String(v.label ?? '').trim();
  return { editionId: String(v.editionId), kind, dueDate: String(v.dueDate), ...(kind === 'custom' && label ? { label } : {}) };
}

export const addableKinds: readonly string[] = KEY_DATE_KINDS;
