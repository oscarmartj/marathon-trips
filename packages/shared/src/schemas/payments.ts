import { z } from 'zod';
import { cancellationPolicyPublicViewSchema } from './cancellations';

// Payments (task 3.1, plan docs/plans/3.1-payment-provider-core.md). Starting a payment carries the method and, at
// most, how far along the plan to pay: never an amount, a currency, card data or a URL. The API takes the amount from
// the booking's payment plan (its snapshot) and the gateway collects card details on its own hosted page.

export const PAYMENT_METHODS = ['card', 'apple_pay', 'google_pay', 'payto', 'becs', 'payid_transfer', 'bpay', 'bnpl', 'manual_other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAY_ID_TYPES = ['email', 'phone', 'abn', 'org_id'] as const;
export type PayIdType = (typeof PAY_ID_TYPES)[number];

export const MANUAL_PAYMENT_METHODS = ['payid_transfer', 'manual_other'] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

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
  kind: z.enum(['deposit', 'balance', 'instalment', 'adjustment', 'penalty']),
  sequence: z.number().int(),
  amountMinor: minor,
  dueDate: z.string(),
  /** What the money collected covers of this item (plan 3.2, section 2). */
  paidMinor: minor,
});

/**
 * How to pay by bank transfer (task 3.4): where to send it, the reference to write on it and the amount the plan asks for.
 * The business's own details; nothing about any customer. The customer never sends an amount.
 */
export const manualInstructionsViewSchema = z.object({
  method: z.enum(['payid_transfer', 'manual_other']),
  /** The booking's reference: the payer writes it on the transfer so staff can find the booking. */
  reference: z.string(),
  amountMinor: minor,
  currency: z.string().length(3),
  payeeName: z.string(),
  payId: z.object({ type: z.enum(PAY_ID_TYPES), value: z.string() }).nullable(),
  bank: z.object({ bsb: z.string(), accountNumber: z.string() }).nullable(),
  /** The staff's words for this method, in the customer's language when there is one, else en-AU. */
  note: z.string().nullable(),
  /** When this request to pay by transfer lapses (ISO 8601). */
  expiresAt: z.string(),
});
export type ManualInstructionsView = z.infer<typeof manualInstructionsViewSchema>;

export const paymentAttemptViewSchema = z.object({
  status: z.enum(PAYMENT_STATUSES),
  method: z.enum(PAYMENT_METHODS),
  amountMinor: minor,
  currency: z.string().length(3),
  nextAction: z.object({ type: z.literal('redirect'), url: z.string().url() }).optional(),
  manual: manualInstructionsViewSchema.optional(),
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
  liveAttempt: paymentAttemptViewSchema.omit({ nextAction: true, manual: true }).nullable(),
  /** The open request to pay by bank transfer, if any (task 3.4). */
  manualIntent: manualInstructionsViewSchema.nullable(),
});
export type PaymentPlanView = z.infer<typeof paymentPlanViewSchema>;

// Checkout (task 3.5, plan docs/plans/3.5-checkout-simulator.md). The terms text always comes from the server; the
// browser only says which version and digest it showed. Nothing here carries an amount, a currency or card data.

/** Body of POST /booking-requests/:reference/terms-acceptance. */
export const acceptTermsSchema = z.strictObject({
  version: z.number().int().min(0).max(1_000_000),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Task 6.4: the digest of the booking's cancellation policy shown with the terms; null when it has none. */
  cancellationPolicyDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
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
  /** Task 6.4: the cancellation policy the booking was sold under, shown with the terms; null when it has none. */
  cancellationPolicy: cancellationPolicyPublicViewSchema.nullable(),
});
export type CheckoutTermsView = z.infer<typeof checkoutTermsViewSchema>;

/** Answer of POST /booking-requests/:reference/payments/refresh: where the latest attempt stands, as the gateway says. */
export const paymentRefreshViewSchema = z.object({
  bookingStatus: z.string(),
  attempt: paymentAttemptViewSchema.omit({ nextAction: true, manual: true }).nullable(),
});
export type PaymentRefreshView = z.infer<typeof paymentRefreshViewSchema>;

// Payment links (task 5.1, plan docs/plans/5.1-customer-area.md, section 5). The token travels in the body, never in a
// URL; the page reads it from the URL fragment. A link pays one plan item: the body has no amount, sequence or replace.

const LINK_TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Body of POST /payment-links/view and /payment-links/refresh. */
export const paymentLinkTokenSchema = z.strictObject({ token: LINK_TOKEN });
export type PaymentLinkToken = z.infer<typeof paymentLinkTokenSchema>;

/** Body of POST /payment-links/payments. Any other key, nested or not, is a 422. */
export const paymentLinkPaySchema = z.strictObject({ token: LINK_TOKEN, method: z.enum(PAYMENT_METHODS) });
export type PaymentLinkPay = z.infer<typeof paymentLinkPaySchema>;

/** What a link shows without a session: the trip, its dates and the amount due now. Nothing personal. */
export const paymentLinkViewSchema = z.strictObject({
  reference: z.string(),
  package: z.strictObject({ name: z.record(z.string(), z.string()) }),
  race: z.strictObject({ name: z.record(z.string(), z.string()) }),
  editionYear: z.number().int(),
  departureDate: z.string(),
  returnDate: z.string(),
  currency: z.string().length(3),
  amountDueMinor: minor,
  payable: z.boolean(),
  notPayableReason: z.string().optional(),
  methods: z.array(z.enum(PAYMENT_METHODS)),
  termsAccepted: z.boolean(),
  liveAttempt: z.strictObject({ status: z.enum(PAYMENT_STATUSES), method: z.enum(PAYMENT_METHODS) }).nullable(),
  expiresAt: z.string(),
});
export type PaymentLinkView = z.infer<typeof paymentLinkViewSchema>;

/** Answer of POST /payment-links/refresh: the latest attempt started through this link, and whether the link has served. */
export const paymentLinkRefreshViewSchema = z.strictObject({
  used: z.boolean(),
  attempt: paymentAttemptViewSchema.omit({ nextAction: true, manual: true }).nullable(),
});
export type PaymentLinkRefreshView = z.infer<typeof paymentLinkRefreshViewSchema>;

/** Body of POST /admin/payments/bookings/:id/payment-links: nothing; the target and the expiry are the server's. */
export const sendPaymentLinkSchema = z.strictObject({});

// Bank transfers confirmed by staff and the manual methods' configuration (task 3.4, plan docs/plans/3.4-manual-payid-transfer.md).

/** The bank's own identifier of a movement: the one reference of a transfer (unique per account until voided). */
export const BANK_REFERENCE = /^[A-Z0-9][A-Z0-9 _./:#-]{0,63}$/;

/** Normalises what staff typed: trimmed, spaces collapsed, upper case. The API checks the result against BANK_REFERENCE. */
export const normaliseBankReference = (v: string): string => v.trim().replace(/\s+/g, ' ').toUpperCase();

/** A booking reference (MT-XXXXXX). It names the booking, never the bank movement, so it is not accepted as a statement ID. */
export const BOOKING_REFERENCE_SHAPE = /^MT-[A-Z0-9]{6}$/;

/** Body of POST /admin/payments/bookings/:id/inbound-payments. The amount is the one the bank shows, in the booking's currency. */
export const confirmTransferSchema = z.strictObject({
  method: z.enum(MANUAL_PAYMENT_METHODS).default('payid_transfer'),
  amountMinor: z.string().regex(/^[1-9]\d{0,11}$/),
  reference: z.string().min(1).max(100).transform(normaliseBankReference).refine((v) => BANK_REFERENCE.test(v), 'Not a bank reference').refine((v) => !BOOKING_REFERENCE_SHAPE.test(v), 'A booking reference is not a bank statement ID'),
});
export type ConfirmTransfer = z.infer<typeof confirmTransferSchema>;

/** Body of POST /admin/payments/payments/:id/void. */
export const voidTransferSchema = z.strictObject({ version: z.number().int().min(0), reason: z.string().trim().min(1).max(200) });
export type VoidTransfer = z.infer<typeof voidTransferSchema>;

const localised = z.record(z.string().regex(/^[a-z]{2}-[A-Z]{2}$/), z.string().trim().min(1).max(2000)).refine((o) => Object.keys(o).length <= 10);

/** Body of PUT /admin/payments/methods/:method. Everything is replaced; `version` is the one the panel read. */
export const manualMethodConfigSchema = z.strictObject({
  version: z.number().int().min(0),
  enabled: z.boolean(),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250),
  displayOrder: z.number().int().min(0).max(1000).default(0),
  instructions: localised.nullable().default(null),
  payeeName: z.string().trim().min(1).max(140).nullable().default(null),
  payId: z.object({ type: z.enum(PAY_ID_TYPES), value: z.string().trim().min(1).max(80) }).nullable().default(null),
  bank: z.object({ bsb: z.string().trim(), accountNumber: z.string().trim() }).nullable().default(null),
  /** Task 4.1: go ahead even though customers in some country would lose their last way to pay. */
  confirmCoverageLoss: z.boolean().optional(),
});
export type ManualMethodConfigInput = z.infer<typeof manualMethodConfigSchema>;

// ---- Gateway accounts in the panel (task 4.1) ----

export const PROVIDER_ACCOUNT_STATUSES = ['active', 'paused', 'retired', 'archived'] as const;
export type ProviderAccountStatus = (typeof PROVIDER_ACCOUNT_STATUSES)[number];

const accountName = z.string().trim().min(1).max(100);

/**
 * `credentials` is checked by the API against the adapter's own fields, never by this schema: a validation error here
 * would repeat a key the client chose, which could be a secret (plan 4.1, 15.6). Mode is always sent; only `test` exists.
 */
export const createProviderAccountSchema = z.strictObject({
  adapterKey: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  displayName: accountName,
  mode: z.enum(['test', 'live']),
  credentials: z.unknown().optional(),
});
export const renameProviderAccountSchema = z.strictObject({ version: z.number().int().min(0), displayName: accountName });
export const providerAccountStatusSchema = z.strictObject({
  version: z.number().int().min(0),
  status: z.enum(PROVIDER_ACCOUNT_STATUSES),
  confirmCoverageLoss: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export const providerAccountCredentialsSchema = z.strictObject({ version: z.number().int().min(0), credentials: z.unknown() });
export const providerAccountWebhookSecretSchema = z.strictObject({ version: z.number().int().min(0), webhookSecret: z.unknown() });
export const providerAccountVersionSchema = z.strictObject({ version: z.number().int().min(0) });

// ---- Refunds from the app and disputes (task 4.5, plan docs/plans/4.5-refunds-disputes.md) ----

export const REFUND_PURPOSES = ['overpayment_return', 'price_reduction', 'cancellation'] as const;
export type RefundPurposeName = (typeof REFUND_PURPOSES)[number];

/**
 * Body of POST /admin/payments/payments/:id/refunds. There is no amount: the API refunds what this payment can give
 * back now (its overpayment), computed on the server. A manual refund's destination is sent in its own step.
 */
export const requestRefundSchema = z.strictObject({
  paymentVersion: z.number().int().min(0),
  purpose: z.enum(REFUND_PURPOSES),
  reason: z.string().trim().min(3).max(500),
});
export type RequestRefund = z.infer<typeof requestRefundSchema>;

/** Where a manual refund goes (PUT /admin/payments/refunds/:id/destination). Exactly one of PayID or bank account. */
export const refundDestinationSchema = z.strictObject({
  version: z.number().int().min(0),
  accountName: z.string().trim().min(1).max(140),
  payId: z.object({ type: z.enum(PAY_ID_TYPES), value: z.string().trim().min(1).max(80) }).nullable().default(null),
  bank: z.object({ bsb: z.string().trim(), accountNumber: z.string().trim() }).nullable().default(null),
}).refine((d) => (d.payId === null) !== (d.bank === null), 'Give a PayID or a bank account, not both');
export type RefundDestinationInput = z.infer<typeof refundDestinationSchema>;

/** Body of POST /admin/payments/refunds/:id/confirm-manual: the movement id of the outgoing transfer on the statement. */
export const confirmManualRefundSchema = z.strictObject({
  version: z.number().int().min(0),
  bankReference: z.string().min(1).max(100).transform(normaliseBankReference).refine((v) => BANK_REFERENCE.test(v), 'Not a bank reference').refine((v) => !BOOKING_REFERENCE_SHAPE.test(v), 'A booking reference is not a bank statement ID'),
});
export type ConfirmManualRefund = z.infer<typeof confirmManualRefundSchema>;

/** Body of the refund and dispute actions that only need the version read (cancel, resolve, evidence submitted). */
export const refundVersionSchema = z.strictObject({ version: z.number().int().min(0) });
