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

/**
 * Task 9.1: eWAY's Secure Fields and its 3-D Secure SDK (plan docs/plans/9.1-eway.md, section 2 and A3; UNVERIFIED: the
 * script URL was read through a summarising fetch tool, the frame and challenge origins are assumptions; the bank's own
 * challenge frame may need more, plan 20 m11). Served on /pay/secure-fields/* only, with its own CSP.
 */
export const EWAY_CARD_FIELDS = {
  scriptUrl: 'https://secure.ewaypayments.com/scripts/eWAY.min.js',
  frameOrigins: ['https://secure.ewaypayments.com'],
  challengeOrigins: { test: ['https://secure.ewaypayments.com'], live: [] as string[] },
} as const;

/** The origins of the Secure Fields page's CSP (`/pay/secure-fields/*`): eWAY's only. */
export const SECURE_FIELDS_PAGE_ORIGINS: readonly string[] = [...EWAY_CARD_FIELDS.frameOrigins];

/** Task 9.1: eWAY's single-use Secure Fields code and 3-D Secure access code, as our endpoints accept them. */
export const SECURE_FIELD_CODE_PATTERN = /^[A-Za-z0-9_-]{10,512}$/;
export const ACCESS_CODE_PATTERN = /^[A-Za-z0-9_-]{10,512}$/;

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

/** Task 9.1: eWAY's Secure Fields code, the only thing its card page sends with a card. */
export const secureFieldsSubmitSchema = z.object({ secureFieldCode: z.string().regex(SECURE_FIELD_CODE_PATTERN) }).strict();
export type SecureFieldsSubmit = z.infer<typeof secureFieldsSubmitSchema>;

/** Task 9.1: after the 3-D Secure challenge, the access code and the same Secure Fields code (plan 9.1, 6.4). */
export const secureFieldsAuthoriseSchema = z.object({ accessCode: z.string().regex(ACCESS_CODE_PATTERN), secureFieldCode: z.string().regex(SECURE_FIELD_CODE_PATTERN) }).strict();
export type SecureFieldsAuthorise = z.infer<typeof secureFieldsAuthoriseSchema>;
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
  /** Task 9.1: eWAY's page runs the 3-D Secure challenge with this access code, then authorises. */
  z.object({ next: z.literal('authenticate'), accessCode: z.string().regex(ACCESS_CODE_PATTERN) }).strict(),
]);
export type CardSubmitResult = z.infer<typeof cardSubmitResultSchema>;
