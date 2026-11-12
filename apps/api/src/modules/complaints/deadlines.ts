import { COMPLAINT_DUE_SOON_DAYS } from '@mt/shared';

// Deadline arithmetic for the complaints register. Everything is a calendar date as YYYY-MM-DD in Brisbane time, so a
// deadline never moves with the server's time zone. Pure functions: the service passes "today" in.

const DAY = 86_400_000;
const ms = (date: string): number => Date.parse(`${date}T00:00:00Z`);

export const addDays = (date: string, days: number): string => new Date(ms(date) + days * DAY).toISOString().slice(0, 10);
/** Whole days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from: string, to: string): number => Math.round((ms(to) - ms(from)) / DAY);

export interface DeadlineSettings {
  acknowledgeDays: number;
  resolveDays: number;
}

/**
 * Default deadlines counted from the day the complaint arrived. If the settings were ever saved the wrong way round,
 * acknowledging is still never due after resolving.
 */
export function defaultDueDates(receivedDate: string, s: DeadlineSettings): { acknowledgeDueDate: string; resolveDueDate: string } {
  const resolveDueDate = addDays(receivedDate, s.resolveDays);
  const acknowledgeDueDate = addDays(receivedDate, Math.min(s.acknowledgeDays, s.resolveDays));
  return { acknowledgeDueDate, resolveDueDate };
}

/**
 * - met: done on or before the due date
 * - late: done after the due date
 * - overdue: not done and the due date has passed (the due date itself is still on time)
 * - due_soon: not done and due within COMPLAINT_DUE_SOON_DAYS days
 * - pending: not done and further away
 * - not_applicable: the complaint was withdrawn before this step was needed
 */
export type DeadlineState = 'met' | 'late' | 'overdue' | 'due_soon' | 'pending' | 'not_applicable';

export interface Milestone {
  dueDate: string;
  /** Brisbane calendar day the step was done, or null. */
  doneOn: string | null;
  state: DeadlineState;
  /** Days from today to the due date while not done: negative once overdue. Null when done or not applicable. */
  daysLeft: number | null;
}

export function milestone(dueDate: string, doneOn: string | null, today: string, applicable: boolean): Milestone {
  if (!applicable) return { dueDate, doneOn, state: 'not_applicable', daysLeft: null };
  if (doneOn) return { dueDate, doneOn, state: doneOn <= dueDate ? 'met' : 'late', daysLeft: null };
  const daysLeft = daysBetween(today, dueDate);
  const state: DeadlineState = daysLeft < 0 ? 'overdue' : daysLeft <= COMPLAINT_DUE_SOON_DAYS ? 'due_soon' : 'pending';
  return { dueDate, doneOn: null, state, daysLeft };
}

export interface DeadlineInput {
  status: string;
  acknowledgeDueDate: string;
  resolveDueDate: string;
  acknowledgedOn: string | null;
  resolvedOn: string | null;
}

export function deadlinesOf(c: DeadlineInput, today: string): { acknowledge: Milestone; resolve: Milestone } {
  const withdrawn = c.status === 'withdrawn';
  return {
    // A complaint withdrawn before anyone acknowledged it owes no acknowledgement.
    acknowledge: milestone(c.acknowledgeDueDate, c.acknowledgedOn, today, !(withdrawn && !c.acknowledgedOn)),
    resolve: milestone(c.resolveDueDate, c.resolvedOn, today, !withdrawn),
  };
}
