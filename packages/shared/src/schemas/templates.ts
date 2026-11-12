import { z } from 'zod';
import { LOCALE_PATTERN, versionSchema } from './catalogue';

// Request bodies of the template routes (task 5.4), shared by the API and the panel. Templates are plain text with
// {{variable}} placeholders; nothing is ever rendered as HTML.

export const TEMPLATE_CHANNELS = ['email', 'document'] as const;
export type TemplateChannelValue = (typeof TEMPLATE_CHANNELS)[number];
export const TEMPLATE_STATUSES = ['draft', 'active', 'archived'] as const;
export type TemplateStatusValue = (typeof TEMPLATE_STATUSES)[number];

const keySchema = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);
const localeSchema = z.string().regex(LOCALE_PATTERN);
const subjectSchema = z.string().trim().max(300).refine((s) => !/[\r\n]/.test(s), { message: 'A subject is a single line' });
const bodySchema = z.string().trim().min(1).max(20000);
const reason = z.string().trim().min(1).max(500).optional();

export const createTemplateSchema = z.strictObject({
  key: keySchema,
  locale: localeSchema.default('en-AU'),
  subject: subjectSchema.default(''),
  body: bodySchema,
  reason,
});

export const updateTemplateSchema = z.strictObject({
  version: versionSchema,
  subject: subjectSchema.optional(),
  body: bodySchema.optional(),
  reason,
});

export const templateStatusSchema = z.strictObject({ version: versionSchema, reason });

export const listTemplatesQuerySchema = z.strictObject({
  key: keySchema.optional(),
  locale: localeSchema.optional(),
  status: z.enum(TEMPLATE_STATUSES).optional(),
});

/** A preview of wording that has not been saved yet, rendered with the sample data for its key. */
export const previewTemplateSchema = z.strictObject({
  key: keySchema,
  subject: subjectSchema.default(''),
  body: bodySchema,
});
