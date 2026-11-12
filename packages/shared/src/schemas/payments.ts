import { z } from 'zod';

// Payments (task 3.1, plan docs/plans/3.1-payment-provider-core.md). Starting a payment carries the method and, at
// most, how far along the plan to pay: never an amount, a currency, card data or a URL. The API takes the amount from
// the booking's payment plan (its snapshot) and the gateway collects card details on its own hosted page.

export const PAYMENT_METHODS = ['card', 'apple_pay', 'google_pay', 'payto', 'becs', 'payid_transfer', 'bpay', 'bnpl', 'manual_other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['created', 'pending', 'requires_action', 'succeeded', 'failed', 'cancelled', 'expired', 'voided'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Body of POST /booking-requests/:reference/payments. Any other key, nested or not, is a 422. */
export const startPaymentSchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
  /** Pay every active item up to this one (1 = the first). Absent: the first item not yet covered. */
  upToSequence: z.number().int().min(1).max(50).optional(),
  /** Replace the live attempt (another method, say) once the gateway confirms it is cancelled (plan 3.2, section 4). */
  replaceLiveAttempt: z.literal(true).optional(),
});
export type StartPayment = z.infer<typeof startPaymentSchema>;

/** Amounts travel as strings of digits (plan 0.1, 1.1); the web formats them and never adds them up. */
const minor = z.string().regex(/^\d+$/);

export const paymentPlanItemViewSchema = z.object({
  kind: z.enum(['deposit', 'balance', 'instalment', 'adjustment']),
  sequence: z.number().int(),
  amountMinor: minor,
  dueDate: z.string(),
  /** What the money collected covers of this item (plan 3.2, section 2). */
  paidMinor: minor,
});

export const paymentAttemptViewSchema = z.object({
  status: z.enum(PAYMENT_STATUSES),
  method: z.enum(PAYMENT_METHODS),
  amountMinor: minor,
  currency: z.string().length(3),
  nextAction: z.object({ type: z.literal('redirect'), url: z.string().url() }).optional(),
});
export type PaymentAttemptView = z.infer<typeof paymentAttemptViewSchema>;

export const paymentPlanViewSchema = z.object({
  reference: z.string(),
  currency: z.string().length(3),
  payable: z.boolean(),
  notPayableReason: z.string().optional(),
  items: z.array(paymentPlanItemViewSchema),
  collectedMinor: minor,
  outstandingMinor: minor,
  /** Collected beyond the plan: to be given back. */
  overpaidMinor: minor,
  /** While the booking waits for its deposit: the exact instant (ISO 8601) after which it can no longer be paid. */
  depositDueBy: z.string().nullable(),
  nextPayable: z.object({ sequence: z.number().int(), amountMinor: minor }).nullable(),
  methods: z.array(z.enum(PAYMENT_METHODS)),
  liveAttempt: paymentAttemptViewSchema.omit({ nextAction: true }).nullable(),
});
export type PaymentPlanView = z.infer<typeof paymentPlanViewSchema>;

// Checkout (task 3.5, plan docs/plans/3.5-checkout-simulator.md). The terms text always comes from the server; the
// browser only says which version and digest it showed. Nothing here carries an amount, a currency or card data.

/** Body of POST /booking-requests/:reference/terms-acceptance. */
export const acceptTermsSchema = z.strictObject({
  version: z.number().int().min(0).max(1_000_000),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AcceptTerms = z.infer<typeof acceptTermsSchema>;

export const checkoutTermsViewSchema = z.object({
  slug: z.string(),
  version: z.number().int(),
  digest: z.string(),
  title: z.string(),
  intro: z.string(),
  body: z.string(),
  /** When the signed-in customer accepted exactly this text for this booking; null until then. */
  acceptedAt: z.string().nullable(),
});
export type CheckoutTermsView = z.infer<typeof checkoutTermsViewSchema>;

/** Answer of POST /booking-requests/:reference/payments/refresh: where the latest attempt stands, as the gateway says. */
export const paymentRefreshViewSchema = z.object({
  bookingStatus: z.string(),
  attempt: paymentAttemptViewSchema.omit({ nextAction: true }).nullable(),
});
export type PaymentRefreshView = z.infer<typeof paymentRefreshViewSchema>;
