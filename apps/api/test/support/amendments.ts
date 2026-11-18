// Test helpers for changes to a booking after its deposit (task 6.3; plan docs/plans/6.3-booking-amendments.md).
import { AMENDMENT_SETTINGS } from '../../src/modules/bookings';
import { SettingsService } from '../../src/platform/flags/flags.service';
import type { TestApp } from './auth';
import type { CustomerSession } from './owned-route-fixtures';

/** Customers' own changes are off by default (plan review M2); tests that use them switch them on. */
export async function setCustomerAmendments(t: TestApp, on: boolean): Promise<void> {
  await t.app.get(SettingsService).set(AMENDMENT_SETTINGS.customerEnabled.key, on);
}

/**
 * A booking of customer `a` walked to deposit_paid (with its plan), the terms accepted and customers' changes on, and a
 * preview body that adds the package's optional tour for place 1 (a positive difference).
 */
export async function amendableBookingOf(t: TestApp, a: CustomerSession): Promise<{ reference: string; bookingId: string; body: Record<string, unknown> }> {
  const { customerBookingIn } = await import('./customer-portal');
  const { acceptCurrentTerms } = await import('./payments');
  const { reference, bookingId } = await customerBookingIn(t, a, 'deposit_paid');
  await acceptCurrentTerms(t, a, reference);
  await setCustomerAmendments(t, true);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { packageId: true, currentSnapshotVersion: true } });
  const extra = await t.prisma.extra.findFirstOrThrow({ where: { packageId: b.packageId, mandatory: false, deletedAt: null }, select: { id: true } });
  return { reference, bookingId, body: { expectedSnapshotVersion: b.currentSnapshotVersion, extraNightsBefore: 0, extraNightsAfter: 0, extras: [{ extraId: extra.id, travellerSlots: [1] }] } };
}

import { randomUUID } from 'node:crypto';
import { STATE_HEADERS } from './auth';
import { Client, announceEdition, buildWorld } from './catalogue';
import { must, publishWith, text } from './pricing';
import type { RatesBody } from './pricing';

export interface AmendWorld {
  pkgId: string;
  editionId: string;
  distanceId: string;
  doubleId: string;
  quadId: string;
  extraId: string;
  entryPoolId: string;
  roomPoolId: string;
  quadPoolId: string;
  extraPoolId: string;
  versionId: string;
}

/**
 * The rate card of the change tests. Double (1–2): 80 000 alone, 50 000 each for two; quad (1–4): 90 000, 60 000, 45 000,
 * 40 000 each; extra nights 25 000/15 000 and 30 000/20 000/15 000/12 500 per person and night; marathon 30 000;
 * supporter 2 500; tour 12 000 per person. Deposit 50 000 per person.
 */
export const amendRates = (w: { doubleId: string; quadId: string; extraId: string; distanceId: string }): RatesBody => ({
  roomRates: [
    { roomOptionId: w.doubleId, occupancy: 1, pricePerPersonMinor: '80000', extraNightPerPersonMinor: '25000' },
    { roomOptionId: w.doubleId, occupancy: 2, pricePerPersonMinor: '50000', extraNightPerPersonMinor: '15000' },
    { roomOptionId: w.quadId, occupancy: 1, pricePerPersonMinor: '90000', extraNightPerPersonMinor: '30000' },
    { roomOptionId: w.quadId, occupancy: 2, pricePerPersonMinor: '60000', extraNightPerPersonMinor: '20000' },
    { roomOptionId: w.quadId, occupancy: 3, pricePerPersonMinor: '45000', extraNightPerPersonMinor: '15000' },
    { roomOptionId: w.quadId, occupancy: 4, pricePerPersonMinor: '40000', extraNightPerPersonMinor: '12500' },
  ],
  participationRates: [
    { participationType: 'runner_with_entry', raceDistanceId: w.distanceId, amountPerPersonMinor: '30000' },
    { participationType: 'supporter', raceDistanceId: null, amountPerPersonMinor: '2500' },
  ],
  extraRates: [{ extraId: w.extraId, amountMinor: '12000' }],
});

/** An open package with a double and a quad room, two extra nights each side, runners and supporters, priced. */
export async function amendWorld(admin: Client, opts: { quadCapacity?: number; doubleCapacity?: number; autoConfirm?: boolean } = {}): Promise<AmendWorld> {
  const w = await buildWorld(admin, { priced: false, packageOver: { maxExtraNightsBefore: 2, maxExtraNightsAfter: 2, autoConfirmOnDeposit: opts.autoConfirm ?? true } });
  await must(admin.put(`/admin/catalogue/packages/${w.pkg.id}/participation`, { types: ['runner_with_entry', 'supporter'] }), 'participation');
  const pools = (await must(admin.get(`/admin/catalogue/editions/${w.edition.id}/pools`), 'pools')).body as Array<{ id: string; version: number }>;
  for (const [id, capacity] of [[w.roomPoolId, opts.doubleCapacity ?? 1000], [w.entryPoolId, 1000], [w.extraPoolId, 1000]] as const) {
    const p = pools.find((x) => x.id === id)!;
    await must(admin.patch(`/admin/catalogue/pools/${id}`, { capacity, version: p.version, reason: 'test' }), 'pool capacity');
  }
  const quadPool = (await must(admin.post(`/admin/catalogue/editions/${w.edition.id}/pools`, { kind: 'room', label: 'quad pool', capacity: opts.quadCapacity ?? 1000, lowStockThreshold: 0 }), 'quad pool', 201)).body.id as string;
  let pkg = (await must(admin.get(`/admin/catalogue/packages/${w.pkg.id}`), 'package')).body;
  await must(admin.post(`/admin/catalogue/packages/${w.pkg.id}/hotels/${pkg.hotels[0].id}/rooms`, { roomType: 'quad', name: text('Quad room'), minOccupancy: 1, maxOccupancy: 4, roomPoolId: quadPool }), 'quad room', 201);
  pkg = (await must(admin.get(`/admin/catalogue/packages/${w.pkg.id}`), 'package')).body;
  const rooms = pkg.hotels[0].rooms as Array<{ id: string; roomType: string }>;
  const ids = { doubleId: rooms.find((r) => r.roomType === 'double')!.id, quadId: rooms.find((r) => r.roomType === 'quad')!.id, extraId: pkg.extras[0].id as string, distanceId: w.distanceId };
  const versionId = await publishWith(admin, w.pkg.id, amendRates(ids));
  await must(admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version }), 'publish race');
  await must(announceEdition(admin, w.edition.id), 'announce edition');
  await must(admin.post(`/admin/catalogue/packages/${w.pkg.id}/sale-status`, { status: 'open', version: pkg.version }), 'open');
  return { pkgId: w.pkg.id, editionId: w.edition.id, ...ids, entryPoolId: w.entryPoolId, roomPoolId: w.roomPoolId, quadPoolId: quadPool, extraPoolId: w.extraPoolId, versionId };
}

export type Traveller = { participationType: 'runner_with_entry' | 'supporter'; raceDistanceId?: string };
export const runner = (w: AmendWorld): Traveller => ({ participationType: 'runner_with_entry', raceDistanceId: w.distanceId });
export const supporter: Traveller = { participationType: 'supporter' };

/** A booking request through the API by a signed-in customer; returns its id and reference. */
export async function requestIn(t: TestApp, cookie: string, w: AmendWorld, body: Record<string, unknown>): Promise<{ bookingId: string; reference: string }> {
  const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', cookie).set('Idempotency-Key', randomUUID())
    .send({ packageId: w.pkgId, contact: { givenName: 'Ada', familyName: 'Runner', phone: '+61 400 000 000', countryOfResidence: 'AU' }, ...body });
  if (res.status !== 201) throw new Error(`request failed: ${res.status} ${JSON.stringify(res.body)}`);
  const b = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string }, select: { id: true, reference: true } });
  return { bookingId: b.id, reference: b.reference };
}
