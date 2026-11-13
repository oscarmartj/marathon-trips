import { z } from 'zod';
import type { SettingsService } from '../../../platform/flags/flags.service';

/** Business settings of the payments module (plan 3.1, assumptions), with conservative defaults. */
export const PAYMENT_SETTINGS = {
  attemptExpiryMinutes: { key: 'paymentAttemptExpiryMinutes', fallback: 60, schema: z.number().int().min(15).max(1440), description: 'Minutes a payment attempt waits before the sweep asks the gateway about it (never extended)' },
  paymentLinkValidDays: { key: 'paymentLinkValidDays', fallback: 7, schema: z.number().int().min(1).max(30), description: 'Days a payment link sent by staff stays valid (capped at the deposit deadline of an approved booking)' },
} as const;

export function definePaymentSettings(settings: SettingsService): void {
  for (const s of Object.values(PAYMENT_SETTINGS)) settings.define(s.key, s.schema, 1, { description: s.description });
}
