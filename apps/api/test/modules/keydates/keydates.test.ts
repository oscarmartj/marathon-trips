import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KEY_DATE_LEAD_DAYS } from '@mt/shared';
import { KEYDATES_PERMISSIONS as K, KeyDatesService, keydatesManifest } from '../../../src/modules/keydates';
import { FeatureFlagService } from '../../../src/platform/flags/flags.service';
import { addDays, todayInBusinessZone } from '../../../src/modules/keydates/dates';
import { TestApp, makeApp } from '../../support/auth';
import { Client, anonymous, closeCatalogue, staffClient } from '../../support/catalogue';
import { makeBookingFor } from '../../support/bookings';
import { insertValidSchedule } from '../../support/payments';
import { ALL, adminWith, setSuppliersFlag, buildWorld, must, supplierWithContract } from '../../support/suppliers';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestApp;
let admin: Client;
let service: KeyDatesService;
const today = () => todayInBusinessZone();
const setFlag = async (enabled: boolean) => {
  await t.app.get(FeatureFlagService).ensure('module.keydates', enabled);
  await t.prisma.featureFlag.update({ where: { key: 'module.keydates' }, data: { enabled } });
};

beforeAll(async () => {
  t = await makeApp();
  admin = await adminWith(t, [...new Set([...Object.values(K), ...ALL])]);
  service = t.app.get(KeyDatesService);
  await setSuppliersFlag(t, true);
});
afterAll(async () => {
  await setFlag(true);
  await closeCatalogue(t);
});

const calendar = async (editionId: string, query = '') => must(await admin.get(`/admin/key-dates?editionId=${editionId}${query}`), 'calendar').body as { items: Array<Record<string, unknown> & { kind: string; date: string; count?: number; taskId?: string | null; keyDateId?: string }>; today: string };

const PATH = ['approved', 'deposit_paid', 'confirmed', 'balance_paid'] as const;
/** Moves a booking along its states in one transaction (the database wants a payment plan by commit once it is approved). */
async function advance(bookingId: string, to: (typeof PATH)[number] | 'requested', dueDate: string): Promise<void> {
  await t.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE bookings SET "balanceDueDate" = '${dueDate}' WHERE id = '${bookingId}'::uuid`);
    for (const step of PATH.slice(0, to === 'requested' ? 0 : PATH.indexOf(to) + 1)) {
      await tx.$executeRawUnsafe(`UPDATE bookings SET version = version + 1, status = '${step}'::"BookingStatus"${step === 'approved' ? `, "approvedAt" = now(), "approvalExpiresAt" = now() + interval '1 day'` : ''} WHERE id = '${bookingId}'::uuid`);
      if (step === 'approved') await insertValidSchedule(tx, bookingId);
    }
  });
}
const tasksFor = (ref: string) => t.prisma.task.findMany({ where: { sourceRef: { startsWith: ref } } });

describe('access and the module flag', () => {
  it('flag_off_routes_are_404 and the sweep does nothing', async () => {
    await setFlag(false);
    try {
      expect((await admin.get('/admin/key-dates')).status).toBe(404);
      expect(await service.sweep()).toEqual({ opened: 0, closed: 0 });
    } finally {
      await setFlag(true);
    }
    expect((await admin.get('/admin/key-dates')).status).toBe(200);
  });

  it('each permission guards its routes; anonymous callers are refused', async () => {
    const readOnly = await staffClient(t, [K.read]);
    expect((await readOnly.get('/admin/key-dates')).status).toBe(200);
    expect((await readOnly.post('/admin/key-dates', {})).status).toBe(403);
    const none = await staffClient(t, []);
    expect((await none.get('/admin/key-dates')).status).toBe(403);
    expect([401, 403]).toContain((await anonymous(t).get('/admin/key-dates')).status);
  });

  it('neither permission can be given to an API key', async () => {
    expect(keydatesManifest.permissions).toHaveLength(2);
    expect(keydatesManifest.permissions.every((p) => p.apiKeyScopable === false)).toBe(true);
    const rows = await t.prisma.permission.findMany({ where: { key: { in: Object.values(K) } }, select: { key: true } });
    expect(rows).toHaveLength(2);
  });
});

describe('stored dates', () => {
  it('create, update with a version, an old version is a 409, delete', async () => {
    const w = await buildWorld(admin);
    const d = must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'entry_submission', dueDate: '2027-03-01' }), 'create').body;
    expect(d).toMatchObject({ kind: 'entry_submission', dueDate: '2027-03-01', version: 0 });
    const u = must(await admin.patch(`/admin/key-dates/${d.id}`, { dueDate: '2027-03-05', version: 0 }), 'update').body;
    expect(u).toMatchObject({ dueDate: '2027-03-05', version: 1 });
    expect((await admin.patch(`/admin/key-dates/${d.id}`, { dueDate: '2027-03-06', version: 0 })).body).toMatchObject({ code: 'version_conflict' });
    expect((await admin.delete(`/admin/key-dates/${d.id}?version=0`)).status).toBe(409);
    expect((await admin.delete(`/admin/key-dates/${d.id}?version=1`)).status).toBe(204);
    expect((await calendar(w.edition.id, '&from=2027-01-01&to=2027-12-31')).items).toHaveLength(0);
    expect(await t.prisma.auditLog.count({ where: { entityType: 'KeyDate', entityId: d.id } })).toBe(3);
  });

  it('one entry submission deadline per edition; a custom date needs a label; unknown edition is 404', async () => {
    const w = await buildWorld(admin);
    must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'entry_submission', dueDate: '2027-03-01' }), 'first');
    expect((await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'entry_submission', dueDate: '2027-03-02' })).body).toMatchObject({ code: 'entry_submission_exists' });
    expect((await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', dueDate: '2027-03-02' })).status).toBe(422);
    expect((await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', label: 'Bib numbers', dueDate: '2027-02-30' })).status).toBe(422);
    expect((await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', label: 'Bib numbers', dueDate: '2027-03-02', extra: 1 })).status).toBe(422);
    expect((await admin.post('/admin/key-dates', { editionId: crypto.randomUUID(), kind: 'custom', label: 'x', dueDate: '2027-03-02' })).status).toBe(404);
    const c = must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', label: 'Bib numbers', dueDate: '2027-03-02' }), 'custom').body;
    expect((await admin.patch(`/admin/key-dates/${c.id}`, { label: null, version: 0 })).status).toBe(422);
  });
});

describe('the calendar joins the three sources', () => {
  it('shows a release date, a balance due date, a deadline and a custom date, and nothing from a released allotment', async () => {
    const w = await buildWorld(admin);
    const { contract } = await supplierWithContract(admin, w);
    const soon = addDays(today(), 3);
    const allot = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.roomPoolId, quantity: 4, releaseDate: soon, unitCostMinor: '12000', currency: 'DKK' }), 'allotment').body;
    const released = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.roomPoolId, quantity: 2, releaseDate: soon, unitCostMinor: '12000', currency: 'DKK' }), 'allotment 2').body;
    must(await admin.post(`/admin/suppliers/allotments/${released.id}/release`, { version: released.version }), 'release');
    const mk = async (status: string) => {
      const { bookingId } = await makeBookingFor(t, { pkg: w.pkg, edition: w.edition, versionId: (await t.prisma.priceVersion.findFirst({ where: { packageId: w.pkg.id } }))!.id });
      await advance(bookingId, status as 'requested', soon);
    };
    await mk('deposit_paid');
    await mk('confirmed');
    await mk('requested'); // owes nothing yet
    await mk('balance_paid'); // already paid
    must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'entry_submission', dueDate: addDays(today(), 10) }), 'deadline');
    must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', label: 'Bib numbers', dueDate: addDays(today(), -2) }), 'custom');

    const cal = await calendar(w.edition.id);
    const kinds = cal.items.map((i) => `${i.kind}:${i.date}`);
    expect(kinds).toEqual([`custom:${addDays(today(), -2)}`, `allotment_release:${soon}`, `balance_due:${soon}`, `entry_submission:${addDays(today(), 10)}`].sort((a, b) => a.split(':')[1]!.localeCompare(b.split(':')[1]!)));
    expect(cal.items.find((i) => i.kind === 'allotment_release')).toMatchObject({ key: `allotment_release:${allot.id}`, count: 4, overdue: false });
    expect(cal.items.find((i) => i.kind === 'balance_due')).toMatchObject({ count: 2, overdue: false });
    expect(cal.items.find((i) => i.kind === 'custom')).toMatchObject({ overdue: true, label: 'Bib numbers' });
    // No customer, reference or amount leaves through the calendar.
    expect(JSON.stringify(cal)).not.toMatch(/MT-[0-9A-Z]{6}|Customer|@/);
  });

  it('a window, an edition filter and bad ranges', async () => {
    const w = await buildWorld(admin);
    must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', label: 'Far away', dueDate: '2031-01-01' }), 'far');
    expect((await calendar(w.edition.id)).items).toHaveLength(0);
    expect((await calendar(w.edition.id, '&from=2030-12-31&to=2031-01-01')).items).toHaveLength(1);
    expect((await admin.get('/admin/key-dates?from=2031-01-02&to=2031-01-01')).status).toBe(422);
    expect((await admin.get('/admin/key-dates?from=2020-01-01&to=2031-01-01')).status).toBe(422);
    expect((await admin.get('/admin/key-dates?editionId=nope')).status).toBe(422);
  });
});

describe('automatic tasks', () => {
  it('opens one task per coming date, once, with a due time; later dates and far-past dates get none', async () => {
    const w = await buildWorld(admin);
    const near = addDays(today(), KEY_DATE_LEAD_DAYS);
    const d = must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', label: 'Briefing pack out', dueDate: near }), 'near').body;
    const later = must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', label: 'Too far', dueDate: addDays(near, 1) }), 'later').body;
    const old = must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'custom', label: 'Long gone', dueDate: addDays(today(), -60) }), 'old').body;
    const first = await service.sweep();
    expect(first.opened).toBeGreaterThanOrEqual(1);
    const mine = await tasksFor(`keydate:custom:${d.id}:`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ source: 'system', status: 'open', entityType: 'KeyDate', entityId: d.id });
    expect(mine[0]!.title).toContain('Briefing pack out');
    expect(mine[0]!.dueAt!.toISOString()).toBe(new Date(`${near}T00:00:00+10:00`).toISOString());
    expect(await tasksFor(`keydate:custom:${later.id}:`)).toHaveLength(0);
    expect(await tasksFor(`keydate:custom:${old.id}:`)).toHaveLength(0);
    // The calendar points at the open task.
    expect((await calendar(w.edition.id)).items.find((i) => i.keyDateId === d.id)!.taskId).toBe(mine[0]!.id);
    // A second sweep, and two at once, add nothing.
    await Promise.all([service.sweep(), service.sweep()]);
    expect(await tasksFor(`keydate:custom:${d.id}:`)).toHaveLength(1);
  });

  it('a task a person closed is not opened again; a moved date closes the old task and opens a new one; a deleted date closes its task', async () => {
    const w = await buildWorld(admin);
    const date = addDays(today(), 2);
    const d = must(await admin.post('/admin/key-dates', { editionId: w.edition.id, kind: 'entry_submission', dueDate: date }), 'create').body;
    await service.sweep();
    const [task] = await tasksFor(`keydate:entry_submission:${d.id}:`);
    await t.prisma.task.update({ where: { id: task!.id }, data: { status: 'done' } });
    await service.sweep();
    expect(await tasksFor(`keydate:entry_submission:${d.id}:`)).toHaveLength(1);

    const moved = must(await admin.patch(`/admin/key-dates/${d.id}`, { dueDate: addDays(today(), 4), version: 0 }), 'move').body;
    await service.sweep();
    const afterMove = await tasksFor(`keydate:entry_submission:${d.id}:`);
    expect(afterMove).toHaveLength(2);
    const open = afterMove.filter((x) => x.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.sourceRef!.endsWith(addDays(today(), 4))).toBe(true);

    must(await admin.patch(`/admin/key-dates/${d.id}`, { dueDate: addDays(today(), 5), version: moved.version }), 'move again');
    await service.sweep();
    expect((await tasksFor(`keydate:entry_submission:${d.id}:`)).filter((x) => x.status === 'open')).toHaveLength(1);
    expect((await admin.delete(`/admin/key-dates/${d.id}?version=2`)).status).toBe(204);
    expect((await tasksFor(`keydate:entry_submission:${d.id}:`)).filter((x) => x.status === 'open')).toHaveLength(0);
  });

  it('a release date opens a task, and releasing the allotment closes it', async () => {
    const w = await buildWorld(admin);
    const { contract } = await supplierWithContract(admin, w);
    const a = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: w.entryPoolId, quantity: 3, releaseDate: addDays(today(), 1), unitCostMinor: '5000', currency: 'DKK' }), 'allotment').body;
    await service.sweep();
    const [task] = await tasksFor(`keydate:allotment_release:${a.id}:`);
    expect(task).toMatchObject({ status: 'open', entityType: 'Allotment', entityId: a.id });
    expect(task!.title).toMatch(/Allotment release for .* 3 entries held by Harbour Hotel/);
    must(await admin.post(`/admin/suppliers/allotments/${a.id}/release`, { version: a.version }), 'release');
    const res = await service.sweep();
    expect(res.closed).toBeGreaterThanOrEqual(1);
    expect((await tasksFor(`keydate:allotment_release:${a.id}:`))[0]!.status).toBe('done');
  });

  it('balances due open one task per edition and date, and close it when none is left to collect', async () => {
    const w = await buildWorld(admin);
    const date = addDays(today(), 1);
    const versionId = (await t.prisma.priceVersion.findFirst({ where: { packageId: w.pkg.id } }))!.id;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { bookingId } = await makeBookingFor(t, { pkg: w.pkg, edition: w.edition, versionId });
      ids.push(bookingId);
      await advance(bookingId, 'deposit_paid', date);
    }
    await service.sweep();
    const tasks = await tasksFor(`keydate:balance_due:${w.edition.id}:`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'open', entityType: 'RaceEdition', entityId: w.edition.id });
    expect(tasks[0]!.title).toMatch(/^2 balances are due for /);
    expect(JSON.stringify(tasks[0])).not.toMatch(/MT-[0-9A-Z]{6}/);
    for (const next of ['confirmed', 'balance_paid']) await t.prisma.$executeRawUnsafe(`UPDATE bookings SET version = version + 1, status = '${next}'::"BookingStatus" WHERE id IN ('${ids.join("','")}')`);
    await service.sweep();
    expect((await tasksFor(`keydate:balance_due:${w.edition.id}:`))[0]!.status).toBe('done');
  });
});
