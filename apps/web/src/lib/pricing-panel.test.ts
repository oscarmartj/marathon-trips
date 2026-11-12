import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FIXED_PER_PERSON_MINOR, MAX_LINE_MINOR } from '@mt/shared';
import { describe, expect, it } from 'vitest';
import {
  adjustmentBody, adjustmentPatch, bpsToText, cellsDiffer, cellsToBody, creationFields, droppedRateCount, emptyAdjustmentForm, extraCell, formatLineAmount, formatMinor,
  missingCell, parseMoney, parsePercent, participationCell, patchIsEmpty, rateShapeOf, ratesToCells, roomCell, rowToForm, toQuoteRequest, travellerCount, versionPhase,
  type PackageForPrices, type RatesJson,
} from './pricing-panel';

describe('parseMoney', () => {
  it.each([
    ['0', '0'], ['0.00', '0'], ['5', '500'], ['5.5', '550'], ['5.50', '550'], ['0.05', '5'], ['0.1', '10'], ['12', '1200'], ['1234.56', '123456'],
    ['$1,234.50', '123450'], ['A$5', '500'], ['a$ 5', '500'], ['  42  ', '4200'], ['1,000', '100000'], ['007', '700'], ['1,000,000', '100000000'], ['1000000.00', '100000000'],
  ])('accepts %j as %s cents', (text, minor) => {
    expect(parseMoney(text)).toEqual({ ok: true, minor });
  });
  it.each([
    ['', 'empty'], ['   ', 'empty'], ['abc', 'invalid'], ['-5', 'invalid'], ['+5', 'invalid'], ['1e3', 'invalid'], ['.5', 'invalid'], ['5.', 'invalid'], ['1,23', 'invalid'], ['12,34,567', 'invalid'],
    ['1 000', 'invalid'], ['5,5', 'invalid'], ['0x10', 'invalid'], ['NaN', 'invalid'], ['12.345', 'decimals'], ['0.001', 'decimals'],
    ['1000000.01', 'too_large'], ['9999999999', 'too_large'],
  ])('refuses %j as %s', (text, reason) => {
    expect(parseMoney(text)).toEqual({ ok: false, reason });
  });
  it('keeps_binary_floating_point_out: 0.1 and 0.2 are 10 and 20 cents, not 30.000000000000004', () => {
    expect(parseMoney('0.1')).toEqual({ ok: true, minor: '10' });
    expect(parseMoney('0.2')).toEqual({ ok: true, minor: '20' });
    expect(parseMoney('4.35')).toEqual({ ok: true, minor: '435' }); // 4.35 * 100 is 434.99999999999994 in floating point
    expect(parseMoney('1.15')).toEqual({ ok: true, minor: '115' });
    expect(parseMoney('8.2')).toEqual({ ok: true, minor: '820' });
  });
  it('honours_a_lower_limit_for_fixed_amounts_per_person', () => {
    const ok = MAX_FIXED_PER_PERSON_MINOR.toString();
    expect(parseMoney(`${ok.slice(0, -2)}.${ok.slice(-2)}`, MAX_FIXED_PER_PERSON_MINOR)).toEqual({ ok: true, minor: ok });
    const over = (MAX_FIXED_PER_PERSON_MINOR + 1n).toString();
    expect(parseMoney(`${over.slice(0, -2)}.${over.slice(-2)}`, MAX_FIXED_PER_PERSON_MINOR)).toEqual({ ok: false, reason: 'too_large' });
    expect(MAX_LINE_MINOR).toBe(100_000_000n);
  });
});

describe('formatMinor', () => {
  it.each([
    ['0', 'A$0.00'], ['5', 'A$0.05'], ['50', 'A$0.50'], ['500', 'A$5.00'], ['123450', 'A$1,234.50'], ['100000000', 'A$1,000,000.00'], ['007', 'A$0.07'], ['1000000000000', 'A$10,000,000,000.00'],
  ])('formats %s as %s', (minor, text) => {
    expect(formatMinor(minor)).toBe(text);
  });
  it('shows_what_it_cannot_read_as_it_came', () => {
    expect(formatMinor('-5')).toBe('-5');
    expect(formatMinor('12.5')).toBe('12.5');
    expect(formatMinor('')).toBe('');
  });
  it('names_other_currencies_by_code', () => {
    expect(formatMinor('1000', 'NZD')).toBe('NZD 10.00');
  });
  it('writes_discounts_with_a_minus', () => {
    expect(formatLineAmount('discount', '2000')).toBe('-A$20.00');
    expect(formatLineAmount('charge', '2000')).toBe('A$20.00');
    expect(formatLineAmount('surcharge', '2000')).toBe('A$20.00');
  });
});

describe('percent', () => {
  it.each([['25', 2500], ['12.5', 1250], ['0.01', 1], ['100', 10000], ['1000', 100000], ['7.05', 705]])('parses %s as %i basis points', (text, bps) => {
    expect(parsePercent(text, 100000)).toBe(bps);
  });
  it.each(['', '0', '0.00', '-1', '1.234', '1e2', 'x', '100001'])('refuses %j', (text) => {
    expect(parsePercent(text, 100000)).toBeNull();
  });
  it('respects_the_limit_of_a_discount', () => {
    expect(parsePercent('100', 10000)).toBe(10000);
    expect(parsePercent('100.01', 10000)).toBeNull();
  });
  it.each([[2500, '25'], [1250, '12.5'], [1, '0.01'], [705, '7.05'], [10000, '100'], [100000, '1000']])('writes %i as %s', (bps, text) => {
    expect(bpsToText(bps)).toBe(text);
    expect(parsePercent(text, 100000)).toBe(bps);
  });
});

const pkg: PackageForPrices = {
  currency: 'AUD',
  maxExtraNightsBefore: 1,
  maxExtraNightsAfter: 0,
  participationOptions: [{ type: 'runner_with_entry', enabled: true }, { type: 'supporter', enabled: true }, { type: 'runner_own_entry', enabled: false }],
  entryOptions: [{ raceDistance: { id: 'd-m', name: { 'en-AU': 'Marathon' } } }, { raceDistance: { id: 'd-h', name: { 'en-AU': 'Half' } } }],
  hotels: [{ hotel: { name: 'Hotel' }, rooms: [{ id: 'r-s', name: {}, minOccupancy: 1, maxOccupancy: 1 }, { id: 'r-d', name: {}, minOccupancy: 1, maxOccupancy: 2 }] }],
  extras: [{ id: 'x-p', name: {}, pricingUnit: 'per_person', mandatory: false }, { id: 'x-t', name: {}, pricingUnit: 'per_booking', mandatory: true }],
};
const shape = rateShapeOf(pkg);
const rates: RatesJson = {
  roomRates: [{ roomOptionId: 'r-s', occupancy: 1, pricePerPersonMinor: '25000', extraNightPerPersonMinor: '9000' }],
  participationRates: [{ participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: '0' }],
  extraRates: [{ extraId: 'x-p', amountMinor: '5050' }],
};

describe('rate editor', () => {
  it('shape_lists_what_can_be_priced', () => {
    expect(shape.rooms.map((r) => r.id)).toEqual(['r-s', 'r-d']);
    expect(shape.participation).toEqual([{ type: 'runner_with_entry', distanceIds: ['d-m', 'd-h'] }, { type: 'supporter', distanceIds: [null] }]);
    expect(shape.extraIds).toEqual(['x-p', 'x-t']);
    expect(shape.offersExtraNights).toBe(true);
    expect(rateShapeOf({ ...pkg, maxExtraNightsBefore: 0 }).offersExtraNights).toBe(false);
  });
  it('cells_show_dollars', () => {
    expect(ratesToCells(rates)).toEqual({
      [roomCell('r-s', 1, 'price')]: '250.00', [roomCell('r-s', 1, 'night')]: '90.00', [participationCell('supporter', null)]: '0.00', [extraCell('x-p')]: '50.50',
    });
  });
  it('saved_rates_go_back_unchanged: cells to body and back is the identity', () => {
    const r = cellsToBody(ratesToCells(rates), shape, 3);
    expect(r).toEqual({
      ok: true,
      body: {
        version: 3,
        roomRates: [{ roomOptionId: 'r-s', occupancy: 1, pricePerPersonMinor: '25000', extraNightPerPersonMinor: '9000' }],
        participationRates: [{ participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: '0' }],
        extraRates: [{ extraId: 'x-p', amountMinor: '5050' }],
      },
    });
  });
  it('empty_cells_are_no_rate_and_a_room_price_alone_sends_zero_for_nights', () => {
    const r = cellsToBody({ [roomCell('r-d', 2, 'price')]: '180', [participationCell('runner_with_entry', 'd-h')]: '$99.99', [extraCell('x-t')]: ' ' }, shape, 1, '  new season ');
    expect(r).toEqual({
      ok: true,
      body: {
        version: 1, reason: 'new season',
        roomRates: [{ roomOptionId: 'r-d', occupancy: 2, pricePerPersonMinor: '18000', extraNightPerPersonMinor: '0' }],
        participationRates: [{ participationType: 'runner_with_entry', raceDistanceId: 'd-h', amountPerPersonMinor: '9999' }],
        extraRates: [],
      },
    });
  });
  it('bad_text_is_reported_per_cell_and_nothing_is_built', () => {
    const r = cellsToBody({ [roomCell('r-s', 1, 'price')]: '12.345', [extraCell('x-p')]: '-3', [roomCell('r-d', 1, 'night')]: '40', [participationCell('supporter', null)]: '1,23' }, shape, 1);
    expect(r).toEqual({
      ok: false,
      errors: [
        { cell: roomCell('r-s', 1, 'price'), reason: 'decimals' },
        { cell: roomCell('r-d', 1, 'price'), reason: 'price_needed' },
        { cell: participationCell('supporter', null), reason: 'invalid' },
        { cell: extraCell('x-p'), reason: 'invalid' },
      ],
    });
  });
  it('cells_for_targets_the_package_lacks_are_left_out_and_counted', () => {
    const gone: RatesJson = {
      roomRates: [...rates.roomRates, { roomOptionId: 'r-old', occupancy: 1, pricePerPersonMinor: '1', extraNightPerPersonMinor: '1' }],
      participationRates: [...rates.participationRates, { participationType: 'runner_with_entry', raceDistanceId: 'd-old', amountPerPersonMinor: '1' }, { participationType: 'runner_own_entry', raceDistanceId: null, amountPerPersonMinor: '1' }],
      extraRates: [...rates.extraRates, { extraId: 'x-old', amountMinor: '1' }],
    };
    expect(droppedRateCount(gone, shape)).toBe(4);
    expect(droppedRateCount(rates, shape)).toBe(0);
    const body = cellsToBody(ratesToCells(gone), shape, 1);
    expect(body.ok && body.body.roomRates.length).toBe(1);
    expect(body.ok && body.body.participationRates.length).toBe(1);
    expect(body.ok && body.body.extraRates.length).toBe(1);
  });
  it('rates_outside_the_occupancy_range_are_kept', () => {
    const r = cellsToBody({ [roomCell('r-s', 3, 'price')]: '10' }, shape, 1);
    expect(r.ok && r.body.roomRates).toEqual([{ roomOptionId: 'r-s', occupancy: 3, pricePerPersonMinor: '1000', extraNightPerPersonMinor: '0' }]);
  });
  it('missing_reports_point_at_cells', () => {
    expect(missingCell({ kind: 'room', roomOptionId: 'r', occupancy: 2 })).toBe(roomCell('r', 2, 'price'));
    expect(missingCell({ kind: 'extra_night', roomOptionId: 'r', occupancy: 2 })).toBe(roomCell('r', 2, 'night'));
    expect(missingCell({ kind: 'participation', participationType: 'supporter', raceDistanceId: null })).toBe(participationCell('supporter', null));
    expect(missingCell({ kind: 'participation', participationType: 'runner_with_entry', raceDistanceId: 'd' })).toBe(participationCell('runner_with_entry', 'd'));
    expect(missingCell({ kind: 'extra', extraId: 'x' })).toBe(extraCell('x'));
  });
  it('dirty_check_ignores_blanks', () => {
    expect(cellsDiffer({ a: '1.00' }, { a: '1.00', b: '' })).toBe(false);
    expect(cellsDiffer({ a: '1.00' }, { a: '1.01' })).toBe(true);
    expect(cellsDiffer({}, { a: '0.00' })).toBe(true);
    expect(cellsDiffer({ a: '250' }, { a: '250.00' })).toBe(false);
    expect(cellsDiffer({ a: '$1,234.5' }, { a: '1234.50' })).toBe(false);
    expect(cellsDiffer({ a: '12.345' }, { a: '12.34' })).toBe(true);
  });
});

describe('quote request', () => {
  const unit = (id: string) => (id === 'x-t' ? 'per_booking' : 'per_person');
  it('sends_a_configuration_and_never_an_amount', () => {
    const body = toQuoteRequest('p1', {
      priceVersionId: 'v1',
      rooms: [{ roomOptionId: 'r-d', travellers: [{ participationType: 'runner_with_entry', raceDistanceId: 'd-m' }, { participationType: 'supporter', raceDistanceId: 'd-m' }] }],
      extraNightsBefore: '1', extraNightsAfter: '', extras: [{ extraId: 'x-p', slots: [2, 1], quantity: '' }, { extraId: 'x-t', slots: [], quantity: '2' }], promoCode: ' early10 ',
    }, unit);
    expect(body).toEqual({
      packageId: 'p1', priceVersionId: 'v1',
      rooms: [{ roomOptionId: 'r-d', travellers: [{ participationType: 'runner_with_entry', raceDistanceId: 'd-m' }, { participationType: 'supporter' }] }],
      extraNightsBefore: 1, extraNightsAfter: 0,
      extras: [{ extraId: 'x-p', travellerSlots: [1, 2] }, { extraId: 'x-t', quantity: 2 }],
      promoCode: 'early10',
    });
    expect(JSON.stringify(body)).not.toMatch(/Minor|total|price"/);
  });
  it('leaves_out_an_empty_version_and_promo', () => {
    const body = toQuoteRequest('p1', { priceVersionId: '', rooms: [], extraNightsBefore: '', extraNightsAfter: '', extras: [], promoCode: '  ' }, unit);
    expect(body).toEqual({ packageId: 'p1', rooms: [], extraNightsBefore: 0, extraNightsAfter: 0, extras: [] });
  });
  it('counts_travellers', () => {
    expect(travellerCount({ rooms: [{ roomOptionId: 'a', travellers: [{ participationType: 'supporter', raceDistanceId: '' }, { participationType: 'supporter', raceDistanceId: '' }] }, { roomOptionId: 'b', travellers: [{ participationType: 'supporter', raceDistanceId: '' }] }] })).toBe(3);
  });
});

describe('rules and codes', () => {
  const o = { audience: 'rule' as const, offsetMinutes: 600 };
  const filled = (over: Partial<ReturnType<typeof emptyAdjustmentForm>> = {}) => ({ ...emptyAdjustmentForm(), label: 'Early bird', kind: 'early_bird', value: '10', bookedOnOrBefore: '2027-01-31', ...over });

  it('percent_rule_goes_to_basis_points', () => {
    expect(adjustmentBody(filled(), o)).toEqual({
      ok: true,
      body: {
        label: 'Early bird', conditions: { bookedOnOrBefore: '2027-01-31' }, effectMode: 'percent', valueBps: 1000, valueMinor: null, currency: null, per: 'booking', appliesTo: 'subtotal',
        stackable: false, enabled: true, validFrom: null, validTo: null, kind: 'early_bird', direction: 'discount', priority: 100,
      },
    });
  });
  it('fixed_rule_goes_to_cents_in_aud_and_keeps_per_person', () => {
    const r = adjustmentBody(filled({ effectMode: 'fixed', value: '25.50', per: 'person', appliesTo: 'accommodation', direction: 'surcharge', kind: 'custom' }), o);
    expect(r.ok && r.body).toMatchObject({ effectMode: 'fixed', valueBps: null, valueMinor: '2550', currency: 'AUD', per: 'person', appliesTo: 'accommodation', direction: 'surcharge' });
  });
  it('a_percentage_is_always_per_booking_even_if_the_form_said_person', () => {
    const r = adjustmentBody(filled({ per: 'person' }), o);
    expect(r.ok && r.body.per).toBe('booking');
  });
  it('surcharges_may_pass_100_percent_discounts_may_not', () => {
    expect(adjustmentBody(filled({ direction: 'surcharge', value: '150' }), o).ok).toBe(true);
    expect(adjustmentBody(filled({ direction: 'discount', value: '150' }), o)).toEqual({ ok: false, errors: [{ field: 'value', reason: 'percent' }] });
  });
  it('fixed_per_person_amount_has_the_lower_limit', () => {
    const over = (MAX_FIXED_PER_PERSON_MINOR + 1n).toString();
    expect(adjustmentBody(filled({ effectMode: 'fixed', per: 'person', value: `${over.slice(0, -2)}.${over.slice(-2)}` }), o)).toEqual({ ok: false, errors: [{ field: 'value', reason: 'too_large' }] });
    expect(adjustmentBody(filled({ effectMode: 'fixed', per: 'booking', value: `${over.slice(0, -2)}.${over.slice(-2)}` }), o).ok).toBe(true);
  });
  it('conditions_and_validity', () => {
    const r = adjustmentBody(filled({
      bookedOnOrBefore: '', minDaysBeforeCheckIn: '30', maxDaysBeforeCheckIn: '', minTravellers: '4', occupancies: [2, 1], participationTypes: ['supporter', 'runner_with_entry'],
      validFrom: '2027-01-01T00:00', validTo: '2027-02-01T00:00',
    }), o);
    expect(r.ok && r.body).toMatchObject({
      conditions: { minDaysBeforeCheckIn: 30, minTravellers: 4, occupancies: [1, 2], participationTypes: ['runner_with_entry', 'supporter'] },
      validFrom: '2026-12-31T14:00:00.000Z', validTo: '2027-01-31T14:00:00.000Z',
    });
  });
  it.each([
    [{ label: '  ' }, 'label', 'label'], [{ value: '' }, 'value', 'percent'], [{ value: 'abc' }, 'value', 'percent'], [{ bookedOnOrBefore: '31/01/2027' }, 'bookedOnOrBefore', 'date'],
    [{ minTravellers: '0' }, 'minTravellers', 'number'], [{ minDaysBeforeCheckIn: '-1' }, 'minDaysBeforeCheckIn', 'number'], [{ minDaysBeforeCheckIn: '1.5' }, 'minDaysBeforeCheckIn', 'number'],
    [{ validFrom: '2027-02-30T10:00' }, 'validFrom', 'instant'], [{ priority: '1001' }, 'priority', 'priority'], [{ priority: '' }, 'priority', 'priority'],
  ] as const)('refuses %j', (over, field, reason) => {
    const r = adjustmentBody(filled(over as never), o);
    expect(r).toEqual({ ok: false, errors: [{ field, reason }] });
  });
  it('a_promo_code_is_always_a_discount_and_carries_limits', () => {
    const r = adjustmentBody(filled({ direction: 'surcharge', maxRedemptions: '50', maxPerCustomer: '' }), { audience: 'promo', offsetMinutes: 0 });
    expect(r.ok && r.body).toMatchObject({ maxRedemptions: 50, maxPerCustomer: null });
    expect(r.ok && 'kind' in r.body).toBe(false);
    expect(r.ok && 'direction' in r.body).toBe(false);
    expect(adjustmentBody(filled({ maxRedemptions: '0' }), { audience: 'promo', offsetMinutes: 0 })).toEqual({ ok: false, errors: [{ field: 'maxRedemptions', reason: 'number' }] });
  });
  it('creation_fields_name_the_scope_and_normalise_the_code', () => {
    expect(creationFields(filled({ scopeType: 'package', scopeId: 'p1', code: ' summer-10 ' }), 'promo')).toEqual({ ok: true, fields: { scopeType: 'package', editionId: null, packageId: 'p1', code: 'SUMMER-10' } });
    expect(creationFields(filled({ scopeType: 'edition', scopeId: 'e1' }), 'rule')).toEqual({ ok: true, fields: { scopeType: 'edition', editionId: 'e1', packageId: null } });
    expect(creationFields(filled(), 'rule')).toEqual({ ok: true, fields: { scopeType: 'global', editionId: null, packageId: null } });
    expect(creationFields(filled({ scopeType: 'package', scopeId: '', code: 'abc' }), 'promo')).toEqual({ ok: false, errors: [{ field: 'scopeId', reason: 'scope' }, { field: 'code', reason: 'code' }] });
  });

  const row = {
    id: 'rule1', version: 4, label: 'Early bird', kind: 'early_bird', direction: 'discount', priority: 100, stackable: false, enabled: true, effectMode: 'percent', valueBps: 1000, valueMinor: null, currency: null,
    per: 'booking', appliesTo: 'subtotal', conditions: { bookedOnOrBefore: '2027-01-31', minTravellers: 2 }, validFrom: '2026-12-31T14:00:00.000Z', validTo: null, scopeType: 'global', editionId: null, packageId: null,
  };
  it('the_form_of_a_stored_row_rebuilds_the_same_body: no change, no patch', () => {
    const form = rowToForm(row, 600);
    expect(form).toMatchObject({ value: '10', validFrom: '2027-01-01T00:00', minTravellers: '2', bookedOnOrBefore: '2027-01-31' });
    const body = adjustmentBody(form, o);
    expect(body.ok).toBe(true);
    if (body.ok) expect(adjustmentPatch(row, body.body)).toEqual({ version: 4 });
  });
  it('patch_has_only_what_changed_plus_the_version', () => {
    const form = { ...rowToForm(row, 600), enabled: false, value: '12.5' };
    const body = adjustmentBody(form, o);
    expect(body.ok && adjustmentPatch(row, body.body, ' pause ')).toEqual({ enabled: false, valueBps: 1250, version: 4, reason: 'pause' });
  });
  it('a_changed_condition_sends_the_conditions_whole', () => {
    const form = { ...rowToForm(row, 600), minTravellers: '3' };
    const body = adjustmentBody(form, o);
    expect(body.ok && adjustmentPatch(row, body.body)).toEqual({ conditions: { bookedOnOrBefore: '2027-01-31', minTravellers: 3 }, version: 4 });
  });
  it('switching_from_percent_to_fixed_changes_the_whole_effect', () => {
    const form = { ...rowToForm(row, 600), effectMode: 'fixed', value: '20', per: 'person' };
    const body = adjustmentBody(form, o);
    expect(body.ok && adjustmentPatch(row, body.body)).toEqual({ effectMode: 'fixed', valueBps: null, valueMinor: '2000', currency: 'AUD', per: 'person', version: 4 });
  });
  it('clearing_a_validity_end_sends_null', () => {
    const r2 = { ...row, validTo: '2027-06-30T00:00:00.000Z' };
    const body = adjustmentBody({ ...rowToForm(r2, 600), validTo: '' }, o);
    expect(body.ok && adjustmentPatch(r2, body.body)).toEqual({ validTo: null, version: 4 });
  });
  it('an_instant_written_another_way_is_not_a_change', () => {
    const r2 = { ...row, validFrom: '2027-01-01T00:00:00.000+10:00' };
    const body = adjustmentBody(rowToForm(r2, 600), o);
    expect(body.ok && patchIsEmpty(adjustmentPatch(r2, body.body))).toBe(true);
  });
  it('fixed_amounts_round_trip_through_the_form', () => {
    const fixed = { ...row, effectMode: 'fixed', valueBps: null, valueMinor: '2550', currency: 'AUD', per: 'person', appliesTo: 'accommodation' };
    const form = rowToForm(fixed, 600);
    expect(form.value).toBe('25.50');
    const body = adjustmentBody(form, o);
    expect(body.ok && patchIsEmpty(adjustmentPatch(fixed, body.body))).toBe(true);
  });
  it('promo_row_shows_limits', () => {
    const promo = { ...row, code: 'SUMMER-10', maxRedemptions: 100, maxPerCustomer: null, redeemedCount: 7 };
    expect(rowToForm(promo, 0)).toMatchObject({ code: 'SUMMER-10', maxRedemptions: '100', maxPerCustomer: '' });
  });
});

describe('purity', () => {
  it('has_no_floating_point_money_calls', () => {
    const src = readFileSync(join(__dirname, 'pricing-panel.ts'), 'utf8');
    for (const banned of [/parseFloat/, /\.toFixed\(/, /Math\.(round|floor|ceil|trunc|pow)/, /toLocaleString/, /NumberFormat/, /\bNumber\(\s*[a-z]*[Mm]inor/]) {
      expect(src).not.toMatch(banned);
    }
  });
});

describe('versionPhase', () => {
  const now = Date.parse('2027-03-01T00:00:00Z');
  it.each([
    [{ id: 'a', status: 'draft', validFrom: null }, 'a', 'draft'],
    [{ id: 'a', status: 'archived', validFrom: null }, 'a', 'archived'],
    [{ id: 'a', status: 'published', validFrom: '2027-01-01T00:00:00Z' }, 'a', 'in_force'],
    [{ id: 'b', status: 'published', validFrom: '2027-06-01T00:00:00Z' }, 'a', 'scheduled'],
    [{ id: 'b', status: 'published', validFrom: '2026-06-01T00:00:00Z' }, 'a', 'past'],
    [{ id: 'b', status: 'published', validFrom: '2026-06-01T00:00:00Z' }, null, 'past'],
  ] as const)('%j with %s in force is %s', (v, current, phase) => {
    expect(versionPhase(v, current, now)).toBe(phase);
  });
});
