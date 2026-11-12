import { vi } from 'vitest';
import type { PackageDetail, RaceDetail, RaceSearchResult, RaceSummary } from '@/lib/catalogue';
import type { PublicBanner, PublicFaq, PublicGuide, PublicMenu, PublicPage } from '@/lib/content';
import type { RedirectRule } from '@/lib/redirects';

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

export const ROOM_TWIN = '11111111-1111-4111-8111-111111111111';
export const ROOM_SINGLE = '22222222-2222-4222-8222-222222222222';
export const EXTRA_TOUR = '33333333-3333-4333-8333-333333333333';
export const EXTRA_PASTA = '44444444-4444-4444-8444-444444444444';
export const EXTRA_TRANSFER = '55555555-5555-4555-8555-555555555555';
export const DIST_MARATHON = '66666666-6666-4666-8666-666666666666';
export const DIST_HALF = '77777777-7777-4777-8777-777777777777';

/** A package as the public catalogue API returns it: two rooms, three extras (one mandatory), two entry distances. */
export const packageDetail = (over: Partial<PackageDetail> = {}): PackageDetail => ({
  id: '88888888-8888-4888-8888-888888888888', slug: 'classic', name: { 'en-AU': 'Classic weekend' }, saleStatus: 'open', currency: 'AUD',
  race: { slug: SLUG, name: { 'en-AU': 'Sample Marathon' }, claims: [] },
  edition: { year: 2027, startDate: '2027-05-01', dateStatus: 'confirmed', dateConfirmed: true },
  checkInDate: '2027-04-29', checkOutDate: '2027-05-03', nights: 4, includes: {}, excludes: {}, instantBooking: false, balanceDueDate: '2027-03-01',
  minTravellers: 1, maxTravellers: 4, maxExtraNightsBefore: 2, maxExtraNightsAfter: 3, participation: ['runner_with_entry', 'runner_own_entry', 'supporter'], guaranteedEntry: false,
  entries: [
    { id: 'e1', distance: { id: DIST_MARATHON, kind: 'marathon', distanceMetres: 42195, name: {} }, availability: 'available' },
    { id: 'e2', distance: { id: DIST_HALF, kind: 'half', distanceMetres: 21097, name: {} }, availability: 'none' },
  ],
  hotels: [{
    id: 'h1', name: 'Lakeside Hotel', address: '1 Lake Rd', city: 'Rotorua', countryCode: 'NZ', starRating: 4, description: {},
    rooms: [
      { id: ROOM_TWIN, roomType: 'twin', name: { 'en-AU': 'Twin room' }, minOccupancy: 1, maxOccupancy: 2, availability: 'low' },
      { id: ROOM_SINGLE, roomType: 'single', name: { 'en-AU': 'Single room' }, minOccupancy: 1, maxOccupancy: 1, availability: 'none' },
    ],
  }],
  extras: [
    { id: EXTRA_TOUR, kind: 'excursion', name: { 'en-AU': 'Geothermal tour' }, description: {}, pricingUnit: 'per_person', availableTo: 'all', mandatory: false, maxPerBooking: null, availability: 'available' },
    { id: EXTRA_PASTA, kind: 'meal', name: { 'en-AU': 'Pasta party' }, description: {}, pricingUnit: 'per_person', availableTo: 'runners', mandatory: false, maxPerBooking: null, availability: 'available' },
    { id: EXTRA_TRANSFER, kind: 'transfer', name: { 'en-AU': 'Airport transfer' }, description: {}, pricingUnit: 'per_booking', availableTo: 'all', mandatory: true, maxPerBooking: 1, availability: 'available' },
  ],
  ...over,
});

/** Stubs the global fetch with the public catalogue API; `calls` records the URLs asked for. */
export interface ContentStub {
  pages?: Record<string, PublicPage>;
  guides?: Record<string, PublicGuide>;
  faqs?: PublicFaq[];
  banners?: PublicBanner[];
  menu?: Partial<PublicMenu>;
  redirects?: RedirectRule[];
}

export const contentPage = (over: Partial<PublicPage> = {}): PublicPage => ({
  slug: SLUG, locale: 'en-AU', kind: 'general', title: 'A page from the content manager', intro: 'Its introduction.', body: 'First paragraph.\n\nSecond paragraph.',
  seoTitle: '', seoDescription: '', legalReviewPending: false, publishedAt: '2027-01-01T00:00:00.000Z', updatedAt: '2027-01-02T00:00:00.000Z', heroMedia: null, ...over,
});

export const contentGuide = (over: Partial<PublicGuide> = {}): PublicGuide => ({
  raceSlug: SLUG, locale: 'en-AU', course: 'Out and back along the lake.', climate: 'Cool mornings in May.', entry: 'Entries open in January.', travelTips: 'Fly into Auckland.',
  seoTitle: '', seoDescription: '', publishedAt: '2027-01-01T00:00:00.000Z', updatedAt: '2027-01-02T00:00:00.000Z', heroMedia: null, ...over,
});

/** Stubs the global fetch with the public catalogue API and the public content API; `calls` records the URLs asked for. */
export function stubCatalogue(options: { search?: RaceSearchResult; race?: RaceDetail | null; status?: number; pkg?: PackageDetail | null; content?: ContentStub } = {}) {
  const calls: string[] = [];
  const search = options.search ?? { items: [summary()], page: 1, pageSize: 12, total: 1 };
  const race = options.race === undefined ? detail() : options.race;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (/\/content\//.test(url)) {
      const c = options.content ?? {};
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
      if (/\/content\/pages\/[^/?]+/.test(url)) {
        // The sample slug is a published general page unless the test says otherwise; every other slug has none.
        const pages = c.pages ?? { [SLUG]: contentPage() };
        return pages[last] ? json(pages[last]) : json({ code: 'not_found' }, 404);
      }
      if (/\/content\/pages(\?|$)/.test(url)) return json({ items: Object.values(c.pages ?? {}).filter((p) => p.kind === 'general').map((p) => ({ slug: p.slug, title: p.title, updatedAt: p.updatedAt })) });
      if (/\/content\/guides\//.test(url)) return c.guides?.[last] ? json(c.guides[last]) : json({ code: 'not_found' }, 404);
      if (/\/content\/faqs/.test(url)) return json({ items: c.faqs ?? [] });
      if (/\/content\/banners/.test(url)) return json({ items: c.banners ?? [] });
      if (/\/content\/menu/.test(url)) return json({ header: [], footer_company: [], footer_legal: [], ...c.menu });
      if (/\/content\/redirects/.test(url)) return json({ items: c.redirects ?? [] });
      return json({}, 404);
    }
    if (options.status) return new Response('{}', { status: options.status });
    if (/\/catalogue\/races\?/.test(url)) return json(search);
    if (/\/editions\/\d+\/packages\/[^/?]+$/.test(url)) return options.pkg === null ? json({ code: 'package_not_found' }, 404) : json(options.pkg ?? packageDetail());
    if (/\/catalogue\/races\/[^/?]+$/.test(url)) return race ? json(race) : json({ code: 'race_not_found' }, 404);
    return json({}, 404);
  }));
  return calls;
}
