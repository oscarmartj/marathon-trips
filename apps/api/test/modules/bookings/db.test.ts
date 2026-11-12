// What the database and the module guarantee on their own (plan docs/plans/2.4-booking-requests.md, sections 3, 6, 12, 16).
import { randomUUID } from 'node:crypto';
import { Body, Controller, Post } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Prisma } from '../../../src/generated/prisma/client';
import { InventoryService } from '../../../src/modules/catalogue';
import { mapLoadError } from '../../../src/modules/bookings/request.service';
import { snapshotBreakdownSchema, snapshotConfigurationSchema } from '../../../src/modules/bookings/snapshot-schema';
import { ReferenceGenerator } from '../../../src/modules/bookings/support';
import { OwnedBy } from '../../../src/platform/access/access.decorators';
import { ApiError } from '../../../src/platform/http/api-error';
import { ZodPipe } from '../../../src/platform/http/zod.pipe';
import { TestApp, makeApp, signInCustomer } from '../../support/auth';
import { closeCatalogue } from '../../support/catalogue';
import { bookingStaff, cleanBookingEvents, customerClient, makeBookingFor, makeCustomer, requestBody } from '../../support/bookings';
import { checkOwnedRoutes } from '../../support/owned-routes';
import { OWNED_ROUTE_FIXTURES } from '../../support/owned-route-fixtures';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof bookingStaff>>;
let w: PricedWorld;
let owner: pg.Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await bookingStaff(t);
  w = await pricedWorld(admin);
  owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await owner.connect();
});
afterAll(async () => {
  await owner.end();
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const sql = (q: string, ...p: unknown[]) => t.prisma.$executeRawUnsafe(q, ...p);
/** As the owner of the tables, rolled back whatever happens: only the triggers stand in the way. */
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
const real = async () => {
  const c = await customerClient(t);
  const res = await c.request(requestBody(w));
  if (res.status !== 201) throw new Error(`request: ${res.status}`);
  return t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference }, include: { snapshots: true, claims: true } });
};

describe('booking_snapshots_immutable and booking_total_mirrors_snapshot', () => {
  it('a snapshot never changes or goes, for the API role and for the owner', async () => {
    const b = await real();
    const s = b.snapshots[0]!;
    await expect(sql(`UPDATE booking_snapshots SET "totalMinor" = 1 WHERE id = $1::uuid`, s.id)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM booking_snapshots WHERE id = $1::uuid`, s.id)).rejects.toThrow(/append-only/);
    await expect(sql(`TRUNCATE booking_snapshots`)).rejects.toThrow(/permission denied|must be owner|append-only/);
    expect(await asOwner(`UPDATE booking_snapshots SET "priceBreakdown" = '{}' WHERE id = $1::uuid`, [s.id])).toMatch(/append-only/);
    expect(await asOwner(`DELETE FROM booking_snapshots WHERE id = $1::uuid`, [s.id])).toMatch(/append-only/);
    expect(await asOwner(`TRUNCATE booking_snapshots CASCADE`)).toMatch(/append-only/);
  });

  it('the totals of a booking always mirror its current snapshot, checked at commit', async () => {
    const b = await real();
    await expect(sql(`UPDATE bookings SET "totalMinor" = "totalMinor" - 1 WHERE id = $1::uuid`, b.id)).rejects.toThrow(/totals must be those of its current snapshot/);
    await expect(sql(`UPDATE bookings SET "depositMinor" = 0 WHERE id = $1::uuid`, b.id)).rejects.toThrow(/totals must be those of its current snapshot/);
    // a new snapshot version without its snapshot is refused too
    await expect(sql(`UPDATE bookings SET "currentSnapshotVersion" = 2 WHERE id = $1::uuid`, b.id)).rejects.toThrow(/totals must be those of its current snapshot/);
    // a booking without a snapshot cannot commit
    const row = await t.prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
    await expect(t.prisma.booking.create({ data: { ...row, customFields: {}, id: randomUUID(), reference: 'MT-YYYYYY', requestKeyHash: 'b'.repeat(64) } })).rejects.toThrow(/totals must be those of its current snapshot/);
  });

  it('booking_identity_columns_immutable and bookings_never_deleted', async () => {
    const b = await real();
    const other = await makeCustomer(t);
    for (const [col, value] of [['customerId', other], ['packageId', randomUUID()], ['currency', 'NZD'], ['reference', 'MT-XXXXXX'], ['requestedAt', new Date()], ['requestKeyHash', 'c'.repeat(64)], ['isDemo', true]] as const) {
      await expect(sql(`UPDATE bookings SET "${col}" = $2 WHERE id = $1::uuid`, b.id, value), col).rejects.toThrow(/identity of a booking never changes|foreign key|violates/);
    }
    await expect(sql(`UPDATE bookings SET "requestContactHmac" = $2 WHERE id = $1::uuid`, b.id, 'd'.repeat(64))).rejects.toThrow(/identity of a booking never changes/);
    await sql(`UPDATE bookings SET "requestContactHmac" = NULL WHERE id = $1::uuid`, b.id);
    await expect(sql(`DELETE FROM bookings WHERE id = $1::uuid`, b.id)).rejects.toThrow(/never deleted/);
    expect(await asOwner(`DELETE FROM bookings WHERE id = $1::uuid`, [b.id])).toMatch(/never deleted/);
    expect(await asOwner(`TRUNCATE bookings CASCADE`)).toMatch(/append-only/);
    expect(await asOwner(`UPDATE bookings SET "editionId" = $2::uuid WHERE id = $1::uuid`, [b.id, randomUUID()])).toMatch(/identity of a booking never changes/);
  });

  it('a booking is created for its package\'s edition only', async () => {
    const other = await pricedWorld(admin);
    const { bookingId } = await makeBookingFor(t, w);
    const row = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    await expect(t.prisma.booking.create({ data: { ...row, customFields: {}, id: randomUUID(), reference: 'MT-WWWWWW', requestKeyHash: 'e'.repeat(64), editionId: other.edition.id } })).rejects.toThrow(/edition is its package's edition/);
  });

  it('inventory_claim_released_once_by_sql: held to released, once, and nothing else; never deleted', async () => {
    const b = await real();
    const claim = b.claims[0]!;
    await expect(sql(`UPDATE inventory_claims SET quantity = 2 WHERE id = $1::uuid`, claim.id)).rejects.toThrow(/only released, once/);
    await expect(sql(`DELETE FROM inventory_claims WHERE id = $1::uuid`, claim.id)).rejects.toThrow(/never deleted/);
    await expect(sql(`UPDATE inventory_claims SET status = 'released' WHERE id = $1::uuid`, claim.id)).rejects.toThrow(/inventory_claims_released_check/);
    await sql(`UPDATE inventory_claims SET status = 'released', "releasedAt" = now() WHERE id = $1::uuid`, claim.id);
    await expect(sql(`UPDATE inventory_claims SET status = 'released', "releasedAt" = now() WHERE id = $1::uuid`, claim.id)).rejects.toThrow(/only released, once/);
    expect(await asOwner(`TRUNCATE inventory_claims`)).toMatch(/append-only/);
  });

  it('promo_redemption_fk_matches_booking_customer: a redemption belongs to its booking\'s customer', async () => {
    const { bookingId } = await makeBookingFor(t, w);
    const stranger = await makeCustomer(t);
    const code = await t.prisma.promoCode.findFirst({ select: { id: true } });
    const codeId = code?.id ?? randomUUID();
    await expect(sql(`INSERT INTO promo_redemptions (id, "promoCodeId", "bookingId", "customerId", "activeBookingId", "redeemedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, randomUUID(), codeId, bookingId, stranger)).rejects.toThrow(/foreign key/);
  });

  it('customers are never deleted (erasure anonymises them, task 5.5)', async () => {
    const id = await makeCustomer(t);
    await expect(sql(`DELETE FROM customers WHERE id = $1::uuid`, id)).rejects.toThrow(/never deleted/);
    await expect(sql(`UPDATE customers SET "isDemo" = true WHERE id = $1::uuid`, id)).rejects.toThrow(/never change/);
    expect(await asOwner(`TRUNCATE customers CASCADE`)).toMatch(/append-only/);
    // only a customer user can be linked
    const staff = admin.staff;
    await expect(sql(`UPDATE customers SET "userId" = $2::uuid WHERE id = $1::uuid`, id, staff.id)).rejects.toThrow(/foreign key/);
  });
});

describe('snapshot_schema_has_no_free_text', () => {
  it('every text field of a stored snapshot refuses arbitrary text', async () => {
    const b = await real();
    const breakdown = b.snapshots[0]!.priceBreakdown as Record<string, unknown>;
    expect(snapshotBreakdownSchema.safeParse(breakdown).success).toBe(true);
    const words = 'Ada Lovelace, 1 Main St';
    const line = (breakdown.lines as Array<Record<string, unknown>>)[0]!;
    const bad: Array<[string, unknown]> = [
      ['currency', { ...breakdown, currency: words }],
      ['engineVersion', { ...breakdown, engineVersion: words }],
      ['line key', { ...breakdown, lines: [{ ...line, key: words }] }],
      ['line refId', { ...breakdown, lines: [{ ...line, refId: words }] }],
      ['line amount', { ...breakdown, lines: [{ ...line, amountMinor: words }] }],
      ['an unknown field', { ...breakdown, note: words }],
      ['an unknown line field', { ...breakdown, lines: [{ ...line, label: words }] }],
      ['date', { ...breakdown, departureDate: words }],
    ];
    for (const [name, value] of bad) expect([name, snapshotBreakdownSchema.safeParse(value).success]).toEqual([name, false]);
    const config = b.snapshots[0]!.configuration as Record<string, unknown>;
    expect(snapshotConfigurationSchema.safeParse(config).success).toBe(true);
    expect(snapshotConfigurationSchema.safeParse({ ...config, packageId: words }).success).toBe(false);
  });
});

describe('failures that are load or change, never a 500', () => {
  it('pool_changed_since_quote_409: an option that no longer resolves is a 409 catalogue_changed', async () => {
    const inventory = t.app.get(InventoryService);
    const base = { packageId: w.pkg.id, rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'supporter', raceDistanceId: null }] }], extras: [] as Array<{ extraId: string; quantity: number }> };
    expect(await t.prisma.$transaction((tx) => inventory.demandFor(tx, base))).toEqual([{ poolId: w.roomPoolId, quantity: 1 }]);
    for (const config of [
      { ...base, rooms: [{ ...base.rooms[0]!, roomOptionId: randomUUID() }] },
      { ...base, extras: [{ extraId: randomUUID(), quantity: 1 }] },
      { ...base, rooms: [{ roomOptionId: w.roomId, travellers: [{ participationType: 'runner_with_entry', raceDistanceId: randomUUID() }] }] },
      { ...base, packageId: (await pricedWorld(admin)).pkg.id },
    ]) {
      await expect(t.prisma.$transaction((tx) => inventory.demandFor(tx, config))).rejects.toMatchObject({ status: 409, code: 'catalogue_changed' });
    }
  });

  it('pool_timeout_maps_to_busy_409: no connection in time or a closed transaction reads as busy', () => {
    for (const code of ['P2024', 'P2028']) {
      const err = new Prisma.PrismaClientKnownRequestError('Timed out', { code, clientVersion: 'test' });
      const mapped = mapLoadError(err) as ApiError;
      expect([mapped.status, mapped.code]).toEqual([409, 'busy_try_again']);
    }
    const other = new Error('Transaction API error: Unable to start a transaction in the given time.');
    expect((mapLoadError(other) as ApiError).code).toBe('busy_try_again');
    const unrelated = new ApiError(409, 'inventory_unavailable', 'x');
    expect(mapLoadError(unrelated)).toBe(unrelated);
  });

  it('reference_collision_retried: a reference already taken is skipped inside the same transaction', async () => {
    const taken = (await real()).reference;
    const refs = t.app.get(ReferenceGenerator);
    const original = refs.next.bind(refs);
    let calls = 0;
    refs.next = () => (++calls <= 2 ? taken : original());
    try {
      const c = await customerClient(t);
      const res = await c.request(requestBody(w));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.reference).not.toBe(taken);
      expect(calls).toBe(3);
      refs.next = () => taken;
      const stuck = await c.request(requestBody(w));
      expect([stuck.status, stuck.body.code]).toEqual([409, 'busy_try_again']);
      expect(await t.prisma.booking.count({ where: { customer: { userId: c.userId } } })).toBe(1);
    } finally {
      refs.next = original;
    }
  });
});

describe('self_route_public_refs_only_exempt_declared_keys', () => {
  it('a self route may take the declared catalogue references, and no other id', async () => {
    @Controller('probe-refs')
    class Probe {
      @Post('ok') @OwnedBy({ kind: 'customer', resource: 'self', publicRefs: ['packageId'] }) ok(@Body(new ZodPipe(z.strictObject({ packageId: z.string() }))) _b: unknown) { return {}; }
      @Post('bad') @OwnedBy({ kind: 'customer', resource: 'self', publicRefs: ['packageId'] }) bad(@Body(new ZodPipe(z.strictObject({ packageId: z.string(), bookingId: z.string() }))) _b: unknown) { return {}; }
    }
    const probe = await makeApp({}, { controllers: [Probe] });
    try {
      const a = await signInCustomer(probe);
      const b = await signInCustomer(probe);
      const { problems } = await checkOwnedRoutes(probe, OWNED_ROUTE_FIXTURES, a, b);
      expect(problems).toEqual(['POST /probe-refs/bad: self route takes bookingId in the body']);
    } finally {
      await probe.close();
    }
  });
});
