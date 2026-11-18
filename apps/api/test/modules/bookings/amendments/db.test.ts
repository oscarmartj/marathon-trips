// What the database guarantees about changes on its own, as the API role and as the owner (plan
// docs/plans/6.3-booking-amendments.md, section 3; review m1, m2, m7): amendment_database_guards.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestApp, makeApp } from '../../../support/auth';
import { CATALOGUE_AND_PRICING, closeCatalogue, staffClient } from '../../../support/catalogue';
import type { Client } from '../../../support/catalogue';
import { ALL_BOOKING_PERMISSIONS, cleanBookingEvents, customerClient } from '../../../support/bookings';
import { walkTo } from '../../../support/customer-portal';
import { ALL_PAYMENT_PERMISSIONS } from '../../../support/payments';
import { AmendWorld, amendWorld, requestIn, runner, supporter } from '../../../support/amendments';
import { retireAmendWorlds } from '../../../support/amendments';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Client;
let w: AmendWorld;
let cookie: string;
let owner: pg.Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
  w = await amendWorld(admin);
  cookie = (await customerClient(t)).cookie;
  owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
});
afterAll(async () => {
  await retireAmendWorlds(t);
  await owner.end();
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const sql = (q: string, ...p: unknown[]) => t.prisma.$executeRawUnsafe(q, ...p);
async function asOwner(q: string, params: unknown[] = []): Promise<string> {
  await owner.query('BEGIN');
  try {
    await owner.query(q, params);
    return 'ok';
  } catch (err) {
    return String(err);
  } finally {
    await owner.query('ROLLBACK');
  }
}

/** A booking at deposit_paid changed once by staff: the supporter becomes a runner (place 2 retired, place 3 added). */
async function amended() {
  const b = await requestIn(t, cookie, w, { rooms: [{ roomOptionId: w.doubleId, travellers: [runner(w), supporter] }] });
  await walkTo(t, b.bookingId, 'deposit_paid');
  const body = { expectedSnapshotVersion: 1, rooms: [{ roomOptionId: w.doubleId, travellers: [{ keepSlot: 1 }, { ...runner(w), replacesSlot: 2 }] }], extraNightsBefore: 0, extraNightsAfter: 0, extras: [], reasonCode: 'correction' };
  const p = await admin.post(`/admin/bookings/${b.bookingId}/amendments/preview`, body);
  const r = await admin.post(`/admin/bookings/${b.bookingId}/amendments`, { ...body, previewDigest: p.body.previewDigest }).set('Idempotency-Key', randomUUID());
  if (r.status !== 201) throw new Error(`apply ${r.status} ${JSON.stringify(r.body)}`);
  return b;
}

describe('amendment_database_guards', () => {
  it('an amendment row never changes or goes, for any role', async () => {
    const b = await amended();
    const a = await t.prisma.bookingAmendment.findFirstOrThrow({ where: { bookingId: b.bookingId } });
    await expect(sql(`UPDATE booking_amendments SET "newTotalMinor" = 1 WHERE id = $1::uuid`, a.id)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM booking_amendments WHERE id = $1::uuid`, a.id)).rejects.toThrow(/append-only/);
    expect(await asOwner(`UPDATE booking_amendments SET "changes" = '{room}' WHERE id = $1::uuid`, [a.id])).toMatch(/append-only/);
    expect(await asOwner(`DELETE FROM booking_amendments WHERE id = $1::uuid`, [a.id])).toMatch(/append-only/);
    expect(await asOwner(`TRUNCATE booking_amendments CASCADE`)).toMatch(/append-only/);
  });

  it('snapshot_version_only_moves_in_amendable_states: no amendment row (and so no new snapshot) on a request', async () => {
    const b = await requestIn(t, cookie, w, { rooms: [{ roomOptionId: w.doubleId, travellers: [runner(w), supporter] }] });
    const s1 = await t.prisma.bookingSnapshot.findUniqueOrThrow({ where: { bookingId_version: { bookingId: b.bookingId, version: 1 } } });
    const err = await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE bookings SET "currentSnapshotVersion" = 2 WHERE id = $1::uuid`, b.bookingId);
      await tx.bookingSnapshot.create({ data: { bookingId: b.bookingId, version: 2, kind: 'amendment', configuration: {}, priceBreakdown: {}, totalMinor: s1.totalMinor, depositMinor: s1.depositMinor, currency: 'AUD', priceVersionId: s1.priceVersionId, engineVersion: s1.engineVersion } });
      await tx.bookingAmendment.create({ data: amendmentRow(b.bookingId, s1) });
    }).catch((e: unknown) => String(e));
    expect(err).toMatch(/only changed after its deposit/);
    // Without the row, the snapshot cannot commit either.
    const err2 = await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE bookings SET "currentSnapshotVersion" = 2 WHERE id = $1::uuid`, b.bookingId);
      await tx.bookingSnapshot.create({ data: { bookingId: b.bookingId, version: 2, kind: 'amendment', configuration: {}, priceBreakdown: {}, totalMinor: s1.totalMinor, depositMinor: s1.depositMinor, currency: 'AUD', priceVersionId: s1.priceVersionId, engineVersion: s1.engineVersion } });
    }).catch((e: unknown) => String(e));
    expect(err2).toMatch(/needs its amendment record/);
    expect((await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).currentSnapshotVersion).toBe(1);
  });

  it('amendment amounts must be consistent (CHECKs): difference, outstanding and credit, drift only as a correction', async () => {
    const b = await amended();
    const a = await t.prisma.bookingAmendment.findFirstOrThrow({ where: { bookingId: b.bookingId } });
    // Variants of the real row (same versions and totals, so the insert trigger passes and the CHECKs decide).
    const P = a.previousTotalMinor;
    const N = a.newTotalMinor;
    const insert = (over: Record<string, unknown>) => asOwner(
      `INSERT INTO booking_amendments (id, "bookingId", currency, "fromVersion", "toVersion", "initiatedBy", "actorUserId", "reasonCode", changes, "previousTotalMinor", "newTotalMinor", "priceDifferenceMinor", "collectedMinor", "outstandingMinor", "creditPendingMinor", "basisDriftMinor", "basisPriceVersionId", "basisAt", "requestKeyHash", "requestBodyHash")
       VALUES ($1, $2, 'AUD', 1, 2, $3, $4, $5, '{nights}', $6, $7, $8, 0, $9, 0, $10, $11, now(), $12, $12)`,
      [randomUUID(), b.bookingId, over.initiatedBy ?? 'staff', a.actorUserId, over.reasonCode ?? 'other', P, N, (over.diff as bigint | undefined) ?? N - P, (over.outstanding as bigint | undefined) ?? N, over.drift ?? 0, a.basisPriceVersionId, 'f'.repeat(64)]);
    expect(await insert({})).toMatch(/booking_amendments_bookingId_toVersion_key/);
    expect(await insert({ diff: N - P - 1n })).toMatch(/booking_amendments_amounts_check/);
    expect(await insert({ outstanding: 10n })).toMatch(/booking_amendments_amounts_check/);
    expect(await insert({ drift: -5 })).toMatch(/booking_amendments_drift_check/);
    expect(await insert({ drift: 5, reasonCode: 'correction' })).toMatch(/booking_amendments_drift_check/);
    expect(await insert({ initiatedBy: 'customer', reasonCode: 'other' })).toMatch(/booking_amendments_customer_check/);
  });

  it('stock claims: one held claim per booking and pool; the version of a claim never changes (m2)', async () => {
    const b = await amended();
    const held = await t.prisma.inventoryClaim.findMany({ where: { bookingId: b.bookingId, status: 'held' } });
    const c0 = held[0]!;
    await expect(sql(`UPDATE inventory_claims SET "snapshotVersion" = 9 WHERE id = $1::uuid`, c0.id)).rejects.toThrow(/only released, once/);
    await expect(sql(`INSERT INTO inventory_claims (id, "bookingId", "poolId", quantity, "snapshotVersion") VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 7)`, randomUUID(), b.bookingId, c0.poolId)).rejects.toThrow(/inventory_claims_one_held_per_pool/);
    // The change released the entry claim of version 1 and took a new one of version 2 for two runners.
    const entry = await t.prisma.inventoryClaim.findMany({ where: { bookingId: b.bookingId, poolId: w.entryPoolId }, orderBy: { snapshotVersion: 'asc' } });
    expect(entry.map((x) => [x.snapshotVersion, x.quantity, x.status])).toEqual([[1, 1, 'released'], [2, 2, 'held']]);
  });

  it('rooms and extras: marked removed once, nothing else changes', async () => {
    const b = await amended();
    const old = await t.prisma.bookingRoom.findFirstOrThrow({ where: { bookingId: b.bookingId, removedInVersion: 2 } });
    const cur = await t.prisma.bookingRoom.findFirstOrThrow({ where: { bookingId: b.bookingId, removedInVersion: null } });
    await expect(sql(`UPDATE booking_rooms SET "removedInVersion" = NULL WHERE id = $1::uuid`, old.id)).rejects.toThrow(/marks it removed, once/);
    await expect(sql(`UPDATE booking_rooms SET occupancy = 1, "travellerSlots" = '{1}' WHERE id = $1::uuid`, cur.id)).rejects.toThrow(/marks it removed, once/);
    await expect(sql(`DELETE FROM booking_rooms WHERE id = $1::uuid`, cur.id)).rejects.toThrow(/never deleted/);
  });

  it('places: a retired place stays retired; exactly one current lead (m1)', async () => {
    const b = await amended();
    const retired = await t.prisma.bookingTraveller.findFirstOrThrow({ where: { bookingId: b.bookingId, slot: 2 } });
    expect(retired.removedInVersion).toBe(2);
    await expect(sql(`UPDATE booking_travellers SET "removedInVersion" = NULL WHERE id = $1::uuid`, retired.id)).rejects.toThrow(/amendments mark it removed/);
    const lead = await t.prisma.bookingTraveller.findFirstOrThrow({ where: { bookingId: b.bookingId, isLead: true } });
    // A second current lead: refused at once.
    await expect(sql(`INSERT INTO booking_travellers (id, "bookingId", "customerId", slot, "participationType", "isLead", "addedInVersion") VALUES ($1::uuid, $2::uuid, $3::uuid, 9, 'supporter', true, 2)`, randomUUID(), b.bookingId, lead.customerId)).rejects.toThrow(/one_current_lead/);
    // No current lead: refused at commit.
    await expect(t.prisma.$transaction((tx) => tx.$executeRawUnsafe(`UPDATE booking_travellers SET "removedInVersion" = 2 WHERE id = $1::uuid`, lead.id))).rejects.toThrow(/exactly one current lead/);
    // A lead on another place than 1 only when a change added it.
    await expect(sql(`INSERT INTO booking_travellers (id, "bookingId", "customerId", slot, "participationType", "isLead", "addedInVersion") VALUES ($1::uuid, $2::uuid, $3::uuid, 9, 'supporter', true, 1)`, randomUUID(), b.bookingId, lead.customerId)).rejects.toThrow(/booking_travellers_slot_check/);
  });
});

function amendmentRow(bookingId: string, s1: { totalMinor: bigint; priceVersionId: string }) {
  return {
    bookingId, currency: 'AUD', fromVersion: 1, toVersion: 2, initiatedBy: 'staff' as const, actorUserId: randomUUID(), reasonCode: 'other' as const, changes: ['nights' as const],
    previousTotalMinor: s1.totalMinor, newTotalMinor: s1.totalMinor, priceDifferenceMinor: 0n, collectedMinor: 0n, outstandingMinor: s1.totalMinor, creditPendingMinor: 0n,
    basisPriceVersionId: s1.priceVersionId, basisAt: new Date(), requestKeyHash: 'e'.repeat(64), requestBodyHash: 'e'.repeat(64),
  };
}
