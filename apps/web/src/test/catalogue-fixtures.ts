import { vi } from 'vitest';
import type { RaceDetail, RaceSearchResult, RaceSummary } from '@/lib/catalogue';

export const SLUG = 'sample-marathon';

const base = {
  slug: SLUG, name: { 'en-AU': 'Sample Marathon' }, countryCode: 'NZ', city: 'Rotorua', raceType: 'road', typicalMonth: 5,
  summary: { 'en-AU': 'A fast, flat road course around the lake.' }, websiteUrl: 'https://example.org/race',
  distances: [{ id: 'd1', kind: 'marathon', distanceMetres: 42195, name: {} }, { id: 'd2', kind: 'half', distanceMetres: 21097, name: {} }],
  claims: [] as string[],
};
const edition = { year: 2027, startDate: '2027-05-01', endDate: null, dateStatus: 'confirmed', dateConfirmed: true, status: 'announced' };

export const summary = (over: Partial<RaceSummary> = {}): RaceSummary => ({ ...base, editions: [edition], ...over });

export const detail = (over: Partial<RaceDetail> = {}): RaceDetail => ({
  ...base,
  editions: [{
    ...edition, notes: {},
    packages: [{ id: 'p1', slug: 'classic', name: { 'en-AU': 'Classic weekend' }, saleStatus: 'open', checkInDate: '2027-04-29', checkOutDate: '2027-05-03', currency: 'AUD', guaranteedEntry: false }],
  }],
  ...over,
});

/** Stubs the global fetch with the public catalogue API; `calls` records the URLs asked for. */
export function stubCatalogue(options: { search?: RaceSearchResult; race?: RaceDetail | null; status?: number } = {}) {
  const calls: string[] = [];
  const search = options.search ?? { items: [summary()], page: 1, pageSize: 12, total: 1 };
  const race = options.race === undefined ? detail() : options.race;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (options.status) return new Response('{}', { status: options.status });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (/\/catalogue\/races\?/.test(url)) return json(search);
    if (/\/catalogue\/races\/[^/?]+$/.test(url)) return race ? json(race) : json({ code: 'race_not_found' }, 404);
    return json({}, 404);
  }));
  return calls;
}
