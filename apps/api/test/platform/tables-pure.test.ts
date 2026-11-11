import { describe, expect, it } from 'vitest';
import { CsvParseError, cell, guardCell, parseCsv, toCsv, unguardCell } from '../../src/platform/common/csv';
import { buildWhere, filterToWhere, sortToOrderBy, validateQuery } from '../../src/platform/common/query';
import { toTsQuery } from '../../src/platform/common/search.service';
import type { TableDef } from '../../src/platform/common/table-def';

const def: TableDef = {
  entityType: 'Thing', model: 'Task', permissions: { read: 'a.b.c', write: 'a.b.d' }, softDelete: true, versioned: true, taggable: false, notes: false,
  columns: [
    { key: 'title', type: 'text', sortable: true, filterable: true, searchable: true },
    { key: 'qty', type: 'number', sortable: true, filterable: true },
    { key: 'due', type: 'date', sortable: true, filterable: true, nullable: true },
    { key: 'ok', type: 'boolean', filterable: true },
    { key: 'status', type: 'enum', values: ['open', 'done'], filterable: true },
    { key: 'secret', type: 'text' },
  ],
};
const base = { filters: [], sort: [], tagIds: [], tagMode: 'any' as const, deleted: 'exclude' as const };

describe('csv escaping', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"], ['+1', "'+1"], ['-1 apples', "'-1 apples"], ['@cmd', "'@cmd"], ['\tTab', "'\tTab"], ['\rCR', "'\rCR"],
    ['plain', 'plain'], ['a-b', 'a-b'], ['1=1', '1=1'],
  ])('formula_guard_%s', (input, expected) => {
    expect(guardCell(input)).toBe(expected);
    expect(unguardCell(guardCell(input))).toBe(input);
  });

  it('numbers_and_dates_are_written_natively_so_negatives_are_not_guarded', () => {
    expect(cell(-5)).toBe('-5');
    expect(cell(new Date('2026-11-12T00:00:00.000Z'))).toBe('2026-11-12T00:00:00.000Z');
    expect(cell(null)).toBe('');
  });

  it('quotes_commas_quotes_and_newlines', () => {
    expect(cell('a,b')).toBe('"a,b"');
    expect(cell('say "hi"')).toBe('"say ""hi"""');
    expect(cell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('round_trips_awkward_text_including_accents', () => {
    const rows = [['=cmd|\' /C calc\'!A0', 'a,b', 'say "x"', 'línea\nnueva', 'Óscar — ñandú', '']];
    const text = toCsv(['a', 'b', 'c', 'd', 'e', 'f'], rows);
    expect(text.startsWith('﻿')).toBe(true);
    const parsed = parseCsv(text);
    expect(parsed[0]).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(parsed[1]!.map(unguardCell)).toEqual(rows[0]);
  });
});

describe('csv parsing', () => {
  it('handles_crlf_lf_blank_lines_and_a_missing_final_newline', () => {
    expect(parseCsv('a,b\r\n1,2\n\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it.each([['a,"b\n'], ['a,"b"c\n'], ['a,b"c"\n']])('rejects_bad_quotes_%#', (input) => {
    expect(() => parseCsv(input)).toThrow(CsvParseError);
  });
  it('rejects_an_empty_file', () => {
    expect(() => parseCsv('')).toThrow(CsvParseError);
  });
});

describe('query builder', () => {
  it('maps_every_operator_by_type', () => {
    expect(filterToWhere(def, { field: 'title', op: 'contains', value: 'x' })).toEqual({ title: { contains: 'x', mode: 'insensitive' } });
    expect(filterToWhere(def, { field: 'qty', op: 'gte', value: 3 })).toEqual({ qty: { gte: 3 } });
    expect(filterToWhere(def, { field: 'status', op: 'in', value: ['open', 'done'] })).toEqual({ status: { in: ['open', 'done'] } });
    expect(filterToWhere(def, { field: 'due', op: 'empty' })).toEqual({ due: null });
    expect(filterToWhere(def, { field: 'ok', op: 'eq', value: true })).toEqual({ ok: true });
    expect(filterToWhere(def, { field: 'due', op: 'lt', value: '2026-01-01' })).toEqual({ due: { lt: new Date('2026-01-01') } });
  });

  it.each([
    ['unknown_field', { field: 'nope', op: 'eq', value: 1 }],
    ['field_not_in_whitelist_for_filtering', { field: 'secret', op: 'eq', value: 'x' }],
    ['operator_not_for_type', { field: 'qty', op: 'contains', value: 'x' }],
    ['text_given_for_number', { field: 'qty', op: 'eq', value: 'x' }],
    ['enum_outside_values', { field: 'status', op: 'eq', value: 'nope' }],
    ['bad_date', { field: 'due', op: 'gt', value: 'tomorrow' }],
    ['in_without_list', { field: 'status', op: 'in', value: 'open' }],
  ] as const)('rejects_%s', (_n, f) => {
    expect(() => filterToWhere(def, f as never)).toThrow();
  });

  it('sort_is_whitelisted_and_ends_with_the_id_tie_break', () => {
    expect(sortToOrderBy(def, [{ field: 'qty', dir: 'desc' }])).toEqual([{ qty: 'desc' }, { id: 'asc' }]);
    expect(sortToOrderBy(def, [{ field: 'due', dir: 'asc' }])[0]).toEqual({ due: { sort: 'asc', nulls: 'last' } });
    expect(() => sortToOrderBy(def, [{ field: 'secret', dir: 'asc' }])).toThrow();
  });

  it('combines_q_filters_deleted_and_tag_ids_with_and', () => {
    const w = buildWhere(def, { ...base, q: 'abc', filters: [{ field: 'qty', op: 'gt', value: 1 }] }, ['id1']) as { AND: unknown[] };
    expect(w.AND).toHaveLength(4);
    expect(buildWhere(def, { ...base, deleted: 'include' }, null)).toEqual({});
    expect(() => validateQuery({ ...def, softDelete: false }, { ...base, deleted: 'only' })).toThrow();
  });
});

describe('search query', () => {
  it('builds_a_prefix_query_from_letters_and_digits_only', () => {
    expect(toTsQuery('mel mar')).toBe('mel:* & mar:*');
    expect(toTsQuery("o'brien; DROP TABLE x --")).toBe("o:* & brien:* & DROP:* & TABLE:* & x:*");
    expect(toTsQuery('!!!')).toBeNull();
    expect(toTsQuery('Óscar')).toBe('Óscar:*');
  });
});
