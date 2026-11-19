// The state a card session keeps before and around its one charge (plan docs/plans/4.4-au-card-gateway.md, sections 4,
// 6, 7, 11 and 18): a port with a Prisma implementation (the API) and a memory one (contract subjects, unit tests). Both
// apply the same transition rules; in the database a trigger applies them again (migration 0039).
import type { CardSessionFailure } from '@mt/shared';
import type { PaymentModeName } from '../provider';

export type CardSessionStatus = 'open' | 'submitting' | 'authenticating' | 'succeeded' | 'failed' | 'cancelled';

export interface CardSession {
  id: string;
  ref: string;
  accountId: string;
  mode: PaymentModeName;
  idempotencyKey: string;
  paymentId: string;
  bookingId: string;
  amountMinor: bigint;
  currency: string;
  returnUrl: string;
  status: CardSessionStatus;
  chargeRef: string | null;
  /** What the bound charge collected, when succeeded (normally the session's amount). */
  chargedMinor: bigint | null;
  failureCode: CardSessionFailure | null;
  submittedAt: Date | null;
  verifyCalls: number;
  createdAt: Date;
  expiresAt: Date;
  version: number;
}

export interface CardSessionInit {
  accountId: string;
  mode: PaymentModeName;
  idempotencyKey: string;
  paymentId: string;
  bookingId: string;
  amountMinor: bigint;
  currency: string;
  returnUrl: string;
  /** The attempt row's createdAt (CreatePaymentInput.createdAt). */
  createdAt: Date;
}

export interface CardSessionChange {
  status?: CardSessionStatus;
  chargeRef?: string;
  chargedMinor?: bigint;
  failureCode?: CardSessionFailure | null;
  submittedAt?: Date;
  verifyCalls?: number;
}

export type CardRefundIntentStatus = 'new' | 'submitting' | 'bound' | 'refused';
/** Why a submitting intent went back to `new`: the gateway did not process the request (plan 4.4, section 7 point 4). */
export type CardRefundLastAnswer = 'rate_limited' | 'auth_failed';

export interface CardRefundIntent {
  id: string;
  accountId: string;
  mode: PaymentModeName;
  idempotencyKey: string;
  refundId: string;
  chargeRef: string;
  amountMinor: bigint;
  currency: string;
  status: CardRefundIntentStatus;
  refundRef: string | null;
  lastAnswer: CardRefundLastAnswer | null;
  createdAt: Date;
  /**
   * When the row last changed: while `submitting`, the moment the one request now outstanding was sent (an intent goes
   * back to `new` only when nothing was processed). Refund candidates are judged from it (review round 2).
   */
  updatedAt: Date;
  version: number;
}

export type CardRefundIntentInit = Omit<CardRefundIntent, 'id' | 'status' | 'refundRef' | 'lastAnswer' | 'createdAt' | 'updatedAt' | 'version'>;

export interface CardRefundIntentChange {
  status: CardRefundIntentStatus;
  refundRef?: string;
  lastAnswer?: CardRefundLastAnswer | null;
}

export interface SessionChargeRow {
  chargeRef: string;
  success: boolean;
  amountMinor: bigint;
  currency: string;
}

/** Tasks a card session opens for staff (plan 4.4, sections 6.3, 6.4 and 18 m7). Codes and ids only. */
export type CardSessionTask = 'extra_charge' | 'reference_mismatch' | 'refund_conflict' | 'refund_candidates' | 'declines_spike';

export interface CardSessionStore {
  now(): Date;
  /** The session of (account, key), created open if new. Its expiry is the attempt's pendingExpiresAt + 30 min. */
  createOrGet(init: CardSessionInit): Promise<CardSession>;
  byRef(accountId: string, ref: string): Promise<CardSession | null>;
  byKey(accountId: string, idempotencyKey: string): Promise<CardSession | null>;
  byChargeRef(accountId: string, chargeRef: string): Promise<CardSession | null>;
  /** Compare-and-set on `version`; null when another change came first. Refuses what `sessionTransitionProblem` refuses. */
  update(s: CardSession, change: CardSessionChange): Promise<CardSession | null>;
  /** Appends a charge seen under a session (once per charge); true when it was new. */
  recordCharge(s: CardSession, c: SessionChargeRow): Promise<boolean>;
  intentByKey(accountId: string, idempotencyKey: string): Promise<CardRefundIntent | null>;
  intentByRefundRef(accountId: string, refundRef: string): Promise<CardRefundIntent | null>;
  submittingIntents(accountId: string, chargeRef: string): Promise<CardRefundIntent[]>;
  /** The intent of (account, key), created `new` if there is none. */
  createIntent(init: CardRefundIntentInit): Promise<CardRefundIntent>;
  updateIntent(i: CardRefundIntent, change: CardRefundIntentChange): Promise<CardRefundIntent | null>;
  openTask(kind: CardSessionTask, accountId: string, subject: string): Promise<void>;
}

const FAILED_LATE_SUCCESS: readonly (CardSessionFailure | null)[] = ['outcome_unknown', 'provider_busy'];

/**
 * The transition rules of a session (plan 4.4, sections 6.5, 11 and 18 M2); null when allowed. Forward only, no way back
 * to `open`, `submittedAt` and `chargeRef` set once; `failed → succeeded` only for an unknown outcome without a charge.
 */
export function sessionTransitionProblem(s: CardSession, change: CardSessionChange): string | null {
  const to = change.status ?? s.status;
  if (to !== s.status) {
    const allowed: Record<CardSessionStatus, readonly CardSessionStatus[]> = {
      open: ['submitting', 'cancelled'],
      submitting: ['authenticating', 'succeeded', 'failed'],
      authenticating: ['succeeded', 'failed'],
      failed: FAILED_LATE_SUCCESS.includes(s.failureCode) && s.chargeRef === null ? ['succeeded'] : [],
      succeeded: [],
      cancelled: [],
    };
    if (!allowed[s.status].includes(to)) return `card_session_transition:${s.status}->${to}`;
    if (to === 'submitting' && !change.submittedAt) return 'card_session_submitted_at_required';
  } else if (change.failureCode !== undefined && change.failureCode !== s.failureCode) {
    return 'card_session_failure_code_fixed';
  }
  if (change.submittedAt && s.submittedAt) return 'card_session_submitted_once';
  if (change.chargeRef !== undefined && s.chargeRef !== null && change.chargeRef !== s.chargeRef) return 'card_session_charge_fixed';
  if (to === 'succeeded' && (change.chargeRef ?? s.chargeRef) === null) return 'card_session_success_needs_charge';
  if (change.verifyCalls !== undefined && (change.verifyCalls !== s.verifyCalls + 1 || change.verifyCalls > 3)) return 'card_session_verify_calls';
  return null;
}

/** The rules of a refund intent: `new → submitting → bound | refused`, and back to `new` only when nothing was processed. */
export function intentTransitionProblem(i: CardRefundIntent, change: CardRefundIntentChange): string | null {
  const ok =
    (i.status === 'new' && change.status === 'submitting') ||
    (i.status === 'submitting' && (change.status === 'bound' || change.status === 'refused')) ||
    (i.status === 'submitting' && change.status === 'new' && (change.lastAnswer === 'rate_limited' || change.lastAnswer === 'auth_failed'));
  if (!ok) return `card_refund_intent_transition:${i.status}->${change.status}`;
  if (change.status === 'bound' && !change.refundRef) return 'card_refund_intent_ref_required';
  if (i.refundRef !== null) return 'card_refund_intent_ref_fixed';
  return null;
}

/** 30 minutes after the attempt's own expiry, so the core's expiry query finds the session still open (plan 4.4, 6.2). */
export const SESSION_MARGIN_MS = 30 * 60_000;
/** Without a payment row (contract subjects): the default attempt expiry of 60 minutes plus the margin. */
export const DEFAULT_SESSION_LIFETIME_MS = 60 * 60_000 + SESSION_MARGIN_MS;

/** A store nothing was wired to (a registry built for a static check): every call is "gateway unavailable". */
export function unwiredCardSessionStore(): CardSessionStore {
  const fail = (): never => {
    throw new Error('card_session_store_unwired');
  };
  return {
    now: () => new Date(), createOrGet: fail, byRef: fail, byKey: fail, byChargeRef: fail, update: fail, recordCharge: fail,
    intentByKey: fail, intentByRefundRef: fail, submittingIntents: fail, createIntent: fail, updateIntent: fail, openTask: fail,
  };
}
