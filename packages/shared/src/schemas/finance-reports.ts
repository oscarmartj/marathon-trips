import { z } from 'zod';
import { isoDateSchema } from './catalogue';
import { supplierCurrencySchema } from './suppliers';

// Task 6.6: the cash forecast query and the accountant export body. Strict objects: an unknown field is a 422.
export const cashForecastQuerySchema = z.strictObject({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  currency: supplierCurrencySchema.optional(),
});

export const ACCOUNTANT_DATASETS = ['trip_result', 'ledger', 'supplier_payments'] as const;
export type AccountantDataset = (typeof ACCOUNTANT_DATASETS)[number];
/** The longest range of one file, in days (inclusive). */
export const ACCOUNTANT_MAX_DAYS = 366;
export const accountantExportBodySchema = z.strictObject({
  dataset: z.enum(ACCOUNTANT_DATASETS),
  from: isoDateSchema,
  to: isoDateSchema,
});
