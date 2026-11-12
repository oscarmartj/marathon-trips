import { describe, expect, it } from 'vitest';
import { createCustomFieldSchema, customFiltersParamSchema, updateCustomFieldSchema, type CustomFieldOption, type CustomFieldType, type CustomFieldValidation } from '@mt/shared';
import { filterCondition, fromCsvCell, isBlank, toCsvCell, validateValue, type RuleDef } from '../../src/platform/common/custom-fields/values';

const label = { 'en-AU': 'Field' };
const opt = (value: string, retired = false): CustomFieldOption => ({ value, label: { 'en-AU': value }, ...(retired ? { retired } : {}) });
const def = (type: CustomFieldType, validation: CustomFieldValidation | null = null, options: CustomFieldOption[] | null = null): RuleDef => ({ key: 'f', type, options, validation, required: false });

describe('validateValue: one case per type and rule', () => {
  const cases: Array<[string, RuleDef, unknown, string | 'ok']> = [
    ['text trims and accepts', def('text'), '  hello ', 'ok'],
    ['text: wrong type', def('text'), 5, 'wrong_type'],
    ['text: below minimum length', def('text', { minLength: 3 }), 'ab', 'too_short'],
    ['text: at minimum length', def('text', { minLength: 3 }), 'abc', 'ok'],
    ['text: above maximum length', def('text', { maxLength: 3 }), 'abcd', 'too_long'],
    ['text: default maximum is 500', def('text'), 'x'.repeat(501), 'too_long'],
    ['text: 500 is fine', def('text'), 'x'.repeat(500), 'ok'],
    ['number: wrong type (string)', def('number'), '5', 'wrong_type'],
    ['number: NaN', def('number'), Number.NaN, 'wrong_type'],
    ['number: Infinity', def('number'), Number.POSITIVE_INFINITY, 'wrong_type'],
    ['number: not an integer', def('number', { integer: true }), 1.5, 'not_integer'],
    ['number: integer ok', def('number', { integer: true }), 2, 'ok'],
    ['number: below minimum', def('number', { min: 1 }), 0.99, 'below_minimum'],
    ['number: at minimum', def('number', { min: 1 }), 1, 'ok'],
    ['number: above maximum', def('number', { max: 10 }), 10.01, 'above_maximum'],
    ['number: at maximum', def('number', { max: 10 }), 10, 'ok'],
    ['number: negative ok without limits', def('number'), -3.5, 'ok'],
    ['number: too large for a double to hold exactly', def('number'), 1e13, 'too_large'],
    ['date: ok', def('date'), '2027-02-28', 'ok'],
    ['date: not a calendar date', def('date'), '2027-02-30', 'wrong_type'],
    ['date: wrong shape', def('date'), '28/02/2027', 'wrong_type'],
    ['date: before earliest', def('date', { minDate: '2027-01-01' }), '2026-12-31', 'before_earliest'],
    ['date: on earliest', def('date', { minDate: '2027-01-01' }), '2027-01-01', 'ok'],
    ['date: after latest', def('date', { maxDate: '2027-01-31' }), '2027-02-01', 'after_latest'],
    ['boolean true', def('boolean'), true, 'ok'],
    ['boolean false', def('boolean'), false, 'ok'],
    ['boolean: string is wrong', def('boolean'), 'true', 'wrong_type'],
    ['select: known option', def('select', null, [opt('a'), opt('b')]), 'a', 'ok'],
    ['select: unknown option', def('select', null, [opt('a')]), 'z', 'unknown_option'],
    ['select: retired option is refused for a new value', def('select', null, [opt('a', true)]), 'a', 'unknown_option'],
    ['select: wrong type', def('select', null, [opt('a')]), 1, 'wrong_type'],
    ['multiselect: ok', def('multiselect', null, [opt('a'), opt('b')]), ['b', 'a'], 'ok'],
    ['multiselect: unknown option', def('multiselect', null, [opt('a')]), ['a', 'z'], 'unknown_option'],
    ['multiselect: duplicates', def('multiselect', null, [opt('a')]), ['a', 'a'], 'duplicate_option'],
    ['multiselect: not an array', def('multiselect', null, [opt('a')]), 'a', 'wrong_type'],
    ['multiselect: array of numbers', def('multiselect', null, [opt('a')]), [1], 'wrong_type'],
    ['multiselect: too few', def('multiselect', { minItems: 2 }, [opt('a'), opt('b')]), ['a'], 'too_few'],
    ['multiselect: too many', def('multiselect', { maxItems: 1 }, [opt('a'), opt('b')]), ['a', 'b'], 'too_many'],
  ];
  it.each(cases)('%s', (_name, d, value, expected) => {
    const res = validateValue(d, value);
    if (expected === 'ok') expect(res.ok).toBe(true);
    else expect(res).toEqual({ ok: false, code: expected });
  });

  it('text is stored trimmed and a multiselect in the order of its options', () => {
    expect(validateValue(def('text'), '  hi  ')).toEqual({ ok: true, value: 'hi' });
    expect(validateValue(def('multiselect', null, [opt('a'), opt('b'), opt('c')]), ['c', 'a'])).toEqual({ ok: true, value: ['a', 'c'] });
  });

  it('a retired option stays valid for the record that already holds it, and for no other', () => {
    const d = def('select', null, [opt('a', true), opt('b')]);
    expect(validateValue(d, 'a', 'a').ok).toBe(true);
    expect(validateValue(d, 'a', 'b')).toEqual({ ok: false, code: 'unknown_option' });
    const m = def('multiselect', null, [opt('a', true), opt('b')]);
    expect(validateValue(m, ['a', 'b'], ['a']).ok).toBe(true);
    expect(validateValue(m, ['a', 'b'], [])).toEqual({ ok: false, code: 'unknown_option' });
  });

  it('a failure is only a short code, never the value', () => {
    for (const [, d, value] of cases) {
      const res = validateValue(d, value);
      if (!res.ok) expect(Object.keys(res).sort()).toEqual(['code', 'ok']);
      if (!res.ok) expect(res.code).toMatch(/^[a-z_]{3,20}$/);
    }
  });

  it('isBlank: null, undefined, blank text and an empty list', () => {
    expect([null, undefined, '', '   ', []].map(isBlank)).toEqual([true, true, true, true, true]);
    expect([0, false, 'a', ['a']].map(isBlank)).toEqual([false, false, false, false]);
  });
});

describe('CSV cells', () => {
  const round: Array<[string, RuleDef, unknown, string]> = [
    ['text', def('text'), 'Hi there', 'Hi there'],
    ['number', def('number'), 12.5, '12.5'],
    ['negative number', def('number'), -4, '-4'],
    ['date', def('date'), '2027-05-02', '2027-05-02'],
    ['boolean true', def('boolean'), true, 'true'],
    ['boolean false', def('boolean'), false, 'false'],
    ['select', def('select', null, [opt('a'), opt('b')]), 'b', 'b'],
    ['multiselect', def('multiselect', null, [opt('a'), opt('b')]), ['a', 'b'], 'a; b'],
  ];
  it.each(round)('%s survives an export and an import', (_n, d, value, text) => {
    expect(String(toCsvCell(d, value))).toBe(text);
    expect(fromCsvCell(d, text)).toEqual({ ok: true, value });
  });

  it('a blank cell means no value, and an empty or missing value writes an empty cell', () => {
    expect(fromCsvCell(def('number'), '  ')).toEqual({ ok: true, blank: true });
    expect(toCsvCell(def('text'), undefined)).toBeNull();
    expect(toCsvCell(def('multiselect'), [])).toBe('');
  });

  it.each([
    ['number', def('number'), '1,5', 'wrong_type'],
    ['number with text', def('number'), '12abc', 'wrong_type'],
    ['boolean yes', def('boolean'), 'yes', 'wrong_type'],
    ['boolean upper case', def('boolean'), 'TRUE', 'wrong_type'],
    ['date', def('date'), '2027-13-01', 'wrong_type'],
    ['select unknown', def('select', null, [opt('a')]), 'zz', 'unknown_option'],
    ['multiselect unknown', def('multiselect', null, [opt('a')]), 'a; zz', 'unknown_option'],
    ['text too long', def('text', { maxLength: 2 }), 'abc', 'too_long'],
  ])('a bad %s cell is a code without the value', (_n, d, cell, code) => {
    const res = fromCsvCell(d, cell);
    expect(res).toEqual({ ok: false, code });
    expect(JSON.stringify(res)).not.toContain(cell);
  });
});

describe('filterCondition', () => {
  const path = ['f'];
  const sel = def('select', null, [opt('a'), opt('b')]);
  const cases: Array<[string, RuleDef, { op: string; value: unknown }, unknown]> = [
    ['text eq', def('text'), { op: 'eq', value: 'x' }, { customFields: { path, equals: 'x' } }],
    ['text contains is case-insensitive', def('text'), { op: 'contains', value: 'x' }, { customFields: { path, string_contains: 'x', mode: 'insensitive' } }],
    ['number eq', def('number'), { op: 'eq', value: 3 }, { customFields: { path, equals: 3 } }],
    ['number gte', def('number'), { op: 'gte', value: 3 }, { customFields: { path, gte: 3 } }],
    ['number lt', def('number'), { op: 'lt', value: 3 }, { customFields: { path, lt: 3 } }],
    ['date gt', def('date'), { op: 'gt', value: '2027-01-01' }, { customFields: { path, gt: '2027-01-01' } }],
    ['date eq', def('date'), { op: 'eq', value: '2027-01-01' }, { customFields: { path, equals: '2027-01-01' } }],
    ['boolean eq', def('boolean'), { op: 'eq', value: true }, { customFields: { path, equals: true } }],
    ['select eq', sel, { op: 'eq', value: 'a' }, { customFields: { path, equals: 'a' } }],
    ['select in', sel, { op: 'in', value: ['a', 'b'] }, { OR: [{ customFields: { path, equals: 'a' } }, { customFields: { path, equals: 'b' } }] }],
    ['multiselect has', def('multiselect', null, [opt('a')]), { op: 'has', value: 'a' }, { customFields: { path, array_contains: ['a'] } }],
  ];
  it.each(cases)('%s', (_n, d, f, expected) => {
    expect(filterCondition(d, f as never)).toEqual(expected);
  });

  it.each([
    ['operator that does not fit the type', def('boolean'), { op: 'gt', value: true }],
    ['contains on a number', def('number'), { op: 'contains', value: 3 }],
    ['text value of the wrong type', def('text'), { op: 'eq', value: 3 }],
    ['empty text', def('text'), { op: 'contains', value: '' }],
    ['number value as text', def('number'), { op: 'gt', value: '3' }],
    ['not a calendar date', def('date'), { op: 'gt', value: '2027-02-30' }],
    ['unknown select option', sel, { op: 'eq', value: 'zz' }],
    ['select in with an unknown option', sel, { op: 'in', value: ['a', 'zz'] }],
    ['select in with a single value', sel, { op: 'in', value: 'a' }],
    ['multiselect eq', def('multiselect', null, [opt('a')]), { op: 'eq', value: 'a' }],
    ['multiselect unknown option', def('multiselect', null, [opt('a')]), { op: 'has', value: 'zz' }],
  ])('refuses: %s', (_n, d, f) => {
    expect(filterCondition(d, f as never)).toBeNull();
  });
});

describe('shared schemas', () => {
  const base = { entityType: 'Race', key: 'ticket_colour', label, type: 'text' };
  it.each([
    ['a plain text field', { ...base }, true],
    ['key with a capital', { ...base, key: 'Ticket' }, false],
    ['key starting with a digit', { ...base, key: '1abc' }, false],
    ['key too long', { ...base, key: 'a'.repeat(41) }, false],
    ['unknown entity', { ...base, entityType: 'Booking' }, false],
    ['label without en-AU', { ...base, label: { 'fr-FR': 'x' } }, false],
    ['select without options', { ...base, type: 'select' }, false],
    ['text with options', { ...base, options: [{ value: 'a', label }] }, false],
    ['select with options', { ...base, type: 'select', options: [{ value: 'a', label }] }, true],
    ['duplicate option values', { ...base, type: 'select', options: [{ value: 'a', label }, { value: 'a', label }] }, false],
    ['rule that does not fit the type', { ...base, validation: { min: 1 } }, false],
    ['minimum above maximum', { ...base, type: 'number', validation: { min: 5, max: 1 } }, false],
    ['earliest after latest', { ...base, type: 'date', validation: { minDate: '2027-02-01', maxDate: '2027-01-01' } }, false],
    ['customer edits but cannot see', { ...base, editableByCustomer: true }, false],
    ['customer edits and sees', { ...base, editableByCustomer: true, visibleToCustomer: true }, true],
    ['unknown property', { ...base, price: 1 }, false],
  ])('create: %s', (_n, body, valid) => {
    expect(createCustomFieldSchema.safeParse(body).success).toBe(valid);
  });

  it('update cannot change the key, the type or the entity', () => {
    for (const bad of [{ key: 'x' }, { type: 'number' }, { entityType: 'Package' }]) expect(updateCustomFieldSchema.safeParse({ ...bad, version: 0 }).success).toBe(false);
    expect(updateCustomFieldSchema.safeParse({ required: true, version: 0 }).success).toBe(true);
  });

  it('the cf parameter is a JSON array of at most five filters', () => {
    const one = JSON.stringify([{ key: 'a', op: 'eq', value: 'x' }]);
    expect(customFiltersParamSchema.safeParse(one).success).toBe(true);
    expect(customFiltersParamSchema.safeParse('not json').success).toBe(false);
    expect(customFiltersParamSchema.safeParse(JSON.stringify(Array(6).fill({ key: 'a', op: 'eq', value: 'x' }))).success).toBe(false);
    expect(customFiltersParamSchema.safeParse(JSON.stringify([{ key: 'a', op: 'drop', value: 'x' }])).success).toBe(false);
    expect(customFiltersParamSchema.safeParse(JSON.stringify([{ key: 'A b', op: 'eq', value: 'x' }])).success).toBe(false);
  });
});
