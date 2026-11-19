import { z } from 'zod';
import type { SettingsService } from '../../../platform/flags/flags.service';

/** Business settings of the payments module (plan 3.1, assumptions), with conservative defaults. */
export const PAYMENT_SETTINGS = {
  attemptExpiryMinutes: { key: 'paymentAttemptExpiryMinutes', fallback: 60, schema: z.number().int().min(15).max(1440), description: 'Minutes a payment attempt waits before the sweep asks the gateway about it (never extended)' },
  manualIntentExpiryDays: { key: 'paymentManualIntentExpiryDays', fallback: 14, schema: z.number().int().min(1).max(60), description: 'Days a request to pay by bank transfer stays open (never past the deposit deadline of an approved booking)' },
  paymentLinkValidDays: { key: 'paymentLinkValidDays', fallback: 7, schema: z.number().int().min(1).max(30), description: 'Days a payment link sent by staff stays valid (capped at the deposit deadline of an approved booking)' },
  balanceReminderOffsetsDays: {
    key: 'balanceReminderOffsetsDays', fallback: [14, 3] as number[],
    schema: z.array(z.number().int().min(0).max(90)).max(5).refine((a) => new Set(a).size === a.length, 'Each offset can appear once'),
    description: 'Days before a balance or instalment falls due on which the customer gets an automatic reminder (an empty list turns reminders off)',
  },
  // Task 3.3: where the daily ledger check continues from (a booking id, or empty for the first). Kept by the check.
  // Internal (task 4.1, from 3.3's review): never listed or changed in the panel.
  ledgerCheckCursor: { key: 'paymentLedgerCheckCursor', fallback: '', schema: z.union([z.literal(''), z.string().uuid()]), description: 'Internal: the booking the daily ledger check continues from (the check keeps it; no need to change it)', internal: true },
  // Task 4.1: how long after its last payment or refund a retired gateway account may still receive a dispute (plan 0.1, 6.4).
  disputeWindowDays: { key: 'paymentDisputeWindowDays', fallback: 180, schema: z.number().int().min(60).max(540), description: 'Days after its last payment or refund before a retired gateway account can be archived (disputes can arrive until then)' },
  // Task 4.2: when a gateway account counts as not answering (plan docs/plans/4.2-routing-rules.md, sections 3 and 15).
  breakerFailures: { key: 'paymentGatewayBreakerFailures', fallback: 3, schema: z.number().int().min(2).max(20), description: 'Failed calls in a row, within the window, after which a gateway account takes no new payments for a while (its backups take them)' },
  breakerWindowSeconds: { key: 'paymentGatewayBreakerWindowSeconds', fallback: 300, schema: z.number().int().min(60).max(3600), description: 'Seconds within which failed calls to a gateway account count together' },
  breakerCooldownSeconds: { key: 'paymentGatewayBreakerCooldownSeconds', fallback: 120, schema: z.number().int().min(30).max(3600), description: 'Seconds a gateway account that stopped answering is skipped before one new payment tries it again' },
} as const;

export function definePaymentSettings(settings: SettingsService): void {
  for (const s of Object.values(PAYMENT_SETTINGS)) settings.define(s.key, s.schema, 1, { description: s.description, internal: 'internal' in s && s.internal });
}
