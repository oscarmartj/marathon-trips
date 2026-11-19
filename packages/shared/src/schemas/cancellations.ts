import { z } from 'zod';
import { SUPPORTED_CURRENCIES, localisedTextSchema, optionalLocalisedTextSchema, uuidSchema, versionSchema } from './catalogue';

// Cancellation policies and cancellations (task 6.4, plan docs/plans/6.4-cancellation-policies.md). The API works out
// every penalty and refund: no request here carries an amount to charge or give back, and the web only shows what the
// API returns. A policy's fixed amounts are configuration, entered by staff, like a rate.

export const CANCELLATION_POLICY_STATUSES = ['draft', 'active', 'archived'] as const;
export const CANCELLATION_PENALTY_MODES = ['percent', 'fixed_per_person', 'fixed_per_booking'] as const;
export const CANCELLATION_BASES = ['policy', 'not_contracted', 'no_policy', 'operator_cancelled'] as const;
export const MAX_CANCELLATION_TIERS = 10;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const minorAmount = z.string().regex(/^\d{1,11}$/);
const staffReason = z.string().trim().min(1).max(500);

export const cancellationTierInputSchema = z.strictObject({
  minDaysBeforeDeparture: z.number().int().min(0).max(3650),
  penaltyMode: z.enum(CANCELLATION_PENALTY_MODES),
  penaltyBps: z.number().int().min(0).max(10_000).nullable(),
  penaltyMinor: minorAmount.nullable(),
  currency: z.enum(SUPPORTED_CURRENCIES).nullable(),
});
export type CancellationTierInput = z.infer<typeof cancellationTierInputSchema>;

export const createCancellationPolicySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: localisedTextSchema(1000),
});
export const updateCancellationPolicySchema = z.strictObject({
  version: versionSchema,
  name: z.string().trim().min(1).max(120).optional(),
  description: optionalLocalisedTextSchema(1000).optional(),
});
export const setCancellationTiersSchema = z.strictObject({
  version: versionSchema,
  tiers: z.array(cancellationTierInputSchema).max(MAX_CANCELLATION_TIERS),
});
export const cancellationPolicyVersionSchema = z.strictObject({ version: versionSchema });
/** Assign (policyId) or remove (null) a package's policy; `version` is the assignment's, null when there is none yet. */
export const assignPackageCancellationPolicySchema = z.strictObject({
  policyId: uuidSchema.nullable(),
  version: versionSchema.nullable(),
});

/** What the customer saw: sent back with a request, a quote acceptance and the terms (plan section 13, M2). */
export const cancellationPolicyRefSchema = z.strictObject({ id: uuidSchema, digest: digestSchema });
export type CancellationPolicyRef = z.infer<typeof cancellationPolicyRefSchema>;

export const acceptQuoteSchema = z.strictObject({ cancellationPolicy: cancellationPolicyRefSchema.nullable().default(null) });
export type AcceptQuote = z.infer<typeof acceptQuoteSchema>;

/** Staff cancel: the version the panel read, a reason, the digest of the quote shown (required), and the operator flag. */
export const staffCancelBookingSchema = z.strictObject({
  version: versionSchema,
  reason: staffReason,
  quoteDigest: digestSchema,
  operatorCancelled: z.boolean().default(false),
});
export type StaffCancelBooking = z.infer<typeof staffCancelBookingSchema>;

export const customerCancelBookingSchema = z.strictObject({ quoteDigest: digestSchema });
export type CustomerCancelBooking = z.infer<typeof customerCancelBookingSchema>;

const minor = z.string().regex(/^\d+$/);
const signedMinor = z.string().regex(/^-?\d+$/);

export const cancellationTierViewSchema = z.object({
  minDaysBeforeDeparture: z.number().int(),
  penaltyMode: z.enum(CANCELLATION_PENALTY_MODES),
  penaltyBps: z.number().int().nullable(),
  penaltyMinor: minor.nullable(),
  currency: z.string().nullable(),
});
export type CancellationTierView = z.infer<typeof cancellationTierViewSchema>;

/** A policy as customers see it (tiers from the highest threshold down). */
export const cancellationPolicyPublicViewSchema = z.object({
  id: uuidSchema,
  digest: digestSchema,
  description: z.record(z.string(), z.string()),
  tiers: z.array(cancellationTierViewSchema),
});
export type CancellationPolicyPublicView = z.infer<typeof cancellationPolicyPublicViewSchema>;

export const cancellationQuoteViewSchema = z.object({
  bookingId: uuidSchema,
  currency: z.string(),
  basis: z.enum(CANCELLATION_BASES),
  /** YYYY-MM-DD the days are counted from (a blocked request's date, within its window, or today). */
  effectiveDate: z.string(),
  daysBeforeDeparture: z.number().int(),
  tier: cancellationTierViewSchema.nullable(),
  policy: cancellationPolicyPublicViewSchema.nullable(),
  heldMinor: signedMinor,
  policyPenaltyMinor: minor,
  penaltyMinor: minor,
  waivedMinor: minor,
  refundableMinor: minor,
  /** Why cancelling is not possible now (money moving, state, departure…); null when it is. */
  blockedReason: z.string().nullable(),
  quoteDigest: digestSchema,
});
export type CancellationQuoteView = z.infer<typeof cancellationQuoteViewSchema>;

export const cancellationViewSchema = z.object({
  id: uuidSchema,
  requestedBy: z.enum(['customer', 'staff']),
  basis: z.enum(CANCELLATION_BASES),
  businessDate: z.string(),
  processedDate: z.string(),
  daysBeforeDeparture: z.number().int(),
  tierMinDays: z.number().int().nullable(),
  currency: z.string(),
  baseTotalMinor: minor,
  collectedMinor: signedMinor,
  policyPenaltyMinor: minor,
  penaltyMinor: minor,
  waivedMinor: minor,
  refundableMinor: minor,
  createdAt: z.string(),
});
export type CancellationView = z.infer<typeof cancellationViewSchema>;
