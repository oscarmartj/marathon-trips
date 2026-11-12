// Table-driven tests of what task 2.2 fixes in the engine (plan docs/plans/2.2-pricing-rules-promo-codes.md, sections 2
// and 15): overlapping targets and "not stackable", filters that match nobody, rules on every occupancy, extra nights and
// supporters, and where a configuration error comes from. Amounts written out by hand from the rate card in fixture.ts.
import { describe, expect, it } from 'vitest';
import { MAX_FIXED_PER_PERSON_MINOR } from '@mt/shared';
import { ENGINE_VERSION, PricingError, price, targetsOverlap } from '../../../../src/modules/pricing/engine';
import type { EngineRequest, PromoInput, RatesView, RuleInput, Target } from '../../../../src/modules/pricing/engine';
import { DOUBLE_2M, M, NOW, RATES, S, VIEW, fixed, promo, req, rule } from './fixture';

const run = (r: EngineRequest, rules: RuleInput[] = [], p: PromoInput | null = null, rates: RatesView = RATES) => price(r, VIEW, rates, rules, p, NOW);
const failure = (f: () => unknown): { code: string; origin: unknown } => {
  try {
    f();
  } catch (e) {
    if (e instanceof PricingError) return { code: e.code, origin: e.details.origin };
    throw e;
  }
  return { code: 'no error', origin: undefined };
};

describe('engine version', () => {
  it('is bumped for the stacking semantics of 2.2', () => expect(ENGINE_VERSION).toBe('pricing-2.2.0'));
});

describe('targetsOverlap', () => {
  it.each<[Target, Target, boolean]>([
    ['accommodation', 'accommodation', true],
    ['accommodation', 'participation', false],
    ['extras', 'participation', false],
    ['subtotal', 'extras', true],
    ['accommodation', 'subtotal', true],
    ['subtotal', 'subtotal', true],
  ])('%s and %s → %s', (a, b, expected) => expect(targetsOverlap(a, b)).toBe(expected));
});

describe('rule_combinations with overlapping targets (base: two marathon runners in a double, 165 000)', () => {
  const sub = (over: Partial<RuleInput>) => rule({ appliesTo: 'subtotal', ...over });
  const acc = (over: Partial<RuleInput>) => rule({ appliesTo: 'accommodation', ...over });
  it.each<[string, RuleInput[], bigint]>([
    ['non-stackable 10 % on the subtotal first blocks non-stackable 10 % on rooms: 165 000 − 16 500', [sub({ priority: 1, stackable: false }), acc({ priority: 2, stackable: false })], 148_500n],
    ['non-stackable 10 % on rooms first blocks non-stackable 10 % on the subtotal: 165 000 − 10 000', [acc({ priority: 1, stackable: false }), sub({ priority: 2, stackable: false })], 155_000n],
    ['non-stackable on rooms blocks a stackable one on the subtotal (2.1 applied both: 138 500)', [acc({ priority: 1, stackable: false }), sub({ priority: 2, stackable: true })], 155_000n],
    ['stackable on the subtotal first blocks a non-stackable one on rooms', [sub({ priority: 1, stackable: true }), acc({ priority: 2, stackable: false })], 148_500n],
    ['stackable on the subtotal and on rooms add up: 16 500 + 10 000', [sub({ priority: 1, stackable: true }), acc({ priority: 2, stackable: true })], 138_500n],
    ['non-stackable on rooms and on participation do not overlap: 10 000 + 6 000', [acc({ stackable: false }), rule({ appliesTo: 'participation', stackable: false })], 149_000n],
    ['non-stackable on extras and on rooms do not overlap: 500 + 10 000', [rule({ appliesTo: 'extras', stackable: false }), acc({ stackable: false })], 154_500n],
    ['a non-stackable surcharge on the subtotal blocks a surcharge on rooms: + 16 500 only', [sub({ direction: 'surcharge', priority: 1, stackable: false }), acc({ direction: 'surcharge', priority: 2, stackable: true })], 181_500n],
    ['a non-stackable surcharge on the subtotal does not block a discount on rooms: + 16 500 − 10 000', [sub({ direction: 'surcharge', stackable: false }), acc({ stackable: false })], 171_500n],
  ])('%s', (_n, rules, total) => expect(run(DOUBLE_2M, rules).totalMinor).toBe(total));

  it('the trace names the blocked rule', () => {
    const a = acc({ priority: 1, stackable: false });
    const b = sub({ priority: 2, stackable: true });
    expect(run(DOUBLE_2M, [a, b]).trace).toEqual(expect.arrayContaining([{ ruleId: a.id, outcome: 'applied' }, { ruleId: b.id, outcome: 'blocked_by_non_stackable' }]));
  });
});

describe('fixed per-booking rules with a traveller filter (plan 2.2, section 2 (c))', () => {
  const single = (over: Partial<RuleInput>) => rule({ appliesTo: 'accommodation', conditions: { occupancies: [1] }, ...over });
  it.each<[string, EngineRequest, RuleInput, bigint, string, bigint | null]>([
    ['discount 20 000 per booking, nobody in a single: not applied', DOUBLE_2M, single(fixed(20_000n)), 165_000n, 'filter_matches_nobody', null],
    ['surcharge 20 000 per booking, nobody in a single: not applied', DOUBLE_2M, single({ direction: 'surcharge', ...fixed(20_000n) }), 165_000n, 'filter_matches_nobody', null],
    ['discount 20 000 per booking, one of three in a single: once, not per traveller', req([['single', [M]], ['double', [M, M]]]), single(fixed(20_000n)), 285_000n - 20_000n, 'applied', null],
    ['discount 100 000 per booking, one in a single: capped at that traveller’s 90 000', req([['single', [M]], ['double', [M, M]]]), single(fixed(100_000n)), 285_000n - 90_000n, 'applied', 100_000n],
    ['surcharge 20 000 per booking, one of three in a single: once', req([['single', [M]], ['double', [M, M]]]), single({ direction: 'surcharge', ...fixed(20_000n) }), 285_000n + 20_000n, 'applied', null],
  ])('%s', (_n, r, x, total, outcome, cappedFrom) => {
    const b = run(r, [x]);
    expect(b.totalMinor).toBe(total);
    expect(b.trace).toEqual([{ ruleId: x.id, outcome }]);
    const line = b.lines.find((l) => l.refId === x.id);
    if (outcome === 'applied') expect([line!.quantity, line!.cappedFromMinor]).toEqual([1, cappedFrom]);
    else expect(line).toBeUndefined();
  });
});

describe('promo_codes with overlapping targets (base 165 000)', () => {
  it.each<[string, RuleInput[], PromoInput, bigint, string]>([
    ['not stackable on rooms, a stackable rule on the subtotal: not combinable', [rule({ appliesTo: 'subtotal', stackable: true })], promo({ appliesTo: 'accommodation', stackable: false }), 148_500n, 'not_combinable'],
    ['not stackable on the subtotal, a stackable rule on extras (500): not combinable (2.1 applied it)', [rule({ appliesTo: 'extras', stackable: true })], promo({ appliesTo: 'subtotal', stackable: false }), 164_500n, 'not_combinable'],
    ['stackable on rooms, a non-stackable rule on the subtotal: not combinable (2.1 applied it)', [rule({ appliesTo: 'subtotal', stackable: false })], promo({ appliesTo: 'accommodation', stackable: true }), 148_500n, 'not_combinable'],
    ['stackable on rooms, a stackable rule on the subtotal: 16 500, then 10 % of the rooms’ 100 000', [rule({ appliesTo: 'subtotal', stackable: true })], promo({ appliesTo: 'accommodation', stackable: true }), 138_500n, 'applied'],
    ['not stackable on participation, a non-stackable rule on rooms: no overlap, 10 000 + 6 000', [rule({ appliesTo: 'accommodation', stackable: false })], promo({ appliesTo: 'participation', stackable: false }), 149_000n, 'applied'],
    ['a surcharge rule never blocks a code', [rule({ appliesTo: 'subtotal', direction: 'surcharge', stackable: false })], promo({ appliesTo: 'subtotal', stackable: false }), 181_500n - 18_150n, 'applied'],
    ['a code whose traveller filter matches nobody', [], promo({ conditions: { occupancies: [1] } }), 165_000n, 'conditions_not_met'],
  ])('%s', (_n, rules, p, total, status) => {
    const b = run(DOUBLE_2M, rules, p);
    expect([b.totalMinor, b.promo.status]).toEqual([total, status]);
  });
});

// Early bird (10 % on rooms, booked by 31 January; "now" is 10 January), single supplement (10 000 per person in a room
// for one, a surcharge) and group discount (5 % of the subtotal from 3 travellers), first all stackable, then none.
const ruleSet = (stackable: boolean): RuleInput[] => [
  rule({ id: 'eb', kind: 'early_bird', appliesTo: 'accommodation', priority: 1, stackable, conditions: { bookedOnOrBefore: '2027-01-31' } }),
  rule({ id: 'gd', kind: 'group_discount', appliesTo: 'subtotal', priority: 2, stackable, valueBps: 500, conditions: { minTravellers: 3 } }),
  rule({ id: 'ss', kind: 'occupancy_supplement', direction: 'surcharge', appliesTo: 'accommodation', priority: 1, stackable, conditions: { occupancies: [1] }, ...fixed(10_000n, { per: 'person' }) }),
  rule({ id: 'sd', kind: 'custom', appliesTo: 'participation', priority: 3, stackable, valueBps: 5000, conditions: { participationTypes: ['supporter'] } }),
];

describe('occupancy_1_to_4, extra_nights and supporters with rules (stackable / not stackable)', () => {
  it.each<[string, EngineRequest, bigint, bigint]>([
    ['single, 1 runner: 125 000 + supplement 10 000 − early bird 9 000', req([['single', [M]]]), 126_000n, 126_000n],
    ['double at 1: 115 000 + 10 000 − 8 000', req([['double', [M]]]), 117_000n, 117_000n],
    ['double at 2: 165 000 − 10 000', DOUBLE_2M, 155_000n, 155_000n],
    ['triple at 3: 215 000 − 12 000 − group 10 750 (not stackable: the group discount overlaps the early bird)', req([['triple', [M, M, M]]]), 192_250n, 203_000n],
    ['quad at 4: 265 000 − 14 000 − group 13 250 (not stackable: early bird only)', req([['quad', [M, M, M, M]]]), 237_750n, 251_000n],
    ['single, 1 extra night before: 155 000 + 10 000 − 12 000', req([['single', [M]]], { extraNightsBefore: 1 }), 153_000n, 153_000n],
    ['single, 2 before and 3 after: 275 000 + 10 000 − 24 000', req([['single', [M]]], { extraNightsBefore: 2, extraNightsAfter: 3 }), 261_000n, 261_000n],
    ['double at 2, 1 after: 195 000 − 13 000', req([['double', [M, M]]], { extraNightsAfter: 1 }), 182_000n, 182_000n],
    ['runner and supporter in a double: 137 500 − 10 000 − half the supporter’s 2 500', req([['double', [M, S]]]), 126_250n, 126_250n],
    ['two supporters in a double: 110 000 − 10 000 − 2 500', req([['double', [S, S]]]), 97_500n, 97_500n],
    ['runner and two supporters in a quad at 3: 166 000 − 12 600 − 8 300 − 2 500 (not stackable: no group discount)', req([['quad', [M, S, S]]]), 142_600n, 150_900n],
  ])('%s', (_n, r, stackableTotal, exclusiveTotal) => {
    expect(run(r, ruleSet(true)).totalMinor).toBe(stackableTotal);
    expect(run(r, ruleSet(false)).totalMinor).toBe(exclusiveTotal);
  });
});

describe('configuration errors say where they come from (plan 2.2, section 15, points 1 and 10)', () => {
  it.each<[string, () => unknown, string, string]>([
    ['a stored rule with a percentage per person', () => run(DOUBLE_2M, [rule({ per: 'person' })]), 'rule_invalid', 'rule'],
    ['a stored rule in another currency', () => run(DOUBLE_2M, [rule(fixed(5_000n, { currency: 'NZD' }))]), 'currency_mismatch', 'rule'],
    ['a code with empty occupancies', () => run(DOUBLE_2M, [], promo({ conditions: { occupancies: [] } })), 'rule_invalid', 'promo'],
    ['a code of the package in another currency', () => run(DOUBLE_2M, [], promo(fixed(5_000n, { currency: 'NZD' }) as Partial<PromoInput>)), 'currency_mismatch', 'promo'],
    ['a fixed amount per person above the per-person limit', () => run(DOUBLE_2M, [rule(fixed(MAX_FIXED_PER_PERSON_MINOR + 1n, { per: 'person' }))]), 'rule_invalid', 'rule'],
  ])('%s → %s from %s', (_n, f, code, origin) => expect(failure(f)).toEqual({ code, origin }));

  it('the most a fixed amount per person can be, times the most travellers, stays within the line limit', () => {
    expect(failure(() => run(DOUBLE_2M, [rule(fixed(MAX_FIXED_PER_PERSON_MINOR, { per: 'person' }))])).code).toBe('no error');
  });

  it('adjustment_above_limit: a 1 000 % surcharge on 80 000 000 of rooms is a configuration error of the rule, not amount_above_limit', () => {
    const dear: RatesView = { ...RATES, roomRates: RATES.roomRates.map((x) => (x.roomOptionId === 'double' && x.occupancy === 2 ? { ...x, pricePerPersonMinor: 40_000_000n } : x)) };
    const surcharge = rule({ direction: 'surcharge', valueBps: 100_000 });
    expect(failure(() => run(DOUBLE_2M, [surcharge], null, dear))).toEqual({ code: 'adjustment_above_limit', origin: 'rule' });
  });
});
