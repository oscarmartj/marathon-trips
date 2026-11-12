import { z } from 'zod';
import { PARTICIPATION_TYPES, SUPPORTED_CURRENCIES, isoDateSchema, uuidSchema, versionSchema } from './catalogue';

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
/** The most travellers one quote can hold (4 per room). */
export const MAX_QUOTE_TRAVELLERS = 4 * MAX_QUOTE_ROOMS;
/**
 * A fixed amount per person of a rule or code: at most the line limit split over the most travellers a quote can
 * hold, so no stored rule can ever produce a line above the limit (plan 2.2, section 15, point 10).
 */
export const MAX_FIXED_PER_PERSON_MINOR = MAX_LINE_MINOR / BigInt(MAX_QUOTE_TRAVELLERS);
/** Basis points: a discount takes at most 100 %, a surcharge at most 1 000 %. */
export const MAX_DISCOUNT_BPS = 10_000;
export const MAX_SURCHARGE_BPS = 100_000;

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
 * `replacesVersionId` is the last published version of the package's timeline the publisher saw, in force or scheduled
 * (null if none): publishing is a compare-and-set on it, so of two drafts published at once only one wins (M3).
 * `validFrom` schedules the version for later (plan 2.2, section 5); without it the version starts now.
 */
export const publishPriceVersionSchema = z.strictObject({
  version: versionSchema,
  replacesVersionId: uuidSchema.nullable(),
  validFrom: z.iso.datetime({ offset: true }).optional(),
  reason,
});

/** Withdraws a scheduled version that has not started (plan 2.2, section 5). */
export const withdrawPriceVersionSchema = z.strictObject({ version: versionSchema, reason });

// ---- Rules and promo codes (plan 2.2, sections 3 and 4) ----

export const PRICE_COMPONENTS = ['accommodation', 'participation', 'extras'] as const;
export const RULE_TARGETS = ['accommodation', 'participation', 'extras', 'subtotal'] as const;

export const RULE_SCOPES = ['global', 'edition', 'package'] as const;
export const RULE_KINDS = ['early_bird', 'late_supplement', 'group_discount', 'occupancy_supplement', 'custom'] as const;
export const RULE_DIRECTIONS = ['discount', 'surcharge'] as const;
export const EFFECT_MODES = ['percent', 'fixed'] as const;
export const EFFECT_PER = ['person', 'booking'] as const;

/** A promo code as stored: upper case, letters, digits and inner hyphens, 6 to 32 characters. */
export const PROMO_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9]$/;
/** How a typed code is compared: without surrounding spaces, in upper case. */
export const normalisePromoCode = (s: string): string => s.trim().toUpperCase();

/**
 * Conditions of a rule or a code (plan 2.1, section 5): ids, numbers, dates and enums only, no free text. The engine
 * checks what each kind needs when a rule is saved.
 */
export const ruleConditionsSchema = z.strictObject({
  bookedOnOrBefore: isoDateSchema.optional(),
  minDaysBeforeCheckIn: z.number().int().min(0).max(3650).optional(),
  maxDaysBeforeCheckIn: z.number().int().min(0).max(3650).optional(),
  minTravellers: z.number().int().min(1).max(MAX_QUOTE_TRAVELLERS).optional(),
  maxTravellers: z.number().int().min(1).max(MAX_QUOTE_TRAVELLERS).optional(),
  occupancies: z.array(z.number().int().min(1).max(4)).min(1).max(4).optional(),
  participationTypes: z.array(z.enum(PARTICIPATION_TYPES)).min(1).max(PARTICIPATION_TYPES.length).optional(),
});
export type RuleConditionsInput = z.infer<typeof ruleConditionsSchema>;

const instant = z.iso.datetime({ offset: true }).nullable();
const label = z.string().trim().min(1).max(80);

/**
 * The effect shared by rules and codes; amounts and basis points are never negative, the direction gives the sign.
 * No defaults here: creation adds them, and an update leaves out what it does not change (plan 2.2, code review G1).
 */
const effectFields = {
  effectMode: z.enum(EFFECT_MODES),
  valueBps: z.number().int().min(0).max(MAX_SURCHARGE_BPS).nullable(),
  valueMinor: rateAmountSchema.nullable(),
  currency: z.enum(SUPPORTED_CURRENCIES).nullable(),
  per: z.enum(EFFECT_PER),
  appliesTo: z.enum(RULE_TARGETS),
};

const scopeFields = {
  scopeType: z.enum(RULE_SCOPES),
  editionId: uuidSchema.nullable().default(null),
  packageId: uuidSchema.nullable().default(null),
};

const ruleFields = {
  label,
  kind: z.enum(RULE_KINDS),
  direction: z.enum(RULE_DIRECTIONS),
  conditions: ruleConditionsSchema,
  ...effectFields,
  priority: z.number().int().min(0).max(1000),
  stackable: z.boolean(),
  enabled: z.boolean(),
  validFrom: instant,
  validTo: instant,
};

/** What creation fills in when a field is left out. Conservative: not stackable unless asked (plan 2.2, point 11). */
const createDefaults = {
  conditions: ruleFields.conditions.default({}),
  valueBps: effectFields.valueBps.default(null),
  valueMinor: effectFields.valueMinor.default(null),
  currency: effectFields.currency.default(null),
  per: effectFields.per.default('booking'),
  stackable: ruleFields.stackable.default(false),
  validFrom: instant.default(null),
  validTo: instant.default(null),
};

export const createPriceRuleSchema = z.strictObject({ ...scopeFields, ...ruleFields, ...createDefaults, priority: ruleFields.priority.default(100), reason });
/**
 * A partial update: a field left out keeps its value, `null` clears a nullable one. The service merges with the stored
 * rule and validates the result; the scope never changes.
 */
export const updatePriceRuleSchema = z.strictObject(ruleFields).partial().extend({ version: versionSchema, reason });
export const archiveSchema = z.strictObject({ version: versionSchema, reason });

const promoFields = {
  label,
  conditions: ruleConditionsSchema,
  ...effectFields,
  stackable: z.boolean(),
  enabled: z.boolean(),
  validFrom: instant,
  validTo: instant,
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable(),
  maxPerCustomer: z.number().int().min(1).max(1000).nullable(),
};

export const createPromoCodeSchema = z.strictObject({
  code: z.string().transform(normalisePromoCode).pipe(z.string().regex(PROMO_CODE_PATTERN)),
  ...scopeFields,
  ...promoFields,
  ...createDefaults,
  maxRedemptions: promoFields.maxRedemptions.default(null),
  maxPerCustomer: promoFields.maxPerCustomer.default(null),
  reason,
});
/** A partial update, like rules: what is left out keeps its value. The code text and the scope never change. */
export const updatePromoCodeSchema = z.strictObject(promoFields).partial().extend({ version: versionSchema, reason });

// ---- What the API answers ----

const minor = z.string().regex(/^\d+$/);
const signedMinor = z.string().regex(/^-?\d+$/);


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
