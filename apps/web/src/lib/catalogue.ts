import { apiBase } from './api-proxy';

/** What the public catalogue API returns (apps/api/src/modules/catalogue/public.service.ts). The web only displays it. */
export interface Distance { id: string; kind: string; distanceMetres: number; name: Record<string, string> }
export interface EditionSummary { year: number; startDate: string | null; endDate: string | null; dateStatus: string; dateConfirmed: boolean; status: string }
export interface RaceSummary {
  slug: string; name: Record<string, string>; countryCode: string; city: string; raceType: string; typicalMonth: number | null;
  summary: Record<string, string>; websiteUrl: string | null; distances: Distance[]; claims: string[]; editions: EditionSummary[];
}
export interface PackageSummary { id: string; slug: string; name: Record<string, string>; saleStatus: string; checkInDate: string; checkOutDate: string; currency: string; guaranteedEntry: boolean }
export interface EditionDetail extends EditionSummary { notes: Record<string, string>; packages: PackageSummary[] }
export interface RaceDetail extends Omit<RaceSummary, 'editions'> { editions: EditionDetail[] }
export type Availability = 'available' | 'low' | 'none';
export interface PackageRoom { id: string; roomType: string; name: Record<string, string>; minOccupancy: number; maxOccupancy: number; availability: Availability }
export interface PackageHotel { id: string; name: string; address: string; city: string; countryCode: string; starRating: number | null; description: Record<string, string>; rooms: PackageRoom[] }
export interface PackageExtra {
  id: string; kind: string; name: Record<string, string>; description: Record<string, string>; pricingUnit: 'per_person' | 'per_booking';
  availableTo: 'all' | 'runners' | 'supporters'; mandatory: boolean; maxPerBooking: number | null; availability: Availability;
}
export interface PackageEntry { id: string; distance: Distance; availability: Availability }
/** One package as the public catalogue API returns it (apps/api/src/modules/catalogue/public.service.ts, packageView). */
export interface PackageDetail {
  id: string; slug: string; name: Record<string, string>; saleStatus: string; currency: string;
  race: { slug: string; name: Record<string, string>; claims: string[] };
  edition: { year: number; startDate: string | null; dateStatus: string; dateConfirmed: boolean };
  checkInDate: string; checkOutDate: string; nights: number; includes: Record<string, string>; excludes: Record<string, string>;
  instantBooking: boolean; balanceDueDate: string | null; minTravellers: number; maxTravellers: number; maxExtraNightsBefore: number; maxExtraNightsAfter: number;
  participation: string[]; guaranteedEntry: boolean; entries: PackageEntry[]; hotels: PackageHotel[]; extras: PackageExtra[];
}
export interface RaceSearchResult { items: RaceSummary[]; page: number; pageSize: number; total: number }

/** The filters of the race finder. Each one maps to a query parameter the API understands. */
export const FILTER_KEYS = ['q', 'distance', 'type', 'month', 'country', 'year'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type RaceFilters = Partial<Record<FilterKey, string>> & { page?: number };

export const DISTANCE_KINDS = ['marathon', 'half', 'ten_k', 'five_k', 'ultra', 'other'] as const;
export const RACE_TYPES = ['road', 'trail', 'ultra', 'other'] as const;
export const PAGE_SIZE = 12;

const ALLOWED: Record<string, (v: string) => boolean> = {
  q: (v) => v.length >= 1 && v.length <= 80,
  distance: (v) => (DISTANCE_KINDS as readonly string[]).includes(v),
  type: (v) => (RACE_TYPES as readonly string[]).includes(v),
  month: (v) => /^([1-9]|1[0-2])$/.test(v),
  country: (v) => /^[A-Z]{2}$/.test(v),
  year: (v) => /^20\d{2}$/.test(v),
};

/** Reads filters from the page's search parameters. Anything unknown or invalid is dropped, so a bad link never breaks the page. */
export function parseFilters(params: Record<string, string | string[] | undefined>): RaceFilters {
  const out: RaceFilters = {};
  for (const key of FILTER_KEYS) {
    const raw = params[key];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    const normalised = key === 'country' ? value?.toUpperCase() : value;
    if (normalised && ALLOWED[key]!(normalised)) out[key] = normalised;
  }
  const page = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  if (Number.isInteger(page) && page > 1 && page <= 1000) out.page = page;
  return out;
}

/** The query string for a set of filters (empty values left out, in a stable order), used for both the API and the page URL. */
export function filtersToSearch(filters: RaceFilters, extra: { pageSize?: number } = {}): string {
  const sp = new URLSearchParams();
  for (const key of FILTER_KEYS) if (filters[key]) sp.set(key, filters[key]!);
  if (filters.page && filters.page > 1) sp.set('page', String(filters.page));
  if (extra.pageSize) sp.set('pageSize', String(extra.pageSize));
  return sp.toString();
}

export function racesHref(filters: RaceFilters): string {
  const qs = filtersToSearch(filters);
  return qs ? `/races?${qs}` : '/races';
}

/** Thrown when the API cannot be reached or answers with an error, so Next does not cache an error page as if it were content. */
export class CatalogueUnavailableError extends Error {}

const REVALIDATE_SECONDS = 60;

async function getJson<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, { headers: { accept: 'application/json' }, next: { revalidate: REVALIDATE_SECONDS } });
  } catch (e) {
    throw new CatalogueUnavailableError(`Catalogue API unreachable: ${(e as Error).message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new CatalogueUnavailableError(`Catalogue API answered ${res.status}`);
  return (await res.json()) as T;
}

export async function searchRaces(filters: RaceFilters): Promise<RaceSearchResult> {
  const result = await getJson<RaceSearchResult>(`/catalogue/races?${filtersToSearch(filters, { pageSize: PAGE_SIZE })}`);
  if (!result) throw new CatalogueUnavailableError('Catalogue search returned 404');
  return result;
}

export const getRace = (slug: string): Promise<RaceDetail | null> => getJson<RaceDetail>(`/catalogue/races/${encodeURIComponent(slug)}`);

export const getPackage = (raceSlug: string, year: number, packageSlug: string): Promise<PackageDetail | null> =>
  getJson<PackageDetail>(`/catalogue/races/${encodeURIComponent(raceSlug)}/editions/${year}/packages/${encodeURIComponent(packageSlug)}`);

/** Slugs to build at deploy time. If the API is not up yet the list is empty and pages are built on first request instead. */
export async function listRaceSlugs(): Promise<string[]> {
  try {
    const result = await getJson<RaceSearchResult>('/catalogue/races?pageSize=50');
    return result?.items.map((r) => r.slug) ?? [];
  } catch {
    return [];
  }
}

/** Country codes for the filter, taken from the published races. The selected one is always kept so the form never loses it. */
export async function listCountryCodes(selected?: string): Promise<string[]> {
  let codes: string[] = [];
  try {
    const result = await getJson<RaceSearchResult>('/catalogue/races?pageSize=50');
    codes = result?.items.map((r) => r.countryCode) ?? [];
  } catch {
    codes = [];
  }
  if (selected) codes.push(selected);
  return [...new Set(codes)].sort();
}

/** The English (Australia) text of a localised value, falling back to any other language. */
export function localisedText(value: Record<string, string> | undefined): string {
  if (!value) return '';
  return value['en-AU'] ?? Object.values(value)[0] ?? '';
}
