// Table-driven tests of the pricing engine (plan 2.1, section 7; .claude/rules/pricing.md). Every expected amount is
// written out by hand from the rate card in fixture.ts, so each row can be checked like a tariff.
import { describe, expect, it } from 'vitest';
import { PricingError, price } from '../../../../src/modules/pricing/engine';
import type { CatalogueView, EngineRequest, PriceBreakdown, PromoInput, RatesView, RuleInput } from '../../../../src/modules/pricing/engine';
import { DOUBLE_2M, H, M, NOW, O, RATES, S, VIEW, fixed, promo, req, rule } from './fixture';

const run = (r: EngineRequest, o: { view?: CatalogueView; rates?: RatesView; rules?: RuleInput[]; promo?: PromoInput | null; now?: Date } = {}): PriceBreakdown =>
  price(r, o.view ?? VIEW, o.rates ?? RATES, o.rules ?? [], o.promo ?? null, o.now ?? NOW);
const errorOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof PricingError) return e.code;
    throw e;
  }
  return 'no error';
};

describe('occupancy_1_to_4', () => {
  it.each<[string, EngineRequest, bigint]>([
    ['single, 1 marathon runner: 90 000 + 30 000 + transfer 5 000', req([['single', [M]]]), 125_000n],
    ['double at 1: 80 000 + 30 000 + 5 000', req([['double', [M]]]), 115_000n],
    ['double at 2: 2 × 50 000 + 2 × 30 000 + 5 000', req([['double', [M, M]]]), 165_000n],
    ['triple at 3: 3 × 40 000 + 3 × 30 000 + 5 000', req([['triple', [M, M, M]]]), 215_000n],
    ['quad at 4: 4 × 35 000 + 4 × 30 000 + 5 000', req([['quad', [M, M, M, M]]]), 265_000n],
    ['quad at 2, runner and supporter: 2 × 55 000 + 30 000 + 2 500 + 5 000', req([['quad', [M, S]]]), 147_500n],
    ['quad at 3, mixed: 3 × 42 000 + 30 000 + 20 000 + 5 000 + 5 000', req([['quad', [M, H, O]]]), 186_000n],
    ['two rooms: single (half) + double (own entry, supporter)', req([['single', [H]], ['double', [O, S]]]), 222_500n],
  ])('%s', (_name, r, total) => {
    const b = run(r);
    expect(b.totalMinor).toBe(total);
    // every traveller in a room pays that room's rate for its occupancy
    for (const room of b.configuration.rooms) {
      const rate = RATES.roomRates.find((x) => x.roomOptionId === room.roomOptionId && x.occupancy === room.occupancy)!;
      for (const t of room.travellers) expect(b.lines.find((l) => l.key === `room:${t.slot}`)!.amountMinor).toBe(rate.pricePerPersonMinor);
    }
  });

  it.each<[string, EngineRequest, string]>([
    ['double with 3', req([['double', [M, M, M]]]), 'occupancy_out_of_range'],
    ['triple with 2', req([['triple', [M, M]]]), 'occupancy_out_of_range'],
    ['quad with 1', req([['quad', [M]]]), 'occupancy_out_of_range'],
    ['quad with 5', req([['quad', [M, M, M, M, M]]]), 'occupancy_out_of_range'],
    ['room with nobody', req([['double', []]]), 'occupancy_out_of_range'],
    ['room of another package', req([['elsewhere', [M]]]), 'room_not_in_package'],
    ['9 travellers in a package for 8', req([['quad', [M, M, M, M]], ['quad', [M, M, M, M]], ['single', [M]]]), 'travellers_out_of_range'],
    ['fewer than the minimum', req([['single', [M]]]), 'travellers_out_of_range'],
  ])('%s → %s', (name, r, code) => {
    const view = name === 'fewer than the minimum' ? { ...VIEW, minTravellers: 2 } : VIEW;
    expect(errorOf(() => run(r, { view }))).toBe(code);
  });
});

describe('extra_nights', () => {
  it.each<[string, EngineRequest, bigint, string, string]>([
    ['single, none', req([['single', [M]]]), 125_000n, '2027-06-18', '2027-06-21'],
    ['single, 1 before: + 30 000', req([['single', [M]]], { extraNightsBefore: 1 }), 155_000n, '2027-06-17', '2027-06-21'],
    ['single, 2 after: + 2 × 30 000', req([['single', [M]]], { extraNightsAfter: 2 }), 185_000n, '2027-06-18', '2027-06-23'],
    ['single, the maximum 2 + 3: + 5 × 30 000', req([['single', [M]]], { extraNightsBefore: 2, extraNightsAfter: 3 }), 275_000n, '2027-06-16', '2027-06-24'],
    ['double at 2, 1 + 1: + 2 × 2 × 15 000', req([['double', [M, M]]], { extraNightsBefore: 1, extraNightsAfter: 1 }), 225_000n, '2027-06-17', '2027-06-22'],
    ['double at 1, 1 after: + 25 000', req([['double', [M]]], { extraNightsAfter: 1 }), 140_000n, '2027-06-18', '2027-06-22'],
    ['triple, 1 after: + 3 × 12 000', req([['triple', [M, M, M]]], { extraNightsAfter: 1 }), 251_000n, '2027-06-18', '2027-06-22'],
    ['quad at 4, 2 before: + 4 × 2 × 10 000', req([['quad', [M, M, M, M]]], { extraNightsBefore: 2 }), 345_000n, '2027-06-16', '2027-06-21'],
  ])('%s', (_n, r, total, departure, ret) => {
    const b = run(r);
    expect(b.totalMinor).toBe(total);
    expect([b.departureDate, b.returnDate]).toEqual([departure, ret]);
  });

  it.each([[3, 0], [0, 4], [-1, 0]])('%i before and %i after → extra_nights_out_of_range', (before, after) => {
    expect(errorOf(() => run(req([['single', [M]]], { extraNightsBefore: before, extraNightsAfter: after })))).toBe('extra_nights_out_of_range');
  });
});

describe('supporters', () => {
  it.each<[string, EngineRequest, bigint]>([
    ['runner and supporter in a double: 2 × 50 000 + 30 000 + 2 500 + 5 000', req([['double', [M, S]]]), 137_500n],
    ['two supporters in a double: 2 × 50 000 + 2 × 2 500 + 5 000', req([['double', [S, S]]]), 110_000n],
    ['supporter takes the scarf: + 3 000', req([['double', [M, S]]], { extras: [{ extraId: 'scarf', travellerSlots: [2] }] }), 140_500n],
    ['both take the tour: + 2 × 12 000', req([['double', [M, S]]], { extras: [{ extraId: 'tour', travellerSlots: [1, 2] }] }), 161_500n],
    ['runner takes pasta, supporter the scarf', req([['double', [M, S]]], { extras: [{ extraId: 'pasta', travellerSlots: [1] }, { extraId: 'scarf', travellerSlots: [2] }] }), 145_000n],
  ])('%s', (_n, r, total) => expect(run(r).totalMinor).toBe(total));

  it('a supporter cannot take a runners-only extra', () => {
    expect(errorOf(() => run(req([['double', [M, S]]], { extras: [{ extraId: 'pasta', travellerSlots: [2] }] })))).toBe('extra_audience_mismatch');
  });
  it('a package without supporters refuses one', () => {
    expect(errorOf(() => run(req([['double', [M, S]]]), { view: { ...VIEW, participationTypes: ['runner_with_entry'] } }))).toBe('participation_not_offered');
  });
});

describe('participation_and_distances', () => {
  it.each<[string, EngineRequest, bigint]>([
    ['marathon: 30 000', req([['single', [M]]]), 125_000n],
    ['half: 20 000', req([['single', [H]]]), 115_000n],
    ['own entry: 5 000', req([['single', [O]]]), 100_000n],
  ])('%s', (_n, r, total) => expect(run(r).totalMinor).toBe(total));

  it.each<[string, EngineRequest, string]>([
    ['runner with entry and no distance', req([['single', [{ participationType: 'runner_with_entry' } as never]]]), 'distance_required'],
    ['a distance the package does not offer', req([['single', [{ participationType: 'runner_with_entry', raceDistanceId: 'ultra' } as never]]]), 'distance_not_offered'],
    ['own entry with a distance', req([['single', [{ participationType: 'runner_own_entry', raceDistanceId: 'marathon' } as never]]]), 'distance_not_allowed'],
    ['supporter with a distance', req([['single', [{ participationType: 'supporter', raceDistanceId: 'marathon' } as never]]]), 'distance_not_allowed'],
  ])('%s → %s', (_n, r, code) => expect(errorOf(() => run(r))).toBe(code));
});

describe('extras', () => {
  const one = (extras: EngineRequest['extras']) => req([['single', [M]]], { extras });
  it.each<[string, EngineRequest, bigint]>([
    ['the mandatory transfer counts without being asked for', one([]), 125_000n],
    ['tour for the runner: + 12 000', one([{ extraId: 'tour', travellerSlots: [1] }]), 137_000n],
    ['two transfers: + 5 000', one([{ extraId: 'transfer', quantity: 2 }]), 130_000n],
  ])('%s', (_n, r, total) => expect(run(r).totalMinor).toBe(total));

  it('a mandatory per-person extra is added for every eligible traveller', () => {
    const view: CatalogueView = { ...VIEW, extras: VIEW.extras.map((e) => (e.id === 'pasta' ? { ...e, mandatory: true } : e)) };
    const b = run(req([['double', [M, S]]]), { view });
    expect(b.lines.filter((l) => l.refId === 'pasta').map((l) => l.travellerSlot)).toEqual([1]);
    expect(b.totalMinor).toBe(137_500n + 4_500n);
  });

  it.each<[string, EngineRequest['extras'], string]>([
    ['three transfers (maximum 2)', [{ extraId: 'transfer', quantity: 3 }], 'extra_quantity_invalid'],
    ['a per-person extra with a quantity', [{ extraId: 'tour', quantity: 1 }], 'extra_quantity_invalid'],
    ['a per-booking extra with slots', [{ extraId: 'transfer', travellerSlots: [1] }], 'extra_quantity_invalid'],
    ['a slot that does not exist', [{ extraId: 'tour', travellerSlots: [2] }], 'traveller_slot_invalid'],
    ['no slots for a per-person extra', [{ extraId: 'tour', travellerSlots: [] }], 'traveller_slot_invalid'],
    ['the same slot twice', [{ extraId: 'tour', travellerSlots: [1, 1] }], 'traveller_slot_duplicated'],
    ['the same extra twice', [{ extraId: 'tour', travellerSlots: [1] }, { extraId: 'tour', travellerSlots: [1] }], 'extra_duplicated'],
    ['an extra of another package, or deleted', [{ extraId: 'spa', travellerSlots: [1] }], 'extra_not_in_package'],
  ])('%s → %s', (_n, extras, code) => expect(errorOf(() => run(one(extras)))).toBe(code));

  it('more scarves than the maximum per booking', () => {
    expect(errorOf(() => run(req([['triple', [S, S, S]]], { extras: [{ extraId: 'scarf', travellerSlots: [1, 2, 3] }] })))).toBe('extra_quantity_invalid');
  });
});

describe('deposit', () => {
  const single = req([['single', [M]]]);
  it.each<[string, CatalogueView['deposit'], bigint | null]>([
    ['per person 50 000 × 1', { mode: 'per_person', amountMinor: 50_000n }, 50_000n],
    ['per booking 70 000', { mode: 'per_booking', amountMinor: 70_000n }, 70_000n],
    ['33.33 % of 125 000 = 41 662.5 → 41 663 (half up)', { mode: 'percent', bps: 3333 }, 41_663n],
    ['deposit_capped_at_total: 200 000 per person on a 125 000 trip', { mode: 'per_person', amountMinor: 200_000n }, 125_000n],
    ['no deposit configured', null, null],
  ])('%s', (_n, deposit, expected) => {
    const b = run(single, { view: { ...VIEW, deposit } });
    expect(b.depositMinor).toBe(expected);
    expect(b.balanceMinor).toBe(expected === null ? null : 125_000n - expected);
  });

  it('a total of 0 has a deposit of 0', () => {
    const b = run(single, { rules: [rule({ appliesTo: 'subtotal', valueBps: 10_000 })] });
    expect([b.totalMinor, b.depositMinor, b.balanceMinor]).toEqual([0n, 0n, 0n]);
  });

  it.each<[string, Date, boolean]>([
    ['the day before the balance date (23:59:59.999 in Brisbane): deposit only', new Date('2027-04-17T13:59:59.999Z'), false],
    ['the balance date itself (00:00 in Brisbane): pay in full', new Date('2027-04-17T14:00:00.000Z'), true],
    ['after the balance date: pay in full', new Date('2027-05-01T00:00:00.000Z'), true],
  ])('%s', (_n, now, full) => {
    const b = run(single, { now });
    expect(b.fullPaymentDue).toBe(full);
    expect(b.depositMinor).toBe(full ? 125_000n : 50_000n);
  });
});

describe('rule_combinations (base: two marathon runners in a double, 165 000)', () => {
  const acc = (over: Partial<RuleInput>) => rule({ appliesTo: 'accommodation', ...over });
  it.each<[string, RuleInput[], bigint]>([
    ['early bird 10 % on rooms + group 5 000 per person on the subtotal', [acc({ kind: 'early_bird', conditions: { bookedOnOrBefore: '2027-01-31' } }), rule({ kind: 'group_discount', conditions: { minTravellers: 2 }, appliesTo: 'subtotal', ...fixed(5_000n, { per: 'person' }) })], 145_000n],
    ['two non-stackable on rooms: only the first by priority (10 %)', [acc({ priority: 1, stackable: false }), acc({ priority: 2, valueBps: 2000, stackable: false })], 155_000n],
    ['the same two, priorities swapped: only 20 %', [acc({ priority: 2, stackable: false }), acc({ priority: 1, valueBps: 2000, stackable: false })], 145_000n],
    ['a non-stackable rule closes only its own group: 10 % rooms + 10 % participation', [acc({ stackable: false }), rule({ appliesTo: 'participation', stackable: false })], 149_000n],
    ['a stackable rule after a non-stackable one in the same group is blocked', [acc({ priority: 1, stackable: false }), acc({ priority: 2 })], 155_000n],
    ['a non-stackable rule after a stackable one in the same group is blocked', [acc({ priority: 1 }), acc({ priority: 2, valueBps: 5000, stackable: false })], 155_000n],
    ['surcharge 20 % and discount 50 000 on rooms: surcharge first', [acc({ kind: 'late_supplement', direction: 'surcharge', valueBps: 2000, conditions: { maxDaysBeforeCheckIn: 200 } }), acc(fixed(50_000n))], 135_000n],
    ['10 % on the subtotal: 16 500', [rule({ appliesTo: 'subtotal' })], 148_500n],
    ['percentages do not compound: 10 % + 10 % on rooms = 2 × 10 000', [acc({}), acc({})], 145_000n],
    ['a disabled rule does nothing', [acc({ enabled: false })], 165_000n],
    ['valid until now (exclusive): does nothing', [acc({ validTo: NOW })], 165_000n],
    ['valid from now (inclusive): applies', [acc({ validFrom: NOW })], 155_000n],
    ['a rule of another package does nothing', [acc({ scopeId: 'other' })], 165_000n],
    ['an edition rule applies', [acc({ scopeType: 'edition', scopeId: 'edition' })], 155_000n],
    ['a global fixed rule in another currency is skipped', [acc({ scopeType: 'global', scopeId: null, ...fixed(5_000n, { currency: 'NZD' }) })], 165_000n],
    ['a single supplement nobody matches does nothing (per booking)', [acc({ kind: 'occupancy_supplement', direction: 'surcharge', conditions: { occupancies: [1] }, ...fixed(10_000n) })], 165_000n],
    ['a single supplement nobody matches does nothing (per person)', [acc({ kind: 'occupancy_supplement', direction: 'surcharge', conditions: { occupancies: [1] }, ...fixed(10_000n, { per: 'person' }) })], 165_000n],
    ['a group discount that needs 3 travellers does nothing for 2', [rule({ kind: 'group_discount', appliesTo: 'subtotal', conditions: { minTravellers: 3 } })], 165_000n],
    ['90 % on the subtotal then 50 000 off rooms: capped to what is left, total 0', [rule({ appliesTo: 'subtotal', valueBps: 9000, priority: 1 }), acc({ priority: 2, ...fixed(50_000n) })], 0n],
    ['100 % off rooms then 90 % on the subtotal: capped, total 0', [acc({ priority: 1, valueBps: 10_000 }), rule({ appliesTo: 'subtotal', valueBps: 9000, priority: 2 })], 0n],
  ])('%s', (_n, rules, total) => {
    const b = run(DOUBLE_2M, { rules });
    expect(b.totalMinor).toBe(total);
    expect(b.totalMinor).toBeGreaterThanOrEqual(0n);
  });

  it('a single supplement applies per person to the travellers in single rooms only', () => {
    const r = rule({ kind: 'occupancy_supplement', direction: 'surcharge', appliesTo: 'accommodation', conditions: { occupancies: [1] }, ...fixed(10_000n, { per: 'person' }) });
    expect(run(req([['single', [M]], ['double', [M, M]]]), { rules: [r] }).totalMinor).toBe(125_000n + 160_000n + 10_000n);
  });

  it('the trace says why each rule did or did not apply', () => {
    const a = acc({ priority: 1, stackable: false });
    const b = acc({ priority: 2 });
    const c = acc({ enabled: false });
    const trace = run(DOUBLE_2M, { rules: [a, b, c] }).trace;
    expect(trace).toEqual(expect.arrayContaining([{ ruleId: a.id, outcome: 'applied' }, { ruleId: b.id, outcome: 'blocked_by_non_stackable' }, { ruleId: c.id, outcome: 'disabled' }]));
  });

  it.each<[string, Partial<RuleInput>, string]>([
    ['a package rule in another currency', fixed(5_000n, { currency: 'NZD' }), 'currency_mismatch'],
    ['a percentage per person', { per: 'person' }, 'rule_invalid'],
    ['percent and fixed at once', { valueMinor: 100n }, 'rule_invalid'],
    ['a fixed rule without currency', fixed(5_000n, { currency: null }), 'rule_invalid'],
    ['a fixed amount above the line limit', fixed(100_000_001n), 'rule_invalid'],
    ['a discount above 100 %', { valueBps: 10_001 }, 'rule_invalid'],
    ['an early bird without a date or days', { kind: 'early_bird' }, 'rule_invalid'],
    ['an occupancy supplement without occupancies', { kind: 'occupancy_supplement' }, 'rule_invalid'],
  ])('%s → %s', (_n, over, code) => expect(errorOf(() => run(DOUBLE_2M, { rules: [acc(over)] }))).toBe(code));
});

describe('discount_capped_at_component', () => {
  it.each<[string, RuleInput[], PromoInput | null, bigint, bigint | null]>([
    ['150 000 off rooms worth 100 000: capped at 100 000', [rule(fixed(150_000n))], null, 65_000n, 150_000n],
    ['rule 60 % then code 50 % on rooms: 60 000, then 50 % of the 40 000 left', [rule({ valueBps: 6000 })], promo({ appliesTo: 'accommodation', valueBps: 5000 }), 85_000n, null],
    ['rule 80 000 then code 50 000 on rooms: the code is capped at the 20 000 left', [rule(fixed(80_000n))], promo({ appliesTo: 'accommodation', ...fixed(50_000n) } as Partial<PromoInput>), 65_000n, 50_000n],
    ['code 100 % on the subtotal: total 0', [], promo({ valueBps: 10_000 }), 0n, null],
    ['50 000 off participation worth 60 000 and 50 000 off the subtotal: 165 000 − 100 000', [rule({ appliesTo: 'participation', priority: 1, ...fixed(50_000n) }), rule({ appliesTo: 'subtotal', priority: 2, ...fixed(50_000n) })], null, 65_000n, null],
  ])('%s', (_n, rules, p, total, cappedFrom) => {
    const b = run(DOUBLE_2M, { rules, promo: p });
    expect(b.totalMinor).toBe(total);
    const last = b.lines[b.lines.length - 1]!;
    expect(last.cappedFromMinor).toBe(cappedFrom);
    // no component ends below zero
    for (const c of ['accommodation', 'participation', 'extras'] as const) {
      const signed = b.lines.filter((l) => l.component === c).reduce((a, l) => a + (l.direction === 'discount' ? -l.amountMinor : l.amountMinor), 0n);
      expect(signed).toBeGreaterThanOrEqual(0n);
    }
  });
});

describe('promo_codes (base 165 000)', () => {
  it.each<[string, RuleInput[], PromoInput, bigint, string]>([
    ['10 % on the subtotal', [], promo({}), 148_500n, 'applied'],
    ['7 500 per booking', [], promo(fixed(7_500n) as Partial<PromoInput>), 157_500n, 'applied'],
    ['2 000 per person on participation: 2 × 2 000', [], promo({ appliesTo: 'participation', ...fixed(2_000n, { per: 'person' }) } as Partial<PromoInput>), 161_000n, 'applied'],
    ['not stackable, with a rule discount on its own target: not applied', [rule({})], promo({ appliesTo: 'accommodation', stackable: false }), 155_000n, 'not_combinable'],
    ['not stackable, rule discount on another target: applied', [rule({})], promo({ appliesTo: 'participation', stackable: false }), 149_000n, 'applied'],
    ['stackable with a rule on the same target: 10 000 then 10 % of 90 000', [rule({})], promo({ appliesTo: 'accommodation' }), 146_000n, 'applied'],
    ['needs 3 travellers', [], promo({ conditions: { minTravellers: 3 } }), 165_000n, 'conditions_not_met'],
    ['unknown, disabled, expired or exhausted: one answer', [], promo({ usable: false }), 165_000n, 'invalid'],
    ['for another package', [], promo({ scopeId: 'other' }), 165_000n, 'invalid'],
    ['a global fixed code in another currency', [], promo({ scopeType: 'global', scopeId: null, ...fixed(5_000n, { currency: 'NZD' }) } as Partial<PromoInput>), 165_000n, 'invalid'],
  ])('%s', (_n, rules, p, total, status) => {
    const b = run(DOUBLE_2M, { rules, promo: p });
    expect(b.totalMinor).toBe(total);
    expect(b.promo.status).toBe(status);
  });

  it('a per-person code shows unit and quantity', () => {
    const b = run(DOUBLE_2M, { promo: promo({ appliesTo: 'participation', ...fixed(2_000n, { per: 'person' }) } as Partial<PromoInput>) });
    expect(b.lines.find((l) => l.kind === 'promo')).toMatchObject({ unitAmountMinor: 2_000n, quantity: 2, amountMinor: 4_000n, direction: 'discount' });
  });
  it('a package code in another currency is a configuration error', () => {
    expect(errorOf(() => run(DOUBLE_2M, { promo: promo(fixed(5_000n, { currency: 'NZD' }) as Partial<PromoInput>) }))).toBe('currency_mismatch');
  });
  it('no code: status none', () => expect(run(DOUBLE_2M).promo.status).toBe('none'));
});

describe('boundary_dates', () => {
  const eb = rule({ kind: 'early_bird', conditions: { bookedOnOrBefore: '2027-01-31' } });
  it.each<[string, Date, RuleInput, boolean]>([
    ['early bird on its last day, 23:59:59.999 in Brisbane', new Date('2027-01-31T13:59:59.999Z'), eb, true],
    ['early bird at 00:00 the next day in Brisbane (14:00 UTC)', new Date('2027-01-31T14:00:00.000Z'), eb, false],
    ['validTo is exclusive', new Date('2027-02-01T00:00:00.000Z'), rule({ validTo: new Date('2027-02-01T00:00:00.000Z') }), false],
    ['one millisecond before validTo', new Date('2027-01-31T23:59:59.999Z'), rule({ validTo: new Date('2027-02-01T00:00:00.000Z') }), true],
    ['validFrom is inclusive', new Date('2027-02-01T00:00:00.000Z'), rule({ validFrom: new Date('2027-02-01T00:00:00.000Z') }), true],
    ['one millisecond before validFrom', new Date('2027-01-31T23:59:59.999Z'), rule({ validFrom: new Date('2027-02-01T00:00:00.000Z') }), false],
    ['159 days before check-in, needs at least 159', NOW, rule({ kind: 'early_bird', conditions: { minDaysBeforeCheckIn: 159 } }), true],
    ['159 days before check-in, needs at least 160', NOW, rule({ kind: 'early_bird', conditions: { minDaysBeforeCheckIn: 160 } }), false],
    ['late supplement within 159 days: applies on the day', NOW, rule({ kind: 'late_supplement', direction: 'surcharge', conditions: { maxDaysBeforeCheckIn: 159 } }), true],
    ['late supplement within 158 days: not yet', NOW, rule({ kind: 'late_supplement', direction: 'surcharge', conditions: { maxDaysBeforeCheckIn: 158 } }), false],
  ])('%s', (_n, now, r, applies) => {
    expect(run(DOUBLE_2M, { rules: [r], now }).trace).toEqual([{ ruleId: r.id, outcome: applies ? 'applied' : expect.not.stringMatching(/^applied$/) }]);
  });

  it('days are counted to the package check-in, also with extra nights before (M4)', () => {
    const r = rule({ kind: 'early_bird', conditions: { minDaysBeforeCheckIn: 159 } });
    const b = run(req([['double', [M, M]]], { extraNightsBefore: 2 }), { rules: [r] });
    expect(b.departureDate).toBe('2027-06-16');
    expect(b.trace).toEqual([{ ruleId: r.id, outcome: 'applied' }]);
  });
});

describe('rule_direction_sets_sign', () => {
  it('a discount subtracts and a surcharge adds; every line amount is zero or more', () => {
    const b = run(DOUBLE_2M, { rules: [rule({ priority: 1 }), rule({ direction: 'surcharge', appliesTo: 'participation', priority: 2 })] });
    expect(b.totalMinor).toBe(165_000n - 10_000n + 6_000n);
    expect(b.lines.every((l) => l.amountMinor >= 0n && l.unitAmountMinor >= 0n)).toBe(true);
    expect(b.lines.filter((l) => l.kind === 'rule').map((l) => l.direction).sort()).toEqual(['discount', 'surcharge']);
  });
  it.each<[string, Partial<RuleInput>]>([
    ['negative amount', fixed(-1n)],
    ['negative basis points', { valueBps: -1 }],
    ['fractional basis points', { valueBps: 1.5 }],
  ])('%s → rule_invalid', (_n, over) => expect(errorOf(() => run(DOUBLE_2M, { rules: [rule(over)] }))).toBe('rule_invalid'));
});

describe('mixed_currency_inputs_rejected and fixed_rule_other_currency_never_applied', () => {
  it('a price version in another currency', () => {
    expect(errorOf(() => run(DOUBLE_2M, { rates: { ...RATES, currency: 'NZD' } }))).toBe('currency_mismatch');
  });
  it('one rate in another currency', () => {
    const rates = { ...RATES, extraRates: RATES.extraRates.map((r) => (r.extraId === 'transfer' ? { ...r, currency: 'NZD' } : r)) };
    expect(errorOf(() => run(DOUBLE_2M, { rates }))).toBe('currency_mismatch');
  });
  it('a global fixed rule in another currency never reaches the breakdown', () => {
    const r = rule({ scopeType: 'global', scopeId: null, ...fixed(5_000n, { currency: 'USD' }) });
    const b = run(DOUBLE_2M, { rules: [r] });
    expect(b.lines.some((l) => l.refId === r.id)).toBe(false);
    expect(b.trace).toEqual([{ ruleId: r.id, outcome: 'other_currency' }]);
  });
});

describe('missing_rate_is_error_not_zero and limits', () => {
  it.each<[string, RatesView, EngineRequest]>([
    ['room at that occupancy', { ...RATES, roomRates: RATES.roomRates.filter((r) => !(r.roomOptionId === 'double' && r.occupancy === 2)) }, DOUBLE_2M],
    ['participation', { ...RATES, participationRates: RATES.participationRates.filter((r) => r.raceDistanceId !== 'half') }, req([['single', [H]]])],
    ['mandatory extra', { ...RATES, extraRates: RATES.extraRates.filter((r) => r.extraId !== 'transfer') }, DOUBLE_2M],
  ])('no rate for the %s → rate_missing', (_n, rates, r) => expect(errorOf(() => run(r, { rates }))).toBe('rate_missing'));

  it('a line above A$1,000,000 is refused (rate × nights)', () => {
    const rates = { ...RATES, roomRates: RATES.roomRates.map((r) => ({ ...r, extraNightPerPersonMinor: 30_000_000n })) };
    expect(errorOf(() => run(req([['single', [M]]], { extraNightsBefore: 2, extraNightsAfter: 3 }), { rates }))).toBe('amount_above_limit');
  });
  it('a total above A$10,000,000 is refused', () => {
    const rates = { ...RATES, roomRates: RATES.roomRates.map((r) => ({ ...r, pricePerPersonMinor: 100_000_000n })) };
    expect(errorOf(() => run(req([['quad', [M, M, M, M]], ['quad', [M, M, M, M]], ['single', [M]], ['single', [M]], ['single', [M]]]), { view: { ...VIEW, maxTravellers: 20 }, rates }))).toBe('amount_above_limit');
  });
});

describe('quote_is_deterministic, breakdown_carries_engine_and_price_version, breakdown_unchanged_after_reprice', () => {
  it('same input and same now give the same breakdown', () => {
    const rules = [rule({ priority: 5 }), rule({ priority: 5, appliesTo: 'subtotal' })];
    const a = run(DOUBLE_2M, { rules, promo: promo({}) });
    const b = run(DOUBLE_2M, { rules: [...rules].reverse(), promo: promo({}) });
    expect(b).toEqual(a);
  });
  it('the breakdown names the engine and the price version', () => {
    const b = run(DOUBLE_2M);
    expect(b.engineVersion).toBe('pricing-2.1.0');
    expect(b.priceVersionId).toBe(RATES.priceVersionId);
    expect(b.computedAt).toBe(NOW.toISOString());
  });
  it('pricing again with new rates leaves an earlier breakdown as it was', () => {
    const first = run(DOUBLE_2M);
    const frozen = structuredClone(first);
    const second = run(DOUBLE_2M, { rates: { ...RATES, priceVersionId: '00000000-0000-7000-8000-000000000002', roomRates: RATES.roomRates.map((r) => ({ ...r, pricePerPersonMinor: r.pricePerPersonMinor + 1_000n })) } });
    expect(second.totalMinor).toBe(167_000n);
    expect(first).toEqual(frozen);
  });
});
