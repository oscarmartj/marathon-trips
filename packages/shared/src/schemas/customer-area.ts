import { z } from 'zod';
import { PAYMENT_METHODS } from './payments';

// The customer area (task 5.1, plan docs/plans/5.1-customer-area.md, sections 3 and 4). Amounts are strings of minor
// units from the API; the web formats them and never adds them up. No internal ids, provider references or failure codes.

const minor = z.string().regex(/^\d+$/);

/** Documents a customer can download (receipts are not among them: task 4.6 is parked). */
export const CUSTOMER_DOCUMENT_KINDS = ['confirmation', 'itinerary', 'voucher'] as const;
export type CustomerDocumentKind = (typeof CUSTOMER_DOCUMENT_KINDS)[number];

export const accountBookingItemSchema = z.strictObject({
  reference: z.string(),
  status: z.string(),
  requestedAt: z.string(),
  departureDate: z.string(),
  returnDate: z.string(),
  currency: z.string().length(3),
  totalMinor: minor,
  package: z.strictObject({
    name: z.record(z.string(), z.string()),
    slug: z.string(),
    editionYear: z.number().int(),
    race: z.strictObject({ name: z.record(z.string(), z.string()), slug: z.string() }),
  }),
});
export type AccountBookingItem = z.infer<typeof accountBookingItemSchema>;

export const accountPaymentRecordSchema = z.strictObject({
  succeededAt: z.string(),
  amountMinor: minor,
  currency: z.string().length(3),
  method: z.enum(PAYMENT_METHODS),
});
export type AccountPaymentRecord = z.infer<typeof accountPaymentRecordSchema>;
