import { z } from 'zod';

// The shape of custom field values on a request (task 7.5). A separate file so the catalogue and supplier schemas can use it
// without a circular import; the definitions and the rules live in custom-fields.ts and in the API.

export const MAX_CUSTOM_FIELD_OPTIONS = 50;
export const MAX_TEXT_MAX_LENGTH = 2000;
export const MAX_CUSTOM_FILTERS = 5;
const CUSTOM_FIELD_KEY = /^(?!constructor$)[a-z][a-z0-9_]{0,39}$/;
const key = z.string().regex(CUSTOM_FIELD_KEY);
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multiselect'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** The values a request may carry on a record: `{ key: value }`. A null clears a value. Checked against definitions by the API. */
export const customFieldValuesSchema = z.record(z.string().max(60), z.union([z.string().max(MAX_TEXT_MAX_LENGTH), z.number().finite(), z.boolean(), z.array(z.string().max(60)).max(MAX_CUSTOM_FIELD_OPTIONS), z.null()])).refine((v) => Object.keys(v).length <= 60, { message: 'Too many custom fields' });
export type CustomFieldValues = z.infer<typeof customFieldValuesSchema>;


export const CUSTOM_FILTER_OPS = ['eq', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'has'] as const;
export type CustomFilterOp = (typeof CUSTOM_FILTER_OPS)[number];
/** Operators each type accepts. */
export const CUSTOM_FILTER_OPS_BY_TYPE: Record<CustomFieldType, readonly CustomFilterOp[]> = {
  text: ['eq', 'contains'],
  number: ['eq', 'gt', 'gte', 'lt', 'lte'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['eq'],
  select: ['eq', 'in'],
  multiselect: ['has'],
};

export const customFilterSchema = z.strictObject({
  key,
  op: z.enum(CUSTOM_FILTER_OPS),
  value: z.union([z.string().max(MAX_TEXT_MAX_LENGTH), z.number().finite(), z.boolean(), z.array(z.string().max(60)).min(1).max(MAX_CUSTOM_FIELD_OPTIONS)]),
});
export type CustomFilter = z.infer<typeof customFilterSchema>;

/** The `cf` query parameter of a list: a JSON array of filters, at most five. */
export const customFiltersParamSchema = z
  .string()
  .max(2000)
  .transform((s, ctx): CustomFilter[] => {
    try {
      const parsed = z.array(customFilterSchema).max(MAX_CUSTOM_FILTERS).safeParse(JSON.parse(s));
      if (parsed.success) return parsed.data;
    } catch {
      /* falls through to the issue below */
    }
    ctx.addIssue({ code: 'custom', message: 'cf must be a JSON array of at most five filters' });
    return z.NEVER;
  });

