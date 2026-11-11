import { z } from 'zod';

// Request bodies and queries of the catalogue routes (task 1.1), shared by the API (validation) and the panel.
// Strict objects: an unknown field is a 422. `isDemo` is in none of them, so the API cannot set or change it.
// Amounts travel as strings of digits (plan 1.1); nothing here computes a price.

export const LOCALE_PATTERN = /^[a-z]{2}-[A-Z]{2}$/;
export const DEFAULT_LOCALE = 'en-AU';
/** The only currency sold for now (plan 0.1, assumption 2). The database column admits others. */
export const SUPPORTED_CURRENCIES = ['AUD'] as const;
/** Business validation limit for one deposit amount: A$1,000,000 in cents. */
export const MAX_DEPOSIT_MINOR = 100_000_000n;

const text = (max: number) => z.string().trim().min(1).max(max);
const localeKey = z.string().regex(LOCALE_PATTERN);

/** `{ "en-AU": "…", "es-ES": "…" }`; en-AU is mandatory. */
export const localisedTextSchema = (max = 300) =>
  z.record(localeKey, text(max)).refine((v) => typeof v[DEFAULT_LOCALE] === 'string', { message: 'en-AU is required' });
/** Same shape, but the field may be empty. */
export const optionalLocalisedTextSchema = (max = 5000) => z.record(localeKey, z.string().trim().max(max));

export const slugSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80);
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), { message: 'Not a calendar date' });
export const versionSchema = z.number().int().min(0);
export const uuidSchema = z.uuid();
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const latitudeE7 = z.number().int().min(-900_000_000).max(900_000_000);
const longitudeE7 = z.number().int().min(-1_800_000_000).max(1_800_000_000);
const seoSchema = z.strictObject({ title: text(70).optional(), description: text(200).optional() });
const reason = z.string().trim().min(1).max(500).optional();

export const RACE_TYPES = ['road', 'trail', 'ultra', 'other'] as const;
export const RACE_STATUSES = ['draft', 'published', 'archived'] as const;
export const DISTANCE_KINDS = ['marathon', 'half', 'ten_k', 'five_k', 'ultra', 'other'] as const;
export const CLAIM_KINDS = ['official_partner', 'accredited_agent', 'guaranteed_entry', 'other'] as const;
export const EDITION_STATUSES = ['draft', 'announced', 'active', 'completed', 'cancelled'] as const;
export const SALE_STATUSES = ['draft', 'coming_soon', 'open', 'waitlist', 'sold_out', 'closed'] as const;
export const PARTICIPATION_TYPES = ['runner_with_entry', 'runner_own_entry', 'supporter'] as const;
export const ROOM_TYPES = ['single', 'twin', 'double', 'triple', 'quad', 'other'] as const;
export const EXTRA_KINDS = ['excursion', 'transfer', 'meal', 'merchandise', 'other'] as const;
export const POOL_KINDS = ['entry', 'room', 'extra'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export type SaleStatus = (typeof SALE_STATUSES)[number];
export type RaceStatus = (typeof RACE_STATUSES)[number];
export type EditionStatus = (typeof EDITION_STATUSES)[number];

// ---- Races, distances, claims, editions ----

const raceFields = {
  slug: slugSchema,
  name: localisedTextSchema(150),
  countryCode,
  city: text(100),
  timeZone: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+){0,2}$/).max(60),
  raceType: z.enum(RACE_TYPES),
  typicalMonth: z.number().int().min(1).max(12).nullable(),
  summary: localisedTextSchema(2000),
  websiteUrl: z.url({ protocol: /^https?$/ }).max(300).nullable(),
  latitudeE7: latitudeE7.nullable(),
  longitudeE7: longitudeE7.nullable(),
  seo: seoSchema,
};

export const createRaceSchema = z
  .strictObject({
    ...raceFields,
    typicalMonth: raceFields.typicalMonth.default(null),
    websiteUrl: raceFields.websiteUrl.default(null),
    latitudeE7: raceFields.latitudeE7.default(null),
    longitudeE7: raceFields.longitudeE7.default(null),
    seo: raceFields.seo.default({}),
    externalSource: text(40).optional(),
    externalId: text(100).optional(),
    reason,
  })
  .refine((v) => (v.externalSource === undefined) === (v.externalId === undefined), { message: 'externalSource and externalId go together' });
export const updateRaceSchema = z.strictObject({ ...Object.fromEntries(Object.entries(raceFields).map(([k, s]) => [k, s.optional()])) as { [K in keyof typeof raceFields]: z.ZodOptional<(typeof raceFields)[K]> }, version: versionSchema, reason });
export const statusChangeSchema = <T extends readonly [string, ...string[]]>(values: T) => z.strictObject({ status: z.enum(values), version: versionSchema, reason });
export const raceStatusChangeSchema = statusChangeSchema(RACE_STATUSES);
export const editionStatusChangeSchema = statusChangeSchema(EDITION_STATUSES);
export const saleStatusChangeSchema = statusChangeSchema(SALE_STATUSES);

export const distanceSchema = z.strictObject({
  kind: z.enum(DISTANCE_KINDS),
  distanceMetres: z.number().int().min(1).max(1_000_000),
  name: localisedTextSchema(100),
});
export const updateDistanceSchema = distanceSchema.partial();

export const setClaimSchema = z.strictObject({ enabled: z.boolean(), evidenceNote: z.string().trim().max(2000).default(''), reason });

const editionFields = {
  year: z.number().int().min(2000).max(2200),
  startDate: isoDateSchema.nullable().default(null),
  endDate: isoDateSchema.nullable().default(null),
  dateStatus: z.enum(['provisional', 'confirmed']).default('provisional'),
  notes: optionalLocalisedTextSchema(2000).default({}),
};
export const createEditionSchema = z.strictObject({ ...editionFields, reason });
export const updateEditionSchema = z.strictObject({
  startDate: isoDateSchema.nullable().optional(),
  endDate: isoDateSchema.nullable().optional(),
  dateStatus: z.enum(['provisional', 'confirmed']).optional(),
  notes: optionalLocalisedTextSchema(2000).optional(),
  version: versionSchema,
  reason,
});

// ---- Packages ----

const amountMinor = z
  .string()
  .regex(/^\d{1,12}$/)
  .refine((s) => BigInt(s) <= MAX_DEPOSIT_MINOR, { message: 'Amount is above the allowed limit' });
/** Fixed deposit (per person or per booking, in the package currency) or a percentage in basis points. */
export const depositSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.enum(['per_person', 'per_booking']), amountMinor }),
  z.strictObject({ mode: z.literal('percent'), bps: z.number().int().min(1).max(10000) }),
]);

const packageFields = {
  slug: slugSchema,
  name: localisedTextSchema(150),
  checkInDate: isoDateSchema,
  checkOutDate: isoDateSchema,
  includes: optionalLocalisedTextSchema(),
  excludes: optionalLocalisedTextSchema(),
  instantBooking: z.boolean(),
  autoConfirmOnDeposit: z.boolean(),
  deposit: depositSchema.nullable(),
  balanceDueDate: isoDateSchema,
  minTravellers: z.number().int().min(1).max(50),
  maxTravellers: z.number().int().min(1).max(50),
  maxExtraNightsBefore: z.number().int().min(0).max(30),
  maxExtraNightsAfter: z.number().int().min(0).max(30),
  seo: seoSchema,
};
export const createPackageSchema = z.strictObject({
  ...packageFields,
  includes: packageFields.includes.default({}),
  excludes: packageFields.excludes.default({}),
  instantBooking: packageFields.instantBooking.default(false),
  autoConfirmOnDeposit: packageFields.autoConfirmOnDeposit.default(true),
  deposit: packageFields.deposit.default(null),
  minTravellers: packageFields.minTravellers.default(1),
  maxExtraNightsBefore: packageFields.maxExtraNightsBefore.default(0),
  maxExtraNightsAfter: packageFields.maxExtraNightsAfter.default(0),
  seo: packageFields.seo.default({}),
  currency: z.enum(SUPPORTED_CURRENCIES).default('AUD'),
  reason,
});
/** The currency cannot be changed after creation, and the sale status has its own route. */
export const updatePackageSchema = z.strictObject({
  ...(Object.fromEntries(Object.entries(packageFields).map(([k, s]) => [k, s.optional()])) as { [K in keyof typeof packageFields]: z.ZodOptional<(typeof packageFields)[K]> }),
  version: versionSchema,
  reason,
});

export const setParticipationSchema = z.strictObject({
  types: z.array(z.enum(PARTICIPATION_TYPES)).max(3).refine((a) => new Set(a).size === a.length, { message: 'Duplicate type' }),
});
export const entryOptionSchema = z.strictObject({ raceDistanceId: uuidSchema, entryPoolId: uuidSchema });
export const addPackageHotelSchema = z.strictObject({ hotelId: uuidSchema, displayOrder: z.number().int().min(0).max(100).default(0) });

export const roomOptionSchema = z
  .strictObject({
    roomType: z.enum(ROOM_TYPES),
    name: localisedTextSchema(100),
    minOccupancy: z.number().int().min(1).max(4),
    maxOccupancy: z.number().int().min(1).max(4),
    roomPoolId: uuidSchema,
  })
  .refine((v) => v.minOccupancy <= v.maxOccupancy, { message: 'minOccupancy must not exceed maxOccupancy', path: ['minOccupancy'] });
export const updateRoomOptionSchema = z.strictObject({
  roomType: z.enum(ROOM_TYPES).optional(),
  name: localisedTextSchema(100).optional(),
  minOccupancy: z.number().int().min(1).max(4).optional(),
  maxOccupancy: z.number().int().min(1).max(4).optional(),
  roomPoolId: uuidSchema.optional(),
});

const extraFields = {
  kind: z.enum(EXTRA_KINDS),
  name: localisedTextSchema(150),
  description: optionalLocalisedTextSchema(2000),
  pricingUnit: z.enum(['per_person', 'per_booking']),
  availableTo: z.enum(['all', 'runners', 'supporters']),
  mandatory: z.boolean(),
  maxPerBooking: z.number().int().min(1).max(100).nullable(),
  poolId: uuidSchema.nullable(),
  schedule: z.strictObject({ departure: text(100).optional(), origin: text(150).optional(), destination: text(150).optional() }).nullable(),
};
export const createExtraSchema = z.strictObject({
  ...extraFields,
  description: extraFields.description.default({}),
  availableTo: extraFields.availableTo.default('all'),
  mandatory: extraFields.mandatory.default(false),
  maxPerBooking: extraFields.maxPerBooking.default(null),
  poolId: extraFields.poolId.default(null),
  schedule: extraFields.schedule.default(null),
});
export const updateExtraSchema = z.strictObject({
  ...(Object.fromEntries(Object.entries(extraFields).map(([k, s]) => [k, s.optional()])) as { [K in keyof typeof extraFields]: z.ZodOptional<(typeof extraFields)[K]> }),
  version: versionSchema,
});

// ---- Hotels and inventory ----

const hotelFields = {
  name: text(150),
  address: text(300),
  city: text(100),
  countryCode,
  starRating: z.number().int().min(1).max(5).nullable(),
  description: optionalLocalisedTextSchema(2000),
  latitudeE7: latitudeE7.nullable(),
  longitudeE7: longitudeE7.nullable(),
};
export const createHotelSchema = z.strictObject({
  ...hotelFields,
  starRating: hotelFields.starRating.default(null),
  description: hotelFields.description.default({}),
  latitudeE7: hotelFields.latitudeE7.default(null),
  longitudeE7: hotelFields.longitudeE7.default(null),
});
export const updateHotelSchema = z.strictObject({
  ...(Object.fromEntries(Object.entries(hotelFields).map(([k, s]) => [k, s.optional()])) as { [K in keyof typeof hotelFields]: z.ZodOptional<(typeof hotelFields)[K]> }),
  version: versionSchema,
});

export const createPoolSchema = z.strictObject({
  kind: z.enum(POOL_KINDS),
  label: text(120),
  capacity: z.number().int().min(0).max(100_000),
  lowStockThreshold: z.number().int().min(0).max(100_000).nullable().default(null),
  confirmedBySupplier: z.boolean().default(false),
  confirmationNote: z.string().trim().max(1000).nullable().default(null),
});
export const updatePoolSchema = z.strictObject({
  label: text(120).optional(),
  capacity: z.number().int().min(0).max(100_000).optional(),
  lowStockThreshold: z.number().int().min(0).max(100_000).nullable().optional(),
  confirmedBySupplier: z.boolean().optional(),
  confirmationNote: z.string().trim().max(1000).nullable().optional(),
  version: versionSchema,
  reason,
});

// ---- Queries ----

const page = z.coerce.number().int().min(1).max(1000).default(1);
const pageSize = z.coerce.number().int().min(1).max(50).default(20);
export const publicRaceQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(80).optional(),
  country: countryCode.optional(),
  type: z.enum(RACE_TYPES).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  distance: z.enum(DISTANCE_KINDS).optional(),
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  page,
  pageSize,
});
export const adminRaceQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(80).optional(),
  status: z.enum(RACE_STATUSES).optional(),
  page,
  pageSize,
});

export type CreateRace = z.infer<typeof createRaceSchema>;
export type CreatePackage = z.infer<typeof createPackageSchema>;
export type PublicRaceQuery = z.infer<typeof publicRaceQuerySchema>;
