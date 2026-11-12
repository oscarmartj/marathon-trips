import { describe, expect, it } from 'vitest';
import { filtersToSearch, parseFilters, racesHref } from './catalogue';

describe('race finder filters', () => {
  it('reads every filter from the URL and writes them back unchanged (so a reload keeps them)', () => {
    const params = { q: 'sydney', distance: 'half', type: 'road', month: '5', country: 'au', year: '2027', page: '2' };
    const filters = parseFilters(params);
    expect(filters).toEqual({ q: 'sydney', distance: 'half', type: 'road', month: '5', country: 'AU', year: '2027', page: 2 });
    expect(parseFilters(Object.fromEntries(new URLSearchParams(filtersToSearch(filters))))).toEqual(filters);
  });

  it('combines filters into one query string in a stable order', () => {
    expect(filtersToSearch({ month: '5', distance: 'marathon', country: 'NZ' })).toBe('distance=marathon&month=5&country=NZ');
    expect(racesHref({})).toBe('/races');
    expect(racesHref({ distance: 'half', page: 3 })).toBe('/races?distance=half&page=3');
  });

  it('drops unknown or invalid values instead of passing them to the API', () => {
    expect(parseFilters({ distance: 'sprint', month: '13', country: 'AUS', year: '1999', type: 'x', q: '  ', page: '0', other: 'a' })).toEqual({});
    expect(parseFilters({ month: ['3', '4'] })).toEqual({ month: '3' });
  });

  it('never sends page 1 or empty values', () => {
    expect(filtersToSearch({ q: '', page: 1 })).toBe('');
  });
});
