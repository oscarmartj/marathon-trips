import { z } from 'zod';

// Traveller details (task 5.2, plan docs/plans/5.2-traveller-details.md). The minimum an entry and a safe trip need:
// a name as on the travel document, a date of birth and an optional finish time for runners, and an optional emergency
// contact. There is deliberately no field for a passport or ID number, nationality, gender, address, or anything
// medical or dietary, and the schemas are strict, so such a key is refused rather than stored.

/** The details keys, in form order. The form, the API and the tests all read this one list. */
export const TRAVELLER_DETAIL_FIELDS = ['givenName', 'familyName', 'dateOfBirth', 'emergencyContactName', 'emergencyContactPhone', 'estimatedFinishSeconds'] as const;

/** Estimated finish time bounds, in seconds: ten minutes to seventy-two hours. */
export const FINISH_SECONDS_MIN = 600;
export const FINISH_SECONDS_MAX = 259_200;

/** A person's name: letters (any script), marks, spaces, apostrophes, full stops and hyphens; no digits or other symbols. */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '’.-]*$/u;
const PHONE_PATTERN = /^\+?[0-9 ()-]{6,20}$/;

const name = z.string().trim().min(1).max(100).regex(NAME_PATTERN);
const phone = z.string().trim().regex(PHONE_PATTERN).refine((v) => v.replace(/\D/g, '').length >= 6);

/** A real calendar date, YYYY-MM-DD, not before 1900. "Not in the future" is checked by the API against Brisbane's today. */
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01';
}, 'not a real date');

/** What the customer sends for one place. Replaces the whole record: a key left out is cleared. */
export const travellerDetailsSchema = z.strictObject({
  givenName: name,
  familyName: name,
  dateOfBirth: calendarDate.nullish(),
  emergencyContactName: name.nullish(),
  emergencyContactPhone: phone.nullish(),
  estimatedFinishSeconds: z.number().int().min(FINISH_SECONDS_MIN).max(FINISH_SECONDS_MAX).nullish(),
}).refine((b) => (b.emergencyContactName == null) === (b.emergencyContactPhone == null), { message: 'send both emergency contact fields or neither', path: ['emergencyContactPhone'] });
export type TravellerDetailsInput = z.infer<typeof travellerDetailsSchema>;

export const TRAVELLER_PARTICIPATION_TYPES = ['runner_with_entry', 'runner_own_entry', 'supporter'] as const;
export const TRAVELLER_UNEDITABLE_REASONS = ['booking_status', 'deadline_passed'] as const;

export const travellerDetailsViewSchema = z.strictObject({
  givenName: z.string(),
  familyName: z.string(),
  dateOfBirth: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  estimatedFinishSeconds: z.number().int().nullable(),
});

export const travellerViewSchema = z.strictObject({
  slot: z.number().int(),
  participationType: z.enum(TRAVELLER_PARTICIPATION_TYPES),
  isLead: z.boolean(),
  /** Runners are asked for a date of birth and a finish time; supporters are not. */
  runner: z.boolean(),
  details: travellerDetailsViewSchema.nullable(),
  /** The details the entry needs are in: a name, and a date of birth for a runner. */
  complete: z.boolean(),
});
export type TravellerView = z.infer<typeof travellerViewSchema>;

/** The places of a booking and whether the customer can still change them. The deadline is the API's, never computed in the browser. */
export const bookingTravellersViewSchema = z.strictObject({
  editable: z.boolean(),
  reason: z.enum(TRAVELLER_UNEDITABLE_REASONS).nullable(),
  /** Last day (a Brisbane calendar date) on which details can be saved; null when no date is set yet. */
  editableUntil: z.string().nullable(),
  travellers: z.array(travellerViewSchema),
});
export type BookingTravellersView = z.infer<typeof bookingTravellersViewSchema>;

/** Hours and minutes typed by a runner to seconds for the API. Returns null for an empty or out-of-range entry. */
export function finishTimeToSeconds(hours: string, minutes: string): number | null {
  if (hours.trim() === '' && minutes.trim() === '') return null;
  if (!/^\d{1,2}$/.test(hours.trim() || '0') || !/^\d{1,2}$/.test(minutes.trim() || '0')) return null;
  const h = Number(hours.trim() || '0');
  const m = Number(minutes.trim() || '0');
  if (m > 59) return null;
  const seconds = h * 3600 + m * 60;
  return seconds >= FINISH_SECONDS_MIN && seconds <= FINISH_SECONDS_MAX ? seconds : null;
}

/** Seconds to the hours and minutes a form shows. */
export function secondsToFinishTime(seconds: number): { hours: string; minutes: string } {
  return { hours: String(Math.floor(seconds / 3600)), minutes: String(Math.round((seconds % 3600) / 60) % 60) };
}
