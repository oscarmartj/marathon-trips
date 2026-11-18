import { z } from 'zod';

// Task 5.5: privacy (plan docs/plans/5.5-privacy-export-erase.md).

/**
 * The code of the marketing consent wording the account page shows (copy `account.privacy.marketing.wording` in
 * en-AU.json). A change of wording is a new key: records keep the key of the text the person saw.
 */
export const MARKETING_WORDING_KEY = 'marketing_email.v1';

export const marketingConsentSchema = z.strictObject({ granted: z.boolean(), wordingKey: z.string().min(1).max(64) });
export type MarketingConsentInput = z.infer<typeof marketingConsentSchema>;

/** Asking for erasure; an account with no customer record must confirm, because it is erased at once. */
export const erasureRequestSchema = z.strictObject({ confirm: z.boolean().optional() });

export const exportAudienceSchema = z.strictObject({ audience: z.enum(['subject', 'full']).optional() });

/** Why erasure cannot go ahead now (privacy_active_trip_reason in migration 0027). */
export const ERASURE_BLOCK_REASONS = ['open_booking', 'trip_not_finished', 'live_payment', 'refund_may_be_due'] as const;
export type ErasureBlockReason = (typeof ERASURE_BLOCK_REASONS)[number];

export interface AccountPrivacyView {
  hasCustomerRecord: boolean;
  marketingConsent: { granted: boolean; recordedAt: string | null };
  wordingKey: string;
  erasureRequest: { status: 'received' | 'completed'; requestedAt: string } | null;
}

export interface StaffPrivacyView {
  anonymised: boolean;
  marketingConsent: { granted: boolean; recordedAt: string | null };
  consentHistory: Array<{ granted: boolean; source: 'account' | 'unsubscribe_link' | 'erasure'; recordedAt: string }>;
  requests: Array<{ kind: 'export' | 'erasure'; status: 'received' | 'completed'; requestedBy: 'customer' | 'staff'; requestedAt: string; completedAt: string | null }>;
  erasure: { possible: boolean; blockedBy: ErasureBlockReason | null };
}
