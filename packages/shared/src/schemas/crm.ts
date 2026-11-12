import { z } from 'zod';
import { uuidSchema, versionSchema } from './catalogue';
import { quoteRequestSchema } from './pricing';

// Quotes (task 2.5, plan docs/plans/2.5-booking-crm.md). A quote is a configuration for one customer. It carries no
// amount, currency, date, status or promo code: the engine prices it on the server and the quote keeps the result.

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'expired', 'withdrawn'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_REFERENCE_PATTERN = /^QT-[0-9A-HJKMNP-TV-Z]{6}$/;
export const MAX_QUOTE_VALIDITY_DAYS = 60;

/** The configuration part: exactly a quote request without a promo code, strict at every level. */
const configurationSchema = quoteRequestSchema.omit({ promoCode: true });

export const createQuoteSchema = z.strictObject({
  customerId: uuidSchema,
  configuration: configurationSchema,
  validForDays: z.number().int().min(1).max(MAX_QUOTE_VALIDITY_DAYS).optional(),
});
export type CreateQuote = z.infer<typeof createQuoteSchema>;

export const quoteVersionSchema = z.strictObject({ version: versionSchema });

export const listQuotesQuerySchema = z.strictObject({
  status: z.enum(QUOTE_STATUSES).optional(),
  customerId: uuidSchema.optional(),
  cursor: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
