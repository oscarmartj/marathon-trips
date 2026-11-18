// Organiser exports (task 7.2, plan docs/plans/7.2-organiser-exports.md, section 3): access, leakage between races,
// validation before export, erased travellers, the response and the audit entry.
import { readdirSync, existsSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingStatus } from '@mt/shared';
import { ExportCheckRateLimitGuard, ExportFileRateLimitGuard } from '../../../src/modules/organiser-exports/rate-limit.guard';
import { ORGANISER_EXPORT_PERMISSIONS as X, organiserExportsManifest } from '../../../src/modules/organiser-exports';
import { TRAVELLER_ENTITIES } from '../../../src/modules/customer-portal';
import { PermissionRegistry } from '../../../src/platform/access/permissions';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { makeBookingFor, makeCustomer } from '../../support/bookings';
import { closeCatalogue, staffClient, anonymous } from '../../support/catalogue';
import { walkTo } from '../../support/customer-portal';
import { cleanPayments, paymentsStaff } from '../../support/payments';
import { pricedWorld, type PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let catalogueAdmin: Awaited<ReturnType<typeof paymentsStaff>>;
let owner: Awaited<ReturnType<typeof staffClient>>;
let readOnly: Awaited<ReturnType<typeof staffClient>>;
let w: PricedWorld; // race A
let other: PricedWorld; // race B

beforeAll(async () => {
  t = await makeApp();
  catalogueAdmin = await paymentsStaff(t);
  owner = await staffClient(t, [X.read, X.generate]);
  readOnly = await staffClient(t, [X.read]);
  w = await pricedWorld(catalogueAdmin);
  other = await pricedWorld(catalogueAdmin);
});
beforeEach(() => {
  t.app.get(ExportFileRateLimitGuard).reset();
  t.app.get(ExportCheckRateLimitGuard).reset();
});
afterAll(async () => {
  await cleanPayments(t);
  await closeCatalogue(t);
});

const WORDS = ['Alba', 'Brisa', 'Cato', 'Dara', 'Elio', 'Fiora', 'Gael', 'Hana', 'Ilan', 'Jora', 'Kiva', 'Lero', 'Mira', 'Nilo', 'Orla', 'Pia', 'Quin', 'Rafa', 'Sela', 'Tavi', 'Uma', 'Vero', 'Wren', 'Xavi', 'Yara', 'Zeno'];
let n = 0;
const word = () => `${WORDS[n++ % WORDS.length]}${String.fromCharCode(97 + Math.floor(n / WORDS.length))}`;

const full = (over: Record<string, unknown> = {}) => ({
  givenName: word(), familyName: word(), dateOfBirth: new Date('1988-03-14T00:00:00Z'), emergencyContactName: 'Sean Oneil', emergencyContactPhone: '+61 400 123 456', estimatedFinishSeconds: 14_400, ...over,
});

interface Seeded { reference: string; bookingId: string; customerId: string; given: string; family: string; supporterGiven: string }

/** A booking in `status` with a runner at slot 1 (details unless null) and a supporter at slot 2 that always has details. */
async function seed(world: PricedWorld, o: { status?: BookingStatus; details?: Record<string, unknown> | null; distanceId?: string | null; type?: 'runner_with_entry' | 'runner_own_entry'; country?: string } = {}): Promise<Seeded> {
  const customerId = await makeCustomer(t);
  const { bookingId } = await makeBookingFor(t, world, customerId);
  if (o.country) await t.prisma.$executeRawUnsafe(`UPDATE bookings SET "residenceCountry" = '${o.country}' WHERE id = '${bookingId}'::uuid`);
  await walkTo(t, bookingId, o.status ?? 'deposit_paid');
  await t.prisma.bookingTraveller.create({ data: { bookingId, customerId, slot: 1, participationType: o.type ?? 'runner_with_entry', raceDistanceId: o.type === 'runner_own_entry' || o.distanceId === null ? null : (o.distanceId ?? world.distanceId), isLead: true } });
  await t.prisma.bookingTraveller.create({ data: { bookingId, customerId, slot: 2, participationType: 'supporter' } });
  const d = o.details === null ? null : full(o.details);
  if (d) await t.prisma.traveller.create({ data: { bookingId, customerId, slot: 1, ...d } as never });
  const sup = { givenName: word(), familyName: word() };
  await t.prisma.traveller.create({ data: { bookingId, customerId, slot: 2, ...sup } });
  const reference = (await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { reference: true } })).reference;
  return { reference, bookingId, customerId, given: String(d?.givenName ?? ''), family: String(d?.familyName ?? ''), supporterGiven: sup.givenName };
}

/**
 * The runner's place is removed by a change (task 6.3): a booking always keeps exactly one current lead (deferred check),
 * so the change that retires place 1 adds the lead's new place (a supporter, never exported) in the same transaction.
 */
const retireLead = (b: Seeded) => t.prisma.$transaction([
  t.prisma.$executeRawUnsafe(`UPDATE booking_travellers SET "removedInVersion" = 2 WHERE "bookingId" = '${b.bookingId}'::uuid AND slot = 1`),
  t.prisma.bookingTraveller.create({ data: { bookingId: b.bookingId, customerId: b.customerId, slot: 3, participationType: 'supporter', isLead: true, addedInVersion: 2 } }),
]);

const body = (world: PricedWorld, over: Record<string, unknown> = {}) => ({ editionId: world.edition.id, formatId: 'entry_list_basic', ...over });
const file = (who: { post: (p: string, b?: object) => ReturnType<typeof owner.post> }, b: object) => who.post('/admin/organiser-exports', b);
const check = (b: object) => owner.post('/admin/organiser-exports/check', b);
const rows = (csv: string) => csv.split('\r\n').filter(Boolean);
const audits = (editionId: string) => t.prisma.auditLog.findMany({ where: { action: 'exports.runnerData.generated', entityId: editionId }, include: { piiValues: true } });
const stale = (userId: string) => t.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) } });

describe('access', () => {
  const routes: Array<[string, string, object | undefined]> = [
    ['GET', '/admin/organiser-exports/formats?editionId=00000000-0000-4000-8000-000000000000', undefined],
    ['POST', '/admin/organiser-exports/check', {}],
    ['POST', '/admin/organiser-exports', {}],
  ];
  const call = (who: { get: (p: string) => ReturnType<typeof owner.get>; post: (p: string, b?: object) => ReturnType<typeof owner.post> }, [m, p, b]: (typeof routes)[number]) => (m === 'GET' ? who.get(p) : who.post(p, b));

  it.each(routes)('%s %s: anonymous is refused (401)', async (m, p, b) => {
    const res = m === 'GET' ? await anonymous(t).get(p) : await t.http().post(p).set(STATE_HEADERS).send(b);
    expect(res.status).toBe(401);
  });

  it('staff without the permissions, even with every booking and catalogue permission, get 403 on every route', async () => {
    const nobody = await staffClient(t, []);
    const broad = await paymentsStaff(t);
    for (const who of [nobody, broad]) for (const r of routes) expect([r[0], r[1], (await call(who, r)).status]).toEqual([r[0], r[1], 403]);
  });

  it('a customer session is refused on every route', async () => {
    const { signInCustomer } = await import('../../support/auth');
    const c = await signInCustomer(t);
    for (const [m, p, b] of routes) {
      const res = m === 'GET' ? await t.http().get(p).set('Cookie', c.cookie) : await t.http().post(p).set(STATE_HEADERS).set('Cookie', c.cookie).send(b);
      expect([m, p, [401, 403].includes(res.status)]).toEqual([m, p, true]);
    }
  });

  it('read lets staff list formats and check, but the file needs the generate permission', async () => {
    expect((await readOnly.get(`/admin/organiser-exports/formats?editionId=${w.edition.id}`)).status).toBe(200);
    expect((await readOnly.post('/admin/organiser-exports/check', body(w))).status).toBe(200);
    expect((await file(readOnly, body(w))).status).toBe(403);
  });

  it('the file needs a recent authenticator check, and a refused attempt writes nothing', async () => {
    const s = await staffClient(t, [X.read, X.generate]);
    await seed(w);
    await stale(s.staff.id);
    const before = (await audits(w.edition.id)).length;
    const res = await file(s, body(w));
    expect([res.status, res.body.code]).toEqual([403, 'step_up_required']);
    expect((await audits(w.edition.id)).length).toBe(before);
    expect((await s.post('/admin/organiser-exports/check', body(w))).status).toBe(200); // the check needs none
  });

  it('an API key cannot reach the routes, and cannot be given either permission', async () => {
    const { INTEGRATIONS_PERMISSIONS: IP } = await import('../../../src/platform/integrations/permissions');
    const { CATALOGUE_PERMISSIONS: C } = await import('../../../src/modules/catalogue/manifest');
    const manager = await staffClient(t, [C.raceRead, IP.apiKeyRead, IP.apiKeyManage]);
    for (const scope of Object.values(X)) expect((await manager.post('/admin/integrations/api-keys', { name: 'Zapier', scopes: [scope] })).status).toBe(422);
    const made = await manager.post('/admin/integrations/api-keys', { name: 'Zapier', scopes: [C.raceRead] });
    expect(made.status).toBe(201);
    const auth = { Authorization: `Bearer ${made.body.token as string}` };
    expect((await t.http().get(`/admin/organiser-exports/formats?editionId=${w.edition.id}`).set(auth)).status).toBe(403);
    expect((await t.http().post('/admin/organiser-exports/check').set(STATE_HEADERS).set(auth).send(body(w))).status).toBe(403);
    expect((await t.http().post('/admin/organiser-exports').set(STATE_HEADERS).set(auth).send(body(w))).status).toBe(403);
  });

  it('neither permission is API-key scopable, none is in a seeded non-owner role, and both are registered', async () => {
    const reg = t.app.get(PermissionRegistry);
    expect(organiserExportsManifest.permissions.map((p) => [p.key, p.apiKeyScopable, p.requiresStepUp])).toEqual([[X.read, false, false], [X.generate, false, true]]);
    for (const k of Object.values(X)) expect(reg.get(k)).toBeTruthy();
    const holders = await t.prisma.rolePermission.findMany({ where: { permissionKey: { in: Object.values(X) } }, select: { role: { select: { key: true, isSystem: true } } } });
    expect(holders.filter((h) => h.role.isSystem && h.role.key !== 'owner')).toEqual([]);
    const owned = await t.prisma.permission.findMany({ where: { key: { in: Object.values(X) } } });
    expect(owned).toHaveLength(2);
  });
});

describe('request checks', () => {
  it('unknown edition, edition of a deleted race, unknown format, a format that is not for this race: 404 with no detail', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await check(body(w, { editionId: missing }))).status).toBe(404);
    expect((await check(body(w, { formatId: 'no_such_format' }))).body.code).toBe('format_not_found');
    expect((await owner.get(`/admin/organiser-exports/formats?editionId=${missing}`)).status).toBe(404);
    const gone = await pricedWorld(catalogueAdmin);
    await t.prisma.race.update({ where: { id: gone.race.id }, data: { deletedAt: new Date() } });
    expect((await check(body(gone))).status).toBe(404);
    expect((await file(owner, body(gone))).status).toBe(404);
  });

  it('a distance of another race is a 404 and reveals nothing', async () => {
    const res = await check(body(w, { raceDistanceId: other.distanceId }));
    expect([res.status, res.body.code]).toEqual([404, 'distance_not_found']);
    expect((await file(owner, body(w, { raceDistanceId: other.distanceId }))).status).toBe(404);
  });

  it.each([
    ['an extra key', { passport: 'x' }], ['a bad uuid', { editionId: 'nope' }], ['a bad format id', { formatId: 'A B' }], ['a bad distance id', { raceDistanceId: 'x' }], ['no format', { formatId: undefined }],
  ])('%s is a 422', async (_n, over) => {
    expect((await check({ ...body(w), ...over })).status).toBe(422);
    expect((await file(owner, { ...body(w), ...over })).status).toBe(422);
  });
});

describe('who is exported, and nothing from another race', () => {
  it('only runners of this edition in a paid status: supporters, other statuses, removed places and own-entry runners never appear', async () => {
    const e = (await pricedWorld(catalogueAdmin));
    const ok = await seed(e);
    const confirmed = await seed(e, { status: 'confirmed' });
    const paid = await seed(e, { status: 'balance_paid' });
    const notPaid = await seed(e, { status: 'approved' });
    const cancelled = await seed(e, { status: 'cancelled' });
    const completed = await seed(e, { status: 'completed' });
    const ownEntry = await seed(e, { type: 'runner_own_entry' });
    const removed = await seed(e);
    await retireLead(removed);
    const elsewhere = await seed(other);
    const res = await file(owner, body(e));
    expect(res.status).toBe(200);
    const text = res.text;
    expect(rows(text)).toHaveLength(1 + 3);
    for (const p of [ok, confirmed, paid]) expect(text).toContain(p.given);
    for (const p of [notPaid, cancelled, completed, ownEntry, removed, elsewhere]) expect(text).not.toContain(p.given);
    for (const p of [ok, confirmed, paid, notPaid, ownEntry, elsewhere]) expect(text).not.toContain(p.supporterGiven);
    expect(res.headers['x-row-count']).toBe('3');
  });

  it('the file of one edition holds none of another race, and the distance filter keeps to its distance', async () => {
    const e = await pricedWorld(catalogueAdmin);
    const half = await t.prisma.raceDistance.create({ data: { raceId: e.race.id, kind: 'half', distanceMetres: 21_097, name: { 'en-AU': 'Half marathon' } } });
    const a = await seed(e);
    const b = await seed(e, { distanceId: half.id });
    const c = await seed(other);
    const all = (await file(owner, body(e))).text;
    expect([all.includes(a.given), all.includes(b.given), all.includes(c.given)]).toEqual([true, true, false]);
    const onlyHalf = (await file(owner, body(e, { raceDistanceId: half.id }))).text;
    expect([onlyHalf.includes(a.given), onlyHalf.includes(b.given), onlyHalf.includes('Half marathon')]).toEqual([false, true, true]);
    expect((await check(body(e, { raceDistanceId: half.id }))).body).toMatchObject({ runners: 1, ready: 1 });
  });

  it('a format that opts into own-entry runners gets them, and still never a supporter', async () => {
    const { FORMATS } = await import('../../../src/modules/organiser-exports');
    const e = await pricedWorld(catalogueAdmin);
    const own = await seed(e, { type: 'runner_own_entry' });
    const sup = await seed(e);
    const { loadRunners } = await import('../../../src/modules/organiser-exports/reader');
    const { defineFormat } = await import('../../../src/modules/organiser-exports');
    const f = defineFormat({ ...FORMATS[0]!, id: 'with_own_entry', participation: ['runner_with_entry', 'runner_own_entry'] });
    const got = await t.prisma.$transaction((tx) => loadRunners(tx, f, e.edition));
    expect(got.rows.map((r) => r.reference).sort()).toEqual([own.reference, sup.reference].sort());
    expect(JSON.stringify(got.rows)).not.toContain(sup.supporterGiven);
  });
});

describe('minimal reads', () => {
  it('the database read of a format that does not ask for date of birth, finish time or emergency contact does not select them', async () => {
    const { FORMATS } = await import('../../../src/modules/organiser-exports');
    const { loadRunners } = await import('../../../src/modules/organiser-exports/reader');
    const e = await pricedWorld(catalogueAdmin);
    const keep = await seed(e);
    const own = await seed(e, { type: 'runner_own_entry' });
    const removed = await seed(e);
    await retireLead(removed);
    const travellerCalls: Array<{ select: Record<string, unknown>; where: { OR: Array<{ bookingId: string; slot: number }> } }> = [];
    const placeCalls: Array<{ select: { booking: { select: Record<string, unknown> } } & Record<string, unknown> }> = [];
    const wrap = (model: object, into: unknown[]) => new Proxy(model, { get: (m, fn) => (fn === 'findMany' ? (args: unknown) => { into.push(args); return (m as { findMany: (a: unknown) => unknown }).findMany(args); } : Reflect.get(m, fn)) });
    await t.prisma.$transaction(async (tx) => {
      const spy = new Proxy(tx, { get: (target, prop) => (prop === 'traveller' ? wrap(target.traveller, travellerCalls) : prop === 'bookingTraveller' ? wrap(target.bookingTraveller, placeCalls) : Reflect.get(target, prop)) });
      await loadRunners(spy as never, { ...FORMATS[0]!, columns: [FORMATS[0]!.columns[0]!] }, e.edition);
    });
    expect(Object.keys(travellerCalls[0]!.select).sort()).toEqual(['anonymisedAt', 'bookingId', 'familyName', 'givenName', 'slot']);
    // only the exported place is asked for: not the supporter, the removed place or the own-entry runner
    expect(travellerCalls[0]!.where).toEqual({ OR: [{ bookingId: keep.bookingId, slot: 1 }] });
    expect(JSON.stringify(travellerCalls[0]!.where)).not.toContain(own.bookingId);
    expect(JSON.stringify(travellerCalls[0]!.where)).not.toContain(removed.bookingId);
    // the booking's country and the distance are not selected unless the format asks for them
    expect(Object.keys(placeCalls[0]!.select.booking.select).sort()).toEqual(['customer', 'reference']);
    expect(placeCalls[0]!.select).not.toHaveProperty('raceDistance');
  });
});

describe('validation before export', () => {
  it('lists each runner with a problem by reference, place and column, with no personal value, and blocks the file', async () => {
    const e = await pricedWorld(catalogueAdmin);
    const good = await seed(e);
    const noRow = await seed(e, { details: null });
    const noDob = await seed(e, { details: { dateOfBirth: null } });
    const c = await check(body(e));
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ runners: 3, ready: 1, erased: 0 });
    const by = Object.fromEntries((c.body.issues as Array<{ reference: string; slot: number; problems: Array<{ column: string; code: string }> }>).map((i) => [i.reference, i]));
    expect(Object.keys(by)).toHaveLength(2);
    expect(by[good.reference]).toBeUndefined();
    expect(by[noRow.reference]!.problems.map((p) => p.column)).toEqual(['Given name', 'Family name', 'Date of birth']);
    expect(by[noDob.reference]).toEqual({ reference: noDob.reference, slot: 1, problems: [{ column: 'Date of birth', code: 'missing' }] });
    expect(JSON.stringify(c.body)).not.toContain(good.given);
    const before = (await audits(e.edition.id)).length;
    const res = await file(owner, body(e));
    expect([res.status, res.body.code, res.body.issues]).toEqual([422, 'export_has_issues', c.body.issues]);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(JSON.stringify(res.body)).not.toContain(good.given);
    expect((await audits(e.edition.id)).length).toBe(before);
  });

  it('an optional empty column does not block; an edition with no runner is 422 no_runners', async () => {
    const e = await pricedWorld(catalogueAdmin);
    expect((await file(owner, body(e, { formatId: 'entry_list_international' }))).body.code).toBe('no_runners');
    await seed(e, { details: { emergencyContactName: null, emergencyContactPhone: null, estimatedFinishSeconds: null } });
    const res = await file(owner, body(e, { formatId: 'entry_list_international' }));
    expect(res.status).toBe(200);
    expect(rows(res.text.replace(/^\uFEFF/, ''))[1]).toMatch(/;Australia;42\.195;;;$/);
  });
});

describe('erased and anonymised travellers', () => {
  it('a traveller erased by the real erasure handler is not exported, is counted, and [redacted] never appears', async () => {
    const e = await pricedWorld(catalogueAdmin);
    const keep = await seed(e);
    const gone = await seed(e);
    await t.prisma.$transaction(async (tx) => { await TRAVELLER_ENTITIES[0]!.handlers!.anonymise(tx, gone.customerId); });
    const c = await check(body(e));
    expect(c.body).toMatchObject({ runners: 1, ready: 1, erased: 1, issues: [] });
    for (const formatId of ['entry_list_basic', 'entry_list_international']) {
      const res = await file(owner, body(e, { formatId }));
      expect(res.status).toBe(200);
      expect(res.text).toContain(keep.given);
      expect(res.text).not.toContain('redacted');
      expect(res.text).not.toContain(gone.given);
    }
    expect(JSON.stringify((await check(body(e))).body)).not.toContain('redacted');
  });

  it('a closed customer, or a country wiped to ZZ, is not exported or not written', async () => {
    const e = await pricedWorld(catalogueAdmin);
    const closed = await seed(e);
    await t.prisma.customer.update({ where: { id: closed.customerId }, data: { anonymisedAt: new Date() } });
    const zz = await seed(e, { country: 'ZZ' });
    expect((await check(body(e))).body).toMatchObject({ runners: 1, erased: 1 });
    // the Country column is required in the international format, so the wiped country is a problem, not a blank cell
    const c = await check(body(e, { formatId: 'entry_list_international' }));
    expect(c.body.issues).toEqual([{ reference: zz.reference, slot: 1, problems: [{ column: 'Country', code: 'missing' }] }]);
    expect((await file(owner, body(e))).text).not.toContain(closed.given);
  });

  it('a soft-deleted customer with a paid booking is not exported, is counted, and the file says how many were left out', async () => {
    const e = await pricedWorld(catalogueAdmin);
    const keep = await seed(e);
    const deleted = await seed(e, { status: 'deposit_paid' });
    await t.prisma.customer.update({ where: { id: deleted.customerId }, data: { deletedAt: new Date() } });
    expect((await check(body(e))).body).toMatchObject({ runners: 1, ready: 1, erased: 1 });
    const res = await file(owner, body(e));
    expect(res.status).toBe(200);
    expect(res.text).toContain(keep.given);
    expect(res.text).not.toContain(deleted.given);
    expect(res.headers['x-row-count']).toBe('1');
    expect(res.headers['x-excluded-count']).toBe('1');
    const none = await pricedWorld(catalogueAdmin);
    await seed(none);
    expect((await file(owner, body(none))).headers['x-excluded-count']).toBe('0');
  });

  it('a runner erased between the check and the file is not in the file (the file reads again)', async () => {
    const e = await pricedWorld(catalogueAdmin);
    await seed(e);
    const late = await seed(e);
    expect((await check(body(e))).body.runners).toBe(2);
    await t.prisma.$transaction(async (tx) => { await TRAVELLER_ENTITIES[0]!.handlers!.anonymise(tx, late.customerId); });
    const res = await file(owner, body(e));
    expect(res.headers['x-row-count']).toBe('1');
    expect(res.text).not.toContain(late.given);
  });
});

describe('the response and the audit entry', () => {
  it('no-store headers, a safe attachment name, text/csv, no BOM for the basic format and a BOM for the international one', async () => {
    const e = await pricedWorld(catalogueAdmin);
    const r = await seed(e);
    const res = await file(owner, body(e));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-\d{4}-entry-list-basic-\d{8}\.csv"$/);
    expect(res.headers['content-disposition']).not.toContain(r.given);
    expect(res.text.charCodeAt(0)).not.toBe(0xfeff);
    expect(rows(res.text)[0]).toBe('Given name,Family name,Date of birth,Distance');
    const dist = await t.prisma.raceDistance.findUniqueOrThrow({ where: { id: e.distanceId }, select: { name: true } });
    const distanceName = (dist.name as Record<string, string>)['en-AU']!;
    expect(distanceName.length).toBeGreaterThan(0);
    expect(rows(res.text)[1]).toBe(`${r.given},${r.family},1988-03-14,${distanceName}`);
    const intl = await file(owner, body(e, { formatId: 'entry_list_international' }));
    expect(intl.text.charCodeAt(0)).toBe(0xfeff);
    expect((await owner.get(`/admin/organiser-exports/formats?editionId=${e.edition.id}`)).headers['cache-control']).toBe('no-store');
    expect((await check(body(e))).headers['cache-control']).toBe('no-store');
  });

  it('formula guard through the whole stack: a phone that starts with + (allowed by the table) is quoted in the file', async () => {
    const e = await pricedWorld(catalogueAdmin);
    await seed(e, { details: { emergencyContactPhone: '+61 400 123 456' } });
    await seed(e, { details: { emergencyContactPhone: '(07) 3000 0000' } });
    const res = await file(owner, body(e, { formatId: 'entry_list_international' }));
    expect(res.status).toBe(200);
    expect(res.text).toContain(";'+61 400 123 456");
    expect(res.text).toContain(';(07) 3000 0000');
  });

  it('one audit row per file with only formatId, distance and row count, no personal value rows, nothing stored on disk', async () => {
    const e = await pricedWorld(catalogueAdmin);
    const r = await seed(e);
    await seed(e);
    const dir = process.env.FILE_STORAGE_DIR!;
    const filesBefore = existsSync(dir) ? readdirSync(dir, { recursive: true }).length : 0;
    expect((await file(owner, body(e))).status).toBe(200);
    expect((await file(owner, body(e, { formatId: 'entry_list_international' }))).status).toBe(200);
    const a = await audits(e.edition.id);
    expect(a).toHaveLength(2);
    expect(a.map((x) => x.entityType)).toEqual(['RaceEdition', 'RaceEdition']);
    expect(a.every((x) => x.actorType === 'staff' && x.actorId === owner.staff.id)).toBe(true);
    expect(a.map((x) => x.changes)).toEqual([
      { formatId: { before: null, after: 'entry_list_basic' }, raceDistanceId: { before: null, after: null }, rowCount: { before: null, after: 2 } },
      { formatId: { before: null, after: 'entry_list_international' }, raceDistanceId: { before: null, after: null }, rowCount: { before: null, after: 2 } },
    ]);
    expect(a.flatMap((x) => x.piiValues)).toEqual([]);
    expect(JSON.stringify(a)).not.toContain(r.given);
    expect(existsSync(dir) ? readdirSync(dir, { recursive: true }).length : 0).toBe(filesBefore);
  });

  it('the 11th file in an hour is 429 with Retry-After', async () => {
    const e = await pricedWorld(catalogueAdmin);
    await seed(e);
    const s = await staffClient(t, [X.read, X.generate]);
    for (let i = 0; i < 10; i++) expect((await file(s, body(e))).status).toBe(200);
    const res = await file(s, body(e));
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('the formats route lists the formats of an edition with their headers and encoding, nothing personal', async () => {
    const res = await owner.get(`/admin/organiser-exports/formats?editionId=${w.edition.id}`);
    expect(res.body.formats.map((f: { id: string }) => f.id)).toEqual(['entry_list_basic', 'entry_list_international']);
    expect(res.body.formats[1]).toMatchObject({ encoding: { charset: 'utf-8', bom: true, delimiter: ';' } });
    expect(res.body.formats[0].columns[0]).toEqual({ header: 'Given name', required: true });
    expect(Object.keys(res.body.edition).sort()).toEqual(['id', 'raceName', 'year']);
  });
});
