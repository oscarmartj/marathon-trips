// eWAY Rapid answers, read into our types (plan docs/plans/9.1-eway.md, sections 2, 3 and 20). Every shape here is
// UNVERIFIED: written from the Rapid v3 reference as a summarising fetch tool returned it, and proven only against the
// fake of test/contract/subjects/eway-fake.ts until `test:sandbox` runs. Only codes are read, never eWAY's free text.
import type { CardDeclineCode, GatewayCharge, GatewayRefund } from '../../core/provider';

/** Our names for eWAY's objects (plan 9.1, section 4.3): a charge and a refund are both eWAY transactions. */
export const CHARGE_REF = /^ewt_[0-9]{1,19}$/;
export const REFUND_REF = /^ewr_[0-9]{1,19}$/;
export const TRANSACTION_ID = /^[0-9]{1,19}$/;
/** Our references at eWAY (InvoiceReference, at most 50 characters): a card session's, or a refund intent's. */
export const SESSION_INVOICE_REF = /^cs_[0-9a-f]{32}$/;
export const INTENT_INVOICE_REF = /^mtr_[0-9a-f]{32}$/;
export const ACCESS_CODE = /^[A-Za-z0-9_-]{10,512}$/;
export const SECURE_FIELD_CODE = /^[A-Za-z0-9_-]{10,512}$/;

/** Codes of a search that cannot be answered for sure (A4, UNVERIFIED): not unique, and not found. */
export const NOT_UNIQUE_ERRORS = ['V6170'];
export const NOT_FOUND_ERRORS = ['V6171'];
/** S5666 "Transaction in unknown state" (A12): never a decline. */
export const UNKNOWN_STATE = 'S5666';
/** D4494 "Duplicate Transaction" (plan 9.1, 20 M4): never read as "no money". */
export const DUPLICATE = 'D4494';

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** eWAY's comma-separated code lists (`ResponseMessage`, `Errors`), as a list of well-formed codes. */
export function codesOf(v: unknown): string[] {
  if (typeof v !== 'string' || v.length > 512) return [];
  return v.split(',').map((c) => c.trim()).filter((c) => /^[A-Z][0-9A-Z]{3,6}$/.test(c));
}

/** An integer amount in the lowest denomination; anything else is unreadable. */
export function minorOf(v: unknown): bigint | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]{1,10}$/.test(v)) return BigInt(v);
  return undefined;
}

export function idOf(v: unknown): string | undefined {
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === 'string' ? v : undefined;
  return s && TRANSACTION_ID.test(s) ? s : undefined;
}

/**
 * Why a card was not charged, from eWAY's codes (plan 9.1, section 5.3). Only a known decline or fraud code is a
 * decline; anything else is unreadable (the caller treats it as unknown, never as "no money").
 */
export function declineOf(codes: readonly string[]): CardDeclineCode | undefined {
  for (const c of codes) {
    if (c === 'D4451') return 'insufficient_funds';
    if (c === 'D4454' || c === 'D4433') return 'expired_card';
    if (c === 'D4459' || c === 'D4441' || c === 'D4443' || c.startsWith('F')) return 'suspected_fraud';
  }
  for (const c of codes) if (/^D4[0-9]{3}$/.test(c) && c !== DUPLICATE) return 'card_declined';
  return undefined;
}

/** The amount of a transaction: `TotalAmount` at the top (query) or under `Payment` (Direct Connection answer). */
export function amountOf(t: Record<string, unknown>): bigint | undefined {
  return minorOf(t.TotalAmount) ?? (isObj(t.Payment) ? minorOf(t.Payment.TotalAmount) : undefined);
}

export function invoiceRefOf(t: Record<string, unknown>): string | undefined {
  const v = typeof t.InvoiceReference === 'string' ? t.InvoiceReference : isObj(t.Payment) && typeof t.Payment.InvoiceReference === 'string' ? t.Payment.InvoiceReference : undefined;
  return v && v.length <= 64 ? v : undefined;
}

/**
 * A transaction as a charge (plan 9.1, 6.4 and 20 M3): `TransactionStatus: true` means charged whatever the approval
 * code; `false` with a known decline is failed; anything else is null (unreadable: unknown).
 */
export function chargeOf(t: unknown): GatewayCharge | null {
  if (!isObj(t)) return null;
  const id = idOf(t.TransactionID);
  const amount = amountOf(t);
  if (!id || amount === undefined) return null;
  const ref = invoiceRefOf(t);
  const sessionRef = ref && SESSION_INVOICE_REF.test(ref) ? ref : undefined;
  const base = { token: `ewt_${id}`, amount: { amountMinor: amount, currency: 'AUD' }, ...(sessionRef ? { sessionRef } : {}) };
  if (t.TransactionStatus === true) return { ...base, success: true, captured: true, pending: false, failed: false };
  if (t.TransactionStatus !== false) return null;
  const codes = codesOf(t.ResponseMessage);
  if (codes.includes(UNKNOWN_STATE)) return null;
  const decline = declineOf(codes);
  if (!decline) return null;
  return { ...base, success: false, captured: false, pending: false, failed: true, failureCode: decline };
}

/** A transaction as a refund: it must name the transaction it refunds (OriginalTransactionId). */
export function refundOf(t: unknown, chargeHint?: string): GatewayRefund | null {
  if (!isObj(t)) return null;
  const id = idOf(t.TransactionID);
  const original = idOf(t.OriginalTransactionId);
  const amount = minorOf(t.TotalAmount) ?? (isObj(t.Refund) ? minorOf(t.Refund.TotalAmount) : undefined);
  const charge = original ? `ewt_${original}` : chargeHint;
  if (!id || amount === undefined || !charge || typeof t.TransactionStatus !== 'boolean') return null;
  // A6 (UNVERIFIED): eWAY has no pending refunds; true is done.
  return { token: `ewr_${id}`, status: t.TransactionStatus ? 'succeeded' : 'failed', amount: { amountMinor: amount, currency: 'AUD' }, chargeToken: charge, createdAt: new Date() };
}
