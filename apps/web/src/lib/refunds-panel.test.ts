import { describe, expect, it } from 'vitest';
import { canMarkEvidence, canRequest, canResolve, destinationBody, manualStep, refundBody } from './refunds-panel';
import type { DisputeRow, RefundRow } from './refunds-panel';

const refund = (over: Partial<RefundRow> = {}): RefundRow => ({
  id: 'r', paymentId: 'p', origin: 'app', manualRefund: false, amountMinor: '100', currency: 'AUD', status: 'requested', providerRefundRef: null, failureCode: null,
  destinationHint: null, hasDestination: false, version: 0, createdAt: '2026-11-19T00:00:00Z', ...over,
});

describe('refunds panel rules (task 4.5)', () => {
  it('a refund request never carries an amount', () => {
    const body = refundBody({ paymentVersion: 3 }, '  Paid twice  ');
    expect(body).toEqual({ paymentVersion: 3, purpose: 'overpayment_return', reason: 'Paid twice' });
    expect(Object.keys(body).some((k) => /amount/i.test(k))).toBe(false);
  });

  it('offers a refund only when the API says something can go back', () => {
    const row = { paymentId: 'p', paymentVersion: 0, method: 'card', manual: false, currency: 'AUD' };
    expect(canRequest({ ...row, refundableMinor: '2500', blockedReason: null })).toBe(true);
    expect(canRequest({ ...row, refundableMinor: '0', blockedReason: 'nothing_to_refund' })).toBe(false);
    expect(canRequest({ ...row, refundableMinor: '2500', blockedReason: 'payment_disputed' })).toBe(false);
  });

  it('walks a manual refund through its steps, and settles only gateway refunds still waiting', () => {
    expect(manualStep(refund({ manualRefund: true }))).toBe('destination');
    expect(manualStep(refund({ manualRefund: true, hasDestination: true }))).toBe('transfer');
    expect(manualStep(refund({ manualRefund: true, status: 'succeeded' }))).toBeNull();
    expect(manualStep(refund())).toBeNull();
    expect(canResolve(refund())).toBe(true);
    expect(canResolve(refund({ status: 'pending' }))).toBe(true);
    expect(canResolve(refund({ manualRefund: true }))).toBe(false);
    expect(canResolve(refund({ origin: 'external' }))).toBe(false);
    expect(canResolve(refund({ status: 'succeeded' }))).toBe(false);
  });

  it('sends a PayID or a bank account, never both', () => {
    const form = { accountName: ' Ada ', kind: 'bank' as const, payIdType: 'email', payId: 'a@b.co', bsb: ' 062-000 ', accountNumber: '1234 5678' };
    expect(destinationBody(2, form)).toEqual({ version: 2, accountName: 'Ada', payId: null, bank: { bsb: '062-000', accountNumber: '12345678' } });
    expect(destinationBody(2, { ...form, kind: 'payid' })).toEqual({ version: 2, accountName: 'Ada', payId: { type: 'email', value: 'a@b.co' }, bank: null });
  });

  it('marks evidence submitted only on an open dispute', () => {
    const d = { status: 'open' } as DisputeRow;
    expect(canMarkEvidence(d)).toBe(true);
    expect(canMarkEvidence({ ...d, status: 'lost' })).toBe(false);
  });
});
