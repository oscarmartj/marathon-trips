import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TestApp, makeApp } from '../../support/auth';
import { Client, World, anonymous, announceEdition, buildWorld, closeCatalogue, driveTo, slug, staffClient } from '../../support/catalogue';
import { CATALOGUE_PERMISSIONS as P } from '../../../src/modules/catalogue';

// Task 1.2: duplicate a package, preview, low-stock warning and catalogue CSV.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

const base = '/admin/catalogue';
const text = (s: string) => ({ 'en-AU': s });
const ok = <T extends { status: number; body: unknown }>(r: T, what: string): T => {
  if (r.status >= 300) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const nextEdition = async (w: World, year: number) => ok(await admin.post(`${base}/races/${w.race.id}/editions`, { year }), 'edition').body as { id: string };
const dupBody = (editionId: string, over: Record<string, unknown> = {}) => ({ targetEditionId: editionId, slug: slug('copy'), checkInDate: '2028-06-16', checkOutDate: '2028-06-19', balanceDueDate: '2028-04-16', ...over });

describe('duplicate a package to another edition', () => {
  it('copies the package as a draft with fresh, empty, unconfirmed stock; the original does not change', async () => {
    const w = await buildWorld(admin);
    // Confirm the source stock and use some of it: neither may be inherited.
    const pool = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.entryPoolId } });
    ok(await admin.patch(`${base}/pools/${w.entryPoolId}`, { confirmedBySupplier: true, confirmationNote: 'Supplier email on file', version: pool.version }), 'confirm');
    await t.prisma.$executeRaw`UPDATE inventory_pools SET consumed = 3 WHERE id = ${w.entryPoolId}::uuid`;
    ok(await admin.put(`${base}/packages/${w.pkg.id}/participation`, { types: ['runner_with_entry', 'supporter'] }), 'participation');
    const before = (await admin.get(`${base}/packages/${w.pkg.id}`)).body;
    const target = await nextEdition(w, 2028);
    const poolsBefore = await t.prisma.inventoryPool.count();

    const res = await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(target.id, { name: text('Race weekend 2028'), reason: 'Next year' }));
    expect(res.status).toBe(201);
    const copy = res.body;
    expect(copy).toMatchObject({
      editionId: target.id, saleStatus: 'draft', version: 0, checkInDate: '2028-06-16', checkOutDate: '2028-06-19', balanceDueDate: '2028-04-16', name: text('Race weekend 2028'),
      deposit: { mode: 'per_person', amountMinor: '50000' }, maxTravellers: 4, currency: 'AUD', publishedAt: null,
    });
    expect(copy.participationOptions.map((o: { type: string }) => o.type).sort()).toEqual(['runner_with_entry', 'supporter']);
    expect(copy.entryOptions).toHaveLength(1);
    expect(copy.hotels).toHaveLength(1);
    expect(copy.hotels[0].rooms).toHaveLength(1);
    expect(copy.extras).toHaveLength(1);
    // Three new pools in the target edition: empty and unconfirmed, with the capacity and threshold of the originals.
    const pools = await t.prisma.inventoryPool.findMany({ where: { editionId: target.id } });
    expect(pools).toHaveLength(3);
    expect(pools.map((p) => [p.kind, p.capacity, p.consumed, p.lowStockThreshold, p.confirmedBySupplier, p.confirmationNote]).sort()).toEqual([
      ['entry', 10, 0, 2, false, null], ['extra', 10, 0, 2, false, null], ['room', 10, 0, 2, false, null],
    ]);
    expect(copy.entryOptions[0].entryPoolId).not.toBe(w.entryPoolId);
    expect(await t.prisma.inventoryPool.count()).toBe(poolsBefore + 3);
    // The original is untouched.
    const after = (await admin.get(`${base}/packages/${w.pkg.id}`)).body;
    expect(after).toEqual(before);
    expect((await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.entryPoolId } })).consumed).toBe(3);
    // Audit entry.
    const log = await t.prisma.auditLog.findFirst({ where: { action: 'catalogue.package.duplicated', entityId: copy.id } });
    expect(log).not.toBeNull();
  });

  it('an open package is copied as a draft and never opens', async () => {
    const w = await buildWorld(admin);
    await announceEdition(admin, w.edition.id);
    ok(await admin.post(`${base}/races/${w.race.id}/status`, { status: 'published', version: w.race.version }), 'publish');
    await driveTo(admin, w.pkg.id, 'open');
    const target = await nextEdition(w, 2028);
    const copy = ok(await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(target.id)), 'duplicate').body;
    expect(copy.saleStatus).toBe('draft');
    expect((await anonymous(t).get(`/catalogue/races/${w.race.slug}/editions/2028/packages/${copy.slug}`)).status).toBe(404);
  });

  it('a pool shared by two rooms stays shared in the copy', async () => {
    const w = await buildWorld(admin);
    const pkg = (await admin.get(`${base}/packages/${w.pkg.id}`)).body;
    ok(await admin.post(`${base}/packages/${w.pkg.id}/hotels/${pkg.hotels[0].id}/rooms`, { roomType: 'twin', name: text('Twin room'), minOccupancy: 1, maxOccupancy: 2, roomPoolId: w.roomPoolId }), 'second room');
    const target = await nextEdition(w, 2028);
    const copy = ok(await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(target.id)), 'duplicate').body;
    const ids = copy.hotels[0].rooms.map((r: { roomPoolId: string }) => r.roomPoolId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(await t.prisma.inventoryPool.count({ where: { editionId: target.id, kind: 'room' } })).toBe(1);
  });

  it('refuses an edition of another race, a missing edition, a repeated slug and bad dates; nothing is left behind', async () => {
    const w = await buildWorld(admin);
    const other = await buildWorld(admin);
    const mine = await nextEdition(w, 2028);
    const pools = () => t.prisma.inventoryPool.count();
    const start = await pools();

    const wrongRace = await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(other.edition.id));
    expect([wrongRace.status, wrongRace.body.code]).toEqual([422, 'duplicate_other_race']);
    expect((await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(crypto.randomUUID()))).status).toBe(404);
    expect((await admin.post(`${base}/packages/${crypto.randomUUID()}/duplicate`, dupBody(mine.id))).status).toBe(404);
    const dates = await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(mine.id, { checkOutDate: '2028-06-15' }));
    expect([dates.status, dates.body.code]).toEqual([422, 'package_dates_invalid']);
    const balance = await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(mine.id, { balanceDueDate: '2028-06-17' }));
    expect([balance.status, balance.body.code]).toEqual([422, 'balance_due_after_check_in']);
    expect((await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(mine.id, { isDemo: true }))).status).toBe(422);
    expect((await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(mine.id, { slug: 'Not A Slug' }))).status).toBe(422);
    expect(await pools()).toBe(start);

    // A repeated slug fails after the pools are created: the whole copy rolls back.
    ok(await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(mine.id, { slug: 'same-slug' })), 'first copy');
    const afterFirst = await pools();
    const dup = await admin.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(mine.id, { slug: 'same-slug' }));
    expect([dup.status, dup.body.code]).toEqual([409, 'package_slug_taken']);
    expect(await pools()).toBe(afterFirst);
  });

  it('needs the package manage permission', async () => {
    const w = await buildWorld(admin);
    const target = await nextEdition(w, 2028);
    const reader = await staffClient(t, [P.packageRead, P.raceRead]);
    expect((await reader.post(`${base}/packages/${w.pkg.id}/duplicate`, dupBody(target.id))).status).toBe(403);
  });
});

describe('preview', () => {
  it('shows a draft the way the public site will, which the public API refuses to show', async () => {
    const w = await buildWorld(admin);
    const p = await admin.get(`${base}/packages/${w.pkg.id}/preview`);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ id: w.pkg.id, preview: true, saleStatus: 'draft', raceStatus: 'draft', guaranteedEntry: false, entries: [{ availability: 'available' }] });
    expect(JSON.stringify(p.body)).not.toMatch(/capacity|consumed|remaining/);
    expect((await anonymous(t).get(`/catalogue/races/${w.race.slug}`)).status).toBe(404);
  });

  it('claims a guaranteed entry only when the claim is on and every entry pool is confirmed', async () => {
    const w = await buildWorld(admin);
    const preview = async () => (await admin.get(`${base}/packages/${w.pkg.id}/preview`)).body.guaranteedEntry as boolean;
    ok(await admin.put(`${base}/races/${w.race.id}/claims/guaranteed_entry`, { enabled: true, evidenceNote: 'Written confirmation on file' }), 'claim');
    expect(await preview()).toBe(false); // claim on, stock not confirmed
    const pool = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.entryPoolId } });
    ok(await admin.patch(`${base}/pools/${w.entryPoolId}`, { confirmedBySupplier: true, version: pool.version }), 'confirm');
    expect(await preview()).toBe(true);
  });

  it('is 404 for a deleted or unknown package', async () => {
    expect((await admin.get(`${base}/packages/${crypto.randomUUID()}/preview`)).status).toBe(404);
  });
});

describe('package list', () => {
  it('lists across editions, filters by sale status and by edition, and searches', async () => {
    const w = await buildWorld(admin);
    const list = await admin.get(`${base}/packages?editionId=${w.edition.id}`);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id: w.pkg.id, saleStatus: 'draft', race: { slug: w.race.slug }, edition: { id: w.edition.id } });
    expect((await admin.get(`${base}/packages?editionId=${w.edition.id}&saleStatus=open`)).body.total).toBe(0);
    expect((await admin.get(`${base}/packages?q=${w.pkg.slug}`)).body.total).toBe(1);
    expect((await admin.get(`${base}/packages?pageSize=500`)).status).toBe(422);
    expect((await admin.get(`${base}/packages?unknown=1`)).status).toBe(422);
  });
});

describe('low-stock warning', () => {
  const find = async (poolId: string) => ((await admin.get(`${base}/low-stock`)).body.items as Array<{ id: string }>).find((i) => i.id === poolId);

  it('appears when a pool reaches its threshold or runs out, and not before or for an unused pool', async () => {
    const w = await buildWorld(admin); // pools have capacity 10 and a threshold of 2
    expect(await find(w.entryPoolId)).toBeUndefined();
    await t.prisma.$executeRaw`UPDATE inventory_pools SET consumed = 7 WHERE id = ${w.entryPoolId}::uuid`;
    expect(await find(w.entryPoolId)).toBeUndefined(); // 3 left, threshold 2
    await t.prisma.$executeRaw`UPDATE inventory_pools SET consumed = 8 WHERE id = ${w.entryPoolId}::uuid`;
    expect(await find(w.entryPoolId)).toMatchObject({ state: 'low', remaining: 2, capacity: 10, lowStock: true, kind: 'entry', race: { slug: w.race.slug }, edition: { id: w.edition.id, year: w.edition.year } });
    await t.prisma.$executeRaw`UPDATE inventory_pools SET consumed = 10 WHERE id = ${w.entryPoolId}::uuid`;
    expect(await find(w.entryPoolId)).toMatchObject({ state: 'none', remaining: 0 });
    // A pool of no capacity is not a warning, and a pool with no threshold only warns when it runs out.
    const empty = (await admin.post(`${base}/editions/${w.edition.id}/pools`, { kind: 'entry', label: 'Unused', capacity: 0 })).body.id as string;
    expect(await find(empty)).toBeUndefined();
    const plain = (await admin.post(`${base}/editions/${w.edition.id}/pools`, { kind: 'entry', label: 'No threshold', capacity: 5 })).body.id as string;
    await t.prisma.$executeRaw`UPDATE inventory_pools SET consumed = 4 WHERE id = ${plain}::uuid`;
    expect(await find(plain)).toBeUndefined();
  });

  it('leaves out completed editions and deleted races, and shows no stock to the public', async () => {
    const w = await buildWorld(admin);
    await t.prisma.$executeRaw`UPDATE inventory_pools SET consumed = 9 WHERE id = ${w.entryPoolId}::uuid`;
    expect(await find(w.entryPoolId)).toBeDefined();
    await t.prisma.$executeRaw`UPDATE race_editions SET status = 'completed' WHERE id = ${w.edition.id}::uuid`;
    expect(await find(w.entryPoolId)).toBeUndefined();
    await t.prisma.$executeRaw`UPDATE race_editions SET status = 'announced' WHERE id = ${w.edition.id}::uuid`;
    await t.prisma.$executeRaw`UPDATE races SET "deletedAt" = now() WHERE id = ${w.race.id}::uuid`;
    expect(await find(w.entryPoolId)).toBeUndefined();
    expect((await anonymous(t).get(`/catalogue/low-stock`)).status).toBe(404);
  });
});

describe('CSV: races', () => {
  const importCsv = (csv: string, dryRun: boolean) => admin.post(`${base}/races/import`, { csv, dryRun });
  const header = 'slug,name,countryCode,city,timeZone,raceType,typicalMonth,summary,websiteUrl';
  const row = (s: string, over: Partial<Record<string, string>> = {}) => {
    const v = { slug: s, name: 'Imported Marathon', countryCode: 'AU', city: 'Cairns', timeZone: 'Australia/Brisbane', raceType: 'road', typicalMonth: '6', summary: 'A scenic course.', websiteUrl: 'https://example.test/race', ...over };
    return [v.slug, v.name, v.countryCode, v.city, v.timeZone, v.raceType, v.typicalMonth, v.summary, v.websiteUrl].join(',');
  };

  it('imports drafts after a check, and the export can be imported again', async () => {
    const a = slug('race-csv');
    const b = slug('race-csv');
    const csv = [header, row(a), row(b, { name: '"Quoted, Marathon"', typicalMonth: '', websiteUrl: '' })].join('\r\n');
    const check = await importCsv(csv, true);
    expect(check.body).toEqual({ valid: true, committed: false, rows: 2, errors: [] });
    expect(await t.prisma.race.count({ where: { slug: { in: [a, b] } } })).toBe(0); // a check writes nothing
    const done = await importCsv(csv, false);
    expect(done.body).toMatchObject({ valid: true, committed: true, rows: 2 });
    const rows = [await t.prisma.race.findUniqueOrThrow({ where: { slug: a } }), await t.prisma.race.findUniqueOrThrow({ where: { slug: b } })];
    expect(rows.map((r) => [r.status, r.isDemo, r.typicalMonth, r.websiteUrl])).toEqual([['draft', false, 6, 'https://example.test/race'], ['draft', false, null, null]]);
    expect((rows[1]!.name as Record<string, string>)['en-AU']).toBe('Quoted, Marathon');
    const log = await t.prisma.auditLog.findFirst({ where: { action: 'catalogue.race.created', entityId: rows[0]!.id } });
    expect(log).not.toBeNull();

    const exported = await admin.post(`${base}/races/export`, {});
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toMatch(/text\/csv/);
    expect(exported.headers['content-disposition']).toMatch(/attachment; filename="catalogue-races-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = exported.text;
    expect(text.split('\r\n')[0]).toContain('slug,name,countryCode');
    expect(text).toContain(a);
    // Re-importing the export fails only because every slug is taken, and says so without echoing any value.
    const again = await importCsv(text, true);
    expect(again.body.valid).toBe(false);
    expect(new Set((again.body.errors as Array<{ code: string }>).map((e) => e.code))).toEqual(new Set(['slug_taken']));
  });

  it('writes nothing when one row is bad, and the errors carry no values', async () => {
    const good = slug('race-csv');
    const secret = 'ZZ-SECRET-VALUE';
    const csv = [header, row(good), row(slug('race-csv'), { countryCode: secret }), row(slug('race-csv'), { raceType: secret }), row(slug('race-csv'), { typicalMonth: '13' }), row(slug('race-csv'), { websiteUrl: 'javascript:alert(1)' })].join('\n');
    const res = await importCsv(csv, false);
    expect(res.body.valid).toBe(false);
    expect(res.body.committed).toBe(false);
    expect(res.body.errors).toEqual([
      { row: 2, column: 'countryCode', code: 'invalid_value' },
      { row: 3, column: 'raceType', code: 'invalid_value' },
      { row: 4, column: 'typicalMonth', code: 'invalid_value' },
      { row: 5, column: 'websiteUrl', code: 'invalid_value' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(await t.prisma.race.count({ where: { slug: good } })).toBe(0);
  });

  it('rejects unknown, duplicate and missing columns, repeated slugs, an empty file and a broken file', async () => {
    const s = slug('race-csv');
    const codes = async (csv: string) => ((await importCsv(csv, true)).body.errors as Array<{ column: string; code: string }>).map((e) => `${e.column}:${e.code}`);
    expect(await codes(`${header},isDemo\n${row(s)},true`)).toEqual(['isDemo:unknown_column']);
    expect(await codes(`${header},status\n${row(s)},published`)).toEqual([]); // status is ignored on import, never written
    expect(await codes(`${header},city\n${row(s)},X`)).toEqual(['city:duplicate_column']);
    expect(await codes(header.replace('summary,', '') + `\n`)).toContain('summary:missing_column');
    expect(await codes([header, row(s), row(s)].join('\n'))).toEqual(['slug:duplicate_in_file']);
    expect(await codes(header)).toEqual([':no_rows']);
    expect(await codes('')).toEqual([':empty_file']);
    expect(await codes(`${header}\n"unterminated`)).toEqual([':bad_csv']);
    expect(await codes(`${header}\n${row(s)},extra`)).toEqual([':wrong_cell_count']);
    expect(await codes([header, ...Array.from({ length: 501 }, (_, i) => row(`${s}-${i}`))].join('\n'))).toEqual([':too_many_rows']);
    const status = slug('race-csv');
    await importCsv(`${header},status\n${row(status)},published`, false);
    expect((await t.prisma.race.findUniqueOrThrow({ where: { slug: status } })).status).toBe('draft');
  });

  it('protects formulas on export and restores them on import', async () => {
    const s = slug('race-csv');
    await importCsv([header, row(s, { name: "'=HYPERLINK(1)" })].join('\n'), false);
    expect(((await t.prisma.race.findUniqueOrThrow({ where: { slug: s } })).name as Record<string, string>)['en-AU']).toBe('=HYPERLINK(1)');
    const exported = (await admin.post(`${base}/races/export`, {})).text;
    expect(exported).toContain("'=HYPERLINK(1)");
  });

  it('needs the right permission: export reads, import manages', async () => {
    const reader = await staffClient(t, [P.raceRead]);
    expect((await reader.post(`${base}/races/export`, {})).status).toBe(200);
    expect((await reader.post(`${base}/races/import`, { csv: header, dryRun: true })).status).toBe(403);
    const nobody = await staffClient(t, []);
    expect((await nobody.post(`${base}/races/export`, {})).status).toBe(403);
  });
});

describe('CSV: packages of an edition', () => {
  const header = 'slug,name,checkInDate,checkOutDate,balanceDueDate,minTravellers,maxTravellers,maxExtraNightsBefore,maxExtraNightsAfter,instantBooking,autoConfirmOnDeposit';
  const row = (s: string, over: Partial<Record<string, string>> = {}) => {
    const v = { slug: s, name: 'Weekend', checkInDate: '2028-06-16', checkOutDate: '2028-06-19', balanceDueDate: '2028-04-16', minTravellers: '1', maxTravellers: '4', before: '1', after: '2', instant: 'false', auto: 'true', ...over };
    return [v.slug, v.name, v.checkInDate, v.checkOutDate, v.balanceDueDate, v.minTravellers, v.maxTravellers, v.before, v.after, v.instant, v.auto].join(',');
  };

  it('imports draft packages with no deposit, exports them with the deposit as information, and checks first', async () => {
    const w = await buildWorld(admin);
    const url = `${base}/editions/${w.edition.id}/packages`;
    const a = slug('pkg-csv');
    const csv = [header, row(a), row(slug('pkg-csv'), { instant: 'true', after: '' })].join('\r\n');
    expect((await admin.post(`${url}/import`, { csv, dryRun: true })).body).toEqual({ valid: true, committed: false, rows: 2, errors: [] });
    expect((await admin.get(`${base}/packages?editionId=${w.edition.id}`)).body.total).toBe(1);
    expect((await admin.post(`${url}/import`, { csv, dryRun: false })).body).toMatchObject({ committed: true, rows: 2 });
    const list = (await admin.get(`${base}/packages?editionId=${w.edition.id}`)).body;
    expect(list.total).toBe(3);
    const created = await t.prisma.package.findFirstOrThrow({ where: { editionId: w.edition.id, slug: a } });
    expect([created.saleStatus, created.depositMode, created.maxExtraNightsAfter, created.maxExtraNightsBefore]).toEqual(['draft', null, 2, 1]);

    const exported = await admin.post(`${url}/export`, {});
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('saleStatus,depositMode,depositAmountMinor,depositBps');
    expect(exported.text).toContain('per_person,50000'); // the existing package's deposit, as information
    // The exported file can be imported again except for the slugs it already holds.
    const again = await admin.post(`${url}/import`, { csv: exported.text, dryRun: true });
    expect(new Set((again.body.errors as Array<{ code: string }>).map((e) => e.code))).toEqual(new Set(['slug_taken']));
  });

  it('refuses bad dates, travellers, numbers and booleans, a deposit column, and a missing edition; writes nothing', async () => {
    const w = await buildWorld(admin);
    const url = `${base}/editions/${w.edition.id}/packages/import`;
    const good = slug('pkg-csv');
    const csv = [
      header, row(good), row(slug('pkg-csv'), { checkOutDate: '2028-06-15' }), row(slug('pkg-csv'), { balanceDueDate: '2028-06-17' }), row(slug('pkg-csv'), { minTravellers: '5' }),
      row(slug('pkg-csv'), { maxTravellers: 'four' }), row(slug('pkg-csv'), { instant: 'yes' }), row(slug('pkg-csv'), { checkInDate: '2028-02-30' }),
    ].join('\n');
    const res = await admin.post(url, { csv, dryRun: false });
    expect(res.body.committed).toBe(false);
    expect(res.body.errors).toEqual([
      { row: 2, column: 'checkOutDate', code: 'package_dates_invalid' },
      { row: 3, column: 'balanceDueDate', code: 'balance_due_after_check_in' },
      { row: 4, column: 'maxTravellers', code: 'travellers_range_invalid' },
      { row: 5, column: 'maxTravellers', code: 'invalid_value' },
      { row: 6, column: 'instantBooking', code: 'invalid_value' },
      { row: 7, column: 'checkInDate', code: 'invalid_value' },
    ]);
    expect(await t.prisma.package.count({ where: { slug: good } })).toBe(0);
    const deposit = await admin.post(url, { csv: `${header},depositAmountMinor\n${row(good)},100`, dryRun: true });
    expect(deposit.body.valid).toBe(true); // ignored, never written
    await admin.post(url, { csv: `${header},depositAmountMinor\n${row(good)},100`, dryRun: false });
    expect((await t.prisma.package.findFirstOrThrow({ where: { slug: good } })).depositMode).toBeNull();
    expect((await admin.post(`${base}/editions/${crypto.randomUUID()}/packages/import`, { csv: header, dryRun: true })).status).toBe(404);
    expect((await admin.post(`${base}/editions/${crypto.randomUUID()}/packages/export`, {})).status).toBe(404);
  });

  it('needs the package permissions', async () => {
    const w = await buildWorld(admin);
    const reader = await staffClient(t, [P.packageRead]);
    expect((await reader.post(`${base}/editions/${w.edition.id}/packages/export`, {})).status).toBe(200);
    expect((await reader.post(`${base}/editions/${w.edition.id}/packages/import`, { csv: header, dryRun: true })).status).toBe(403);
  });
});
