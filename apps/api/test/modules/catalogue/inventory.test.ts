import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InventoryService } from '../../../src/modules/catalogue';
import { TestApp, makeApp } from '../../support/auth';
import { Client, World, buildWorld, staffClient, closeCatalogue } from '../../support/catalogue';

let t: TestApp;
let admin: Client;
let inv: InventoryService;
const actor = { type: 'system' as const, id: null };
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t);
  inv = t.app.get(InventoryService);
});
afterAll(async () => {
  await closeCatalogue(t);
});

const pool = (id: string) => t.prisma.inventoryPool.findUniqueOrThrow({ where: { id } });
const hold = (id: string, n: number) => t.prisma.$transaction((tx) => inv.hold(tx, id, n, { actor }));
const release = (id: string, n: number) => t.prisma.$transaction((tx) => inv.release(tx, id, n, { actor }));
const newPool = async (w: World, capacity: number) => (await admin.post(`/admin/catalogue/editions/${w.edition.id}/pools`, { kind: 'entry', label: 'Extra entries', capacity })).body;

describe('stock never goes below zero or above capacity (plan 7)', () => {
  it('pool_never_below_zero: concurrent holds on the last places, only the ones that fit win', async () => {
    const w = await buildWorld(admin);
    const p = await newPool(w, 3);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => hold(p.id, 1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'inventory_unavailable' });
    expect((await pool(p.id)).consumed).toBe(3);
    expect(await t.prisma.inventoryMovement.count({ where: { poolId: p.id, reason: 'hold' } })).toBe(3);
  });

  it('a hold bigger than what remains changes nothing', async () => {
    const w = await buildWorld(admin);
    const p = await newPool(w, 2);
    await expect(hold(p.id, 3)).rejects.toMatchObject({ code: 'inventory_unavailable' });
    expect((await pool(p.id)).consumed).toBe(0);
    await expect(hold(p.id, 0)).rejects.toMatchObject({ code: 'inventory_bad_places' });
    await expect(hold(p.id, 1.5)).rejects.toMatchObject({ code: 'inventory_bad_places' });
    await expect(hold(crypto.randomUUID(), 1)).rejects.toMatchObject({ code: 'pool_not_found' });
  });

  it('release_never_below_zero: releasing more than is held is refused, not clamped; a release is recorded and announced', async () => {
    const w = await buildWorld(admin);
    const p = await newPool(w, 5);
    await hold(p.id, 2);
    await expect(release(p.id, 3)).rejects.toMatchObject({ status: 409, code: 'release_exceeds_held' });
    await release(p.id, 2);
    expect((await pool(p.id)).consumed).toBe(0);
    const moves = await t.prisma.inventoryMovement.findMany({ where: { poolId: p.id }, orderBy: { createdAt: 'asc' } });
    expect(moves.map((m) => [m.reason, m.delta])).toEqual([['hold', 2], ['release', -2]]);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'catalogue.inventory.released', aggregateId: p.id } })).toBe(1);
  });

  it('a hold in a rolled-back transaction leaves no places taken and no movement', async () => {
    const w = await buildWorld(admin);
    const p = await newPool(w, 5);
    await expect(t.prisma.$transaction(async (tx) => { await inv.hold(tx, p.id, 2, { actor }); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect((await pool(p.id)).consumed).toBe(0);
    expect(await t.prisma.inventoryMovement.count({ where: { poolId: p.id } })).toBe(0);
  });

  it('capacity_below_consumed_rejected; raising capacity leaves a movement; the panel sees numbers and lowStock', async () => {
    const w = await buildWorld(admin);
    const p = await newPool(w, 5);
    await hold(p.id, 4);
    const low = await admin.patch(`/admin/catalogue/pools/${p.id}`, { capacity: 3, version: p.version });
    expect(low.status).toBe(409);
    expect(low.body.code).toBe('capacity_below_consumed');
    const ok = await admin.patch(`/admin/catalogue/pools/${p.id}`, { capacity: 8, lowStockThreshold: 5, version: p.version });
    expect(ok.body).toMatchObject({ capacity: 8, consumed: 4, remaining: 4, lowStock: true, state: 'low', version: p.version + 1 });
    expect((await admin.patch(`/admin/catalogue/pools/${p.id}`, { capacity: 9, version: p.version })).body.code).toBe('version_conflict');
    expect((await admin.get(`/admin/catalogue/pools/${p.id}/movements`)).body.map((m: { reason: string; delta: number }) => [m.reason, m.delta])).toEqual(expect.arrayContaining([['capacity_change', 3], ['hold', 4]]));
    const listed = (await admin.get(`/admin/catalogue/editions/${w.edition.id}/pools`)).body as Array<{ id: string; lowStock: boolean }>;
    expect(listed.find((x) => x.id === p.id)?.lowStock).toBe(true);
  });

  it('a hold while the panel changes capacity: both finish and consumed stays within capacity', async () => {
    const w = await buildWorld(admin);
    const p = await newPool(w, 10);
    await Promise.allSettled([hold(p.id, 6), admin.patch(`/admin/catalogue/pools/${p.id}`, { capacity: 6, version: p.version }), hold(p.id, 3)]);
    const after = await pool(p.id);
    expect(after.consumed).toBeLessThanOrEqual(after.capacity);
    expect(after.consumed).toBeGreaterThanOrEqual(0);
  });

  it('check_constraint_backstop: SQL that would break the invariant is rejected by the database', async () => {
    const w = await buildWorld(admin);
    const p = await newPool(w, 2);
    await expect(t.prisma.$executeRaw`UPDATE inventory_pools SET consumed = 3 WHERE id = ${p.id}::uuid`).rejects.toThrow();
    await expect(t.prisma.$executeRaw`UPDATE inventory_pools SET consumed = -1 WHERE id = ${p.id}::uuid`).rejects.toThrow();
    expect((await pool(p.id)).consumed).toBe(0);
  });

  it('inventory_movements_are_immutable: no update, delete or truncate, even by SQL', async () => {
    const w = await buildWorld(admin);
    const p = await newPool(w, 2);
    await hold(p.id, 1);
    const m = await t.prisma.inventoryMovement.findFirstOrThrow({ where: { poolId: p.id } });
    await expect(t.prisma.$executeRaw`UPDATE inventory_movements SET delta = 5 WHERE id = ${m.id}::uuid`).rejects.toThrow();
    await expect(t.prisma.$executeRaw`DELETE FROM inventory_movements WHERE id = ${m.id}::uuid`).rejects.toThrow();
    await expect(t.prisma.$executeRawUnsafe('TRUNCATE inventory_movements')).rejects.toThrow();
    expect(await t.prisma.inventoryMovement.count({ where: { id: m.id } })).toBe(1);
  });

  it('options must use pools of the right kind and edition', async () => {
    const w = await buildWorld(admin);
    const other = await buildWorld(admin, { year: 2029 });
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    const room = (poolId: string) => admin.post(`/admin/catalogue/packages/${w.pkg.id}/hotels/${pkg.hotels[0].id}/rooms`, { roomType: 'single', name: { 'en-AU': 'S' }, minOccupancy: 1, maxOccupancy: 1, roomPoolId: poolId });
    expect((await room(w.entryPoolId)).body.code).toBe('pool_wrong_kind');
    expect((await room(other.roomPoolId)).body.code).toBe('pool_other_edition');
    expect((await room(w.roomPoolId)).status).toBe(201);
    expect((await admin.post(`/admin/catalogue/packages/${w.pkg.id}/extras`, { kind: 'meal', name: { 'en-AU': 'Pasta party' }, pricingUnit: 'per_person', poolId: w.roomPoolId })).body.code).toBe('pool_wrong_kind');
  });
});
