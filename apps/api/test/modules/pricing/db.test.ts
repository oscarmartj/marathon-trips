// What the database guarantees on its own, whatever the code does (plan 2.1, G3, M1, M2, M13): SQL straight to
// PostgreSQL as the API role.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestApp, makeApp } from '../../support/auth';
import { Client, closeCatalogue, staffClient } from '../../support/catalogue';
import { draftWith, pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
let admin: Client;
let w: PricedWorld;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t);
  w = await pricedWorld(admin);
});
afterAll(async () => {
  await closeCatalogue(t);
});

const sql = (q: string, ...params: unknown[]) => t.prisma.$executeRawUnsafe(q, ...params);
const id = () => crypto.randomUUID();
const draft = async () => (await draftWith(admin, w.pkg.id, { roomRates: [], participationRates: [], extraRates: [] })).id;

describe('published_rates_immutable', () => {
  it('rates of a published version cannot be inserted, changed or deleted', async () => {
    await expect(sql(`UPDATE room_rates SET "pricePerPersonMinor" = 1 WHERE "priceVersionId" = $1::uuid`, w.versionId)).rejects.toThrow(/only the rates of a draft/);
    await expect(sql(`DELETE FROM extra_rates WHERE "priceVersionId" = $1::uuid`, w.versionId)).rejects.toThrow(/only the rates of a draft/);
    await expect(sql(`INSERT INTO extra_rates (id, "priceVersionId", currency, "extraId", "amountMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, 1)`, id(), w.versionId, w.extraId)).rejects.toThrow(/only the rates of a draft|duplicate/);
    await expect(sql(`TRUNCATE room_rates`)).rejects.toThrow();
    await expect(sql(`TRUNCATE price_versions`)).rejects.toThrow();
    const r = await t.prisma.roomRate.findMany({ where: { priceVersionId: w.versionId }, orderBy: { occupancy: 'asc' } });
    expect(r.map((x) => x.pricePerPersonMinor)).toEqual([80_000n, 50_000n]);
  });

  it('a published version is frozen: no label, status or start change, no delete, no archive', async () => {
    await expect(sql(`UPDATE price_versions SET label = 'x' WHERE id = $1::uuid`, w.versionId)).rejects.toThrow(/frozen/);
    await expect(sql(`UPDATE price_versions SET status = 'archived', "validFrom" = NULL WHERE id = $1::uuid`, w.versionId)).rejects.toThrow(/frozen/);
    await expect(sql(`UPDATE price_versions SET "validFrom" = now() + interval '1 day' WHERE id = $1::uuid`, w.versionId)).rejects.toThrow(/frozen/);
    await expect(sql(`DELETE FROM price_versions WHERE id = $1::uuid`, w.versionId)).rejects.toThrow(/only a draft/);
  });

  it('published_version_closed_only_with_successor; an end in the past is refused', async () => {
    await expect(sql(`UPDATE price_versions SET "validTo" = now() WHERE id = $1::uuid`, w.versionId)).rejects.toThrow(/successor/);
    await expect(sql(`UPDATE price_versions SET "validTo" = now() - interval '1 hour' WHERE id = $1::uuid`, w.versionId)).rejects.toThrow(/not in the past/);
    expect((await t.prisma.priceVersion.findUniqueOrThrow({ where: { id: w.versionId } })).validTo).toBeNull();
  });

  it('a rate edit waits for its version row (FOR SHARE), so a publish cannot slip between them (M2)', async () => {
    const d = await draft();
    const order: string[] = [];
    let other: Promise<unknown> = Promise.resolve();
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO extra_rates (id, "priceVersionId", currency, "extraId", "amountMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, 1)`, id(), d, w.extraId);
      // another connection updating the version (as a publish does) must wait for this transaction
      other = t.prisma.$executeRawUnsafe(`UPDATE price_versions SET label = 'Locked out' WHERE id = $1::uuid`, d).then(() => order.push('publish side'));
      await new Promise((r) => setTimeout(r, 300));
      order.push('rate side commits');
    });
    await other;
    expect(order).toEqual(['rate side commits', 'publish side']);
  });
});

describe('published_versions_do_not_overlap', () => {
  it('a second published version over the same period is refused by the EXCLUDE constraint', async () => {
    const d = await draft();
    await expect(sql(`UPDATE price_versions SET status = 'published', "validFrom" = now() WHERE id = $1::uuid`, d)).rejects.toThrow(/price_versions_no_overlap|exclusion|conflicting key/);
  });
  it('a draft cannot be published in the past', async () => {
    const d = await draft();
    await expect(sql(`UPDATE price_versions SET status = 'published', "validFrom" = now() - interval '1 day', "validTo" = now() - interval '12 hours' WHERE id = $1::uuid`, d)).rejects.toThrow(/in the past/);
  });
});

describe('rate shape (G3)', () => {
  it('duplicate_participation_rate_rejected: also when there is no distance (NULLS NOT DISTINCT)', async () => {
    const d = await draft();
    const ins = () => sql(`INSERT INTO participation_rates (id, "priceVersionId", currency, "participationType", "raceDistanceId", "amountPerPersonMinor") VALUES ($1::uuid, $2::uuid, 'AUD', 'supporter', NULL, 1)`, id(), d);
    await ins();
    await expect(ins()).rejects.toThrow(/participation_rates_version_type_distance_key|duplicate/);
    const withDistance = () => sql(`INSERT INTO participation_rates (id, "priceVersionId", currency, "participationType", "raceDistanceId", "amountPerPersonMinor") VALUES ($1::uuid, $2::uuid, 'AUD', 'runner_with_entry', $3::uuid, 1)`, id(), d, w.distanceId);
    await withDistance();
    await expect(withDistance()).rejects.toThrow(/duplicate/);
  });

  it('duplicate_extra_rate_rejected', async () => {
    const d = await draft();
    const ins = () => sql(`INSERT INTO extra_rates (id, "priceVersionId", currency, "extraId", "amountMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, 1)`, id(), d, w.extraId);
    await ins();
    await expect(ins()).rejects.toThrow(/extra_rates_priceVersionId_extraId_key|duplicate/);
  });

  it('distance_required_iff_runner_with_entry', async () => {
    const d = await draft();
    const ins = (type: string, distance: string | null) =>
      sql(`INSERT INTO participation_rates (id, "priceVersionId", currency, "participationType", "raceDistanceId", "amountPerPersonMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::"ParticipationType", $4::uuid, 1)`, id(), d, type, distance);
    await expect(ins('runner_with_entry', null)).rejects.toThrow(/distance_iff_entry/);
    await expect(ins('supporter', w.distanceId)).rejects.toThrow(/distance_iff_entry/);
    await expect(ins('runner_own_entry', w.distanceId)).rejects.toThrow(/distance_iff_entry/);
  });

  it('rate_for_other_package_rejected, negative and oversized amounts rejected', async () => {
    const other = await pricedWorld(admin, { open: false });
    const d = await draft();
    await expect(sql(`INSERT INTO extra_rates (id, "priceVersionId", currency, "extraId", "amountMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, 1)`, id(), d, other.extraId)).rejects.toThrow(/belongs to its package/);
    await expect(sql(`INSERT INTO room_rates (id, "priceVersionId", currency, "roomOptionId", occupancy, "pricePerPersonMinor", "extraNightPerPersonMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, 1, 1, 1)`, id(), d, other.roomId)).rejects.toThrow(/belongs to its package/);
    await expect(sql(`INSERT INTO participation_rates (id, "priceVersionId", currency, "participationType", "raceDistanceId", "amountPerPersonMinor") VALUES ($1::uuid, $2::uuid, 'AUD', 'runner_with_entry', $3::uuid, 1)`, id(), d, other.distanceId)).rejects.toThrow(/belongs to its package/);
    await expect(sql(`INSERT INTO extra_rates (id, "priceVersionId", currency, "extraId", "amountMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, -1)`, id(), d, w.extraId)).rejects.toThrow(/extra_rates_amount_check/);
    await expect(sql(`INSERT INTO extra_rates (id, "priceVersionId", currency, "extraId", "amountMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, 100000001)`, id(), d, w.extraId)).rejects.toThrow(/extra_rates_amount_check/);
    await expect(sql(`INSERT INTO room_rates (id, "priceVersionId", currency, "roomOptionId", occupancy, "pricePerPersonMinor", "extraNightPerPersonMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, 5, 1, 1)`, id(), d, w.roomId)).rejects.toThrow(/room_rates_occupancy_check/);
  });
});

describe('money_identity_columns_immutable', () => {
  it('a version keeps its package and currency; a rate keeps its version and currency; a priced package keeps its currency', async () => {
    const d = await draft();
    await sql(`INSERT INTO extra_rates (id, "priceVersionId", currency, "extraId", "amountMinor") VALUES ($1::uuid, $2::uuid, 'AUD', $3::uuid, 1)`, id(), d, w.extraId);
    const other = await pricedWorld(admin, { open: false });
    await expect(sql(`UPDATE price_versions SET currency = 'NZD' WHERE id = $1::uuid`, d)).rejects.toThrow(/never change|foreign key/);
    await expect(sql(`UPDATE price_versions SET "packageId" = $2::uuid WHERE id = $1::uuid`, d, other.pkg.id)).rejects.toThrow(/never change|foreign key/);
    await expect(sql(`UPDATE extra_rates SET currency = 'NZD' WHERE "priceVersionId" = $1::uuid`, d)).rejects.toThrow(/never change|foreign key/);
    await expect(sql(`UPDATE extra_rates SET "priceVersionId" = $2::uuid WHERE "priceVersionId" = $1::uuid`, d, other.versionId)).rejects.toThrow(/never change|foreign key/);
    await expect(sql(`UPDATE packages SET currency = 'NZD' WHERE id = $1::uuid`, w.pkg.id)).rejects.toThrow(/foreign key|violates/);
  });

  it('a version in another currency than its package cannot exist (composite foreign key)', async () => {
    await expect(sql(`INSERT INTO price_versions (id, "packageId", currency, label, "updatedAt") VALUES ($1::uuid, $2::uuid, 'NZD', 'x', now())`, id(), w.pkg.id)).rejects.toThrow(/foreign key/);
  });
});
