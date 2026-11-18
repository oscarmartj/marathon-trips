import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REPORT_ENTITY_CATALOGUE } from '@mt/shared';
import { REPORTS_PERMISSIONS as P, reportsManifest } from '../../../src/modules/reports';
import { ReportScheduler } from '../../../src/modules/reports/scheduler';
import { ReportsService } from '../../../src/modules/reports/reports.service';
import { VISIT_DEDUPE_MS, VISITS_PER_MINUTE, VisitDeduper } from '../../../src/modules/reports/rate-limit.guard';
import { FeatureFlagService } from '../../../src/platform/flags/flags.service';
import { MailService } from '../../../src/platform/mail/mail.service';
import { STATE_HEADERS, TestApp, makeApp, signInCustomer } from '../../support/auth';
import { Client, CATALOGUE_AND_PRICING, World, announceEdition, buildWorld, closeCatalogue, staffClient } from '../../support/catalogue';
import { insertValidSchedule } from '../../support/payments';
import { makeBookingFor } from '../../support/bookings';
import { must } from '../../support/suppliers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
type Staff = Awaited<ReturnType<typeof staffClient>>;
let admin: Staff;
const BOOKING_READ = 'bookings.booking.read';
const ALL_REPORTS = Object.values(P);
const setFlag = async (enabled: boolean) => {
  await t.app.get(FeatureFlagService).ensure('module.reports', enabled);
  await t.prisma.featureFlag.update({ where: { key: 'module.reports' }, data: { enabled } });
};

beforeAll(async () => {
  t = await makeApp();
  await setFlag(true);
  admin = await staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_REPORTS, BOOKING_READ]);
});
afterAll(async () => {
  await t.prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = 'mail.send'`);
  await setFlag(true);
  await closeCatalogue(t);
});

const beacon = (body: object) => t.http().post('/analytics/race-events').set(STATE_HEADERS).send(body);
async function publishedWorld(): Promise<World> {
  const w = await buildWorld(admin);
  must(await admin.post(`/admin/catalogue/races/${w.race.id}/status`, { status: 'published', version: w.race.version }), 'publish');
  expect((await announceEdition(admin, w.edition.id)).status).toBe(200);
  return w;
}
const service = () => t.app.get(ReportsService);
const stats = (raceId: string) => t.prisma.raceDailyStat.findMany({ where: { raceId } });
const sum = async (raceId: string, f: 'views' | 'builderUses') => (await stats(raceId)).reduce((n, r) => n + r[f], 0);

const dayRange = (from: string, to: string) => ({ kind: 'dates', from, to }) as const;
const funnelDef = (raceIds: string[], over: Record<string, unknown> = {}) => ({ entity: 'funnel', columns: ['views', 'builder_uses', 'requests', 'approved', 'paid', 'request_rate_pct', 'paid_rate_pct'], groupBy: 'race', raceIds, range: { kind: 'last_days', days: 366 }, ...over });
const bookingDef = (raceIds: string[], over: Record<string, unknown> = {}) => ({ entity: 'bookings', columns: ['bookings', 'approved', 'declined', 'expired', 'cancelled', 'paid'], groupBy: 'race', raceIds, range: { kind: 'last_days', days: 366 }, ...over });
type Result = { columns: string[]; groupBy: string; from: string; to: string; truncated: boolean; rows: Array<{ key: string; label: string; values: Record<string, number | null> }> };
const preview = async (c: Client, definition: object): Promise<Result> => must(await c.post('/admin/reports/preview', { definition }), 'preview').body;

const PATH = ['approved', 'deposit_paid', 'confirmed', 'balance_paid'] as const;
/** A booking in a world, moved along its states in one transaction (the database wants a payment plan by commit once approved). */
async function booking(w: World, versionId: string, state: 'requested' | (typeof PATH)[number] | 'declined' | 'cancelled' | 'expired', requestedAt?: string): Promise<string> {
  const { bookingId } = await makeBookingFor(t, { pkg: w.pkg, edition: w.edition, versionId }, undefined, requestedAt ? new Date(requestedAt) : undefined);
  await t.prisma.$transaction(async (tx) => {
    if (state === 'requested') return;
    if (state === 'declined' || state === 'cancelled' || state === 'expired') {
      const col = { declined: 'declinedAt', cancelled: 'cancelledAt', expired: 'expiredAt' }[state];
      await tx.$executeRawUnsafe(`UPDATE bookings SET version = version + 1, status = '${state}'::"BookingStatus", "${col}" = now() WHERE id = '${bookingId}'::uuid`);
      return;
    }
    for (const step of PATH.slice(0, PATH.indexOf(state) + 1)) {
      await tx.$executeRawUnsafe(`UPDATE bookings SET version = version + 1, status = '${step}'::"BookingStatus"${step === 'approved' ? `, "approvedAt" = now(), "approvalExpiresAt" = now() + interval '1 day'` : ''} WHERE id = '${bookingId}'::uuid`);
      if (step === 'approved') await insertValidSchedule(tx, bookingId);
    }
  });
  return bookingId;
}
/**
 * A draft demo race with an edition and a package, made through Prisma: `isDemo` can only be set when the row is created
 * (a trigger keeps it), and a demo race can never be published (a CHECK), so this is the only shape one can take.
 */
async function demoWorld(): Promise<{ race: { id: string; slug: string }; edition: { id: string }; pkg: { id: string } }> {
  const base = await buildWorld(admin);
  const { id: _r, createdAt: _c, updatedAt: _u, ...race } = await t.prisma.race.findUniqueOrThrow({ where: { id: base.race.id } });
  const demo = await t.prisma.race.create({ data: { ...race, slug: `demo-${base.race.slug}`, isDemo: true, status: 'draft', publishedAt: null } });
  const { id: _e, raceId: _er, createdAt: _ec, updatedAt: _eu, ...edition } = await t.prisma.raceEdition.findUniqueOrThrow({ where: { id: base.edition.id } });
  const ed = await t.prisma.raceEdition.create({ data: { ...edition, raceId: demo.id } });
  const { id: _p, editionId: _pe, createdAt: _pc, updatedAt: _pu, ...pkg } = await t.prisma.package.findUniqueOrThrow({ where: { id: base.pkg.id } });
  const pk = await t.prisma.package.create({ data: { ...pkg, editionId: ed.id, saleStatus: 'draft' } });
  return { race: { id: demo.id, slug: demo.slug }, edition: { id: ed.id }, pkg: { id: pk.id } };
}
const versionOf = async (w: World): Promise<string> => (await t.prisma.priceVersion.findFirstOrThrow({ where: { packageId: w.pkg.id } })).id;

describe('visits', () => {
  it('a published race counts views and builder uses, nothing else is stored', async () => {
    const w = await publishedWorld();
    expect((await beacon({ raceSlug: w.race.slug, kind: 'view' })).status).toBe(204);
    expect((await beacon({ raceSlug: w.race.slug, kind: 'builder' })).status).toBe(204);
    await service().recordEvent({ raceSlug: w.race.slug, kind: 'view' });
    expect(await sum(w.race.id, 'views')).toBe(2);
    expect(await sum(w.race.id, 'builderUses')).toBe(1);
    expect(await stats(w.race.id)).toHaveLength(1);
    const cols = (await t.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'race_daily_stats'`)).map((c) => c.column_name).sort();
    expect(cols).toEqual(['builderUses', 'day', 'raceId', 'views']);
  });

  it('the same address counts once per race and kind in half an hour, and the answer does not change', async () => {
    const w = await publishedWorld();
    const other = await publishedWorld();
    for (let i = 0; i < 5; i++) expect((await beacon({ raceSlug: w.race.slug, kind: 'view' })).status).toBe(204);
    expect(await sum(w.race.id, 'views')).toBe(1);
    expect((await beacon({ raceSlug: w.race.slug, kind: 'builder' })).status).toBe(204);
    expect((await beacon({ raceSlug: other.race.slug, kind: 'view' })).status).toBe(204);
    expect(await sum(w.race.id, 'builderUses')).toBe(1);
    expect(await sum(other.race.id, 'views')).toBe(1);
    // A header the proxy setting does not trust does not make a new visitor.
    expect((await t.http().post('/analytics/race-events').set(STATE_HEADERS).set('X-Forwarded-For', '203.0.113.9').send({ raceSlug: w.race.slug, kind: 'view' })).status).toBe(204);
    expect(await sum(w.race.id, 'views')).toBe(1);
  });

  it('the deduper is per address, race and kind, forgets after the window and is bounded', () => {
    const d = new VisitDeduper();
    const t0 = 1_000_000;
    expect(d.first('a', 'r', 'view', t0)).toBe(true);
    expect(d.first('a', 'r', 'view', t0 + 1)).toBe(false);
    expect(d.first('b', 'r', 'view', t0)).toBe(true);
    expect(d.first('a', 'r', 'builder', t0)).toBe(true);
    expect(d.first('a', 'r2', 'view', t0)).toBe(true);
    expect(d.first('a', 'r', 'view', t0 + VISIT_DEDUPE_MS - 1)).toBe(false);
    expect(d.first('a', 'r', 'view', t0 + VISIT_DEDUPE_MS + 2)).toBe(true);
    for (let i = 0; i < 12_000; i++) d.first(`ip${i}`, 'r', 'view', t0);
    expect(d.first('ip0', 'r', 'view', t0)).toBe(true); // the oldest entries were dropped, so memory stays bounded
  });

  it('concurrent visits are all counted', async () => {
    const w = await publishedWorld();
    await Promise.all(Array.from({ length: 12 }, (_, i) => service().recordEvent({ raceSlug: w.race.slug, kind: i % 3 === 0 ? 'builder' : 'view' })));
    expect(await sum(w.race.id, 'views')).toBe(8);
    expect(await sum(w.race.id, 'builderUses')).toBe(4);
  });

  it('a draft, a deleted, a demo or an unknown race counts nothing and the answer is the same', async () => {
    const draft = await buildWorld(admin);
    const gone = await publishedWorld();
    const demo = await demoWorld();
    await t.prisma.$executeRawUnsafe(`UPDATE races SET "deletedAt" = now(), "deletedById" = (SELECT id FROM users LIMIT 1) WHERE id = '${gone.race.id}'::uuid`);
    for (const slug of [draft.race.slug, gone.race.slug, demo.race.slug, 'no-such-race']) expect((await beacon({ raceSlug: slug, kind: 'view' })).status).toBe(204);
    expect(await sum(draft.race.id, 'views')).toBe(0);
    expect(await sum(gone.race.id, 'views')).toBe(0);
    expect(await sum(demo.race.id, 'views')).toBe(0);
  });

  it('refuses a body with more than a slug and a kind', async () => {
    expect((await beacon({ raceSlug: 'x', kind: 'click' })).status).toBe(422);
    expect((await beacon({ raceSlug: 'x', kind: 'view', userId: 'a' })).status).toBe(422);
    expect((await beacon({ raceSlug: 'Not A Slug', kind: 'view' })).status).toBe(422);
    expect((await beacon({})).status).toBe(422);
  });

  it('is counted even while the module is off, and the panel routes answer 404', async () => {
    const w = await publishedWorld();
    await setFlag(false);
    try {
      expect((await beacon({ raceSlug: w.race.slug, kind: 'view' })).status).toBe(204);
      expect((await admin.get('/admin/reports/funnel')).status).toBe(404);
      expect(await t.app.get(ReportScheduler).tick()).toEqual({ runs: 0, emails: 0 });
    } finally {
      await setFlag(true);
    }
    expect(await sum(w.race.id, 'views')).toBe(1);
  });
});

describe('access', () => {
  it('each permission guards its routes and the data needs its own permission', async () => {
    const funnelOnly = await staffClient(t, [P.funnelRead]);
    expect((await funnelOnly.get('/admin/reports/funnel')).status).toBe(200);
    expect((await funnelOnly.get('/admin/reports')).status).toBe(403);
    const reader = await staffClient(t, [P.read]);
    expect((await reader.get('/admin/reports')).status).toBe(200);
    expect((await reader.get('/admin/reports/funnel')).status).toBe(403);
    expect((await reader.post('/admin/reports', { name: 'x', definition: funnelDef([]) })).status).toBe(403);
    const none = await staffClient(t, []);
    for (const path of ['/admin/reports', '/admin/reports/funnel', '/admin/reports/catalogue']) expect((await none.get(path)).status).toBe(403);
    expect([401, 403]).toContain((await t.http().get('/admin/reports')).status);
  });

  it('a report of bookings needs bookings.booking.read to preview, run, create and change', async () => {
    const noBookings = await staffClient(t, [P.read, P.manage, P.funnelRead]);
    expect((await noBookings.post('/admin/reports/preview', { definition: bookingDef([]) })).status).toBe(403);
    expect((await noBookings.post('/admin/reports', { name: 'x', definition: bookingDef([]) })).status).toBe(403);
    expect((await noBookings.post('/admin/reports/preview', { definition: funnelDef([]) })).status).toBe(200);
    const saved = must(await admin.post('/admin/reports', { name: 'Bookings by race', definition: bookingDef([]) }), 'create').body;
    expect((await noBookings.post(`/admin/reports/${saved.id}/run`)).status).toBe(403);
    expect((await noBookings.patch(`/admin/reports/${saved.id}`, { name: 'y', version: 0 })).status).toBe(403);
    const funnelSaved = must(await admin.post('/admin/reports', { name: 'Funnel', definition: funnelDef([]) }), 'create').body;
    expect((await noBookings.post(`/admin/reports/${funnelSaved.id}/run`)).status).toBe(200);
  });

  it('no permission can be given to an API key', async () => {
    expect(reportsManifest.permissions).toHaveLength(3);
    expect(reportsManifest.permissions.every((p) => p.apiKeyScopable === false && !p.requiresStepUp)).toBe(true);
    expect(await t.prisma.permission.count({ where: { key: { in: ALL_REPORTS } } })).toBe(3);
    expect(Object.values(REPORT_ENTITY_CATALOGUE).map((e) => e.permission).sort()).toEqual([BOOKING_READ, P.funnelRead]);
  });

  it('the catalogue says which entities the caller may use and lists only staff who can read reports as recipients', async () => {
    const limited = await staffClient(t, [P.read]);
    type Cat = { entities: Array<{ entity: string; allowed: boolean }>; recipients: Array<{ id: string; email: string }> };
    const cat = must(await limited.get('/admin/reports/catalogue'), 'catalogue').body as Cat;
    expect(cat.entities.map((e) => [e.entity, e.allowed])).toEqual([['funnel', false], ['bookings', false]]);
    // Staff addresses go only to someone who can choose recipients.
    expect(cat.recipients).toEqual([]);
    const manager = await staffClient(t, [P.read, P.manage]);
    const full = must(await manager.get('/admin/reports/catalogue'), 'catalogue').body as Cat;
    expect(full.recipients.some((r) => r.id === limited.staff.id)).toBe(true);
    const noReports = await staffClient(t, [BOOKING_READ]);
    expect(full.recipients.some((r) => r.id === noReports.staff.id)).toBe(false);
  });
});

describe('funnel and booking figures', () => {
  it('counts requests by the Brisbane day they were made, approved and paid as a cohort, and rates from them', async () => {
    const w = await publishedWorld();
    const v = await versionOf(w);
    // 2027-03-03 00:00 Brisbane is 2027-03-02T14:00Z.
    await booking(w, v, 'requested', '2027-03-02T13:59:59Z'); // 2 March in Brisbane: outside
    await booking(w, v, 'requested', '2027-03-02T14:00:00Z'); // first instant of 3 March
    await booking(w, v, 'approved', '2027-03-03T05:00:00Z');
    await booking(w, v, 'deposit_paid', '2027-03-03T06:00:00Z');
    await booking(w, v, 'balance_paid', '2027-03-03T13:59:59Z'); // last second of 3 March
    await booking(w, v, 'declined', '2027-03-03T14:00:00Z'); // 4 March in Brisbane: outside
    // Visits on days inside and outside the range.
    await t.prisma.$executeRawUnsafe(`INSERT INTO race_daily_stats ("raceId", day, views, "builderUses") VALUES ('${w.race.id}'::uuid, '2027-03-03', 40, 10), ('${w.race.id}'::uuid, '2027-03-02', 99, 99), ('${w.race.id}'::uuid, '2027-03-04', 99, 99)`);
    const res = await preview(admin, funnelDef([w.race.id], { range: dayRange('2027-03-03', '2027-03-03') }));
    expect(res).toMatchObject({ from: '2027-03-03', to: '2027-03-03', truncated: false });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ key: w.race.id });
    expect(res.rows[0]!.values).toEqual({ views: 40, builder_uses: 10, requests: 4, approved: 3, paid: 2, request_rate_pct: 10, paid_rate_pct: 50 });
  });

  it('bookings by status columns, race, edition, package, channel and month; the race filter and an empty period', async () => {
    const w = await publishedWorld();
    const v = await versionOf(w);
    await booking(w, v, 'requested', '2027-01-10T01:00:00Z');
    await booking(w, v, 'declined', '2027-01-20T01:00:00Z');
    await booking(w, v, 'cancelled', '2027-02-05T01:00:00Z');
    await booking(w, v, 'expired', '2027-02-06T01:00:00Z');
    await booking(w, v, 'confirmed', '2027-02-07T01:00:00Z');
    await booking(w, v, 'requested', '2026-12-31T13:59:59Z'); // 31 Dec 23:59:59 Brisbane
    const base = { range: dayRange('2026-12-01', '2027-03-31') };
    const byRace = await preview(admin, bookingDef([w.race.id], base));
    expect(byRace.rows).toHaveLength(1);
    expect(byRace.rows[0]!.values).toEqual({ bookings: 6, approved: 1, declined: 1, expired: 1, cancelled: 1, paid: 1 });
    const byMonth = await preview(admin, bookingDef([w.race.id], { ...base, groupBy: 'month', columns: ['bookings', 'paid'] }));
    expect(byMonth.rows.map((r) => [r.key, r.values.bookings, r.values.paid])).toEqual([['2026-12', 1, 0], ['2027-01', 2, 0], ['2027-02', 3, 1]]);
    const byEdition = await preview(admin, bookingDef([w.race.id], { ...base, groupBy: 'edition', columns: ['bookings'] }));
    expect(byEdition.rows[0]).toMatchObject({ key: w.edition.id });
    expect(byEdition.rows[0]!.label).toContain(String(w.edition.year));
    const byPackage = await preview(admin, bookingDef([w.race.id], { ...base, groupBy: 'package', columns: ['bookings'] }));
    expect(byPackage.rows[0]).toMatchObject({ key: w.pkg.id, values: { bookings: 6 } });
    const byChannel = await preview(admin, bookingDef([w.race.id], { ...base, groupBy: 'channel', columns: ['bookings'] }));
    expect(byChannel.rows).toEqual([{ key: 'panel', label: 'panel', values: { bookings: 6 } }]);
    const total = await preview(admin, funnelDef([w.race.id], { ...base, groupBy: 'none', columns: ['requests'] }));
    expect(total.rows).toEqual([{ key: 'all', label: 'All races', values: { requests: 6 } }]);
    // Another race is not mixed in, and an empty period has no rows.
    const other = await publishedWorld();
    await booking(other, await versionOf(other), 'requested', '2027-01-10T01:00:00Z');
    expect((await preview(admin, bookingDef([w.race.id], base))).rows[0]!.values.bookings).toBe(6);
    expect((await preview(admin, bookingDef([w.race.id, other.race.id], base))).rows).toHaveLength(2);
    expect((await preview(admin, bookingDef([w.race.id], { range: dayRange('2031-01-01', '2031-01-31') }))).rows).toEqual([]);
  });

  it('a race with visits but no requests still shows, rates are null without a denominator, and a deleted race is left out', async () => {
    const quiet = await publishedWorld();
    const gone = await publishedWorld();
    await t.prisma.$executeRawUnsafe(`INSERT INTO race_daily_stats ("raceId", day, views) VALUES ('${quiet.race.id}'::uuid, '2027-05-05', 5), ('${gone.race.id}'::uuid, '2027-05-05', 5)`);
    await t.prisma.$executeRawUnsafe(`UPDATE races SET "deletedAt" = now(), "deletedById" = (SELECT id FROM users LIMIT 1) WHERE id = '${gone.race.id}'::uuid`);
    const res = await preview(admin, funnelDef([quiet.race.id, gone.race.id].slice(0, 1), { range: dayRange('2027-05-01', '2027-05-31') }));
    expect(res.rows[0]!.values).toMatchObject({ views: 5, requests: 0, request_rate_pct: 0, paid_rate_pct: null });
    const both = must(await admin.get('/admin/reports/funnel?from=2027-05-01&to=2027-05-31'), 'funnel').body as Result;
    expect(both.rows.some((r) => r.key === gone.race.id)).toBe(false);
    expect(both.rows.find((r) => r.key === quiet.race.id)).toBeTruthy();
  });

  it('the funnel route defaults to 30 days, takes days or two dates and refuses a bad range', async () => {
    const def = must(await admin.get('/admin/reports/funnel'), 'default').body as Result;
    expect(def.columns).toEqual([...REPORT_ENTITY_CATALOGUE.funnel.columns]);
    expect(def.to >= def.from).toBe(true);
    expect(Date.parse(def.to) - Date.parse(def.from)).toBe(29 * 86_400_000);
    expect((await admin.get('/admin/reports/funnel?days=7')).status).toBe(200);
    for (const q of ['days=0', 'days=400', 'from=2027-01-01', 'to=2027-01-01', 'from=2027-02-01&to=2027-01-01', 'from=2020-01-01&to=2027-01-01', 'x=1']) expect([q, (await admin.get(`/admin/reports/funnel?${q}`)).status]).toEqual([q, 422]);
  });

  it('demo bookings and demo races are left out of every figure', async () => {
    const w = await publishedWorld();
    const v = await versionOf(w);
    // A demo booking can sit on a real race, so the filter is also per booking.
    await makeBookingFor(t, { pkg: w.pkg, edition: w.edition, versionId: v });
    await makeBookingFor(t, { pkg: w.pkg, edition: w.edition, versionId: v }, undefined, undefined, undefined, { isDemo: true });
    expect((await t.prisma.booking.findMany({ where: { editionId: w.edition.id }, select: { isDemo: true } })).map((b) => b.isDemo).sort()).toEqual([false, true]);
    expect((await preview(admin, bookingDef([w.race.id]))).rows[0]!.values.bookings).toBe(1);
    expect((await preview(admin, funnelDef([w.race.id], { groupBy: 'none', columns: ['requests'] }))).rows).toEqual([{ key: 'all', label: 'All races', values: { requests: 1 } }]);
    // A demo race (a draft: the database refuses a published one) with counters and a demo booking shows nothing.
    const demo = await demoWorld();
    await t.prisma.$executeRawUnsafe(`INSERT INTO race_daily_stats ("raceId", day, views) VALUES ('${demo.race.id}'::uuid, CURRENT_DATE, 7)`);
    await makeBookingFor(t, { pkg: demo.pkg, edition: demo.edition, versionId: v }, undefined, undefined, undefined, { isDemo: true });
    await makeBookingFor(t, { pkg: demo.pkg, edition: demo.edition, versionId: v });
    expect((await t.prisma.raceDailyStat.count({ where: { raceId: demo.race.id } }))).toBe(1);
    expect((await preview(admin, funnelDef([demo.race.id]))).rows).toEqual([]);
    expect((await preview(admin, bookingDef([demo.race.id]))).rows).toEqual([]);
  });

  it('a report holds counts only: no reference, name or address of a customer', async () => {
    const w = await publishedWorld();
    const { customerId } = await makeBookingFor(t, { pkg: w.pkg, edition: w.edition, versionId: await versionOf(w) });
    await t.prisma.customer.update({ where: { id: customerId }, data: { givenName: 'Zoltanzz', familyName: 'Quibblewick' } });
    const c = await t.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const b = await t.prisma.booking.findFirstOrThrow({ where: { customerId } });
    const text = JSON.stringify([await preview(admin, bookingDef([w.race.id])), await preview(admin, funnelDef([w.race.id]))]);
    for (const secret of [c.email, c.givenName, c.familyName, b.reference, c.id, customerId]) if (secret) expect(text).not.toContain(secret);
    expect(Object.keys((await preview(admin, bookingDef([w.race.id]))).rows[0]!.values)).toEqual(['bookings', 'approved', 'declined', 'expired', 'cancelled', 'paid']);
  });

  it('refuses an unknown race in the filter and an invalid definition', async () => {
    expect((await admin.post('/admin/reports/preview', { definition: bookingDef(['0192f0a0-0000-7000-8000-0000000000aa']) })).body).toMatchObject({ code: 'report_race_not_found' });
    expect((await admin.post('/admin/reports/preview', { definition: bookingDef([], { columns: ['views'] }) })).status).toBe(422);
    expect((await admin.post('/admin/reports/preview', { definition: bookingDef([], { groupBy: "race'; drop table bookings;--" }) })).status).toBe(422);
    expect((await admin.post('/admin/reports/preview', { definition: bookingDef([]), extra: 1 })).status).toBe(422);
  });
});

describe('saved reports', () => {
  it('create, read, change with a version, delete, audited, and the writer becomes the owner', async () => {
    const created = must(await admin.post('/admin/reports', { name: 'Weekly funnel', definition: funnelDef([]) }), 'create');
    expect(created.status).toBe(201);
    const r = created.body;
    expect(r).toMatchObject({ name: 'Weekly funnel', entity: 'funnel', schedule: null, recipientUserIds: [], version: 0, ownerUserId: admin.staff.id });
    expect((must(await admin.get('/admin/reports'), 'list').body as { items: Array<{ id: string }> }).items.some((i) => i.id === r.id)).toBe(true);
    expect(must(await admin.get(`/admin/reports/${r.id}`), 'get').body.name).toBe('Weekly funnel');
    const other = await staffClient(t, [...ALL_REPORTS, BOOKING_READ]);
    const u = must(await other.patch(`/admin/reports/${r.id}`, { name: 'Renamed', definition: bookingDef([]), version: 0 }), 'update').body;
    expect(u).toMatchObject({ name: 'Renamed', entity: 'bookings', version: 1, ownerUserId: other.staff.id });
    expect((await admin.patch(`/admin/reports/${r.id}`, { name: 'Stale', version: 0 })).body).toMatchObject({ code: 'version_conflict' });
    expect((await admin.delete(`/admin/reports/${r.id}?version=0`)).status).toBe(409);
    expect((await admin.delete(`/admin/reports/${r.id}?version=1`)).status).toBe(204);
    for (const res of [await admin.get(`/admin/reports/${r.id}`), await admin.post(`/admin/reports/${r.id}/run`), await admin.patch(`/admin/reports/${r.id}`, { name: 'z', version: 2 })]) expect(res.status).toBe(404);
    expect((await t.prisma.auditLog.findMany({ where: { entityType: 'SavedReport', entityId: r.id }, orderBy: { occurredAt: 'asc' } })).map((a) => a.action)).toEqual(['reports.report.created', 'reports.report.updated', 'reports.report.deleted']);
    // Never removed from the table, and the API role cannot remove it.
    expect(await t.prisma.savedReport.count({ where: { id: r.id, deletedAt: { not: null } } })).toBe(1);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM saved_reports WHERE id = '${r.id}'::uuid`)).rejects.toThrow();
    expect((await t.prisma.savedReport.findUniqueOrThrow({ where: { id: r.id } })).deletedById).toBe(admin.staff.id);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE saved_reports SET "deletedById" = NULL WHERE id = '${r.id}'::uuid`)).rejects.toThrow();
  });

  it('recipients must be active staff who can read reports and the data; they need a schedule', async () => {
    const schedule = { frequency: 'weekly', weekday: 3, time: '08:00' };
    const ok = await staffClient(t, [P.read, BOOKING_READ]);
    const noData = await staffClient(t, [P.read]);
    const noReports = await staffClient(t, [BOOKING_READ]);
    const off = await staffClient(t, [P.read, BOOKING_READ]);
    await t.prisma.user.update({ where: { id: off.staff.id }, data: { status: 'disabled' } });
    const def = bookingDef([]);
    const make = (recipientUserIds: string[], s: object | null = schedule) => admin.post('/admin/reports', { name: 'R', definition: def, schedule: s, recipientUserIds });
    expect((await make([ok.staff.id])).status).toBe(201);
    for (const id of [noData.staff.id, noReports.staff.id, off.staff.id, '0192f0a0-0000-7000-8000-0000000000bb']) expect([id, (await make([id])).status]).toEqual([id, 422]);
    expect((await make([noData.staff.id])).body).toMatchObject({ code: 'report_recipient_cannot_see_data' });
    expect((await make([ok.staff.id], null)).body).toMatchObject({ code: 'report_schedule_required' });
    expect((await make([ok.staff.id, ok.staff.id])).status).toBe(422);
    // A customer's user id is not a recipient either.
    const cust = await signInCustomer(t);
    expect((await make([cust.userId])).status).toBe(422);
  });

  it('changing the schedule restarts its clock; changing only the name does not', async () => {
    const r = must(await admin.post('/admin/reports', { name: 'Clock', definition: funnelDef([]), schedule: { frequency: 'weekly', weekday: 1, time: '09:00' } }), 'create').body;
    const started = async () => (await t.prisma.savedReport.findUniqueOrThrow({ where: { id: r.id } })).scheduleStartedAt!.getTime();
    const first = await started();
    await t.prisma.$executeRawUnsafe(`UPDATE saved_reports SET "scheduleStartedAt" = '2027-01-01T00:00:00Z' WHERE id = '${r.id}'::uuid`);
    const renamed = must(await admin.patch(`/admin/reports/${r.id}`, { name: 'Clock 2', version: 0 }), 'rename').body;
    expect(await started()).toBe(Date.parse('2027-01-01T00:00:00Z'));
    must(await admin.patch(`/admin/reports/${r.id}`, { schedule: { frequency: 'monthly', dayOfMonth: 2, time: '09:00' }, version: renamed.version }), 'reschedule');
    // The clock restarted at the change: no longer the old value, and not in the future.
    expect(await started()).not.toBe(Date.parse('2027-01-01T00:00:00Z'));
    expect(await started()).toBeLessThanOrEqual(Date.now());
    expect(await started()).toBeGreaterThanOrEqual(first);
    const cleared = must(await admin.patch(`/admin/reports/${r.id}`, { schedule: null, version: 2 }), 'clear').body;
    expect(cleared.schedule).toBeNull();
    expect((await t.prisma.savedReport.findUniqueOrThrow({ where: { id: r.id } })).scheduleStartedAt).toBeNull();
  });
});

describe('scheduled sending', () => {
  // Wednesday 2027-03-03, 10:00 in Brisbane. A weekly Wednesday 08:00 report was due at 2027-03-02T22:00Z.
  const NOW = new Date('2027-03-03T00:00:00Z');
  const WED = { frequency: 'weekly', weekday: 3, time: '08:00' };
  async function scheduled(recipients: Staff[], over: { schedule?: object; owner?: Staff } = {}) {
    const owner = over.owner ?? admin;
    const r = must(await owner.post('/admin/reports', { name: `Sched ${Date.now()}`, definition: funnelDef([]), schedule: over.schedule ?? WED, recipientUserIds: recipients.map((c) => c.staff.id) }), 'create').body as { id: string };
    await t.prisma.$executeRawUnsafe(`UPDATE saved_reports SET "scheduleStartedAt" = '2027-01-01T00:00:00Z' WHERE id = '${r.id}'::uuid`);
    return r.id;
  }
  const emailsOf = (runId: string) => t.prisma.outboundEmail.findMany({ where: { dedupeKey: { startsWith: `report:${runId}:` } }, orderBy: { to: 'asc' } });
  const runsOf = (reportId: string) => t.prisma.reportRun.findMany({ where: { reportId } });
  const tick = (now = NOW) => t.app.get(ReportScheduler).tick(now);

  it('makes one run and one email per recipient, however many times and instances tick', async () => {
    const a = await staffClient(t, [P.read, P.funnelRead]);
    const b = await staffClient(t, [P.read, P.funnelRead]);
    const id = await scheduled([a, b]);
    await Promise.all([tick(), tick(), tick()]);
    await tick();
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'queued', emailsQueued: 2, recipientsSkipped: 0, reasonCode: null });
    expect(runs[0]!.scheduledFor.toISOString()).toBe('2027-03-02T22:00:00.000Z');
    const mails = await emailsOf(runs[0]!.id);
    expect(mails.map((m) => m.to).sort()).toEqual([a.staff.email, b.staff.email].sort());
    expect(mails.every((m) => m.templateKey === 'reports.scheduled' && m.category === 'transactional')).toBe(true);
  });

  it('sends the table at send time, counts only', async () => {
    const a = await staffClient(t, [P.read, P.funnelRead]);
    const id = await scheduled([a], { schedule: { frequency: 'weekly', weekday: 3, time: '08:00' } });
    await tick();
    const run = (await runsOf(id))[0]!;
    const mail = (await emailsOf(run.id))[0]!;
    t.mail.sent.length = 0;
    expect(await t.app.get(MailService).processSend(mail.id)).toBe('sent');
    const sent = t.mail.sent.find((m) => m.to === a.staff.email)!;
    expect(sent.subject).toMatch(/^Report: Sched /);
    expect(sent.text).toContain('views');
    expect(sent.text).toContain('/admin/reports');
    expect(sent.text).toContain('(Brisbane time)');
    expect(sent.text).not.toMatch(/@example\.test/);
  });

  it('is not sent before the schedule was set, late, or off the schedule', async () => {
    const a = await staffClient(t, [P.read, P.funnelRead]);
    const id = await scheduled([a]);
    expect(await tick(new Date('2027-03-02T21:59:00Z'))).toMatchObject({ runs: 0 }); // 07:59 on Wednesday: last week's occurrence is old
    expect(await runsOf(id)).toHaveLength(0);
    expect(await tick(new Date('2027-03-03T04:01:00Z'))).toMatchObject({ runs: 0 }); // more than six hours after
    expect(await runsOf(id)).toHaveLength(0);
    await t.prisma.$executeRawUnsafe(`UPDATE saved_reports SET "scheduleStartedAt" = '2027-03-02T23:00:00Z' WHERE id = '${id}'::uuid`);
    expect(await tick()).toMatchObject({ runs: 0 }); // the schedule was set after the occurrence
    expect(await runsOf(id)).toHaveLength(0);
    await t.prisma.$executeRawUnsafe(`UPDATE saved_reports SET "scheduleStartedAt" = '2027-01-01T00:00:00Z' WHERE id = '${id}'::uuid`);
    expect((await tick(new Date('2027-03-02T22:00:00Z'))).runs).toBeGreaterThanOrEqual(1); // exactly on the time
    expect(await runsOf(id)).toHaveLength(1);
    // The next week is another run.
    await tick(new Date('2027-03-10T00:00:00Z'));
    expect(await runsOf(id)).toHaveLength(2);
  });

  it('leaves out a recipient who lost access and says so; with none left the run is skipped', async () => {
    const stays = await staffClient(t, [P.read, P.funnelRead]);
    const loses = await staffClient(t, [P.read, P.funnelRead]);
    const disabled = await staffClient(t, [P.read, P.funnelRead]);
    const id = await scheduled([stays, loses, disabled]);
    await t.prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE "userId" = '${loses.staff.id}'::uuid`);
    await t.prisma.user.update({ where: { id: disabled.staff.id }, data: { status: 'disabled' } });
    await tick();
    const run = (await runsOf(id))[0]!;
    expect(run).toMatchObject({ status: 'queued', emailsQueued: 1, recipientsSkipped: 2 });
    expect((await emailsOf(run.id)).map((m) => m.to)).toEqual([stays.staff.email]);

    const alone = await staffClient(t, [P.read, P.funnelRead]);
    const id2 = await scheduled([alone]);
    await t.prisma.user.update({ where: { id: alone.staff.id }, data: { status: 'disabled' } });
    await tick();
    expect((await runsOf(id2))[0]).toMatchObject({ status: 'skipped', reasonCode: 'no_recipients', emailsQueued: 0, recipientsSkipped: 1 });
  });

  it('sends nothing when the owner lost access to the data, and opens one task', async () => {
    const owner = await staffClient(t, [...ALL_REPORTS, BOOKING_READ]);
    const a = await staffClient(t, [P.read, BOOKING_READ]);
    const r = must(await owner.post('/admin/reports', { name: 'Owner report', definition: bookingDef([]), schedule: WED, recipientUserIds: [a.staff.id] }), 'create').body as { id: string };
    await t.prisma.$executeRawUnsafe(`UPDATE saved_reports SET "scheduleStartedAt" = '2027-01-01T00:00:00Z' WHERE id = '${r.id}'::uuid`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE "userId" = '${owner.staff.id}'::uuid`);
    await tick();
    const run = (await runsOf(r.id))[0]!;
    expect(run).toMatchObject({ status: 'skipped', reasonCode: 'owner_unavailable', emailsQueued: 0 });
    expect(await emailsOf(run.id)).toHaveLength(0);
    expect(await t.prisma.task.count({ where: { sourceRef: `reports:owner_unavailable:${r.id}`, status: 'open' } })).toBe(1);
  });

  it('a deleted or unscheduled report makes no run', async () => {
    const a = await staffClient(t, [P.read, P.funnelRead]);
    const gone = await scheduled([a]);
    const cleared = await scheduled([a]);
    must(await admin.delete(`/admin/reports/${gone}?version=0`), 'delete');
    must(await admin.patch(`/admin/reports/${cleared}`, { schedule: null, recipientUserIds: [], version: 0 }), 'clear');
    await tick();
    expect(await runsOf(gone)).toHaveLength(0);
    expect(await runsOf(cleared)).toHaveLength(0);
  });

  it('the email is refused for someone who lost access after it was queued, or when the report is gone', async () => {
    const a = await staffClient(t, [P.read, P.funnelRead]);
    const b = await staffClient(t, [P.read, P.funnelRead]);
    const id = await scheduled([a, b]);
    await tick();
    const run = (await runsOf(id))[0]!;
    const mails = await emailsOf(run.id);
    await t.prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE "userId" = '${a.staff.id}'::uuid`);
    t.mail.sent.length = 0;
    const mailA = mails.find((m) => m.to === a.staff.email)!;
    const mailB = mails.find((m) => m.to === b.staff.email)!;
    expect(await t.app.get(MailService).processSend(mailA.id)).toBe('failed');
    expect((await t.prisma.outboundEmail.findUniqueOrThrow({ where: { id: mailA.id } })).error).toContain('mail_not_sendable');
    must(await admin.delete(`/admin/reports/${id}?version=0`), 'delete');
    expect(await t.app.get(MailService).processSend(mailB.id)).toBe('failed');
    expect(t.mail.sent.filter((m) => m.subject.startsWith('Report: Sched'))).toHaveLength(0);
  });

  it('a queued email is refused when the person was taken off the report or its owner lost the data', async () => {
    const a = await staffClient(t, [P.read, P.funnelRead]);
    const b = await staffClient(t, [P.read, P.funnelRead]);
    const owner = await staffClient(t, [...ALL_REPORTS]);
    const r = must(await owner.post('/admin/reports', { name: `Sched ${Date.now()}`, definition: funnelDef([]), schedule: WED, recipientUserIds: [a.staff.id, b.staff.id] }), 'create').body as { id: string; version: number };
    await t.prisma.$executeRawUnsafe(`UPDATE saved_reports SET "scheduleStartedAt" = '2027-01-01T00:00:00Z' WHERE id = '${r.id}'::uuid`);
    await tick();
    const mails = await emailsOf((await runsOf(r.id))[0]!.id);
    // a is taken off the report; the owner of the report then loses the funnel permission for b's email.
    await t.prisma.$executeRawUnsafe(`UPDATE saved_reports SET "recipientUserIds" = ARRAY['${b.staff.id}']::uuid[] WHERE id = '${r.id}'::uuid`);
    const mail = t.app.get(MailService);
    expect(await mail.processSend(mails.find((m) => m.to === a.staff.email)!.id)).toBe('failed');
    await t.prisma.$executeRawUnsafe(`DELETE FROM user_roles WHERE "userId" = '${owner.staff.id}'::uuid`);
    expect(await mail.processSend(mails.find((m) => m.to === b.staff.email)!.id)).toBe('failed');
  });

  it('a run is written once: the API role cannot change it', async () => {
    const a = await staffClient(t, [P.read, P.funnelRead]);
    const id = await scheduled([a]);
    await tick();
    const run = (await runsOf(id))[0]!;
    await expect(t.prisma.$executeRawUnsafe(`UPDATE report_runs SET "emailsQueued" = 9 WHERE id = '${run.id}'::uuid`)).rejects.toThrow();
  });

  it('with the module off nothing is made', async () => {
    const a = await staffClient(t, [P.read, P.funnelRead]);
    const id = await scheduled([a]);
    await setFlag(false);
    try {
      expect(await tick()).toEqual({ runs: 0, emails: 0 });
    } finally {
      await setFlag(true);
    }
    expect(await runsOf(id)).toHaveLength(0);
  });
});

describe('visit rate limit', () => {
  it('one address cannot send more than the limit in a minute', async () => {
    expect(VISITS_PER_MINUTE).toBe(60);
    const statuses: number[] = [];
    for (let i = 0; i < VISITS_PER_MINUTE + 2; i++) statuses.push((await beacon({ raceSlug: `no-such-race-${i}`, kind: 'view' })).status);
    expect(statuses[0]).toBe(204);
    expect(statuses.at(-1)).toBe(429);
  });
});
