import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRoutes } from '../../support/routes';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { Client, anonymous, buildWorld, packageBody, setSale, slug, staffClient, closeCatalogue } from '../../support/catalogue';
import { CATALOGUE_PERMISSIONS as P } from '../../../src/modules/catalogue';

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t);
});
afterAll(async () => {
  await closeCatalogue(t);
});

/** Demo rows can only be made behind the API's back (the seed, task 1.5): here with the Prisma client directly. */
async function demoWorld() {
  const race = await t.prisma.race.create({ data: { slug: slug('race-demo'), name: { 'en-AU': 'Demo Marathon' }, countryCode: 'AU', city: 'Brisbane', timeZone: 'Australia/Brisbane', raceType: 'road', summary: { 'en-AU': 'Demo' }, isDemo: true } });
  const edition = await t.prisma.raceEdition.create({ data: { raceId: race.id, year: 2030, status: 'announced' } });
  const pkg = (await admin.post(`/admin/catalogue/editions/${edition.id}/packages`, packageBody())).body;
  const hotel = await t.prisma.hotel.create({ data: { name: 'Demo Hotel', address: '1 Demo St', city: 'Brisbane', countryCode: 'AU', description: {}, isDemo: true } });
  return { race, edition, pkg, hotel };
}

describe('demo data can never be published (phase 1 criterion, plan 6.1)', () => {
  it('demo_race_cannot_be_published: API and database', async () => {
    const { race } = await demoWorld();
    const res = await admin.post(`/admin/catalogue/races/${race.id}/status`, { status: 'published', version: race.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('demo_cannot_be_published');
    await expect(t.prisma.$executeRaw`UPDATE races SET status = 'published' WHERE id = ${race.id}::uuid`).rejects.toThrow();
    await expect(t.prisma.race.create({ data: { slug: slug('race-demo'), name: {}, countryCode: 'AU', city: 'X', timeZone: 'UTC', raceType: 'road', summary: {}, isDemo: true, status: 'published' } })).rejects.toThrow();
    expect((await t.prisma.race.findUniqueOrThrow({ where: { id: race.id } })).status).toBe('draft');
    // Not in the public API, draft or not.
    expect((await anonymous(t).get(`/catalogue/races/${race.slug}`)).status).toBe(404);
    expect((await anonymous(t).get(`/catalogue/races?q=${race.slug}`)).body.total).toBe(0);
  });

  it('demo_package_cannot_leave_draft: API and database', async () => {
    const { pkg, edition } = await demoWorld();
    for (const to of ['coming_soon', 'open']) {
      const res = await setSale(admin, pkg.id, to);
      expect(res.status, to).toBe(409);
      expect(res.body.code).toBe('demo_cannot_be_published');
    }
    await expect(t.prisma.$executeRaw`UPDATE packages SET "saleStatus" = 'open' WHERE id = ${pkg.id}::uuid`).rejects.toThrow();
    await expect(t.prisma.package.create({ data: { editionId: edition.id, slug: slug('p'), name: {}, checkInDate: new Date('2030-06-18'), checkOutDate: new Date('2030-06-20'), includes: {}, excludes: {}, balanceDueDate: new Date('2030-05-01'), maxTravellers: 2, saleStatus: 'open' } })).rejects.toThrow();
    expect((await admin.get(`/admin/catalogue/packages/${pkg.id}`)).body.saleStatus).toBe('draft');
  });

  it('isDemo cannot be changed, by SQL either; a demo hotel only joins a demo race', async () => {
    const { race, hotel, pkg } = await demoWorld();
    await expect(t.prisma.race.update({ where: { id: race.id }, data: { isDemo: false } })).rejects.toThrow();
    await expect(t.prisma.hotel.update({ where: { id: hotel.id }, data: { isDemo: false } })).rejects.toThrow();
    expect((await admin.post(`/admin/catalogue/packages/${pkg.id}/hotels`, { hotelId: hotel.id })).status).toBe(201);
    const real = await buildWorld(admin);
    const mismatch = await admin.post(`/admin/catalogue/packages/${real.pkg.id}/hotels`, { hotelId: hotel.id });
    expect(mismatch.body.code).toBe('demo_mismatch');
    await expect(t.prisma.packageHotel.create({ data: { packageId: real.pkg.id, hotelId: hotel.id } })).rejects.toThrow();
    const realHotel = (await admin.post('/admin/catalogue/hotels', { name: 'Real', address: 'A', city: 'C', countryCode: 'AU' })).body;
    expect((await admin.post(`/admin/catalogue/packages/${pkg.id}/hotels`, { hotelId: realHotel.id })).body.code).toBe('demo_mismatch');
  });

  it('a real race still publishes and a real package still opens', async () => {
    const w = await buildWorld(admin);
    expect((await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version })).status).toBe(200);
    expect((await setSale(admin, w.pkg.id, 'open')).status).toBe(200);
    await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'archived', version: w.race.version + 1 });
  });
});

describe('permissions', () => {
  const routes = () => allRoutes(t.app).filter((r) => r.path.startsWith('/admin/catalogue'));
  const fill = (path: string) => path.replace(/:\w+/g, (m) => (m === ':kind' ? 'official_partner' : crypto.randomUUID()));

  it('every catalogue admin route is refused without a session (401) and without its permission (403)', async () => {
    const rs = routes();
    expect(rs.length).toBeGreaterThanOrEqual(30);
    const nobody = await staffClient(t, []);
    for (const r of rs) {
      const method = r.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const anon = await t.http()[method](fill(r.path)).set(STATE_HEADERS).send({});
      expect(anon.status, `${r.method} ${r.path} anonymous`).toBe(401);
      const denied = method === 'get' ? await nobody.get(fill(r.path)) : await nobody[method](fill(r.path), {} as never);
      expect(denied.status, `${r.method} ${r.path} no permission`).toBe(403);
    }
  });

  it('each route names exactly one catalogue permission, and every catalogue permission is used', () => {
    const used = new Set<string>();
    for (const r of routes()) {
      expect(r.marks, `${r.method} ${r.path}`).toHaveLength(1);
      const mark = r.marks[0]!;
      expect(mark.type).toBe('permission');
      used.add((mark as { key: string }).key);
    }
    expect([...used].sort()).toEqual(Object.values(P).sort());
  });

  it('reading is not writing: a reader can see drafts and cannot change them', async () => {
    const w = await buildWorld(admin);
    const reader = await staffClient(t, [P.raceRead, P.packageRead]);
    expect((await reader.get(`/admin/catalogue/races/${w.race.id}`)).status).toBe(200);
    expect((await reader.get(`/admin/catalogue/packages/${w.pkg.id}`)).status).toBe(200);
    expect((await reader.patch(`/admin/catalogue/races/${w.race.id}`, { city: 'X', version: 0 })).status).toBe(403);
    expect((await reader.post(`/admin/catalogue/packages/${w.pkg.id}/sale-status`, { status: 'open', version: 0 })).status).toBe(403);
    const seller = await staffClient(t, [P.packageRead, P.packageSetSaleStatus]);
    expect((await seller.post(`/admin/catalogue/packages/${w.pkg.id}/sale-status`, { status: 'coming_soon', version: w.pkg.version })).status).toBe(200);
    expect((await seller.patch(`/admin/catalogue/packages/${w.pkg.id}`, { maxTravellers: 5, version: w.pkg.version + 1 })).status).toBe(403);
  });

  it('claims need a recent TOTP check', async () => {
    const w = await buildWorld(admin);
    const staff = await staffClient(t, [P.claimManage]);
    const url = `/admin/catalogue/races/${w.race.id}/claims/official_partner`;
    expect((await staff.put(url, { enabled: true, evidenceNote: 'On file' })).status).toBe(200);
    await t.prisma.session.updateMany({ where: { userId: staff.staff.id, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });
    const old = await staff.put(url, { enabled: false });
    expect(old.status).toBe(403);
    expect(old.body.code).toBe('step_up_required');
  });

  it('public routes need no session and expose no admin data', async () => {
    const r = allRoutes(t.app).filter((x) => x.path.startsWith('/catalogue'));
    expect(r.map((x) => x.marks[0]?.type)).toEqual(['public', 'public', 'public']);
    expect((await anonymous(t).get('/catalogue/races')).status).toBe(200);
  });
});
