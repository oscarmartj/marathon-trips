// The price of a change, table-driven (plan docs/plans/6.3-booking-amendments.md, sections 4 and 11; .claude/rules/pricing.md):
// occupancy 1 to 4, extra nights, supporters, extras, promo codes, rules, rounding and the price basis drift.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestApp, makeApp } from '../../../support/auth';
import { CATALOGUE_AND_PRICING, closeCatalogue, staffClient } from '../../../support/catalogue';
import type { Client } from '../../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents } from '../../../support/bookings';
import { walkTo } from '../../../support/customer-portal';
import { createCode, createRule, freshCode } from '../../../support/adjustments';
import { ALL_PAYMENT_PERMISSIONS, acceptCurrentTerms, cleanPayments } from '../../../support/payments';
import { customerClient } from '../../../support/bookings';
import type { CustomerClient } from '../../../support/bookings';
import { STATE_HEADERS } from '../../../support/auth';
import { AmendWorld, Traveller, amendWorld, requestIn, runner, setCustomerAmendments, supporter } from '../../../support/amendments';
import { retireAmendWorlds } from '../../../support/amendments';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let t: TestApp;
let admin: Client;
let c: CustomerClient;
let w: AmendWorld;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
  c = await customerClient(t);
  w = await amendWorld(admin);
});
afterAll(async () => {
  await retireAmendWorlds(t);
  await setCustomerAmendments(t, false);
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

type Room = { roomOptionId: string; travellers: Traveller[] };
type AmendTraveller = { keepSlot: number } | Traveller & { replacesSlot?: number };

/** A booking walked to deposit_paid by SQL (the price is what is tested here, not the payment). */
async function booked(world: AmendWorld, rooms: Room[], extra: Record<string, unknown> = {}) {
  const b = await requestIn(t, c.cookie, world, { rooms, ...extra });
  await walkTo(t, b.bookingId, 'deposit_paid');
  return b;
}

const engineForm = (rooms: Array<{ roomOptionId: string; travellers: AmendTraveller[] }>, places: Map<number, Traveller>) =>
  rooms.map((r) => ({ roomOptionId: r.roomOptionId, travellers: r.travellers.map((x) => ('keepSlot' in x ? places.get(x.keepSlot)! : { participationType: x.participationType, ...(x.raceDistanceId ? { raceDistanceId: x.raceDistanceId } : {}) })) }));

interface Row {
  name: string;
  initial: Room[];
  initialExtra?: Record<string, unknown>;
  rooms: (w: AmendWorld) => Array<{ roomOptionId: string; travellers: AmendTraveller[] }>;
  nights?: [number, number];
  extras?: Array<{ extraId: string; travellerSlots?: number[] }>;
  total: string;
  difference: string;
}

const A = (x: AmendWorld): Room[] => [{ roomOptionId: x.doubleId, travellers: [runner(x), supporter] }];
const rows = (x: AmendWorld): Row[] => [
  { name: 'occupancy 2 → 1: the supporter leaves the double', initial: A(x), rooms: () => [{ roomOptionId: x.doubleId, travellers: [{ keepSlot: 1 }] }], total: '110000', difference: '-22500' },
  { name: 'occupancy 1 → 2: a supporter joins the double', initial: [{ roomOptionId: x.doubleId, travellers: [runner(x)] }], rooms: () => [{ roomOptionId: x.doubleId, travellers: [{ keepSlot: 1 }, supporter] }], total: '132500', difference: '22500' },
  { name: 'occupancy 3: double for two → quad for three', initial: A(x), rooms: () => [{ roomOptionId: x.quadId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }, supporter] }], total: '170000', difference: '37500' },
  { name: 'occupancy 4: double for two → quad for four', initial: A(x), rooms: () => [{ roomOptionId: x.quadId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }, supporter, supporter] }], total: '197500', difference: '65000' },
  { name: 'occupancy 4 → 1: three supporters leave the quad', initial: [{ roomOptionId: x.quadId, travellers: [runner(x), supporter, supporter, supporter] }], rooms: () => [{ roomOptionId: x.quadId, travellers: [{ keepSlot: 1 }] }], total: '120000', difference: '-77500' },
  { name: 'extra nights: two before and one after for two people', initial: A(x), rooms: () => [{ roomOptionId: x.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], nights: [2, 1], total: '222500', difference: '90000' },
  { name: 'extra nights removed', initial: A(x), initialExtra: { extraNightsAfter: 2 }, rooms: () => [{ roomOptionId: x.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], nights: [0, 0], total: '132500', difference: '-60000' },
  { name: 'a second room with a supporter', initial: A(x), rooms: () => [{ roomOptionId: x.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }, { roomOptionId: x.doubleId, travellers: [supporter] }], total: '215000', difference: '82500' },
  { name: 'the supporter becomes a runner (place replaced)', initial: A(x), rooms: () => [{ roomOptionId: x.doubleId, travellers: [{ keepSlot: 1 }, { ...runner(x), replacesSlot: 2 }] }], total: '160000', difference: '27500' },
  { name: 'the tour for both (per-person extra)', initial: A(x), rooms: () => [{ roomOptionId: x.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], extras: [{ extraId: x.extraId, travellerSlots: [1, 2] }], total: '156500', difference: '24000' },
];

async function previewOf(bookingId: string, body: object) {
  return admin.post(`/admin/bookings/${bookingId}/amendments/preview`, body);
}
async function applyOf(bookingId: string, body: object) {
  const p = await previewOf(bookingId, body);
  if (p.status !== 200) throw new Error(`preview ${p.status} ${JSON.stringify(p.body)}`);
  const r = await admin.post(`/admin/bookings/${bookingId}/amendments`, { ...body, previewDigest: p.body.previewDigest }).set('Idempotency-Key', randomUUID());
  if (r.status !== 201) throw new Error(`apply ${r.status} ${JSON.stringify(r.body)}`);
  return p.body;
}
const placesOf = async (bookingId: string) => new Map((await t.prisma.bookingTraveller.findMany({ where: { bookingId, removedInVersion: null } })).map((p) => [p.slot, { participationType: p.participationType as Traveller['participationType'], ...(p.raceDistanceId ? { raceDistanceId: p.raceDistanceId } : {}) }]));

describe('amendment_price_table: every row equals the engine quote of the same configuration and difference = new − old', () => {
  it.each(rows({ doubleId: 'd', quadId: 'q', extraId: 'e', distanceId: 'x' } as AmendWorld).map((r, i) => [r.name, i]))('%s', async (_name, i) => {
    const row = rows(w)[i as number]!;
    const b = await booked(w, row.initial, row.initialExtra);
    const before = await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } });
    const v1 = await t.prisma.bookingSnapshot.findUniqueOrThrow({ where: { bookingId_version: { bookingId: b.bookingId, version: 1 } } });
    const rooms = row.rooms(w);
    const [nb, na] = row.nights ?? [0, (row.initialExtra?.extraNightsAfter as number | undefined) ?? 0];
    const body = { expectedSnapshotVersion: 1, rooms, extraNightsBefore: nb, extraNightsAfter: na, extras: row.extras ?? [], reasonCode: 'correction' };
    const quote = await admin.post('/admin/pricing/quotes', { packageId: w.pkgId, priceVersionId: w.versionId, rooms: engineForm(rooms, await placesOf(b.bookingId)), extraNightsBefore: nb, extraNightsAfter: na, extras: row.extras ?? [] });
    expect(quote.status).toBe(200);
    const p = await applyOf(b.bookingId, body);
    expect([p.newTotalMinor, p.priceDifferenceMinor]).toEqual([row.total, row.difference]);
    expect(p.newTotalMinor).toBe(quote.body.totalMinor);
    expect(BigInt(p.newTotalMinor) - BigInt(p.previousTotalMinor)).toBe(BigInt(p.priceDifferenceMinor));
    expect(p.previousTotalMinor).toBe(before.totalMinor.toString());
    // The original snapshot is untouched; the new one mirrors the booking.
    expect(await t.prisma.bookingSnapshot.findUniqueOrThrow({ where: { bookingId_version: { bookingId: b.bookingId, version: 1 } } })).toEqual(v1);
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).totalMinor.toString()).toBe(row.total);
    // Stock follows the new configuration exactly: one held claim per pool, matching what the configuration needs.
    const claims = await t.prisma.inventoryClaim.findMany({ where: { bookingId: b.bookingId, status: 'held' } });
    expect(new Set(claims.map((x) => x.poolId)).size).toBe(claims.length);
  });
});

describe('promo codes and rules are re-evaluated on the price basis', () => {
  it('a percentage code still applies after the change; the use stays counted once', async () => {
    const world = await amendWorld(admin);
    const code = await createCode(admin, freshCode('AM'), { scopeType: 'package', packageId: world.pkgId, valueBps: 1000 });
    const b = await booked(world, A(world), { promoCode: code.code });
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).totalMinor).toBe(119250n);
    const p = await applyOf(b.bookingId, { expectedSnapshotVersion: 1, rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], extraNightsBefore: 0, extraNightsAfter: 1, extras: [], reasonCode: 'customer_request' });
    // (132 500 + 30 000) × 90 % = 146 250.
    expect([p.newTotalMinor, p.priceDifferenceMinor, p.price.promo.status]).toEqual(['146250', '27000', 'applied']);
    expect(await t.prisma.promoRedemption.count({ where: { bookingId: b.bookingId, releasedAt: null } })).toBe(1);
    expect((await t.prisma.promoCode.findUniqueOrThrow({ where: { id: code.id } })).redeemedCount).toBe(1);
  });

  it('a code whose conditions no longer hold is dropped and its use given back once', async () => {
    const world = await amendWorld(admin);
    const code = await createCode(admin, freshCode('AM'), { scopeType: 'package', packageId: world.pkgId, valueBps: 1000, conditions: { minTravellers: 2 } });
    const b = await booked(world, A(world), { promoCode: code.code });
    const p = await applyOf(b.bookingId, { expectedSnapshotVersion: 1, rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [], reasonCode: 'correction' });
    expect([p.newTotalMinor, p.price.promo.status]).toEqual(['110000', 'conditions_not_met']);
    expect(await t.prisma.promoRedemption.count({ where: { bookingId: b.bookingId, releasedAt: null } })).toBe(0);
    expect((await t.prisma.promoCode.findUniqueOrThrow({ where: { id: code.id } })).redeemedCount).toBe(0);
  });

  it('rounding rule: a 7.5 % code on an odd base rounds half up once, line by line; the difference is the exact subtraction', async () => {
    const world = await amendWorld(admin);
    const code = await createCode(admin, freshCode('AM'), { scopeType: 'package', packageId: world.pkgId, valueBps: 750 });
    const b = await booked(world, A(world), { promoCode: code.code });
    // 132 500 × 7.5 % = 9 937.5 → 9 938 (half up): 122 562.
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).totalMinor).toBe(122562n);
    const p = await applyOf(b.bookingId, { expectedSnapshotVersion: 1, rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [{ extraId: world.extraId, travellerSlots: [1] }], reasonCode: 'customer_request' });
    // 144 500 × 7.5 % = 10 837.5 → 10 838: 133 662; difference 11 100 (not 12 000 × 92.5 % = 11 100 by accident: both totals are rounded first).
    expect([p.newTotalMinor, p.priceDifferenceMinor]).toEqual(['133662', '11100']);
  });

  it('early_bird_kept_by_price_basis: a rule that ended after the booking still prices the change', async () => {
    const world = await amendWorld(admin);
    await createRule(admin, { scopeType: 'package', packageId: world.pkgId, kind: 'custom', valueBps: 1000, appliesTo: 'accommodation', validTo: new Date(Date.now() + 6_000).toISOString() });
    const b = await booked(world, A(world));
    // (100 000 × 90 %) + 32 500 = 122 500.
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).totalMinor).toBe(122500n);
    await new Promise((r) => setTimeout(r, 7_000));
    const p = await applyOf(b.bookingId, { expectedSnapshotVersion: 1, rooms: [{ roomOptionId: world.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], extraNightsBefore: 0, extraNightsAfter: 1, extras: [], reasonCode: 'customer_request' });
    // (130 000 × 90 %) + 32 500 = 149 500: the early bird still applies to the whole stay.
    expect([p.newTotalMinor, p.priceDifferenceMinor]).toEqual(['149500', '27000']);
    const basis = await t.prisma.bookingAmendment.findFirstOrThrow({ where: { bookingId: b.bookingId } });
    const v1 = await t.prisma.bookingSnapshot.findUniqueOrThrow({ where: { bookingId_version: { bookingId: b.bookingId, version: 1 } } });
    expect([basis.basisPriceVersionId, basis.basisAt.toISOString()]).toEqual([v1.priceVersionId, (v1.priceBreakdown as { computedAt: string }).computedAt]);
  });

  it('rule combinations: two non-stackable discounts on overlapping targets price the change as the engine quotes it', async () => {
    const world = await amendWorld(admin);
    await createRule(admin, { scopeType: 'package', packageId: world.pkgId, valueBps: 1000, appliesTo: 'accommodation', priority: 1 });
    await createRule(admin, { scopeType: 'package', packageId: world.pkgId, valueBps: 500, appliesTo: 'subtotal', priority: 2 });
    const b = await booked(world, A(world));
    const rooms = [{ roomOptionId: world.quadId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }, supporter] }];
    const quote = await admin.post('/admin/pricing/quotes', { packageId: world.pkgId, priceVersionId: world.versionId, rooms: engineForm(rooms, await placesOf(b.bookingId)), extraNightsBefore: 0, extraNightsAfter: 0, extras: [] });
    const p = await applyOf(b.bookingId, { expectedSnapshotVersion: 1, rooms, extraNightsBefore: 0, extraNightsAfter: 0, extras: [], reasonCode: 'customer_request' });
    expect(p.newTotalMinor).toBe(quote.body.totalMinor);
  });
});

describe('basis drift (decision 4, review G1)', () => {
  const nightBody = (w2: AmendWorld, reasonCode = 'customer_request') => ({ expectedSnapshotVersion: 1, rooms: [{ roomOptionId: w2.doubleId, travellers: [{ keepSlot: 1 }, { keepSlot: 2 }] }], extraNightsBefore: 0, extraNightsAfter: 1, extras: [], reasonCode });

  it('positive_basis_drift_refused_for_staff: a surcharge added after the sale is never charged, and Oscar gets a task', async () => {
    const world = await amendWorld(admin);
    const b = await booked(world, A(world));
    await createRule(admin, { scopeType: 'package', packageId: world.pkgId, direction: 'surcharge', valueBps: 1000, appliesTo: 'accommodation' });
    for (const reasonCode of ['customer_request', 'correction']) {
      const r = await previewOf(b.bookingId, nightBody(world, reasonCode));
      expect([r.status, r.body.code]).toEqual([409, 'amendment_price_basis_drifted']);
    }
    expect(await t.prisma.task.count({ where: { sourceRef: `bookings:amendment_basis_drift:${b.bookingId}:v1`, status: 'open' } })).toBe(1);
    expect(await t.prisma.bookingAmendment.count({ where: { bookingId: b.bookingId } })).toBe(0);
  });

  it('negative_drift_recorded_and_audited: a discount added later only with `correction`, by staff; never by the customer', async () => {
    const world = await amendWorld(admin);
    const b = await booked(world, A(world));
    await acceptCurrentTerms(t, c, b.reference);
    await createRule(admin, { scopeType: 'package', packageId: world.pkgId, valueBps: 1000, appliesTo: 'accommodation' });
    expect((await previewOf(b.bookingId, nightBody(world))).body.code).toBe('amendment_price_basis_drifted');
    await setCustomerAmendments(t, true);
    try {
      const cust = await t.http().post(`/account/bookings/${b.reference}/amendments/preview`).set(STATE_HEADERS).set('Cookie', c.cookie).send({ expectedSnapshotVersion: 1, extraNightsBefore: 0, extraNightsAfter: 1, extras: [] });
      expect(cust.body.code).toBe('amendment_price_basis_drifted');
    } finally {
      await setCustomerAmendments(t, false);
    }
    const p = await applyOf(b.bookingId, nightBody(world, 'correction'));
    // Drift −10 000 (10 % of 100 000); new (130 000 × 90 %) + 32 500 = 149 500; difference 149 500 − 132 500.
    expect([p.basisDriftMinor, p.newTotalMinor, p.priceDifferenceMinor]).toEqual(['-10000', '149500', '17000']);
    const a = await t.prisma.bookingAmendment.findFirstOrThrow({ where: { bookingId: b.bookingId } });
    expect([a.basisDriftMinor, a.reasonCode]).toEqual([-10000n, 'correction']);
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { entityId: b.bookingId, action: 'bookings.booking.amended' } });
    expect(JSON.stringify(audit.changes)).toContain('-10000');
  });
});
