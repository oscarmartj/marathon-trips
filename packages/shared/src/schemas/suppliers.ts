import { z } from 'zod';
import { isoDateSchema, versionSchema } from './catalogue';

// Request bodies and queries of the supplier routes (task 6.1), shared by the API and the panel.
// Strict objects: an unknown field is a 422. Amounts travel as strings of digits in minor units, with their currency.
// `amountMinor` of a cost is not an input: the server works it out as quantity x unit amount.

export const SUPPLIER_KINDS = ['hotel', 'ground_operator', 'race_organiser', 'other'] as const;
export const ALLOTMENT_KINDS = ['room', 'entry'] as const;
export const COST_BASES = ['per_person', 'per_room', 'per_booking', 'fixed'] as const;
/** `paid` is set only by supplier payments (task 6.2), so it is not a status staff can choose. */
export const COST_STATUS_CHOICES = ['planned', 'due', 'cancelled'] as const;
export type SupplierKind = (typeof SUPPLIER_KINDS)[number];
export type CostStatusChoice = (typeof COST_STATUS_CHOICES)[number];

/** Business limit for one unit amount: 1,000,000,000,000 minor units. With a quantity of at most 100,000 it fits a BIGINT. */
export const MAX_UNIT_MINOR = 1_000_000_000_000n;
export const MAX_COST_QUANTITY = 100_000;

const KNOWN_CURRENCIES: ReadonlySet<string> = new Set(
  (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency') ?? ['AUD', 'EUR', 'USD', 'GBP', 'NZD', 'JPY'],
);
export const supplierCurrencySchema = z.string().regex(/^[A-Z]{3}$/).refine((c) => KNOWN_CURRENCIES.has(c), { message: 'Not an ISO 4217 currency' });
const unitMinor = z.string().regex(/^\d{1,13}$/).refine((s) => /^\d+$/.test(s) && BigInt(s) <= MAX_UNIT_MINOR, { message: 'Amount is above the allowed limit' });

const text = (max: number) => z.string().trim().min(1).max(max);
const freeText = (max: number) => z.string().trim().max(max);
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const reason = z.string().trim().min(1).max(500).optional();
const optionalDate = isoDateSchema.nullable();

// ---- Suppliers and contacts ----

const supplierFields = {
  kind: z.enum(SUPPLIER_KINDS),
  name: text(150),
  countryCode,
  defaultCurrency: supplierCurrencySchema,
  paymentTerms: freeText(1000),
  notes: freeText(4000),
};
export const createSupplierSchema = z.strictObject({ ...supplierFields, paymentTerms: supplierFields.paymentTerms.default(''), notes: supplierFields.notes.default(''), reason });
export const updateSupplierSchema = z.strictObject({ ...Object.fromEntries(Object.entries(supplierFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof supplierFields]: z.ZodOptional<(typeof supplierFields)[K]> }, version: versionSchema, reason });
export const supplierQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(SUPPLIER_KINDS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const contactFields = { name: text(150), email: z.email().max(200).nullable(), phone: freeText(40).nullable(), role: freeText(100) };
export const createContactSchema = z.strictObject({ ...contactFields, email: contactFields.email.default(null), phone: contactFields.phone.default(null), role: contactFields.role.default('') });
export const updateContactSchema = z.strictObject({ name: contactFields.name.optional(), email: contactFields.email.optional(), phone: contactFields.phone.optional(), role: contactFields.role.optional() });

// ---- Contracts ----

const contractFields = {
  editionId: z.uuid().nullable(),
  reference: text(80),
  signedAt: optionalDate,
  validFrom: optionalDate,
  validTo: optionalDate,
  terms: freeText(8000),
};
const validRange = (v: { validFrom?: string | null; validTo?: string | null }) => !v.validFrom || !v.validTo || v.validFrom <= v.validTo;
export const createContractSchema = z
  .strictObject({ ...contractFields, editionId: contractFields.editionId.default(null), signedAt: optionalDate.default(null), validFrom: optionalDate.default(null), validTo: optionalDate.default(null), terms: contractFields.terms.default(''), reason })
  .refine(validRange, { message: 'validFrom must not be after validTo', path: ['validTo'] });
export const updateContractSchema = z
  .strictObject({ ...Object.fromEntries(Object.entries(contractFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof contractFields]: z.ZodOptional<(typeof contractFields)[K]> }, version: versionSchema, reason })
  .refine(validRange, { message: 'validFrom must not be after validTo', path: ['validTo'] });

// ---- Allotments ----

export const createAllotmentSchema = z.strictObject({
  poolId: z.uuid(),
  quantity: z.number().int().min(1).max(100_000),
  releaseDate: optionalDate.default(null),
  unitCostMinor: unitMinor,
  currency: supplierCurrencySchema,
  reason,
});
export const updateAllotmentSchema = z.strictObject({
  quantity: z.number().int().min(1).max(100_000).optional(),
  releaseDate: optionalDate.optional(),
  unitCostMinor: unitMinor.optional(),
  currency: supplierCurrencySchema.optional(),
  version: versionSchema,
  reason,
});
export const releaseAllotmentSchema = z.strictObject({ version: versionSchema, reason });
export const releasesQuerySchema = z.strictObject({
  withinDays: z.coerce.number().int().min(0).max(730).default(30),
  asOf: isoDateSchema.optional(),
});
export const coverageQuerySchema = z.strictObject({ editionId: z.uuid() });

// ---- Cost items ----

const costFields = {
  contractId: z.uuid().nullable(),
  packageId: z.uuid().nullable(),
  description: text(300),
  basis: z.enum(COST_BASES),
  quantity: z.number().int().min(1).max(MAX_COST_QUANTITY),
  unitAmountMinor: unitMinor,
  currency: supplierCurrencySchema,
  dueDate: optionalDate,
};
export const createCostSchema = z.strictObject({ ...costFields, contractId: costFields.contractId.default(null), packageId: costFields.packageId.default(null), dueDate: optionalDate.default(null), reason });
export const updateCostSchema = z.strictObject({ ...Object.fromEntries(Object.entries(costFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof costFields]: z.ZodOptional<(typeof costFields)[K]> }, version: versionSchema, reason });
export const costStatusSchema = z.strictObject({ status: z.enum(COST_STATUS_CHOICES), version: versionSchema, reason });
