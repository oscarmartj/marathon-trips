import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicCatalogueService } from '../../../src/modules/catalogue';
import { TestApp, makeApp } from '../../support/auth';
import { Client, World, announceEdition, anonymous, buildWorld, driveTo, setSale, slug, staffClient, closeCatalogue } from '../../support/catalogue';

let t: TestApp;
let admin: Client;
beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t);
});
afterAll(async () => {
  await t.prisma.race.updateMany({ where: { status: 'published', isDemo: false, slug: { startsWith: 'race-' } }, data: { status: 'archived' } });
  await closeCatalogue(t);
});

const publish = async (w: World) => admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version });
const pub = () => anonymous(t);
const pkgUrl = (w: World) => `/catalogue/races/${w.race.slug}/editions/${w.edition.year}/packages/${w.pkg.slug}`;

describe('draft and unpublished data stay private (phase 1 criterion)', () => {
  it('draft_package_absent_from_public_api: detail, race page, search and sitemap list', async () => {
    const w = await buildWorld(admin);
    await publish(w);
    expect((await pub().get(`/catalogue/races/${w.race.slug}`)).status).toBe(200);
    // The edition is still a draft: neither it nor its package shows.
    let race = (await pub().get(`/catalogue/races/${w.race.slug}`)).body;
    expect(race.editions).toEqual([]);
    expect((await pub().get(pkgUrl(w))).status).toBe(404);
    await announceEdition(admin, w.edition.id);
    race = (await pub().get(`/catalogue/races/${w.race.slug}`)).body;
    expect(race.editions).toHaveLength(1);
    expect(race.editions[0].packages).toEqual([]); // package is still draft
    expect((await pub().get(pkgUrl(w))).status).toBe(404);
    const sitemap = async () => (await t.app.get(PublicCatalogueService).listPublicPackages()).filter((p) => p.raceSlug === w.race.slug);
    expect(await sitemap()).toEqual([]);
    await setSale(admin, w.pkg.id, 'coming_soon');
    expect((await pub().get(pkgUrl(w))).status).toBe(200);
    expect(await sitemap()).toEqual([expect.objectContaining({ packageSlug: w.pkg.slug, year: w.edition.year })]);
    // Back to draft is allowed from coming_soon, and the page disappears again.
    await setSale(admin, w.pkg.id, 'draft');
    expect((await pub().get(pkgUrl(w))).status).toBe(404);
    expect(await sitemap()).toEqual([]);
  });

  it('an unpublished or deleted race is a 404 and is not listed', async () => {
    const w = await buildWorld(admin);
    expect((await pub().get(`/catalogue/races/${w.race.slug}`)).status).toBe(404);
    const search = await pub().get(`/catalogue/races?q=${w.race.slug}`);
    expect(search.body.total).toBe(0);
    expect((await pub().get('/catalogue/races/Not%20a%20slug')).status).toBe(404);
  });
});

describe('search filters combine (API side of the 1.3 criterion)', () => {
  it('country, type, month, distance, year and text narrow each other', async () => {
    const tag = slug('find');
    const make = async (over: Record<string, unknown>, year: number, month: string) => {
      const w = await buildWorld(admin, { year });
      await admin.patch(`/admin/catalogue/races/${w.race.id}`, { slug: slug(`race-${tag}`), version: w.race.version, ...over });
      await admin.patch(`/admin/catalogue/editions/${w.edition.id}`, { startDate: `${year}-${month}-14`, endDate: `${year}-${month}-14`, version: 0 });
      await admin.post(`/admin/catalogue/editions/${w.edition.id}/status`, { status: 'announced', version: 1 });
      const race = (await admin.get(`/admin/catalogue/races/${w.race.id}`)).body;
      await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: race.version });
      return race.slug as string;
    };
    const a = await make({ countryCode: 'AU', raceType: 'road', city: 'Gold Coast' }, 2027, '07');
    const b = await make({ countryCode: 'AU', raceType: 'trail', city: 'Gold Coast' }, 2028, '07');
    const c = await make({ countryCode: 'NZ', raceType: 'road', city: 'Auckland' }, 2027, '10');
    const slugs = async (qs: string) => ((await pub().get(`/catalogue/races?q=${tag}&${qs}`)).body.items as Array<{ slug: string }>).map((r) => r.slug).sort();
    expect(await slugs('')).toEqual([a, b, c].sort());
    expect(await slugs('country=AU')).toEqual([a, b].sort());
    expect(await slugs('country=AU&type=road')).toEqual([a]);
    expect(await slugs('month=7')).toEqual([a, b].sort());
    expect(await slugs('month=7&year=2028')).toEqual([b]);
    expect(await slugs('month=10&country=AU')).toEqual([]);
    expect(await slugs('distance=marathon&country=NZ')).toEqual([c]);
    expect(await slugs('distance=half')).toEqual([]);
    expect((await pub().get(`/catalogue/races?q=${tag}&pageSize=2&page=2`)).body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect((await pub().get('/catalogue/races?country=Australia')).status).toBe(422);
    expect((await pub().get('/catalogue/races?bogus=1')).status).toBe(422);
  });

  it('a provisional date is flagged so the website can show it', async () => {
    const w = await buildWorld(admin);
    await admin.patch(`/admin/catalogue/editions/${w.edition.id}`, { dateStatus: 'provisional', version: 0 });
    await admin.post(`/admin/catalogue/editions/${w.edition.id}/status`, { status: 'announced', version: 1 });
    await publish(w);
    const race = (await pub().get(`/catalogue/races/${w.race.slug}`)).body;
    expect(race.editions[0]).toMatchObject({ dateStatus: 'provisional', dateConfirmed: false });
    expect((await admin.patch(`/admin/catalogue/editions/${w.edition.id}`, { dateStatus: 'confirmed', startDate: null, version: 2 })).body.code).toBe('edition_confirmed_needs_date');
  });
});

describe('badges and guaranteed entry (plan 5.2)', () => {
  const claimOn = (w: World, kind: string) => admin.put(`/admin/catalogue/races/${w.race.id}/claims/${kind}`, { enabled: true, evidenceNote: 'Written confirmation on file' });
  const live = async (): Promise<World> => {
    const w = await buildWorld(admin);
    await announceEdition(admin, w.edition.id);
    await publish(w);
    await driveTo(admin, w.pkg.id, 'open');
    return w;
  };
  const guaranteed = async (w: World) => (await pub().get(pkgUrl(w))).body.guaranteedEntry as boolean;
  const pool = async (w: World) => (await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.entryPoolId } }));
  const confirm = async (w: World, confirmedBySupplier: boolean) => admin.patch(`/admin/catalogue/pools/${w.entryPoolId}`, { confirmedBySupplier, version: (await pool(w)).version });

  it('guaranteed_entry_false_without_claim, with unconfirmed stock, or without entries; true only when all hold', async () => {
    const w = await live();
    expect(await guaranteed(w)).toBe(false); // no claim, stock unconfirmed
    await confirm(w, true);
    expect(await guaranteed(w)).toBe(false); // stock confirmed, no claim
    await claimOn(w, 'guaranteed_entry');
    expect(await guaranteed(w)).toBe(true);
    await confirm(w, false);
    expect(await guaranteed(w)).toBe(false); // claim on, stock not confirmed
    // a second entry pool that is not confirmed also switches it off
    await confirm(w, true);
    const second = (await admin.post(`/admin/catalogue/editions/${w.edition.id}/pools`, { kind: 'entry', label: 'Half entries', capacity: 5 })).body;
    const half = (await admin.post(`/admin/catalogue/races/${w.race.id}/distances`, { kind: 'half', distanceMetres: 21097, name: { 'en-AU': 'Half marathon' } })).body;
    await admin.post(`/admin/catalogue/packages/${w.pkg.id}/entry-options`, { raceDistanceId: half.id, entryPoolId: second.id });
    expect(await guaranteed(w)).toBe(false);
    await admin.patch(`/admin/catalogue/pools/${second.id}`, { confirmedBySupplier: true, version: second.version });
    expect(await guaranteed(w)).toBe(true);
    // The race page agrees, and the claim switched off removes it.
    expect((await pub().get(`/catalogue/races/${w.race.slug}`)).body.editions[0].packages[0].guaranteedEntry).toBe(true);
    await admin.put(`/admin/catalogue/races/${w.race.id}/claims/guaranteed_entry`, { enabled: false });
    expect(await guaranteed(w)).toBe(false);
  });

  it('no entries at all: never guaranteed, even with the claim on', async () => {
    const w = await live();
    await claimOn(w, 'guaranteed_entry');
    const detail = (await admin.get(`/admin/catalogue/packages/${w.pkg.id}`)).body;
    await admin.delete(`/admin/catalogue/packages/${w.pkg.id}/entry-options/${detail.entryOptions[0].id}`);
    expect(await guaranteed(w)).toBe(false);
  });

  it('race badges come only from enabled claims, and guaranteed_entry is never a race badge', async () => {
    const w = await live();
    expect((await pub().get(`/catalogue/races/${w.race.slug}`)).body.claims).toEqual([]);
    await claimOn(w, 'official_partner');
    await claimOn(w, 'guaranteed_entry');
    await admin.put(`/admin/catalogue/races/${w.race.id}/claims/accredited_agent`, { enabled: false });
    expect((await pub().get(`/catalogue/races/${w.race.slug}`)).body.claims).toEqual(['official_partner']);
    expect((await pub().get(pkgUrl(w))).body.race.claims).toEqual(['official_partner']);
  });

  it('the public JSON carries no stock numbers, only available, low or none', async () => {
    const w = await live();
    const body = (await pub().get(pkgUrl(w))).body;
    expect(body.entries[0].availability).toBe('available');
    expect(body.hotels[0].rooms[0].availability).toBe('available');
    const text = JSON.stringify(body);
    for (const key of ['capacity', 'consumed', 'lowStock', 'remaining', 'confirmedBySupplier', 'confirmationNote', 'evidenceNote', 'poolId', 'entryPoolId', 'roomPoolId', 'deletedAt', 'isDemo']) {
      expect(text, key).not.toContain(`"${key}"`);
    }
    // 10 places, threshold 2: hold 8 -> low; hold 2 more -> none.
    const { InventoryService } = await import('../../../src/modules/catalogue');
    const inv = t.app.get(InventoryService);
    const actor = { type: 'system' as const, id: null };
    await t.prisma.$transaction((tx) => inv.hold(tx, w.entryPoolId, 8, { actor }));
    expect((await pub().get(pkgUrl(w))).body.entries[0].availability).toBe('low');
    await t.prisma.$transaction((tx) => inv.hold(tx, w.entryPoolId, 2, { actor }));
    expect((await pub().get(pkgUrl(w))).body.entries[0].availability).toBe('none');
  });

  it('a package of a race that is later archived disappears', async () => {
    const w = await live();
    expect((await pub().get(pkgUrl(w))).status).toBe(200);
    await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'archived', version: 1 });
    expect((await pub().get(pkgUrl(w))).status).toBe(404);
  });
});
