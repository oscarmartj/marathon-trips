import { TRAVELLER_DETAIL_FIELDS, finishTimeToSeconds, secondsToFinishTime, travellerDetailsSchema } from '@mt/shared';
import type { BookingTravellersView, TravellerDetailsInput, TravellerView } from '@mt/shared';

// Traveller details (task 5.2). Pure helpers, tested without a browser. The page shows what the API sends: whether a
// form is shown comes from `editable`, the deadline from `editableUntil`; nothing here decides either.

/** What the form holds while a person types: all text, as typed. */
export interface DetailsForm {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  finishHours: string;
  finishMinutes: string;
}

export const emptyForm = (): DetailsForm => ({ givenName: '', familyName: '', dateOfBirth: '', emergencyContactName: '', emergencyContactPhone: '', finishHours: '', finishMinutes: '' });

export function formFrom(details: TravellerView['details']): DetailsForm {
  if (!details) return emptyForm();
  const finish = details.estimatedFinishSeconds === null ? { hours: '', minutes: '' } : secondsToFinishTime(details.estimatedFinishSeconds);
  return {
    givenName: details.givenName, familyName: details.familyName, dateOfBirth: details.dateOfBirth ?? '',
    emergencyContactName: details.emergencyContactName ?? '', emergencyContactPhone: details.emergencyContactPhone ?? '',
    finishHours: finish.hours, finishMinutes: finish.minutes,
  };
}

/** The form fields an error can point at (ids are `<field>` under a traveller's prefix). */
export type DetailsField = 'givenName' | 'familyName' | 'dateOfBirth' | 'emergencyContactName' | 'emergencyContactPhone' | 'estimatedFinish';
export type FormResult = { ok: true; body: TravellerDetailsInput } | { ok: false; errors: Partial<Record<DetailsField, string>> };

/** The schema's keys as the form's fields (the finish time is typed as hours and minutes). */
const FIELD_OF_KEY: Record<string, DetailsField> = Object.fromEntries(TRAVELLER_DETAIL_FIELDS.map((k) => [k, k === 'estimatedFinishSeconds' ? 'estimatedFinish' : k]));

const blank = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

/**
 * The body to send for one place: only the six detail keys (the API's strict schema refuses anything else), with the
 * runner-only ones left out for a supporter. Errors are message keys under account.travellers.errors.
 */
export function toDetailsBody(form: DetailsForm, runner: boolean): FormResult {
  const errors: Partial<Record<DetailsField, string>> = {};
  const seconds = runner ? finishTimeToSeconds(form.finishHours, form.finishMinutes) : null;
  if (runner && (form.finishHours.trim() !== '' || form.finishMinutes.trim() !== '') && seconds === null) errors.estimatedFinish = 'estimatedFinish';
  const candidate = {
    givenName: form.givenName.trim(), familyName: form.familyName.trim(),
    ...(runner && blank(form.dateOfBirth) ? { dateOfBirth: form.dateOfBirth.trim() } : {}),
    ...(blank(form.emergencyContactName) ? { emergencyContactName: form.emergencyContactName.trim() } : {}),
    ...(blank(form.emergencyContactPhone) ? { emergencyContactPhone: form.emergencyContactPhone.trim() } : {}),
    ...(seconds !== null ? { estimatedFinishSeconds: seconds } : {}),
  };
  const parsed = travellerDetailsSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = FIELD_OF_KEY[String(issue.path[0] ?? '')];
      if (field) errors[field] ??= field;
    }
    // Both emergency fields or neither: the refinement has no field of its own, so it points at the phone.
    if (Object.keys(errors).length === 0) errors.emergencyContactPhone = 'emergencyContactPhone';
  }
  return Object.keys(errors).length > 0 || !parsed.success ? { ok: false, errors } : { ok: true, body: parsed.data };
}

/** Message key (under account.travellers.errors) for an answer of the save and remove routes. */
export function saveErrorKey(status: number, code: string | undefined): string {
  if (status === 409 && code === 'travellers_not_editable') return 'notEditable';
  if (status === 401 || status === 404) return 'notFound';
  if (status === 422) return code === 'invalid_date_of_birth' ? 'dateOfBirth' : 'rejected';
  if (status === 429) return 'tooMany';
  return 'generic';
}

/** How many places have what the entry needs, from the API's own `complete` flags. */
export function progress(view: Pick<BookingTravellersView, 'travellers'>): { done: number; total: number } {
  return { done: view.travellers.filter((x) => x.complete).length, total: view.travellers.length };
}

/** Whether the booking page shows the section: a form can be used, or there is something saved to read. */
export const showTravellerSection = (view: BookingTravellersView | null): view is BookingTravellersView => !!view && (view.editable || view.travellers.some((x) => x.details !== null));

export const travellerHref = (reference: string): string | null => (/^MT-[0-9A-HJKMNP-TV-Z]{6}$/.test(reference) ? `/account/bookings/${reference}/travellers` : null);

/** The API path of a place's save and remove routes. */
export const travellerPath = (reference: string, slot: number): string => `/account/bookings/${encodeURIComponent(reference)}/travellers/${slot}`;
