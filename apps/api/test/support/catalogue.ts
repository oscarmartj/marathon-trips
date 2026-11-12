import { CATALOGUE_PERMISSIONS } from '../../src/modules/catalogue';
import { PRICING_PERMISSIONS } from '../../src/modules/pricing';
import { SALE_TRANSITIONS } from '../../src/modules/catalogue/transitions';
import { STATE_HEADERS, TestApp, createStaff, signInStaff } from './auth';

export const P = CATALOGUE_PERMISSIONS;
export const ALL_CATALOGUE_PERMISSIONS = Object.values(CATALOGUE_PERMISSIONS);
/** What the catalogue tests' admin can do: the catalogue, and pricing so that packages can open (2.1). */
export const CATALOGUE_AND_PRICING = [...ALL_CATALOGUE_PERMISSIONS, ...Object.values(PRICING_PERMISSIONS)];

let n = 0;
/** A slug that is unique per run, so tests never collide with leftovers in a shared database. */
export const slug = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(n++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export type Client = ReturnType<typeof clientFor>;

const clientFor = (t: TestApp, cookie: string) => ({
  get: (path: string) => t.http().get(path).set('Cookie', cookie),
  post: (path: string, body: object = {}) => t.http().post(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
  patch: (path: string, body: object) => t.http().patch(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
  put: (path: string, body: object) => t.http().put(path).set(STATE_HEADERS).set('Cookie', cookie).send(body),
  delete: (path: string) => t.http().delete(path).set(STATE_HEADERS).set('Cookie', cookie),
});

/** A staff client with the given permissions (all catalogue and pricing permissions by default). */
export async function staffClient(t: TestApp, permissions: string[] = CATALOGUE_AND_PRICING) {
  const staff = await createStaff(t, { permissions });
  return { ...clientFor(t, await signInStaff(t, staff)), staff };
}

export const anonymous = (t: TestApp) => ({ get: (path: string) => t.http().get(path) });

const text = (s: string) => ({ 'en-AU': s });

export const raceBody = (over: Record<string, unknown> = {}) => ({
  slug: slug('race'), name: text('Test Marathon'), countryCode: 'AU', city: 'Brisbane', timeZone: 'Australia/Brisbane', raceType: 'road', summary: text('A flat, fast marathon.'), ...over,
});

export const packageBody = (over: Record<string, unknown> = {}) => ({
  slug: slug('pkg'), name: text('Race weekend'), checkInDate: '2027-06-18', checkOutDate: '2027-06-21', balanceDueDate: '2027-04-18', maxTravellers: 4,
  deposit: { mode: 'per_person', amountMinor: '50000' }, ...over,
});

export interface World {
  race: { id: string; slug: string; version: number };
  edition: { id: string; year: number };
  distanceId: string;
  entryPoolId: string;
  roomPoolId: string;
  extraPoolId: string;
  pkg: { id: string; slug: string; version: number };
}

/**
 * Gives a package a published price version that prices everything it offers (each missing rate at `amountMinor`),
 * unless it already has one in force that is complete. Since 2.1 a package opens only with such a version.
 */
export async function pricePackageFully(admin: Client, packageId: string, amountMinor = '10000'): Promise<string> {
  const list = (await admin.get(`/admin/pricing/packages/${packageId}/price-versions`)).body;
  if (list.currentId) {
    const current = (await admin.get(`/admin/pricing/price-versions/${list.currentId}`)).body;
    if (current.missing.length === 0) return list.currentId as string;
  }
  const draft = (await admin.post(`/admin/pricing/packages/${packageId}/price-versions`, { label: 'Test prices', copyCurrent: true })).body;
  if (!draft.id) throw new Error(`create price version failed: ${JSON.stringify(draft)}`);
  const rooms = [...draft.rates.roomRates];
  const participation = [...draft.rates.participationRates];
  const extras = [...draft.rates.extraRates];
  for (const m of draft.missing as Array<Record<string, unknown>>) {
    if (m.kind === 'room') rooms.push({ roomOptionId: m.roomOptionId, occupancy: m.occupancy, pricePerPersonMinor: amountMinor, extraNightPerPersonMinor: amountMinor });
    if (m.kind === 'participation') participation.push({ participationType: m.participationType, raceDistanceId: m.raceDistanceId, amountPerPersonMinor: amountMinor });
    if (m.kind === 'extra') extras.push({ extraId: m.extraId, amountMinor });
  }
  const strip = <T extends Record<string, unknown>>(xs: T[]) => xs.map(({ currency: _c, ...x }) => x);
  const set = await admin.put(`/admin/pricing/price-versions/${draft.id}/rates`, { version: draft.version, roomRates: strip(rooms), participationRates: strip(participation), extraRates: strip(extras) });
  if (set.status !== 200) throw new Error(`set rates failed: ${set.status} ${JSON.stringify(set.body)}`);
  const pub = await admin.post(`/admin/pricing/price-versions/${draft.id}/publish`, { version: set.body.version });
  if (pub.status !== 200) throw new Error(`publish failed: ${pub.status} ${JSON.stringify(pub.body)}`);
  return draft.id as string;
}

/**
 * A race (draft), edition, distance, three pools and a draft package with an entry option, a hotel, a room and an extra,
 * with its prices published (unless `priced: false`).
 */
export async function buildWorld(admin: Client, opts: { year?: number; packageOver?: Record<string, unknown>; priced?: boolean } = {}): Promise<World> {
  const must = <T extends { status: number; body: unknown }>(r: T, what: string): T => {
    if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };
  const race = must(await admin.post('/admin/catalogue/races', raceBody()), 'create race').body;
  const year = opts.year ?? 2027;
  const edition = must(await admin.post(`/admin/catalogue/races/${race.id}/editions`, { year, startDate: `${year}-06-20`, endDate: `${year}-06-20`, dateStatus: 'confirmed' }), 'create edition').body;
  const distance = must(await admin.post(`/admin/catalogue/races/${race.id}/distances`, { kind: 'marathon', distanceMetres: 42195, name: text('Marathon') }), 'create distance').body;
  const pool = async (kind: string, capacity: number) =>
    must(await admin.post(`/admin/catalogue/editions/${edition.id}/pools`, { kind, label: `${kind} pool`, capacity, lowStockThreshold: 2 }), `create ${kind} pool`).body.id as string;
  const [entryPoolId, roomPoolId, extraPoolId] = [await pool('entry', 10), await pool('room', 10), await pool('extra', 10)];
  const pkg = must(await admin.post(`/admin/catalogue/editions/${edition.id}/packages`, packageBody(opts.packageOver)), 'create package').body;
  must(await admin.post(`/admin/catalogue/packages/${pkg.id}/entry-options`, { raceDistanceId: distance.id, entryPoolId }), 'entry option');
  const hotel = must(await admin.post('/admin/catalogue/hotels', { name: 'Riverside Hotel', address: '1 Main Street', city: 'Brisbane', countryCode: 'AU', starRating: 4 }), 'create hotel').body;
  const linked = must(await admin.post(`/admin/catalogue/packages/${pkg.id}/hotels`, { hotelId: hotel.id }), 'link hotel').body;
  must(await admin.post(`/admin/catalogue/packages/${pkg.id}/hotels/${linked.hotels[0].id}/rooms`, { roomType: 'double', name: text('Double room'), minOccupancy: 1, maxOccupancy: 2, roomPoolId }), 'room');
  must(await admin.post(`/admin/catalogue/packages/${pkg.id}/extras`, { kind: 'excursion', name: text('City tour'), pricingUnit: 'per_person', poolId: extraPoolId }), 'extra');
  if (opts.priced !== false) await pricePackageFully(admin, pkg.id);
  const full = must(await admin.get(`/admin/catalogue/packages/${pkg.id}`), 'get package').body;
  return {
    race: { id: race.id, slug: race.slug, version: race.version }, edition: { id: edition.id, year }, distanceId: distance.id, entryPoolId, roomPoolId, extraPoolId,
    pkg: { id: full.id, slug: full.slug, version: full.version },
  };
}

/** Shortest path through the sale-status table, so a test can put a package in any state. */
export function pathTo(target: string): string[] {
  const queue: string[][] = [['draft']];
  const seen = new Set(['draft']);
  while (queue.length) {
    const p = queue.shift()!;
    const last = p[p.length - 1]!;
    if (last === target) return p.slice(1);
    for (const next of SALE_TRANSITIONS[last as keyof typeof SALE_TRANSITIONS]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...p, next]);
      }
    }
  }
  throw new Error(`no path to ${target}`);
}

export async function setSale(admin: Client, packageId: string, status: string, version?: number): Promise<Awaited<ReturnType<Client["post"]>>> {
  const v = version ?? (await admin.get(`/admin/catalogue/packages/${packageId}`)).body.version;
  return admin.post(`/admin/catalogue/packages/${packageId}/sale-status`, { status, version: v });
}

export async function driveTo(admin: Client, packageId: string, status: string): Promise<void> {
  const path = pathTo(status);
  if (path.includes('open')) await pricePackageFully(admin, packageId);
  for (const step of path) {
    const r = await setSale(admin, packageId, step);
    if (r.status !== 200) throw new Error(`could not reach ${step}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

export async function announceEdition(admin: Client, editionId: string): Promise<Awaited<ReturnType<Client["post"]>>> {
  const v = (await admin.get(`/admin/catalogue/editions/${editionId}`)).body.version;
  return admin.post(`/admin/catalogue/editions/${editionId}/status`, { status: 'announced', version: v });
}

/** Closes the app after removing the events catalogue tests leave behind, so other test files start clean. */
export async function closeCatalogue(t: TestApp): Promise<void> {
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'catalogue.%' OR type LIKE 'pricing.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'catalogue.%' OR type LIKE 'pricing.%'`);
  await t.close();
}
