// Card sessions (task 4.4, plan docs/plans/4.4-au-card-gateway.md, sections 5.1 and 10): the card page of a gateway
// whose card fields are its own iframes on our page. The page shows the amount the API returns and posts only the
// gateway's single-use card token: never a card number, a CVC, an expiry, an amount or a URL.
import { z } from 'zod';

/**
 * Pin Payments' hosted fields (plan 4.4, section 2; A11 and A12 are unverified until the sandbox run). One constant for
 * the adapter's manifest and the card page's CSP, so the two cannot drift.
 */
export const PIN_CARD_FIELDS = {
  scriptUrl: 'https://cdn.pinpayments.com/pin.hosted_fields.v1.js',
  frameOrigins: ['https://cdn.pinpayments.com'],
  challengeOrigins: { test: ['https://sandbox.checkout.com'], live: [] as string[] },
} as const;

/** Every origin a card page may load scripts or frames from (the CSP of `/pay/card/*`). */
export const CARD_PAGE_FRAME_ORIGINS: readonly string[] = [...PIN_CARD_FIELDS.frameOrigins];

export const CARD_SESSION_REF_PATTERN = /^cs_[0-9a-f]{32}$/;
export const CARD_TOKEN_PATTERN = /^card_[A-Za-z0-9_-]{10,64}$/;

/** Why a session ended without money, as the card page may show it (a closed list). */
export const CARD_SESSION_FAILURES = [
  'card_declined', 'insufficient_funds', 'expired_card', 'card_not_authenticated', 'processing_error', 'suspected_fraud',
  'provider_rejected', 'provider_auth_failed', 'provider_busy', 'outcome_unknown', 'expired', 'too_many_attempts',
] as const;
export type CardSessionFailure = (typeof CARD_SESSION_FAILURES)[number];

/** Only the token: any other field is a 422 and nothing is written. */
export const cardSubmitSchema = z.object({ cardToken: z.string().regex(CARD_TOKEN_PATTERN) }).strict();
export type CardSubmit = z.infer<typeof cardSubmitSchema>;

export const cardSessionViewSchema = z.object({
  status: z.enum(['open', 'processing', 'finished']),
  amountMinor: z.string().regex(/^[0-9]{1,15}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Only while the session is open and its account active. */
  card: z.object({ publishableKey: z.string().min(1).max(128), sandbox: z.boolean(), scriptUrl: z.string().url() }).strict().optional(),
  failed: z.enum(CARD_SESSION_FAILURES).optional(),
  returnUrl: z.string().url().optional(),
}).strict();
export type CardSessionView = z.infer<typeof cardSessionViewSchema>;

export const cardSubmitResultSchema = z.discriminatedUnion('next', [
  z.object({ next: z.literal('redirect'), url: z.string().url() }).strict(),
  z.object({ next: z.literal('wait') }).strict(),
]);
export type CardSubmitResult = z.infer<typeof cardSubmitResultSchema>;
