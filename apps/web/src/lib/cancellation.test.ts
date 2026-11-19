import { describe, expect, it } from 'vitest';
import { percentText, policyRef, tierLine, tierLines } from './cancellation';
import { refundAmount, refundBody, refundPurpose } from './refunds-panel';
import { t } from './i18n';

// Task 6.4: the web shows the API's policy and amounts; it never computes a penalty or a refund.
const pct = (minDaysBeforeDeparture: number, penaltyBps: number) => ({ minDaysBeforeDeparture, penaltyMode: 'percent' as const, penaltyBps, penaltyMinor: null, currency: null });
const policy = {
  id: '00000000-0000-4000-8000-000000000001', digest: 'a'.repeat(64), description: { 'en-AU': 'Our policy' },
  tiers: [pct(60, 1000), { minDaysBeforeDeparture: 14, penaltyMode: 'fixed_per_person' as const, penaltyBps: null, penaltyMinor: '50000', currency: 'AUD' }, pct(0, 10_000)],
};

describe('cancellation_policy_display', () => {
  it('percentages are cut from their text', () => {
    expect([percentText(1000), percentText(1250), percentText(5), percentText(0), percentText(10_000)]).toEqual(['10%', '12.5%', '0.05%', '0%', '100%']);
  });

  it('every tier has wording, from the highest threshold down; the 0 tier reads "less than" the one above', () => {
    const lines = tierLines(policy).map((l) => t(l.key, l.params));
    expect(lines[0]).toMatch(/60 days or more.*10% of the total/);
    expect(lines[1]).toMatch(/14 days or more.*\$500\.00 per traveller/);
    expect(lines[2]).toMatch(/Less than 14 days.*100% of the total/);
    expect(t(tierLine(pct(0, 2000), null).key, tierLine(pct(0, 2000), null).params)).toMatch(/At any time: 20% of the total/);
  });

  it('what goes back to the API is the policy seen, or null when none was shown', () => {
    expect(policyRef(policy)).toEqual({ id: policy.id, digest: policy.digest });
    expect([policyRef(null), policyRef(undefined)]).toEqual([null, null]);
  });
});

describe('cancellation_refund_purpose_from_api', () => {
  const row = { paymentId: 'p', paymentVersion: 3, method: 'card', manual: false, refundableMinor: '9000', currency: 'AUD', blockedReason: null };
  it('a cancellation refund when the API says the cancellation allows one, with its amount; otherwise an overpayment return', () => {
    expect([refundPurpose({ ...row, cancellationRefundableMinor: '7000' }), refundAmount({ ...row, cancellationRefundableMinor: '7000' })]).toEqual(['cancellation', '7000']);
    expect([refundPurpose({ ...row, cancellationRefundableMinor: '0' }), refundAmount({ ...row, cancellationRefundableMinor: '0' })]).toEqual(['overpayment_return', '9000']);
    expect(refundPurpose({ ...row, cancellationRefundableMinor: null })).toBe('overpayment_return');
    expect(refundBody({ ...row, cancellationRefundableMinor: '7000' }, ' Cancelled trip ')).toEqual({ paymentVersion: 3, purpose: 'cancellation', reason: 'Cancelled trip' });
  });
});
