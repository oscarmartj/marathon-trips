import { z } from 'zod';
import { PARTICIPATION_TYPES, uuidSchema } from './catalogue';
import { MAX_EXTRA_QUANTITY, MAX_QUOTE_EXTRAS, MAX_QUOTE_ROOMS, MAX_QUOTE_TRAVELLERS } from './pricing';

// Changes to a booking after its deposit (task 6.3; plan docs/plans/6.3-booking-amendments.md, section 8). Strict at every
// level and with no amount, total, price or date field: the server prices the change and works out what is owed.

/** A booking's place number (1 to 80, the most a booking can ever use). */
const placeSchema = z.number().int().min(1).max(80);
const versionNumber = z.number().int().min(1).max(1000);
const nightsSchema = z.number().int().min(0).max(30);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const AMENDMENT_REASONS = ['customer_request', 'correction', 'supplier_change', 'other'] as const;
export type AmendmentReason = (typeof AMENDMENT_REASONS)[number];
export const AMENDMENT_CHANGES = ['room', 'nights', 'travellers_added', 'travellers_removed', 'participation', 'extras'] as const;

/** A traveller of the new configuration: an existing place kept as it is, or a new place (replacing one, or not). */
const keptTraveller = z.strictObject({ keepSlot: placeSchema });
const newTraveller = z.strictObject({
  participationType: z.enum(PARTICIPATION_TYPES),
  raceDistanceId: uuidSchema.optional(),
  /** The place this one replaces (a change of distance or of kind of traveller); its details are carried over. */
  replacesSlot: placeSchema.optional(),
});
export const amendmentTravellerSchema = z.union([keptTraveller, newTraveller]);
export type AmendmentTravellerRequest = z.infer<typeof amendmentTravellerSchema>;

const staffExtra = z.strictObject({
  extraId: uuidSchema,
  /** Per-person extras: positions (1-based, in the order of rooms and travellers of this request), as in a quote. */
  travellerSlots: z.array(z.number().int().min(1).max(MAX_QUOTE_TRAVELLERS)).max(MAX_QUOTE_TRAVELLERS).optional(),
  quantity: z.number().int().min(1).max(MAX_EXTRA_QUANTITY).optional(),
});

const staffFields = {
  expectedSnapshotVersion: versionNumber,
  rooms: z.array(z.strictObject({ roomOptionId: uuidSchema, travellers: z.array(amendmentTravellerSchema).min(1).max(4) })).min(1).max(MAX_QUOTE_ROOMS),
  extraNightsBefore: nightsSchema,
  extraNightsAfter: nightsSchema,
  extras: z.array(staffExtra).max(MAX_QUOTE_EXTRAS),
  reasonCode: z.enum(AMENDMENT_REASONS),
};
/** The panel's preview of a change. */
export const staffAmendmentPreviewSchema = z.strictObject(staffFields);
/** The panel applies the change it previewed. */
export const staffAmendmentSchema = z.strictObject({ ...staffFields, previewDigest: digestSchema });
export type StaffAmendmentPreview = z.infer<typeof staffAmendmentPreviewSchema>;
export type StaffAmendment = z.infer<typeof staffAmendmentSchema>;

const customerExtra = z.strictObject({
  extraId: uuidSchema,
  /** Per-person extras: the booking's place numbers that take it. */
  travellerSlots: z.array(placeSchema).max(MAX_QUOTE_TRAVELLERS).optional(),
  quantity: z.number().int().min(1).max(MAX_EXTRA_QUANTITY).optional(),
});
const customerFields = {
  expectedSnapshotVersion: versionNumber,
  extraNightsBefore: nightsSchema,
  extraNightsAfter: nightsSchema,
  /** Every optional extra the booking should have after the change (mandatory ones are added by the server). */
  extras: z.array(customerExtra).max(MAX_QUOTE_EXTRAS),
};
/** A customer's preview of a change: nights and extras only. */
export const customerAmendmentPreviewSchema = z.strictObject(customerFields);
/** The customer applies the change they previewed and accepts its price. */
export const customerAmendmentSchema = z.strictObject({ ...customerFields, previewDigest: digestSchema, acceptNewPrice: z.literal(true) });
export type CustomerAmendmentPreview = z.infer<typeof customerAmendmentPreviewSchema>;
export type CustomerAmendment = z.infer<typeof customerAmendmentSchema>;
