// Rules, promo codes and a richer priced world for the tests of task 2.2.
import { Client, announceEdition, buildWorld } from './catalogue';
import type { World } from './catalogue';
import { must, publishWith } from './pricing';
import type { RatesBody } from './pricing';

const text = (s: string) => ({ 'en-AU': s });

export const ruleBody = (over: Record<string, unknown> = {}) => ({
  label: 'Test rule', scopeType: 'global', kind: 'custom', direction: 'discount', effectMode: 'percent', valueBps: 1000, appliesTo: 'accommodation', enabled: true, ...over,
});

export const promoBody = (code: string, over: Record<string, unknown> = {}) => ({
  code, label: 'Test code', scopeType: 'global', effectMode: 'percent', valueBps: 1000, appliesTo: 'subtotal', enabled: true, ...over,
});

let n = 0;
/** A code nobody else uses: letters and digits, upper case. */
export const freshCode = (prefix = 'T') => `${prefix}${Date.now().toString(36).toUpperCase()}${(n++).toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export async function createRule(admin: Client, over: Record<string, unknown>): Promise<{ id: string; version: number; [k: string]: unknown }> {
  return (await must(admin.post('/admin/pricing/rules', ruleBody(over)), 'create rule', 201)).body;
}

export async function createCode(admin: Client, code: string, over: Record<string, unknown> = {}): Promise<{ id: string; version: number; code: string; [k: string]: unknown }> {
  return (await must(admin.post('/admin/pricing/promo-codes', promoBody(code, over)), 'create code', 201)).body;
}

export interface RichWorld extends World {
  doubleId: string;
  quadId: string;
  extraId: string;
  versionId: string;
  rates: RatesBody;
}

/**
 * An open package for up to 4 travellers (runners with an entry and supporters) with a double (1–2) and a quad (1–4),
 * up to 2 extra nights after, and an optional per-person tour. Rate card: double 80 000 alone or 50 000 each; quad
 * 90 000 / 55 000 / 42 000 / 35 000 per person at 1–4; extra nights 25 000, 15 000, 30 000, 16 000, 12 500, 10 000;
 * marathon 30 000; supporter 2 500; tour 12 000.
 */
export async function richWorld(admin: Client): Promise<RichWorld> {
  const w = await buildWorld(admin, { priced: false, packageOver: { maxExtraNightsAfter: 2 } });
  await must(admin.put(`/admin/catalogue/packages/${w.pkg.id}/participation`, { types: ['runner_with_entry', 'supporter'] }), 'participation');
  let pkg = (await must(admin.get(`/admin/catalogue/packages/${w.pkg.id}`), 'package')).body;
  await must(admin.post(`/admin/catalogue/packages/${w.pkg.id}/hotels/${pkg.hotels[0].id}/rooms`, { roomType: 'quad', name: text('Quad room'), minOccupancy: 1, maxOccupancy: 4, roomPoolId: w.roomPoolId }), 'quad', 201);
  pkg = (await must(admin.get(`/admin/catalogue/packages/${w.pkg.id}`), 'package')).body;
  const rooms = pkg.hotels[0].rooms as Array<{ id: string; roomType: string }>;
  const doubleId = rooms.find((r) => r.roomType === 'double')!.id;
  const quadId = rooms.find((r) => r.roomType === 'quad')!.id;
  const extraId = pkg.extras[0].id as string;
  const room = (roomOptionId: string, occupancy: number, p: string, x: string) => ({ roomOptionId, occupancy, pricePerPersonMinor: p, extraNightPerPersonMinor: x });
  const rates: RatesBody = {
    roomRates: [
      room(doubleId, 1, '80000', '25000'), room(doubleId, 2, '50000', '15000'),
      room(quadId, 1, '90000', '30000'), room(quadId, 2, '55000', '16000'), room(quadId, 3, '42000', '12500'), room(quadId, 4, '35000', '10000'),
    ],
    participationRates: [
      { participationType: 'runner_with_entry', raceDistanceId: w.distanceId, amountPerPersonMinor: '30000' },
      { participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: '2500' },
    ],
    extraRates: [{ extraId, amountMinor: '12000' }],
  };
  const versionId = await publishWith(admin, w.pkg.id, rates);
  await must(admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version }), 'publish race');
  await must(announceEdition(admin, w.edition.id), 'announce edition');
  await must(admin.post(`/admin/catalogue/packages/${w.pkg.id}/sale-status`, { status: 'open', version: pkg.version }), 'open');
  return { ...w, doubleId, quadId, extraId, versionId, rates };
}
