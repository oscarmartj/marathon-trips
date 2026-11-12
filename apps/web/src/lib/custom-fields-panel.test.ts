import { describe, expect, it } from 'vitest';
import type { CustomFieldDefinitionView, CustomFieldType } from '@mt/shared';
import { buildFilter, customFieldPatch, definitionBody, definitionFormValues, filterParam, initialValues, offeredOptions, optionLines, parseOptionLines, parseValue, suggestKey, updateDefinitionBody } from './custom-fields-panel';

const def = (key: string, type: CustomFieldType, extra: Partial<CustomFieldDefinitionView> = {}): CustomFieldDefinitionView => ({
  id: key, entityType: 'Race', key, label: { 'en-AU': key }, type, options: null, validation: null, required: false, visibleToCustomer: false, editableByCustomer: false, displayOrder: 0, archivedAt: null, version: 0, ...extra,
});
const choice = def('size', 'select', { options: [{ value: 's', label: { 'en-AU': 'Small' } }, { value: 'old', label: { 'en-AU': 'Old' }, retired: true }] });
const defs = [def('note', 'text'), def('count', 'number'), def('day', 'date'), def('flag', 'boolean'), choice, def('tags', 'multiselect', { options: [{ value: 'a', label: { 'en-AU': 'A' } }] })];

describe('form state', () => {
  it('starts from the stored values and is empty for a new record', () => {
    expect(initialValues(defs, { note: 'hi', count: 3, flag: false, size: 's', tags: ['a'] })).toEqual({ note: 'hi', count: '3', day: '', flag: 'false', size: 's', tags: ['a'] });
    expect(initialValues(defs, undefined)).toEqual({ note: '', count: '', day: '', flag: '', size: '', tags: [] });
    expect(initialValues(defs, [])).toEqual({ note: '', count: '', day: '', flag: '', size: '', tags: [] });
  });

  it.each([
    ['text', 'text', '  hi ', 'hi'],
    ['blank text', 'text', '   ', null],
    ['number', 'number', '12.5', 12.5],
    ['negative number', 'number', '-4', -4],
    ['number with a comma', 'number', '1,5', undefined],
    ['number with text', 'number', '1e3', undefined],
    ['true', 'boolean', 'true', true],
    ['false', 'boolean', 'false', false],
    ['boolean not set', 'boolean', '', null],
    ['boolean nonsense', 'boolean', 'maybe', undefined],
    ['date', 'date', '2027-01-02', '2027-01-02'],
  ] as const)('parses a %s', (_n, type, raw, expected) => {
    expect(parseValue({ type }, raw)).toBe(expected);
  });

  it('parses a multiselect and treats an empty list as no value', () => {
    expect(parseValue({ type: 'multiselect' }, ['a', 'b'])).toEqual(['a', 'b']);
    expect(parseValue({ type: 'multiselect' }, [])).toBeNull();
  });

  it('retired options are offered only to a record that holds them', () => {
    expect(offeredOptions(choice, '').map((o) => o.value)).toEqual(['s']);
    expect(offeredOptions(choice, 'old').map((o) => o.value)).toEqual(['s', 'old']);
  });
});

describe('customFieldPatch', () => {
  const form = { note: 'hi', count: '3', day: '', flag: 'true', size: '', tags: ['a'] };
  it('on a new record sends every field that has a value', () => {
    expect(customFieldPatch(defs, form, undefined, true)).toEqual({ patch: { note: 'hi', count: 3, flag: true, tags: ['a'] }, invalid: [] });
  });
  it('on an existing record sends only what changed, and null for what was cleared', () => {
    const stored = { note: 'hi', count: 3, flag: true, tags: ['a'], size: 's' };
    expect(customFieldPatch(defs, form, stored, false)).toEqual({ patch: { size: null }, invalid: [] });
    expect(customFieldPatch(defs, { ...form, note: 'new' }, { ...stored, size: undefined }, false).patch).toEqual({ note: 'new' });
  });
  it('sends nothing when nothing changed, and lists the fields it could not read', () => {
    expect(customFieldPatch(defs, { note: '', count: '', day: '', flag: '', size: '', tags: [] }, {}, false)).toEqual({ patch: undefined, invalid: [] });
    expect(customFieldPatch(defs, { ...form, count: 'many', flag: 'maybe' }, undefined, true).invalid).toEqual(['count', 'flag']);
  });
});

describe('filters', () => {
  it('builds a filter from what was typed', () => {
    expect(buildFilter(def('n', 'number'), 'gte', '3')).toEqual({ key: 'n', op: 'gte', value: 3 });
    expect(buildFilter(def('b', 'boolean'), 'eq', 'true')).toEqual({ key: 'b', op: 'eq', value: true });
    expect(buildFilter(def('t', 'text'), 'contains', ' dawn ')).toEqual({ key: 't', op: 'contains', value: 'dawn' });
    expect(buildFilter(choice, 'in', 's, old')).toEqual({ key: 'size', op: 'in', value: ['s', 'old'] });
    expect(buildFilter(def('m', 'multiselect'), 'has', 'a')).toEqual({ key: 'm', op: 'has', value: 'a' });
  });
  it.each([
    ['an operator the type does not take', def('b', 'boolean'), 'gt', 'true'],
    ['a blank value', def('t', 'text'), 'eq', '  '],
    ['a number that is not one', def('n', 'number'), 'eq', 'abc'],
    ['a boolean that is not one', def('b', 'boolean'), 'eq', 'yes'],
    ['an empty list', choice, 'in', ' , '],
  ])('leaves the filter off for %s', (_n, d, op, raw) => {
    expect(buildFilter(d, op, raw)).toBeNull();
  });
  it('has no parameter without filters', () => {
    expect(filterParam([])).toBeNull();
    expect(filterParam([{ key: 'a', op: 'eq', value: 'x' }])).toBe('[{"key":"a","op":"eq","value":"x"}]');
  });
});

describe('option lines', () => {
  it('round trip, keeping other languages and the retired flag', () => {
    const previous = [{ value: 's', label: { 'en-AU': 'Small', 'fr-FR': 'Petit' } }];
    const text = 's | Small\nold | Old | retired';
    const res = parseOptionLines(text, previous);
    expect(res).toEqual({ ok: true, options: [{ value: 's', label: { 'en-AU': 'Small', 'fr-FR': 'Petit' } }, { value: 'old', label: { 'en-AU': 'Old' }, retired: true }] });
    if (res.ok) expect(optionLines(res.options)).toBe(text);
  });
  it.each([
    ['nothing', '', 'empty'],
    ['a line with no label', 's', 'format'],
    ['an unknown flag', 's | Small | gone', 'format'],
    ['too many parts', 's | a | retired | x', 'format'],
    ['a value with capitals', 'Small | Small', 'value'],
    ['a repeated value', 's | A\ns | B', 'duplicate'],
  ])('rejects %s', (_n, text, code) => {
    expect(parseOptionLines(text)).toEqual({ ok: false, code });
  });
  it('suggests a key from a label', () => {
    expect(suggestKey('Bib colour!')).toBe('bib_colour');
    expect(suggestKey('2027 theme')).toBe('f_2027_theme');
    expect(suggestKey('  ')).toBe('');
    expect(suggestKey('x'.repeat(60)).length).toBe(40);
  });
});

describe('settings forms', () => {
  const create = (over: Record<string, string | boolean> = {}) => ({ label: 'Bib colour', key: '', type: 'text', options: '', required: false, visibleToCustomer: false, displayOrder: '', maxLength: '', ...over });

  it('builds a definition with a suggested key and only the limits of its type', () => {
    expect(definitionBody(create({ maxLength: '20', min: '5' }), 'Race')).toEqual({
      ok: true,
      body: { entityType: 'Race', key: 'bib_colour', label: { 'en-AU': 'Bib colour' }, type: 'text', required: false, visibleToCustomer: false, editableByCustomer: false, displayOrder: 0, validation: { maxLength: 20 } },
    });
  });
  it('reads options for a select and refuses bad ones', () => {
    const ok = definitionBody(create({ type: 'select', options: 'a | Alpha\nb | Beta' }), 'Package');
    expect(ok.ok && ok.body.options).toEqual([{ value: 'a', label: { 'en-AU': 'Alpha' } }, { value: 'b', label: { 'en-AU': 'Beta' } }]);
    expect(definitionBody(create({ type: 'select', options: '' }), 'Package')).toEqual({ ok: false, code: 'options' });
  });
  it('never marks a supplier field visible to customers, and never editable by them', () => {
    const res = definitionBody(create({ visibleToCustomer: true }), 'Supplier');
    expect(res.ok && res.body.visibleToCustomer).toBe(false);
    const race = definitionBody(create({ visibleToCustomer: true }), 'Race');
    expect(race.ok && race.body.editableByCustomer).toBe(false);
  });
  it.each([
    ['no label', { label: '  ' }, 'label'],
    ['no usable key', { label: '!!!' }, 'key'],
    ['a limit that is not a number', { type: 'number', min: 'ten' }, 'rule'],
    ['a length that is not whole', { maxLength: '2.5' }, 'rule'],
    ['a date limit with the wrong shape', { type: 'date', minDate: '1/2/2027' }, 'rule'],
  ])('refuses %s', (_n, over, code) => {
    expect(definitionBody(create(over), 'Race')).toEqual({ ok: false, code });
  });

  it('edits a definition: label keeps other languages, limits can be cleared, key and type are not sent', () => {
    const d = def('size', 'number', { label: { 'en-AU': 'Size', 'fr-FR': 'Taille' }, validation: { min: 1, integer: true }, version: 4 });
    const values = definitionFormValues(d);
    expect(values).toMatchObject({ label: 'Size', min: '1', max: '', integer: true });
    const res = updateDefinitionBody(d, { ...values, min: '', integer: false, label: 'Shoe size' });
    expect(res).toEqual({ ok: true, body: { label: { 'en-AU': 'Shoe size', 'fr-FR': 'Taille' }, required: false, visibleToCustomer: false, displayOrder: 0, version: 4, validation: {} } });
    expect(res.ok && Object.keys(res.body)).not.toContain('key');
    expect(res.ok && Object.keys(res.body)).not.toContain('type');
  });
});

describe('a field called "constructor" never reads an inherited value', () => {
  const odd = [def('constructor', 'text'), def('constructor', 'multiselect', { id: 'c2' })];
  it('the form starts empty, not with "function Object() { [native code] }"', () => {
    expect(initialValues([odd[0]!], {})).toEqual({ constructor: '' });
    expect(initialValues([odd[1]!], {})).toEqual({ constructor: [] });
    expect(initialValues([odd[0]!], undefined)).toEqual({ constructor: '' });
    expect(initialValues([odd[0]!], { constructor: 'mine' })).toEqual({ constructor: 'mine' });
  });

  it('an untouched new record sends nothing, and a cleared stored value sends null', () => {
    const empty = initialValues([odd[0]!], {});
    expect(customFieldPatch([odd[0]!], empty, {}, true)).toEqual({ patch: undefined, invalid: [] });
    expect(customFieldPatch([odd[0]!], { constructor: '' }, { constructor: 'mine' }, false).patch).toEqual({ constructor: null });
    expect(customFieldPatch([odd[0]!], {}, {}, true)).toEqual({ patch: undefined, invalid: [] });
  });

  it('a label that suggests that key gets a different one', () => {
    expect(suggestKey('Constructor')).toBe('constructor_field');
    expect(suggestKey('Constructor notes')).toBe('constructor_notes');
  });
});
