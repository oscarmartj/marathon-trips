// Task 6.4: the cancellation penalty, pure and table-driven (plan docs/plans/6.4-cancellation-policies.md, sections 3,
// 4 and 10): the exact day of every tier, occupancy and places, rounding, caps, what was held, basis by state, validation.
import { describe, expect, it } from 'vitest';
import { applyBps, basisFor, quoteCancellation, tierFor, tierPenalty, validatePolicy } from '../../../../src/modules/pricing/engine';
import type { CancellationPolicyInput, CancellationTierInput } from '../../../../src/modules/pricing/engine';
import { calendarDateIn, daysBetween } from '../../../../src/modules/pricing/engine/calendar';

const tier = (id: string, minDaysBeforeDeparture: number, t: Partial<CancellationTierInput>): CancellationTierInput => ({
  id, minDaysBeforeDeparture, penaltyMode: 'percent', penaltyBps: null, penaltyMinor: null, currency: null, ...t,
});
/** The plan's four tiers: 60 d 10 %, 30 d 50 %, 14 d A$500 per person, 0 d 100 %. */
const FOUR: CancellationPolicyInput = {
  id: 'p', currency: 'AUD',
  tiers: [
    tier('t60', 60, { penaltyBps: 1000 }), tier('t30', 30, { penaltyBps: 5000 }),
    tier('t14', 14, { penaltyMode: 'fixed_per_person', penaltyMinor: 50_000n, currency: 'AUD' }), tier('t0', 0, { penaltyBps: 10_000 }),
  ],
};
const DEPARTURE = '2027-06-18';
const on = (days: number) => {
  const d = new Date(Date.parse(`${DEPARTURE}T00:00:00Z`) - days * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const quote = (over: Partial<Parameters<typeof quoteCancellation>[0]> = {}) => quoteCancellation({
  policy: FOUR, status: 'confirmed', operatorCancelled: false, departureDate: DEPARTURE, effectiveDate: on(45), baseTotalMinor: 400_000n, places: 2, currency: 'AUD', heldMinor: 400_000n, ...over,
});

describe('cancellation_tier_boundaries: the penalty on the exact day of every tier', () => {
  // [days before departure, tier, expected for a A$4,000 total and 2 places]
  const ROWS: Array<[number, string, bigint]> = [
    [400, 't60', 40_000n], [60, 't60', 40_000n], [59, 't30', 200_000n], [30, 't30', 200_000n], [29, 't14', 100_000n],
    [14, 't14', 100_000n], [13, 't0', 400_000n], [1, 't0', 400_000n], [0, 't0', 400_000n], [-1, 't0', 400_000n], [-30, 't0', 400_000n],
  ];
  it.each(ROWS)('%i days → %s', (days, id, penalty) => {
    const q = quote({ effectiveDate: on(days) });
    expect([q.daysBeforeDeparture, q.tier?.id, q.policyPenaltyMinor, q.penaltyMinor, q.refundableMinor]).toEqual([days, id, penalty, penalty, 400_000n - penalty]);
  });

  it('cancellation_after_departure_uses_final_tier: days below 0 take the 0 tier', () => {
    for (const d of [-1, -2, -365]) expect(tierFor(FOUR.tiers, d).id).toBe('t0');
  });

  it('the tiers are read from the highest threshold down, whatever their order', () => {
    const shuffled = [FOUR.tiers[2]!, FOUR.tiers[0]!, FOUR.tiers[3]!, FOUR.tiers[1]!];
    for (const [days, id] of [[60, 't60'], [59, 't30'], [14, 't14'], [13, 't0']] as const) expect(tierFor(shuffled, days).id).toBe(id);
  });
});

describe('occupancy 1 to 4, rooms, extra nights, supporters and promo codes change the base, never the rule', () => {
  // Totals as the engine would give them (extra nights and supporters raise it, a code lowers it); places count every traveller.
  const CASES: Array<{ name: string; total: bigint; places: number }> = [
    { name: 'occupancy 1', total: 180_000n, places: 1 }, { name: 'occupancy 2', total: 300_000n, places: 2 }, { name: 'occupancy 3', total: 405_000n, places: 3 },
    { name: 'occupancy 4', total: 520_000n, places: 4 }, { name: 'two rooms of 4', total: 1_040_000n, places: 8 }, { name: 'extra nights', total: 345_000n, places: 2 },
    { name: 'a supporter', total: 260_000n, places: 2 }, { name: 'a promo code', total: 279_999n, places: 2 },
  ];
  it.each(CASES)('$name', ({ total, places }) => {
    expect(quote({ effectiveDate: on(60), baseTotalMinor: total, places, heldMinor: total }).policyPenaltyMinor).toBe(applyBps(total, 1000));
    expect(quote({ effectiveDate: on(30), baseTotalMinor: total, places, heldMinor: total }).policyPenaltyMinor).toBe(applyBps(total, 5000));
    const perPerson = 50_000n * BigInt(places);
    expect(quote({ effectiveDate: on(14), baseTotalMinor: total, places, heldMinor: total }).policyPenaltyMinor).toBe(perPerson < total ? perPerson : total);
    expect(quote({ effectiveDate: on(0), baseTotalMinor: total, places, heldMinor: total }).policyPenaltyMinor).toBe(total);
  });

  it('fixed_per_booking does not grow with places', () => {
    const p: CancellationPolicyInput = { id: 'b', currency: 'AUD', tiers: [tier('x', 0, { penaltyMode: 'fixed_per_booking', penaltyMinor: 25_000n, currency: 'AUD' })] };
    for (const places of [1, 2, 3, 4, 8]) expect(quote({ policy: p, places }).policyPenaltyMinor).toBe(25_000n);
  });
});

describe('penalty_rounding_half_up: THE rounding rule, through applyBps', () => {
  it.each([
    [1n, 5000, 1n], [3n, 5000, 2n], [5n, 1000, 1n], [4n, 1000, 0n], [123_457n, 3333, 41_148n], [999_999n, 1, 100n], [400_001n, 10_000, 400_001n], [15n, 3333, 5n],
  ] as const)('%s × %i bps = %s', (total, bps, expected) => {
    const p: CancellationPolicyInput = { id: 'r', currency: null, tiers: [tier('x', 0, { penaltyBps: bps })] };
    expect(quote({ policy: p, baseTotalMinor: total, heldMinor: total }).policyPenaltyMinor).toBe(expected);
  });
});

describe('penalty_capped_at_total and penalty_above_collected_is_not_charged', () => {
  it('a fixed penalty above the total is the total', () => {
    expect(tierPenalty(FOUR.tiers[2]!, 60_000n, 2, 'AUD')).toBe(60_000n);
    expect(tierPenalty(tier('x', 0, { penaltyMode: 'fixed_per_booking', penaltyMinor: 1_000_000n, currency: 'AUD' }), 0n, 0, 'AUD')).toBe(0n);
  });

  it.each([
    // [held, policy penalty 200 000 at 30 days] → [kept, waived, refundable]
    [400_000n, 200_000n, 0n, 200_000n], [200_000n, 200_000n, 0n, 0n], [120_000n, 120_000n, 80_000n, 0n], [0n, 0n, 200_000n, 0n], [-5_000n, 0n, 200_000n, 0n],
  ])('held %s → kept %s, waived %s, refundable %s', (held, kept, waived, refundable) => {
    const q = quote({ effectiveDate: on(30), heldMinor: held });
    expect([q.policyPenaltyMinor, q.penaltyMinor, q.waivedMinor, q.refundableMinor]).toEqual([200_000n, kept, waived, refundable]);
  });
});

describe('basis_by_state: who decides the penalty', () => {
  it.each([
    ['requested', true, false, 'not_contracted'], ['approved', true, false, 'not_contracted'], ['deposit_paid', true, false, 'policy'], ['confirmed', true, false, 'policy'],
    ['balance_paid', true, false, 'policy'], ['confirmed', false, false, 'no_policy'], ['approved', true, true, 'operator_cancelled'], ['balance_paid', true, true, 'operator_cancelled'],
  ] as const)('%s, policy %s, operator %s → %s', (status, hasPolicy, operator, basis) => {
    expect(basisFor(status, hasPolicy, operator)).toBe(basis);
  });

  it('not_contracted, no_policy and operator_cancelled keep nothing: everything held is refundable', () => {
    for (const q of [quote({ status: 'approved' }), quote({ policy: null }), quote({ operatorCancelled: true, effectiveDate: on(0) })]) {
      expect([q.policyPenaltyMinor, q.penaltyMinor, q.refundableMinor, q.tier]).toEqual([0n, 0n, 400_000n, null]);
    }
  });

  it('completed, declined, expired, cancelled and refunded cannot be cancelled', () => {
    for (const s of ['completed', 'declined', 'expired', 'cancelled', 'refunded']) expect(() => basisFor(s, true, false)).toThrow(/cannot be cancelled/);
  });
});

describe('fixed_tier_other_currency_fails_closed', () => {
  it('a fixed tier in another currency than the booking is an error, never a guess', () => {
    const p: CancellationPolicyInput = { id: 'n', currency: 'NZD', tiers: [tier('x', 0, { penaltyMode: 'fixed_per_booking', penaltyMinor: 100n, currency: 'NZD' })] };
    expect(() => quote({ policy: p })).toThrow(expect.objectContaining({ code: 'cancellation_currency_mismatch' }));
  });
});

describe('days_before_departure_flips_at_brisbane_midnight', () => {
  it('the business date changes at 14:00 UTC (Brisbane is UTC+10, no daylight saving)', () => {
    const before = calendarDateIn(new Date('2027-05-18T13:59:59.999Z'));
    const after = calendarDateIn(new Date('2027-05-18T14:00:00.000Z'));
    expect([before, after]).toEqual(['2027-05-18', '2027-05-19']);
    expect([daysBetween(before, DEPARTURE), daysBetween(after, DEPARTURE)]).toEqual([31, 30]);
    expect([quote({ effectiveDate: before }).tier?.id, quote({ effectiveDate: after }).tier?.id]).toEqual(['t30', 't30']);
    expect([quote({ effectiveDate: calendarDateIn(new Date('2027-05-19T13:59:59.999Z')) }).tier?.id, quote({ effectiveDate: calendarDateIn(new Date('2027-05-19T14:00:00Z')) }).tier?.id]).toEqual(['t30', 't14']);
  });
});

describe('policy_validation', () => {
  const ok = FOUR.tiers.map(({ id: _id, ...t }) => t);
  it('a valid policy has no problems and one currency', () => expect(validatePolicy(ok)).toEqual({ problems: [], currency: 'AUD' }));
  it.each([
    ['no tiers', [], 'no_tiers'],
    ['no 0 tier', ok.filter((t) => t.minDaysBeforeDeparture !== 0), 'no_zero_tier'],
    ['duplicate days', [...ok, ok[0]!], 'duplicate_days'],
    ['negative days', [...ok, { ...ok[0]!, minDaysBeforeDeparture: -1 }], 'days_out_of_range'],
    ['bps above 100 %', [{ ...ok[3]!, penaltyBps: 10_001 }], 'percent_out_of_range'],
    ['fixed without currency', [{ ...ok[3]!, penaltyMode: 'fixed_per_booking' as const, penaltyBps: null, penaltyMinor: 1n, currency: null }], 'fixed_without_currency'],
    ['mixed currencies', [ok[2]!, { ...ok[2]!, minDaysBeforeDeparture: 0, currency: 'NZD' }], 'mixed_currencies'],
    ['eleven tiers', Array.from({ length: 11 }, (_, i) => ({ ...ok[3]!, minDaysBeforeDeparture: i })), 'too_many_tiers'],
  ] as const)('%s', (_name, tiers, code) => {
    expect(validatePolicy(tiers as never).problems.map((p) => p.code)).toContain(code);
  });
});
