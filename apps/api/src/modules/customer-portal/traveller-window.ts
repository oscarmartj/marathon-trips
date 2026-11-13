import type { BookingStatus } from '@mt/shared';

/**
 * Whether the customer can still change a booking's traveller details (task 5.2, plan docs/plans/5.2-traveller-details.md,
 * section 2). Pure: the service gives it the facts and the API's own clock, so the browser never decides.
 */

/** Details are asked for once the deposit is in; a finished trip keeps them but nobody changes them. */
export const DETAILS_OPEN_STATUSES: readonly BookingStatus[] = ['deposit_paid', 'confirmed', 'balance_paid'];
/** The business setting: days before the race start by which details lock when staff have set no key date. */
export const TRAVELLER_SETTINGS = { cutoffDays: { key: 'travellerDetailsCutoffDays', fallback: 14 } } as const;

export interface WindowFacts {
  status: BookingStatus;
  /** The edition's entry submission key date (a calendar date), when staff have set one. */
  entrySubmissionDate: string | null;
  /** The edition's start date (a calendar date), when it is known. */
  raceStartDate: string | null;
  /** Days before the race start when there is no key date. */
  cutoffDays: number;
  /** Today in Brisbane, from the API's clock. */
  today: string;
}

export interface EditWindow {
  editable: boolean;
  reason: 'booking_status' | 'deadline_passed' | null;
  editableUntil: string | null;
}

const minusDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/** The last day details can be saved: the key date if there is one, else the race start less the cutoff; null with neither. */
export function lastEditableDay(f: Pick<WindowFacts, 'entrySubmissionDate' | 'raceStartDate' | 'cutoffDays'>): string | null {
  if (f.entrySubmissionDate) return f.entrySubmissionDate;
  return f.raceStartDate ? minusDays(f.raceStartDate, f.cutoffDays) : null;
}

export function editWindow(f: WindowFacts): EditWindow {
  const editableUntil = lastEditableDay(f);
  if (!DETAILS_OPEN_STATUSES.includes(f.status)) return { editable: false, reason: 'booking_status', editableUntil };
  // The last day itself is still open: dates are Brisbane calendar days, compared as such.
  if (editableUntil !== null && f.today > editableUntil) return { editable: false, reason: 'deadline_passed', editableUntil };
  return { editable: true, reason: null, editableUntil };
}
