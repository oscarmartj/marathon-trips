// Rules of the refunds and disputes section of a booking (task 4.5). The amount of a refund is never typed or computed
// here: the API says what each payment can give back, and the panel only shows it.

export interface RefundableRow {
  paymentId: string;
  paymentVersion: number;
  method: string;
  manual: boolean;
  refundableMinor: string;
  currency: string;
  blockedReason: string | null;
}

export interface RefundRow {
  id: string;
  paymentId: string;
  origin: string;
  manualRefund: boolean;
  amountMinor: string;
  currency: string;
  status: string;
  providerRefundRef: string | null;
  failureCode: string | null;
  destinationHint: string | null;
  hasDestination: boolean;
  version: number;
  createdAt: string;
}

export interface DisputeRow {
  id: string;
  paymentId: string;
  providerDisputeRef: string;
  amountMinor: string;
  currency: string;
  reasonCode: string;
  status: string;
  evidenceDueBy: string | null;
  fundsWithdrawnAt: string | null;
  fundsReinstatedAt: string | null;
  version: number;
}

/** The body of a refund request: never an amount. */
export function refundBody(row: Pick<RefundableRow, 'paymentVersion'>, reason: string): { paymentVersion: number; purpose: 'overpayment_return'; reason: string } {
  return { paymentVersion: row.paymentVersion, purpose: 'overpayment_return', reason: reason.trim() };
}

export const canRequest = (row: RefundableRow): boolean => row.blockedReason === null && /^[1-9]\d*$/.test(row.refundableMinor);

/** A manual refund waiting for Oscar: where it goes first, then the transfer and its reference. */
export function manualStep(r: RefundRow): 'destination' | 'transfer' | null {
  if (!r.manualRefund || r.status !== 'requested') return null;
  return r.hasDestination ? 'transfer' : 'destination';
}

/**
 * A gateway refund the gateway has not settled: staff can ask the app to settle it. That includes one of ours marked
 * as not made that the gateway was still processing (late_pending_at_gateway): resolving is its way out.
 */
export const canResolve = (r: RefundRow): boolean => r.origin === 'app' && !r.manualRefund
  && (r.status === 'requested' || r.status === 'pending' || (r.status === 'failed' && r.failureCode === 'late_pending_at_gateway'));

/** Ours, marked as not made, still being processed by the gateway: shown with its own explanation. */
export const isLatePending = (r: RefundRow): boolean => r.status === 'failed' && r.failureCode === 'late_pending_at_gateway';

/** The destination body: a PayID or a bank account, never both; spaces trimmed. */
export function destinationBody(version: number, form: { accountName: string; kind: 'payid' | 'bank'; payIdType: string; payId: string; bsb: string; accountNumber: string }) {
  return {
    version, accountName: form.accountName.trim(),
    payId: form.kind === 'payid' ? { type: form.payIdType, value: form.payId.trim() } : null,
    bank: form.kind === 'bank' ? { bsb: form.bsb.trim(), accountNumber: form.accountNumber.replace(/\s+/g, '') } : null,
  };
}

export const canMarkEvidence = (d: DisputeRow): boolean => d.status === 'open';

/** A fresh Idempotency-Key for one click (a retry of the same click reuses it). */
export const newIdempotencyKey = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-key`);
