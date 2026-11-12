import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SALE_STATUSES } from '@mt/shared';
import { SALE_TRANSITIONS, RACE_TRANSITIONS, EDITION_TRANSITIONS } from '../../../src/modules/catalogue/transitions';
import { TestApp, makeApp } from '../../support/auth';
import { Client, buildWorld, driveTo, packageBody, pricePackageFully, raceBody, setSale, staffClient, closeCatalogue } from '../../support/catalogue';

// These tests make many HTTP and database calls; a loaded machine must not fail them on the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t);
});
afterAll(async () => {
  // Stock history is immutable, so test data stays; make sure none of it is public.
  await t.prisma.race.updateMany({ where: { status: 'published', isDemo: false, slug: { startsWith: 'race-' } }, data: { status: 'archived' } });
  await closeCatalogue(t);
});

describe('create, edit and publish (phase 1 criterion)', () => {
  it('a race with an edition, package, hotel and extra can be created and published', async () => {
    const w = await buildWorld(admin);
    expect((await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version })).body.status).toBe('published');
    expect((await setSale(admin, w.pkg.id, 'open')).body.saleStatus).toBe('open');
    const edition = (await admin.get(`/admin/catalogue/editions/${w.edition.id}`)).body;
    expect(edition.packages).toHaveLength(1);
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    expect(pkg).toMatchObject({ saleStatus: 'open', deposit: { mode: 'per_person', amountMinor: '50000' }, currency: 'AUD', checkInDate: '2027-06-18' });
    expect(pkg.hotels[0].rooms).toHaveLength(1);
    expect(pkg.extras).toHaveLength(1);
    expect(pkg.entryOptions).toHaveLength(1);
  }, 60_000);

  it('is_demo_not_settable_via_api: isDemo is refused on create and update, and always false', async () => {
    expect((await admin.post('/admin/catalogue/races', raceBody({ isDemo: true }))).status).toBe(422);
    const race = (await admin.post('/admin/catalogue/races', raceBody())).body;
    expect(race.isDemo).toBe(false);
    expect((await admin.patch(`/admin/catalogue/races/${race.id}`, { isDemo: true, version: race.version })).status).toBe(422);
    const hotel = { name: 'H', address: 'A', city: 'C', countryCode: 'AU' };
    expect((await admin.post('/admin/catalogue/hotels', { ...hotel, isDemo: true })).status).toBe(422);
    expect((await admin.post('/admin/catalogue/hotels', hotel)).body.isDemo).toBe(false);
  });

  it('validation: unknown fields, bad dates, amounts as numbers and out-of-range occupancy are 422', async () => {
    const w = await buildWorld(admin);
    const ed = `/admin/catalogue/editions/${w.edition.id}/packages`;
    expect((await admin.post(ed, packageBody({ surprise: 1 }))).status).toBe(422);
    expect((await admin.post(ed, packageBody({ checkOutDate: '2027-06-18' }))).body.code).toBe('package_dates_invalid');
    expect((await admin.post(ed, packageBody({ balanceDueDate: '2027-06-19' }))).body.code).toBe('balance_due_after_check_in');
    expect((await admin.post(ed, packageBody({ deposit: { mode: 'per_person', amountMinor: 50000 } }))).status).toBe(422);
    expect((await admin.post(ed, packageBody({ deposit: { mode: 'per_person', amountMinor: '100000001' } }))).status).toBe(422);
    expect((await admin.post(ed, packageBody({ deposit: { mode: 'percent', bps: 0 } }))).status).toBe(422);
    expect((await admin.post(ed, packageBody({ currency: 'EUR' }))).status).toBe(422);
    expect((await admin.post(ed, packageBody({ checkInDate: '2027-02-30', balanceDueDate: '2027-01-01' }))).status).toBe(422);
    const pkg = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    const hotelLink = pkg.hotels[0].id;
    const room = (over: object) => admin.post(`/admin/catalogue/packages/${w.pkg.id}/hotels/${hotelLink}/rooms`, { roomType: 'double', name: { 'en-AU': 'R' }, minOccupancy: 1, maxOccupancy: 2, roomPoolId: w.roomPoolId, ...over });
    for (const bad of [{ minOccupancy: 0 }, { maxOccupancy: 5 }, { minOccupancy: 3, maxOccupancy: 2 }]) expect((await room(bad)).status).toBe(422);
    for (const occupancy of [1, 2, 3, 4]) expect((await room({ minOccupancy: occupancy, maxOccupancy: occupancy })).status).toBe(201);
    expect((await admin.post('/admin/catalogue/races', raceBody({ name: { 'es-ES': 'Solo español' } }))).status).toBe(422);
  }, 60_000);

  it('optimistic locking: a stale version is a 409 and changes nothing', async () => {
    const w = await buildWorld(admin);
    const ok = await admin.patch(`/admin/catalogue/races/${w.race.id}`, { city: 'Cairns', version: w.race.version });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ city: 'Cairns', version: w.race.version + 1 });
    const stale = await admin.patch(`/admin/catalogue/races/${w.race.id}`, { city: 'Perth', version: w.race.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    expect((await admin.get(`/admin/catalogue/races/${w.race.id}`)).body.city).toBe('Cairns');
    expect((await admin.patch(`/admin/catalogue/packages/${w.pkg.id}`, { maxTravellers: 6, version: 99 })).status).toBe(409);
  });

  it('duplicate slugs and editions are 409; options from another race or edition are refused', async () => {
    const w = await buildWorld(admin);
    const other = await buildWorld(admin, { year: 2028 });
    expect((await admin.post('/admin/catalogue/races', raceBody({ slug: w.race.slug }))).body.code).toBe('race_slug_taken');
    expect((await admin.post(`/admin/catalogue/races/${w.race.id}/editions`, { year: w.edition.year })).body.code).toBe('edition_year_taken');
    expect((await admin.post(`/admin/catalogue/editions/${w.edition.id}/packages`, packageBody({ slug: w.pkg.slug }))).body.code).toBe('package_slug_taken');
    const entry = (poolId: string, distanceId: string) => admin.post(`/admin/catalogue/packages/${w.pkg.id}/entry-options`, { raceDistanceId: distanceId, entryPoolId: poolId });
    expect((await entry(other.entryPoolId, other.distanceId)).body.code).toBe('distance_other_race');
    expect((await entry(other.entryPoolId, w.distanceId)).body.code).toBe('pool_other_edition');
    expect((await entry(w.roomPoolId, w.distanceId)).body.code).toBe('pool_wrong_kind');
    expect((await entry(w.entryPoolId, w.distanceId)).body.code).toBe('entry_option_exists');
  }, 60_000);

  it('a draft race or package can be deleted; a package on sale cannot; used distances stay', async () => {
    const w = await buildWorld(admin);
    expect((await admin.delete(`/admin/catalogue/distances/${w.distanceId}`)).body.code).toBe('distance_in_use');
    expect((await admin.delete(`/admin/catalogue/races/${w.race.id}`)).body.code).toBe('race_has_editions');
    await driveTo(admin, w.pkg.id, 'open');
    expect((await admin.delete(`/admin/catalogue/packages/${w.pkg.id}`)).body.code).toBe('package_not_draft');
    const w2 = await buildWorld(admin);
    expect((await admin.delete(`/admin/catalogue/packages/${w2.pkg.id}`)).status).toBe(204);
    expect((await admin.get(`/admin/catalogue/packages/${w2.pkg.id}`)).status).toBe(404);
  });
});

describe('sale status (plan 6.1)', () => {
  it('sale_status_transitions_match_table: every (from, to) pair, only the table passes', async () => {
    const w = await buildWorld(admin);
    const fresh = async (from: string) => {
      const pkg = (await admin.post(`/admin/catalogue/editions/${w.edition.id}/packages`, packageBody())).body;
      // Since 2.1 a package opens only with complete prices in force; give every fresh package its prices.
      await pricePackageFully(admin, pkg.id);
      await driveTo(admin, pkg.id, from);
      return pkg.id as string;
    };
    for (const from of SALE_STATUSES) {
      const allowedTo = SALE_TRANSITIONS[from] as readonly string[];
      // Refused changes leave the package where it was, so one package serves all of them.
      const kept = await fresh(from);
      for (const to of SALE_STATUSES.filter((x) => !allowedTo.includes(x))) {
        const before = (await admin.get(`/admin/catalogue/packages/${kept}`)).body;
        const res = await setSale(admin, kept, to, before.version);
        expect(res.status, `${from} -> ${to}`).toBe(409);
        expect(res.body.code).toBe('transition_not_allowed');
        expect((await admin.get(`/admin/catalogue/packages/${kept}`)).body.saleStatus).toBe(from);
      }
      // An allowed change moves the package, so each one gets its own.
      for (const to of allowedTo) {
        const id = await fresh(from);
        const res = await setSale(admin, id, to);
        expect(res.status, `${from} -> ${to}`).toBe(200);
        expect(res.body.saleStatus).toBe(to);
      }
    }
  }, 120_000);

  it('race and edition tables cover every pair and each change is audited with its event', async () => {
    for (const table of [RACE_TRANSITIONS, EDITION_TRANSITIONS]) {
      for (const [from, tos] of Object.entries(table)) expect(new Set(tos).has(from as never), `${from} to itself`).toBe(false);
    }
    const w = await buildWorld(admin);
    await setSale(admin, w.pkg.id, 'coming_soon');
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Package', entityId: w.pkg.id, action: 'catalogue.package.sale_status_changed' } });
    expect(log.changes).toMatchObject({ saleStatus: { before: 'draft', after: 'coming_soon' } });
    const event = await t.prisma.outboxEvent.findFirstOrThrow({ where: { type: 'catalogue.package.sale_status_changed', aggregateId: w.pkg.id } });
    expect(event.payload).toMatchObject({ packageId: w.pkg.id, fromStatus: 'draft', toStatus: 'coming_soon' });
    await setSale(admin, w.pkg.id, 'closed');
    expect((await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'archived', version: w.race.version })).status).toBe(200);
    expect((await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version + 1 })).body.code).toBe('transition_not_allowed');
  });

  it('two transitions at once: one wins, the other gets 409', async () => {
    const w = await buildWorld(admin);
    const v = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body.version;
    const results = await Promise.all([setSale(admin, w.pkg.id, 'coming_soon', v), setSale(admin, w.pkg.id, 'open', v)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.prisma.outboxEvent.count({ where: { type: 'catalogue.package.sale_status_changed', aggregateId: w.pkg.id } })).toBe(1);
  });

  it('open_needs_deposit_and_registered_gates', async () => {
    const w = await buildWorld(admin, { packageOver: { deposit: null } });
    const res = await setSale(admin, w.pkg.id, 'open');
    expect(res.body.code).toBe('deposit_not_configured');
    expect((await setSale(admin, w.pkg.id, 'coming_soon')).status).toBe(200);
    expect((await admin.patch(`/admin/catalogue/packages/${w.pkg.id}`, { deposit: { mode: 'percent', bps: 2500 }, version: (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body.version })).body.deposit).toEqual({ mode: 'percent', bps: 2500 });
    const { PackageOpenGates } = await import('../../../src/modules/catalogue');
    const gates = t.app.get(PackageOpenGates);
    gates.register(`test-gate-${w.pkg.id}`, async (_tx, pkg) => (pkg.id === w.pkg.id ? { code: 'no_price_version', message: 'Publish a price version first' } : null));
    expect((await setSale(admin, w.pkg.id, 'open')).body.code).toBe('no_price_version');
    expect((await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body.saleStatus).toBe('coming_soon');
    // a package on sale cannot lose its deposit
    const w2 = await buildWorld(admin);
    await setSale(admin, w2.pkg.id, 'open');
    const v = (await admin.get(`/admin/catalogue/packages/${w2.pkg.id}`)).body.version;
    expect((await admin.patch(`/admin/catalogue/packages/${w2.pkg.id}`, { deposit: null, version: v })).body.code).toBe('open_package_needs_deposit');
  });
});

describe('claims (plan 5.2)', () => {
  it('turning a claim on needs evidence; the change is audited with before and after', async () => {
    const w = await buildWorld(admin);
    const url = `/admin/catalogue/races/${w.race.id}/claims/official_partner`;
    expect((await admin.put(url, { enabled: true })).body.code).toBe('evidence_required');
    const on = await admin.put(url, { enabled: true, evidenceNote: 'Letter from the organiser, 2 July' });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true });
    expect(on.body.enabledAt).toBeTruthy();
    const off = await admin.put(url, { enabled: false, evidenceNote: 'Letter from the organiser, 2 July' });
    expect(off.body).toMatchObject({ enabled: false, enabledAt: null });
    const logs = await t.prisma.auditLog.findMany({ where: { entityType: 'RaceClaim', entityId: on.body.id }, orderBy: { occurredAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[0]!.changes).toMatchObject({ enabled: { before: null, after: true } });
    expect(logs[1]!.changes).toMatchObject({ enabled: { before: true, after: false } });
    expect((await admin.put(`/admin/catalogue/races/${w.race.id}/claims/bogus`, { enabled: false })).status).toBe(404);
  });
});
