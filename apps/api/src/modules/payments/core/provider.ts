// The contract every payment adapter implements (plan docs/plans/3.1-payment-provider-core.md, section 2.2).
// An adapter only talks to its gateway: no Prisma, no settings, no environment variables, no logging, no bookings.
import type { PaymentMethod } from '@mt/shared';

/** The only way card data is handled: on the gateway's hosted page or fields. There is no type for card numbers here. */
export type CardDataHandling = 'hosted_only';

/** planned: catalogue entry only; experimental: written from the documentation; verified: passed against the real sandbox. */
export type AdapterStatus = 'planned' | 'experimental' | 'verified';

export type PaymentModeName = 'test' | 'live';

export interface Money {
  amountMinor: bigint;
  currency: string;
}

export interface AdapterManifest {
  key: string;
  displayName: string;
  status: AdapterStatus;
  /** Required when verified: the docs/done/ file that records the sandbox run (test:sandbox) with its date. */
  evidence?: string;
  /** True: never live and only in the development, test and ci environments. */
  testOnly: boolean;
  cardDataHandling: CardDataHandling;
  methods: readonly PaymentMethod[];
  currencies: readonly string[];
  countries: readonly string[] | 'any';
  /** Where its redirect URLs may point; anything else is never handed to a customer. */
  checkoutOrigin: string;
  /**
   * Task 4.4: the gateway's hosted card fields, for an adapter whose card is typed into the gateway's iframes on our own
   * card page (plan docs/plans/4.4-au-card-gateway.md, section 5.1). Fixed in code; only the mode selects.
   */
  cardFields?: CardFieldsConfig;
  /** How an account of this adapter is set up from the panel (task 4.1). Test mode only: no live pattern exists. */
  account: AccountSetup;
  capabilities: {
    refunds: 'none' | 'full' | 'partial';
    deferredCapture: boolean;
    lookupByIdempotencyKey: true;
    /**
     * What a declined card does to the object (plan 3.3, section 12.4): `failed` ends it; `stays_payable` leaves it
     * waiting for the customer, who may try another card (Stripe Checkout). Checked by the contract suite.
     */
    declineOutcome: 'failed' | 'stays_payable';
    /**
     * Task 4.5: the adapter reads the gateway's disputes (events and retrieveDispute). Absent means none: its dispute
     * events are `unsupported` and the dispute clauses of the contract suite do not apply.
     */
    disputes?: 'events';
    /**
     * Task 4.6: what the daily reconciliation can list at the gateway. `activity`: listActivity; `settlements`:
     * listSettlements. Absent means neither: the reconciliation then compares our own objects one by one.
     */
    reconciliation?: { activity: boolean; settlements: boolean };
    /**
     * Task 4.4 (plan 4.4, sections 12.2 and 18 M1): the payment waits for a card on our own page and has no counterpart
     * at the gateway until the card is submitted, so the gateway has no event for it yet. Only CardSessionProvider sets
     * it (checked by the registry); never an adapter's own manifest.
     */
    preCardSession?: true;
    /**
     * Task 4.4 (plan 4.4, section 7): the gateway's refund events carry no id of ours (Pin has no refund metadata); our
     * refund id comes from retrieveRefund, which the core calls before recording a refund as external. Only with
     * preCardSession (a CardSessionProvider keeps the refund intents that back it).
     */
    refundEventOurId?: 'via_retrieve';
    /**
     * Task 9.1 (plan docs/plans/9.1-eway.md, sections 4.2 and 20 M1, M6): the gateway sends no server-to-server event
     * at all (eWAY): every state is read from the gateway. Only adapter keys in EVENTLESS_ADAPTER_KEYS may declare it;
     * its signature headers are empty, it cannot be `verified` without reconciliation and disputes, and the contract
     * suite replaces the webhook checks with checks of the read path (an answer lost after the gateway acted is found
     * by a read, linked, and never sent again).
     */
    gatewayEvents?: 'none';
  };
}

/** Task 9.1 (plan 9.1, 20 M6): the closed list of adapters that may declare `gatewayEvents: 'none'`. */
export const EVENTLESS_ADAPTER_KEYS: readonly string[] = ['eway'];

/** Task 4.4: the hosted card fields of a gateway (script, iframe origins, 3-D Secure challenge origins by mode). */
export interface CardFieldsConfig {
  /**
   * Task 9.1: which client code the card page runs, and on which path it is served (each path has its own CSP).
   * `pin_hosted_fields` at /pay/card (task 4.4); `eway_secure_fields` at /pay/secure-fields.
   */
  driver: CardFieldsDriver;
  scriptUrl: string;
  frameOrigins: readonly string[];
  challengeOrigins: Readonly<Record<PaymentModeName, readonly string[]>>;
}

export type CardFieldsDriver = 'pin_hosted_fields' | 'eway_secure_fields';

/** A credential staff type in the panel: its value is validated against `pattern` (anchored), encrypted and never shown. */
export interface CredentialField {
  key: string;
  label: string;
  /** Anchored regular expression source for a test-mode value. */
  pattern: string;
  /**
   * Task 4.4 (plan 4.4, D4): a key the gateway designs for the browser (Pin's publishable key). Still encrypted and never
   * returned by the panel; only the card page of an open session of that account receives it. Only with `cardFields`.
   */
  exposure?: 'card_page';
  /**
   * Checked by manifestProblems (plan 4.1, section 2): `valid` must match the pattern, and every `rejected` one (a live key,
   * another kind of key) must not. Built in code, never a real key.
   */
  samples: CredentialSamples;
}

export interface CredentialSamples {
  valid: string;
  rejected: readonly string[];
}

/**
 * The credentials of an account (plan 4.1, section 2). `generated` values (the simulator's API key) and a `generated`
 * webhook secret are made by the server; an `entered` webhook secret is issued by the gateway once the account's webhook
 * URL is registered there (Stripe), so it is set after creation (plan 4.1, 15.2).
 */
export interface AccountSetup {
  fields: readonly CredentialField[];
  generated?: readonly { key: string; prefix: string }[];
  webhookSecret: { source: 'entered'; label: string; pattern: string; samples: CredentialSamples } | { source: 'generated' };
}

/** What the gateway wrapper hands an adapter for one call. Credentials are decrypted only for that call. */
export interface ProviderContext {
  accountId: string;
  mode: PaymentModeName;
  credentials: Readonly<Record<string, string>>;
  /** Empty while an entered webhook secret has not been set yet (task 4.1). */
  webhookSecret: string;
}

/** No index signature: a card field cannot be added by accident. */
export interface CreatePaymentInput {
  amount: Money;
  method: PaymentMethod;
  /** Ours, generated by the server (booking:<id>:attempt:<n>), used as the gateway's own idempotency key. */
  idempotencyKey: string;
  /** Identifiers only. */
  metadata: { paymentId: string; bookingId: string };
  /** Built by the server from WEB_ORIGIN and a fixed path; never from the request. */
  returnUrl: string;
  customerCountry: string;
  /**
   * When our attempt row was created (plan 3.3, section 12.5): always the row's, never the time of the call, so every
   * parameter sent under one idempotency key is the same on every retry, and a gateway without lookup by key can search
   * a bounded window.
   */
  createdAt: Date;
}

/** How a payment is looked up: by the gateway's reference, or by our idempotency key and the attempt row's createdAt. */
export type PaymentLookup = { ref: string } | { idempotencyKey: string; createdAt: Date };

/**
 * `failed` means terminal at the gateway: the object can no longer be charged. A gateway that leaves a failed object
 * reusable (a 3-D Secure failure, for instance) is reported as `requires_action`, or cancelled by the adapter before it
 * reports `failed` (plan 3.1, section 14, point 3; checked by the contract suite of 3.6).
 */
export type ProviderPaymentStatus = 'requires_action' | 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface ProviderPayment {
  ref: string;
  status: ProviderPaymentStatus;
  amount: Money;
  /** Our payment id from the metadata, when the gateway returns it. */
  ourPaymentId?: string;
  nextAction?: { type: 'redirect'; url: string };
  failureCode?: string;
}

export interface NormalisedEvent {
  providerEventId: string;
  /** The gateway's own event type (payment.updated, payout.paid…), as stored with the raw event. */
  type: string;
  occurredAt: Date;
  /** Settlements are an extension for 4.6. */
  kind: 'payment' | 'refund' | 'dispute' | 'unsupported';
  payment?: ProviderPayment;
  refund?: ProviderRefund;
  dispute?: ProviderDispute;
  /**
   * Task 4.3: an `unsupported` event in which money moved without us (a capture reversal, a dispute opened): the core
   * opens a task for staff to review instead of only ignoring it.
   */
  review?: 'reversal' | 'dispute';
}

/** Why a cardholder disputed a payment, normalised (task 4.5); a gateway's code outside the list is `other`. */
export const DISPUTE_REASON_CODES = ['fraudulent', 'product_not_received', 'product_unacceptable', 'duplicate', 'credit_not_processed', 'unrecognised', 'general', 'other'] as const;
export type DisputeReasonCode = (typeof DISPUTE_REASON_CODES)[number];

/** `closed`: ended without an outcome (an inquiry that did not become a chargeback). won, lost and closed are final. */
export type ProviderDisputeStatus = 'open' | 'evidence_submitted' | 'won' | 'lost' | 'closed';

/**
 * A dispute as the gateway sees it now (task 4.5). The funds flags are cumulative: every event and every retrieve says
 * whether the disputed amount was ever taken from us and whether it was given back, so order does not matter.
 */
export interface ProviderDispute {
  ref: string;
  /** The payment disputed, as the gateway names it: retrievePayment({ ref: paymentRef }) resolves it. */
  paymentRef: string;
  amount: Money;
  reasonCode: DisputeReasonCode;
  status: ProviderDisputeStatus;
  evidenceDueBy?: Date;
  fundsWithdrawn: boolean;
  fundsReinstated: boolean;
}

/** `cancelled`: the gateway dropped it before any money moved. */
export type ProviderRefundStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface ProviderRefund {
  ref: string;
  status: ProviderRefundStatus;
  amount: Money;
  /** The payment refunded, as the gateway names it: retrievePayment({ ref: paymentRef }) resolves it (plan 3.3, 3.2). */
  paymentRef: string;
  /** Our refund id from the metadata, when the refund was started by us (task 4.5). */
  ourRefundId?: string;
  failureCode?: string;
}

/** No index signature, as for payments. */
export interface CreateRefundInput {
  /** The payment's reference as createPayment returned it. */
  paymentRef: string;
  amount: Money;
  idempotencyKey: string;
  metadata: { refundId: string; paymentId: string; bookingId: string };
  /** When our refund row was created: the window a gateway without lookup by key searches. */
  createdAt: Date;
}

export type RefundLookup = { ref: string } | { idempotencyKey: string; paymentRef: string; createdAt: Date };

export type WebhookVerification = { ok: true; event: NormalisedEvent } | { ok: false; code: 'bad_signature' | 'stale_timestamp' | 'malformed'; claimedEventId?: string };

export interface PaymentProvider {
  readonly manifest: AdapterManifest;
  testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }>;
  createPayment(ctx: ProviderContext, input: CreatePaymentInput): Promise<ProviderPayment>;
  /** `ref` may also be the `paymentRef` of a refund event (the gateway's other name for the payment). */
  retrievePayment(ctx: ProviderContext, by: PaymentLookup): Promise<ProviderPayment | null>;
  cancelPayment(ctx: ProviderContext, ref: string, idempotencyKey: string): Promise<ProviderPayment>;
  /** A refund of a collected payment; refused (provider_rejected, definitive) beyond what is left or if the capability says so. */
  createRefund(ctx: ProviderContext, input: CreateRefundInput): Promise<ProviderRefund>;
  retrieveRefund(ctx: ProviderContext, by: RefundLookup): Promise<ProviderRefund | null>;
  /** Task 4.5: required when `capabilities.disputes` is declared. Null if the gateway does not know it. */
  retrieveDispute?(ctx: ProviderContext, ref: string): Promise<ProviderDispute | null>;
  /**
   * Optional (task 4.3, plan 4.3 section 5.3): finishes a payment the customer approved at the gateway (PayPal's
   * capture). The core calls it only for a live attempt of a payable booking on an active account (sync, drive and
   * expire), never to cancel, replace, close an orphan or process a refund. Answers as retrievePayment would after it.
   */
  completePayment?(ctx: ProviderContext, ref: string, idempotencyKey: string): Promise<ProviderPayment>;
  /**
   * Optional (task 4.3, plan 4.3 section 7.3): fetches from the gateway, and caches, what verifyWebhook needs to check this
   * delivery offline (PayPal's signing certificate). Called by the gateway wrapper before verifyWebhook; never throws.
   */
  prepareWebhook?(ctx: ProviderContext, headers: Readonly<Record<string, string>>): Promise<void>;
  /** No network: checks the signature over the raw body with this account's secret, and the timestamp. */
  verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification;
  /** Reads a body that already passed verifyWebhook (when it was received), for processing later and on retries. */
  parseEvent(rawBody: Buffer): NormalisedEvent | null;
  /** Names of the headers that carry the signature: stored without their value. */
  readonly signatureHeaders: readonly string[];
  /**
   * Task 4.6, optional (capabilities.reconciliation.activity): one page of the payments, refunds and disputes the
   * gateway recorded in the window, oldest first. `cursor` is the previous page's `next`; no `next` means the last page.
   */
  listActivity?(ctx: ProviderContext, window: { from: Date; to: Date; cursor?: string }): Promise<{ items: ProviderActivity[]; next?: string }>;
  /** Task 4.6, optional (capabilities.reconciliation.settlements): one page of the payouts made since a calendar date. */
  listSettlements?(ctx: ProviderContext, since: { payoutDateFrom: string; cursor?: string }): Promise<{ items: ProviderSettlement[]; next?: string }>;
}

/** Task 4.6: one object the gateway recorded, as listActivity returns it (codes, references and amounts only). */
export interface ProviderActivity {
  kind: 'payment' | 'refund' | 'dispute';
  ref: string;
  /** For a refund or a dispute: the payment it belongs to, as the gateway names it. */
  paymentRef?: string;
  /** Our id from the metadata (a payment's or a refund's), when the gateway returns it. */
  ourId?: string;
  amount: Money;
  /** The object's status at the gateway (a payment's, a refund's or a dispute's own list). */
  status: string;
  occurredAt: Date;
}

export type ProviderSettlementLineKind = 'charge' | 'refund' | 'dispute_withdrawal' | 'dispute_reinstatement' | 'adjustment' | 'other';

/** Task 4.6: a payout and its lines. Signed minor units: a refund line is negative, a fee given back is negative. */
export interface ProviderSettlement {
  ref: string;
  /** Calendar date (YYYY-MM-DD). */
  payoutDate: string;
  currency: string;
  grossMinor: bigint;
  feesMinor: bigint;
  netMinor: bigint;
  lines: ProviderSettlementLine[];
}

export interface ProviderSettlementLine {
  ref: string;
  kind: ProviderSettlementLineKind;
  paymentRef?: string;
  refundRef?: string;
  disputeRef?: string;
  amountMinor: bigint;
  feeMinor: bigint;
}

export const PROVIDER_ERROR_CODES = ['provider_unavailable', 'provider_timeout', 'provider_busy', 'provider_rejected', 'provider_auth_failed', 'provider_not_found'] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * The only error an adapter throws: a code from a closed list, never the gateway's message or response.
 *
 * Contract for createPayment (plan 3.1, section 16): a NON-retryable error means that no object exists, and none ever
 * will, under that idempotency key. A gateway's "idempotency key in use" (another request with the same key still in
 * flight) is `provider_busy` and retryable: the object may be about to exist.
 */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    readonly retryable: boolean,
  ) {
    super(`payment provider error: ${code}`);
    this.name = 'ProviderError';
  }
}

// ---- Task 4.4: gateways whose card is tokenised by hosted fields on our page (plan docs/plans/4.4-au-card-gateway.md) ----

/** Our card session reference: the bearer value in the card page's URL. */
export const CARD_SESSION_REF = /^cs_[0-9a-f]{32}$/;

/** Why a card was not charged, from a closed list (plan 4.4, section 6.3). */
export const CARD_DECLINE_CODES = ['card_declined', 'insufficient_funds', 'expired_card', 'card_not_authenticated', 'processing_error', 'suspected_fraud'] as const;
export type CardDeclineCode = (typeof CARD_DECLINE_CODES)[number];

/** A charge as the gateway reports it. `pending`: a 3-D Secure challenge is still open. */
export interface GatewayCharge {
  token: string;
  success: boolean;
  captured: boolean;
  /** Still in progress: a 3-D Secure challenge open, or successful but not yet captured. */
  pending: boolean;
  /** Ended without money, said explicitly by the gateway (never inferred from an unknown state: review M1). */
  failed: boolean;
  amount: Money;
  /** Our session reference and payment id from the charge's metadata, when present and well formed. */
  sessionRef?: string;
  ourPaymentId?: string;
  failureCode?: CardDeclineCode;
}

/** One charge of a card token. Payer details are required by the gateway (plan 4.4, D10) and sent nowhere else. */
export interface CardChargeRequest {
  amount: Money;
  cardToken: string;
  payer: { email: string; ipAddress: string };
  sessionRef: string;
  paymentId: string;
  /** Where the gateway sends the customer back after 3-D Secure. */
  callbackUrl: string;
  /**
   * Task 9.1, `before_charge` gateways only: the result of the authentication that came first. Opaque, in memory for
   * one request: never stored or logged.
   */
  authentication?: AuthenticationProof;
}

/** Task 9.1: what a `before_charge` gateway's authentication gave (eWAY's ThreeDSecureAuth). Never stored or logged. */
export interface AuthenticationProof {
  readonly opaque: Readonly<Record<string, string>>;
}

/** Task 9.1: the payer as 3-D Secure 2 needs them (from the payment's payer, plan 9.1 20 m9). Sent to the gateway only. */
export interface AuthenticationPayer {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
}

/** Task 9.1: the start of a `before_charge` authentication. Moves no money. */
export type AuthenticationStart =
  | { kind: 'challenge'; authRef: string }
  | { kind: 'declined'; code: CardDeclineCode }
  | { kind: 'refused'; code: 'provider_rejected' | 'provider_auth_failed' };

/** Task 9.1: what the gateway says of an authentication once the customer finished it. Moves no money. */
export type AuthenticationResult = { authenticated: true; proof: AuthenticationProof } | { authenticated: false };

/**
 * Task 9.1 (plan 9.1, 20 m10): what a search by our session reference gave when the gateway refuses it because the
 * reference is on more than one object. Staff resolve it (`payments:card-session-bind`).
 */
export const NOT_UNIQUE = 'not_unique' as const;

/**
 * What a charge request gave. An unknown outcome (timeout, 5xx, 409) is not a value: the gateway throws a retryable
 * ProviderError and the charge may or may not exist.
 */
export type CardChargeOutcome =
  | { kind: 'charged'; charge: GatewayCharge }
  | { kind: 'challenge'; charge: GatewayCharge; redirectUrl?: string }
  | { kind: 'declined'; code: CardDeclineCode; chargeToken?: string }
  | { kind: 'refused'; code: 'provider_rejected' | 'provider_auth_failed' | 'provider_busy' }
  /**
   * Task 9.1 (plan 9.1, 20 M4): the gateway refused it as a duplicate of an operation it already saw. Never read as "no
   * money": an earlier attempt of the same booking may have charged without our knowing.
   */
  | { kind: 'duplicate' };

export interface GatewayRefund {
  token: string;
  status: ProviderRefundStatus;
  amount: Money;
  chargeToken: string;
  createdAt: Date;
  failureCode?: string;
}

/** An unknown outcome throws a retryable ProviderError; `rate_limited` means nothing was created (plan 4.4, A18). */
export type GatewayRefundOutcome = { kind: 'created'; refund: GatewayRefund } | { kind: 'refused' } | { kind: 'rate_limited' };

/**
 * Task 4.4 (plan 4.4, section 4.2): the narrow interface of a gateway that charges card tokens from hosted fields. It is
 * stateless like every adapter; the core's CardSessionProvider keeps the state before a card is submitted and exposes
 * the result as a PaymentProvider. Its manifest never declares `preCardSession`.
 */
export interface CardTokenGateway {
  readonly manifest: AdapterManifest;
  /**
   * Task 9.1 (plan 9.1, section 4.1): `after_charge`, the charge starts 3-D Secure (Pin); `before_charge`, 3-D Secure
   * comes first and the one charge carries its result (eWAY), through beginAuthentication and completeAuthentication.
   */
  readonly authentication: 'after_charge' | 'before_charge';
  /** Task 9.1 (plan 9.1, section 4.3): the shapes of this gateway's charge and refund references. */
  readonly chargeRefPattern: RegExp;
  readonly refundRefPattern: RegExp;
  /** Whether the gateway's refund events carry our refund id; if not, CardSessionProvider declares refundEventOurId. */
  readonly refundEventsCarryOurId: boolean;
  readonly signatureHeaders: readonly string[];
  /** One authenticated read that moves nothing: bad credentials throw provider_auth_failed. */
  probe(ctx: ProviderContext): Promise<void>;
  testConnection(ctx: ProviderContext): Promise<{ ok: true } | { ok: false; code: string }>;
  charge(ctx: ProviderContext, req: CardChargeRequest): Promise<CardChargeOutcome>;
  /** The charge a 3-D Secure session token belongs to, once the customer is back; null if unknown. */
  verifyAuthentication(ctx: ProviderContext, sessionToken: string): Promise<GatewayCharge | null>;
  retrieveCharge(ctx: ProviderContext, token: string): Promise<GatewayCharge | null>;
  /**
   * Every charge whose metadata names this session (plan 4.4, section 6.3 step 5). An empty list is a definitive "none";
   * anything the gateway cannot answer for sure throws a retryable error. NOT_UNIQUE: the gateway refuses the search
   * because the reference is on more than one object (plan 9.1, 20 m10).
   */
  chargesOfSession(ctx: ProviderContext, sessionRef: string): Promise<GatewayCharge[] | typeof NOT_UNIQUE>;
  /** Task 9.1, `before_charge` only: starts 3-D Secure for a card token. Moves no money. */
  beginAuthentication?(ctx: ProviderContext, req: { amount: Money; cardToken: string; payer: AuthenticationPayer }): Promise<AuthenticationStart>;
  /** Task 9.1, `before_charge` only: what the authentication gave. Moves no money; an unknown answer throws (retryable). */
  completeAuthentication?(ctx: ProviderContext, authRef: string): Promise<AuthenticationResult>;
  /**
   * Task 9.1 (plan 9.1, section 7): the refund the gateway holds under our own reference for the intent (eWAY's
   * InvoiceReference), or null for a definitive "none". With it, a submitting intent binds by exact match, never by the
   * time window.
   */
  refundByOurRef?(ctx: ProviderContext, intentRef: string, chargeToken: string): Promise<GatewayRefund | null>;
  /** Pending refunds of a charge are part of `refunds`; `refunded` is the gateway's own total. */
  refundState(ctx: ProviderContext, chargeToken: string): Promise<{ charge: GatewayCharge; refunded: bigint } | null>;
  /** `intentRef`: our reference for the refund (task 9.1), sent where the gateway keeps one (eWAY); Pin ignores it. */
  createRefund(ctx: ProviderContext, chargeToken: string, amount: Money, intentRef?: string): Promise<GatewayRefundOutcome>;
  retrieveRefund(ctx: ProviderContext, token: string): Promise<GatewayRefund | null>;
  listRefunds(ctx: ProviderContext, chargeToken: string): Promise<GatewayRefund[]>;
  verifyWebhook(ctx: ProviderContext, rawBody: Buffer, headers: Readonly<Record<string, string>>, now: Date): WebhookVerification;
  parseEvent(rawBody: Buffer): NormalisedEvent | null;
}
