import { describe, expect, it } from 'vitest';
import { emptyQuery, errText, queryBody, queryParams } from './shared';

describe('table query helpers', () => {
  it('builds_the_query_string_the_api_expects', () => {
    const q = { ...emptyQuery, q: ' mel ', filters: [{ field: 'status', op: 'eq', value: 'open' }], sort: [{ field: 'dueAt', dir: 'desc' as const }], tagIds: ['a', 'b'], tagMode: 'all' as const };
    const p = new URLSearchParams(queryParams(q, 2, 25));
    expect(p.get('q')).toBe('mel');
    expect(JSON.parse(p.get('filters')!)).toEqual(q.filters);
    expect(p.get('sort')).toBe('dueAt:desc');
    expect(p.get('tags')).toBe('a,b');
    expect([p.get('tagMode'), p.get('deleted'), p.get('page'), p.get('pageSize')]).toEqual(['all', 'exclude', '2', '25']);
  });

  it('leaves_out_an_empty_search_and_empty_lists', () => {
    const p = new URLSearchParams(queryParams(emptyQuery, 1, 25));
    expect(p.has('q') || p.has('filters') || p.has('sort') || p.has('tags')).toBe(false);
    expect(queryBody(emptyQuery).q).toBeUndefined();
  });

  it('uses_a_specific_message_for_known_codes_and_a_general_one_otherwise', () => {
    expect(errText({ status: 409, body: { code: 'version_conflict' } })).toMatch(/Someone else changed/);
    expect(errText({ status: 403, body: { code: 'something_new' } })).toBe(errText({ status: 403, body: {} }));
  });
});

describe('catalogue', () => {
  it('every_admin_table_key_used_in_components_exists', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { t } = await import('@/lib/i18n');
    const dir = __dirname;
    const keys = new Set<string>();
    for (const f of [...readdirSync(dir), '../global-search.tsx'].filter((x) => x.endsWith('.tsx'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\bt\(\s*'(admin\.(?:table|tasks)\.[A-Za-z.]+)'/g)) keys.add(m[1]!);
    }
    expect(keys.size).toBeGreaterThan(40);
    for (const k of keys) expect(() => t(k, { count: 1, from: 1, to: 1, total: 1, page: 1, pages: 1, title: 'x', label: 'x', name: 'x', field: 'x', op: 'x', value: 'x', ok: 1, rows: 1, columns: 'x', row: 1, column: 'x', message: 'x', reason: 'x', actor: 'x', time: 'x' }), k).not.toThrow();
  });
});
