import { Client, World, announceEdition, buildWorld } from './catalogue';

const text = (s: string) => ({ 'en-AU': s });

export interface PricedWorld extends World {
  roomId: string;
  extraId: string;
  versionId: string;
  rates: RatesBody;
}

export interface RatesBody {
  roomRates: Array<{ roomOptionId: string; occupancy: number; pricePerPersonMinor: string; extraNightPerPersonMinor: string }>;
  participationRates: Array<{ participationType: string; raceDistanceId: string | null; amountPerPersonMinor: string }>;
  extraRates: Array<{ extraId: string; amountMinor: string }>;
}

/** The rate card of the pricing API tests: double room 80 000 alone or 50 000 each for two; marathon 30 000. */
export const cardFor = (w: { roomId: string; extraId: string; distanceId: string }): RatesBody => ({
  roomRates: [
    { roomOptionId: w.roomId, occupancy: 1, pricePerPersonMinor: '80000', extraNightPerPersonMinor: '25000' },
    { roomOptionId: w.roomId, occupancy: 2, pricePerPersonMinor: '50000', extraNightPerPersonMinor: '15000' },
  ],
  participationRates: [
    { participationType: 'runner_with_entry', raceDistanceId: w.distanceId, amountPerPersonMinor: '30000' },
    { participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: '2500' },
  ],
  extraRates: [{ extraId: w.extraId, amountMinor: '12000' }],
});

export async function must<T extends { status: number; body: unknown }>(r: Promise<T> | T, what: string, status = 200): Promise<T> {
  const res = await r;
  if (res.status !== status) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/** A draft with the given rates; returns its id and version. */
export async function draftWith(admin: Client, packageId: string, rates: RatesBody, label = 'Prices'): Promise<{ id: string; version: number }> {
  const draft = (await must(admin.post(`/admin/pricing/packages/${packageId}/price-versions`, { label }), 'create draft', 201)).body;
  const set = (await must(admin.put(`/admin/pricing/price-versions/${draft.id}/rates`, { version: draft.version, ...rates }), 'set rates')).body;
  return { id: draft.id, version: set.version };
}

/** The id of the version in force for a package, or null. */
export async function currentOf(admin: Client, packageId: string): Promise<string | null> {
  return (await must(admin.get(`/admin/pricing/packages/${packageId}/price-versions`), 'list versions')).body.currentId;
}

/** The id of the last published version of a package's timeline (in force or scheduled), or null (2.2). */
export async function lastOf(admin: Client, packageId: string): Promise<string | null> {
  return (await must(admin.get(`/admin/pricing/packages/${packageId}/price-versions`), 'list versions')).body.lastId;
}

/** Publishes a draft now, after whatever is last in the package's timeline (in force, unless something is scheduled). */
export const publishDraft = async (admin: Client, packageId: string, d: { id: string; version: number }): Promise<{ status: number; body: { code?: string; [k: string]: unknown } }> =>
  admin.post(`/admin/pricing/price-versions/${d.id}/publish`, { version: d.version, replacesVersionId: await lastOf(admin, packageId) });

export async function publishWith(admin: Client, packageId: string, rates: RatesBody, label = 'Prices'): Promise<string> {
  const d = await draftWith(admin, packageId, rates, label);
  await must(publishDraft(admin, packageId, d), 'publish');
  return d.id;
}

/**
 * A published race and announced edition with one package that takes runners with an entry and supporters, a double
 * room (1–2 people) and an optional per-person tour, priced with `cardFor` and, unless `open: false`, open for sale.
 */
export async function pricedWorld(admin: Client, opts: { open?: boolean } = {}): Promise<PricedWorld> {
  const w = await buildWorld(admin, { priced: false });
  await must(admin.put(`/admin/catalogue/packages/${w.pkg.id}/participation`, { types: ['runner_with_entry', 'supporter'] }), 'participation');
  const pkg = (await must(admin.get(`/admin/catalogue/packages/${w.pkg.id}`), 'package')).body;
  const roomId = pkg.hotels[0].rooms[0].id as string;
  const extraId = pkg.extras[0].id as string;
  const rates = cardFor({ roomId, extraId, distanceId: w.distanceId });
  const versionId = await publishWith(admin, w.pkg.id, rates);
  await must(admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version }), 'publish race');
  await must(announceEdition(admin, w.edition.id), 'announce edition');
  if (opts.open !== false) await must(admin.post(`/admin/catalogue/packages/${w.pkg.id}/sale-status`, { status: 'open', version: pkg.version }), 'open');
  return { ...w, roomId, extraId, versionId, rates };
}

export const quoteBody = (w: { pkg: { id: string }; roomId: string; distanceId: string }, over: Record<string, unknown> = {}) => ({
  packageId: w.pkg.id,
  rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'runner_with_entry', raceDistanceId: w.distanceId }, { participationType: 'supporter' }] }],
  ...over,
});

export { text };
