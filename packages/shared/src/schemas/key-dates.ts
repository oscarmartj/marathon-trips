import { z } from 'zod';
import { isoDateSchema, versionSchema } from './catalogue';

// Key dates calendar (task 7.3). Three kinds of date appear on it: two come from other modules and are read-only here
// (a contracted allotment's release date, a booking balance's due date); the entry submission deadline and any other
// date staff add are stored by this module. Strict objects: an unknown field is a 422.

/** What staff can add to an edition. The derived kinds are never stored. */
export const KEY_DATE_KINDS = ['entry_submission', 'custom'] as const;
export const CALENDAR_ITEM_KINDS = ['allotment_release', 'balance_due', 'entry_submission', 'custom'] as const;
export type KeyDateKind = (typeof KEY_DATE_KINDS)[number];
export type CalendarItemKind = (typeof CALENDAR_ITEM_KINDS)[number];

/** Days before a key date when its task is opened. A fixed business rule until a setting exists (done note 7.3). */
export const KEY_DATE_LEAD_DAYS = 7;
/** A date more than this many days past is not given a new task (it is on the calendar, shown as overdue). */
export const KEY_DATE_LOOKBACK_DAYS = 30;

const label = z.string().trim().min(1).max(120);
const reason = z.string().trim().min(1).max(500).optional();

export const createKeyDateSchema = z
  .strictObject({
    editionId: z.uuid(),
    kind: z.enum(KEY_DATE_KINDS),
    /** Required for `custom`; an entry submission deadline needs none. */
    label: label.optional(),
    dueDate: isoDateSchema,
    reason,
  })
  .refine((v) => v.kind !== 'custom' || !!v.label, { message: 'A label is required for a custom date', path: ['label'] });

export const updateKeyDateSchema = z.strictObject({ label: label.nullable().optional(), dueDate: isoDateSchema.optional(), version: versionSchema, reason });
/** A DELETE has no body here: the version the caller read travels in the query. */
export const deleteKeyDateSchema = z.strictObject({ version: z.coerce.number().int().min(0), reason });

export const calendarQuerySchema = z.strictObject({
  /** The first day shown. Default: today (Brisbane). */
  from: isoDateSchema.optional(),
  /** The last day shown. Default: 90 days after `from`. */
  to: isoDateSchema.optional(),
  editionId: z.uuid().optional(),
});

export interface CalendarItem {
  /** Stable key: kind and the id of the thing the date belongs to. */
  key: string;
  kind: CalendarItemKind;
  date: string;
  overdue: boolean;
  edition: { id: string; year: number; raceName: string };
  /** Only a stored date has these. */
  keyDateId?: string;
  version?: number;
  label?: string | null;
  /** Release: allotment, supplier, pool. Balance: how many bookings. */
  count?: number;
  detail?: string;
  /** The open task the system made for this date, if there is one. */
  taskId?: string | null;
}
