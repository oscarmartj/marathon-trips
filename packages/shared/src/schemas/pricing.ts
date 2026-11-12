import { z } from 'zod';
import { PARTICIPATION_TYPES, isoDateSchema, uuidSchema, versionSchema } from './catalogue';

// Pricing (task 2.1, plan docs/plans/2.1-pricing-engine.md). The API's pricing engine is the only place a total is
// computed: these schemas describe what a client may ask for (a configuration, never an amount) and what the API
// answers (a breakdown whose amounts are strings of digits). Nothing here does arithmetic on money.

/** Business limit for one line of a breakdown or one rate: A$1,000,000 in cents (plan 0.1, 1.1). */
export const MAX_LINE_MINOR = 100_000_000n;
/** Business limit for the total of one quote: A$10,000,000 in cents. */
export const MAX_TOTAL_MINOR = 1_000_000_000n;
/** Upper bounds that keep a quote request small. */
export const MAX_QUOTE_ROOMS = 20;
export const MAX_QUOTE_EXTRAS = 50;
export const MAX_EXTRA_QUANTITY = 100;

const reason = z.string().trim().min(1).max(500).optional();

/** A non-negative amount in minor units, as a string of digits, within the line limit. */
export const rateAmountSchema = z
  .string()
  .regex(/^\d{1,12}$/)
  // zod 4 runs every check, so the refinement must not trust the regex: BigInt('1.5') would throw.
  .refine((s) => /^\d{1,12}$/.test(s) && BigInt(s) <= MAX_LINE_MINOR, { message: 'Amount is above the allowed limit' });

// ---- What a client may ask for ----

const travellerRequest = z.strictObject({
  participationType: z.enum(PARTICIPATION_TYPES),
  raceDistanceId: uuidSchema.optional(),
});

const roomRequest = z.strictObject({
  roomOptionId: uuidSchema,
  travellers: z.array(travellerRequest).min(1).max(4),
});

const extraRequest = z.strictObject({
  extraId: uuidSchema,
  /** Per-person extras: the traveller slots (1-based, in the order of rooms and travellers) that take it. */
  travellerSlots: z.array(z.number().int().min(1).max(4 * MAX_QUOTE_ROOMS)).max(4 * MAX_QUOTE_ROOMS).optional(),
  /** Per-booking extras: how many. */
  quantity: z.number().int().min(1).max(MAX_EXTRA_QUANTITY).optional(),
});

const quoteFields = {
  packageId: uuidSchema,
  rooms: z.array(roomRequest).min(1).max(MAX_QUOTE_ROOMS),
  extraNightsBefore: z.number().int().min(0).max(30).default(0),
  extraNightsAfter: z.number().int().min(0).max(30).default(0),
  extras: z.array(extraRequest).max(MAX_QUOTE_EXTRAS).default([]),
  promoCode: z.string().trim().min(1).max(40).optional(),
};

/**
 * A quote request: a configuration and nothing else. Strict at every level, so a field such as `priceMinor`, `total`
 * or a date is a 422, never silently ignored (plan 2.1, threats 1 and 10).
 */
export const quoteRequestSchema = z.strictObject(quoteFields);
/** The panel may also price a given version, a draft included, to preview it before publishing (plan 2.1, M7). */
export const adminQuoteRequestSchema = z.strictObject({ ...quoteFields, priceVersionId: uuidSchema.optional() });
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type AdminQuoteRequest = z.infer<typeof adminQuoteRequestSchema>;

// ---- Price versions and rates (panel) ----

export const PRICE_VERSION_STATUSES = ['draft', 'published', 'archived'] as const;

export const createPriceVersionSchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  /** Start from the rates of the version in force now. */
  copyCurrent: z.boolean().default(false),
  reason,
});

export const roomRateInputSchema = z.strictObject({
  roomOptionId: uuidSchema,
  occupancy: z.number().int().min(1).max(4),
  pricePerPersonMinor: rateAmountSchema,
  extraNightPerPersonMinor: rateAmountSchema,
});

export const participationRateInputSchema = z.strictObject({
  participationType: z.enum(PARTICIPATION_TYPES),
  raceDistanceId: uuidSchema.nullable().default(null),
  amountPerPersonMinor: rateAmountSchema,
});

export const extraRateInputSchema = z.strictObject({ extraId: uuidSchema, amountMinor: rateAmountSchema });

/** Replaces every rate of a draft version (a PUT): what is not listed is removed. */
export const setRatesSchema = z.strictObject({
  version: versionSchema,
  roomRates: z.array(roomRateInputSchema).max(500),
  participationRates: z.array(participationRateInputSchema).max(100),
  extraRates: z.array(extraRateInputSchema).max(200),
  reason,
});

/**
 * `replacesVersionId` is the version in force the publisher saw (null if none): publishing is a compare-and-set on it,
 * so of two drafts published at once only one wins (M3).
 */
export const publishPriceVersionSchema = z.strictObject({ version: versionSchema, replacesVersionId: uuidSchema.nullable(), reason });

// ---- What the API answers ----

const minor = z.string().regex(/^\d+$/);
const signedMinor = z.string().regex(/^-?\d+$/);

export const PRICE_COMPONENTS = ['accommodation', 'participation', 'extras'] as const;
export const RULE_TARGETS = ['accommodation', 'participation', 'extras', 'subtotal'] as const;

const ruleEffectSchema = z.strictObject({
  kind: z.string(),
  direction: z.enum(['discount', 'surcharge']),
  effectMode: z.enum(['percent', 'fixed']),
  valueBps: z.number().int().nullable(),
  valueMinor: minor.nullable(),
  per: z.enum(['person', 'booking']),
  appliesTo: z.enum(RULE_TARGETS),
});

export const priceLineSchema = z.strictObject({
  key: z.string(),
  component: z.enum(RULE_TARGETS),
  kind: z.enum(['room', 'extra_nights', 'participation', 'extra', 'rule', 'promo']),
  direction: z.enum(['charge', 'surcharge', 'discount']),
  travellerSlot: z.number().int().nullable(),
  refId: z.string().nullable(),
  unitAmountMinor: minor,
  quantity: z.number().int(),
  amountMinor: minor,
  cappedFromMinor: minor.nullable(),
  effect: ruleEffectSchema.nullable(),
});

/** The configuration that was priced, in canonical order; a booking snapshot (2.4) stores it as it is. */
export const pricedConfigurationSchema = z.strictObject({
  packageId: uuidSchema,
  rooms: z.array(z.strictObject({
    roomOptionId: uuidSchema,
    occupancy: z.number().int().min(1).max(4),
    travellers: z.array(z.strictObject({ slot: z.number().int(), participationType: z.enum(PARTICIPATION_TYPES), raceDistanceId: uuidSchema.nullable() })),
  })),
  extraNightsBefore: z.number().int(),
  extraNightsAfter: z.number().int(),
  extras: z.array(z.strictObject({ extraId: uuidSchema, travellerSlots: z.array(z.number().int()), quantity: z.number().int() })),
});

/** Everything the API says about a price. Amounts are strings of digits; there is no free text and no personal data. */
export const priceBreakdownSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceVersionId: uuidSchema,
  engineVersion: z.string(),
  computedAt: z.string(),
  configuration: pricedConfigurationSchema,
  departureDate: isoDateSchema,
  returnDate: isoDateSchema,
  lines: z.array(priceLineSchema),
  subtotals: z.strictObject({ accommodation: minor, participation: minor, extras: minor, subtotal: minor }),
  surchargesMinor: minor,
  discountsMinor: minor,
  totalMinor: minor,
  perTraveller: z.array(z.strictObject({ slot: z.number().int(), amountMinor: minor })),
  unattributedMinor: signedMinor,
  depositMinor: minor.nullable(),
  balanceMinor: minor.nullable(),
  balanceDueDate: isoDateSchema,
  fullPaymentDue: z.boolean(),
  promo: z.strictObject({ status: z.enum(['none', 'applied', 'not_combinable', 'conditions_not_met', 'invalid']) }),
});
export type PriceBreakdownJson = z.infer<typeof priceBreakdownSchema>;
