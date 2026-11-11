import { CATALOGUE_PERMISSIONS } from '../../src/modules/catalogue';
import { SALE_TRANSITIONS } from '../../src/modules/catalogue/transitions';
import { STATE_HEADERS, TestApp, createStaff, signInStaff } from './auth';

export const P = CATALOGUE_PERMISSIONS;
export const ALL_CATALOGUE_PERMISSIONS = Object.values(CATALOGUE_PERMISSIONS);

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

/** A staff client with the given permissions (all catalogue permissions by default). */
export async function staffClient(t: TestApp, permissions: string[] = ALL_CATALOGUE_PERMISSIONS) {
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

/** A race (draft), edition, distance, three pools and a draft package with an entry option, a hotel, a room and an extra. */
export async function buildWorld(admin: Client, opts: { year?: number; packageOver?: Record<string, unknown> } = {}): Promise<World> {
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
  for (const step of pathTo(status)) {
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
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'catalogue.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'catalogue.%'`);
  await t.close();
}
