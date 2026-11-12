import { z } from 'zod';
import { isoDateSchema, localisedTextSchema, versionSchema } from './catalogue';
import { reasonSchema } from './auth';
import { CUSTOM_FIELD_TYPES, MAX_CUSTOM_FIELD_OPTIONS, MAX_TEXT_MAX_LENGTH, type CustomFieldType } from './custom-field-values';
export {
  CUSTOM_FILTER_OPS, CUSTOM_FILTER_OPS_BY_TYPE, MAX_CUSTOM_FILTERS, customFilterSchema, customFiltersParamSchema, type CustomFilter, type CustomFilterOp,
  CUSTOM_FIELD_TYPES, type CustomFieldType, customFieldValuesSchema, type CustomFieldValues, MAX_CUSTOM_FIELD_OPTIONS, MAX_TEXT_MAX_LENGTH } from './custom-field-values';

// Custom fields defined from the panel (task 7.5). Shared by the API (validation) and the panel (forms and filters).
// A definition names a field on one kind of record; the values live in that record's `customFields` JSON column, keyed by
// the field's `key`. Nothing here is money: there is no money type and no custom field feeds a price or a payment.


/** Records that can carry custom fields today. Customer, Traveller and Booking join when their tables exist. */
export const CUSTOM_FIELD_ENTITIES = ['Race', 'Package', 'Supplier'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_KEY = /^(?!constructor$)[a-z][a-z0-9_]{0,39}$/;
export const CUSTOM_FIELD_OPTION_VALUE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const DEFAULT_TEXT_MAX_LENGTH = 500;

const key = z.string().regex(CUSTOM_FIELD_KEY);
const reason = reasonSchema;

export const customFieldOptionSchema = z.strictObject({
  value: z.string().regex(CUSTOM_FIELD_OPTION_VALUE),
  label: localisedTextSchema(80),
  /** A retired option stays valid for records that hold it but is no longer offered. */
  retired: z.boolean().optional(),
});
export type CustomFieldOption = z.infer<typeof customFieldOptionSchema>;

export const customFieldValidationSchema = z.strictObject({
  minLength: z.number().int().min(0).max(MAX_TEXT_MAX_LENGTH).optional(),
  maxLength: z.number().int().min(1).max(MAX_TEXT_MAX_LENGTH).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  integer: z.boolean().optional(),
  minDate: isoDateSchema.optional(),
  maxDate: isoDateSchema.optional(),
  minItems: z.number().int().min(0).max(MAX_CUSTOM_FIELD_OPTIONS).optional(),
  maxItems: z.number().int().min(1).max(MAX_CUSTOM_FIELD_OPTIONS).optional(),
});
export type CustomFieldValidation = z.infer<typeof customFieldValidationSchema>;

const ALLOWED_RULES: Record<CustomFieldType, ReadonlyArray<keyof CustomFieldValidation>> = {
  text: ['minLength', 'maxLength'],
  number: ['min', 'max', 'integer'],
  date: ['minDate', 'maxDate'],
  boolean: [],
  select: [],
  multiselect: ['minItems', 'maxItems'],
};

/** Cross-field rules of a definition, shared by create and update. Returns a message or null. */
export function definitionProblem(type: CustomFieldType, options: readonly CustomFieldOption[] | undefined | null, validation: CustomFieldValidation | undefined | null): string | null {
  const isSelect = type === 'select' || type === 'multiselect';
  if (isSelect && (!options || options.length === 0)) return 'A select field needs at least one option';
  if (!isSelect && options && options.length > 0) return 'Only select fields take options';
  if (options) {
    if (options.length > MAX_CUSTOM_FIELD_OPTIONS) return 'Too many options';
    if (new Set(options.map((o) => o.value)).size !== options.length) return 'Option values must be unique';
  }
  for (const rule of Object.keys(validation ?? {}) as Array<keyof CustomFieldValidation>) {
    if (!ALLOWED_RULES[type].includes(rule)) return 'That validation rule does not apply to this field type';
  }
  const v = validation ?? {};
  if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) return 'The minimum length is above the maximum';
  if (v.min !== undefined && v.max !== undefined && v.min > v.max) return 'The minimum is above the maximum';
  if (v.minDate !== undefined && v.maxDate !== undefined && v.minDate > v.maxDate) return 'The earliest date is after the latest';
  if (v.minItems !== undefined && v.maxItems !== undefined && v.minItems > v.maxItems) return 'The minimum number of choices is above the maximum';
  return null;
}

const flags = {
  required: z.boolean(),
  visibleToCustomer: z.boolean(),
  editableByCustomer: z.boolean(),
};
const displayOrder = z.number().int().min(0).max(1000);

export const createCustomFieldSchema = z
  .strictObject({
    entityType: z.enum(CUSTOM_FIELD_ENTITIES),
    key,
    label: localisedTextSchema(80),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(customFieldOptionSchema).max(MAX_CUSTOM_FIELD_OPTIONS).optional(),
    validation: customFieldValidationSchema.optional(),
    required: flags.required.default(false),
    visibleToCustomer: flags.visibleToCustomer.default(false),
    editableByCustomer: flags.editableByCustomer.default(false),
    displayOrder: displayOrder.default(0),
    reason,
  })
  .superRefine((v, ctx) => {
    const problem = definitionProblem(v.type, v.options, v.validation);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['options'] });
    if (v.editableByCustomer && !v.visibleToCustomer) ctx.addIssue({ code: 'custom', message: 'A field the customer edits must be visible to them', path: ['visibleToCustomer'] });
  });
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

/** `entityType`, `key` and `type` are not here on purpose: they never change. */
export const updateCustomFieldSchema = z.strictObject({
  label: localisedTextSchema(80).optional(),
  options: z.array(customFieldOptionSchema).max(MAX_CUSTOM_FIELD_OPTIONS).optional(),
  validation: customFieldValidationSchema.optional(),
  required: flags.required.optional(),
  visibleToCustomer: flags.visibleToCustomer.optional(),
  editableByCustomer: flags.editableByCustomer.optional(),
  displayOrder: displayOrder.optional(),
  version: versionSchema,
  reason,
});
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;

export const archiveCustomFieldSchema = z.strictObject({ version: versionSchema, reason });

export const customFieldListQuerySchema = z.strictObject({
  entityType: z.enum(CUSTOM_FIELD_ENTITIES).optional(),
  includeArchived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

/** What the panel and the public API return for one definition (no internal columns). */
export interface CustomFieldDefinitionView {
  id: string;
  entityType: CustomFieldEntity;
  key: string;
  label: Record<string, string>;
  type: CustomFieldType;
  options: CustomFieldOption[] | null;
  validation: CustomFieldValidation | null;
  required: boolean;
  visibleToCustomer: boolean;
  editableByCustomer: boolean;
  displayOrder: number;
  archivedAt: string | null;
  version: number;
}
