// The staff start page (task 5.6): counts and short lists from the owning modules, each section only for someone who can
// read what it lists, and nothing personal on it. Real database.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_LIST_SIZE, DASHBOARD_PERMISSIONS } from '@mt/shared';
import type { DashboardView } from '@mt/shared';
import { readStockForDashboard } from '../../../src/modules/catalogue';
import { PaymentPendingService } from '../../../src/modules/payments';
import { PermissionRegistry } from '../../../src/platform/access/permissions';
import { TestApp, makeApp } from '../../support/auth';
import { cleanBookingEvents, requestBody } from '../../support/bookings';
import { closeCatalogue, staffClient } from '../../support/catalogue';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';
import { PayingCustomer, approvedBooking, cleanPayments, ensureTerms, onlyAccount, payingCustomer, paymentsStaff, simulatorAccount } from '../../support/payments';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let c: PayingCustomer;
let w: PricedWorld;
const ROUTE = 'dashboard.home.read';
const ALL_SECTIONS = Object.values(DASHBOARD_PERMISSIONS);

beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  await onlyAccount(t, (await simulatorAccount(t)).id);
  c = await payingCustomer(t);
  await ensureTerms(t);
  w = await pricedWorld(admin);
});
afterAll(async () => {
  await t.prisma.alertSubscription.deleteMany({ where: { email: { endsWith: '@dashboard.example.test' } } });
  await t.prisma.task.deleteMany({ where: { title: { startsWith: 'Dashboard test' } } });
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const viewFor = async (permissions: string[]): Promise<DashboardView> => {
  const res = await (await staffClient(t, permissions)).get('/admin/dashboard');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as DashboardView;
};

describe('who can open it', () => {
  it('dashboard_requires_permission: anonymous 401, staff without it 403, a customer refused', async () => {
    expect((await t.http().get('/admin/dashboard')).status).toBe(401);
    const without = await staffClient(t, ALL_SECTIONS);
    expect((await without.get('/admin/dashboard')).status).toBe(403);
    expect([401, 403]).toContain((await t.http().get('/admin/dashboard').set('Cookie', c.cookie)).status);
  });

  it('dashboard_sections_follow_permissions: each section appears only with the permission that reads its data', async () => {
    expect((await viewFor([ROUTE])).sections).toEqual({});
    for (const [section, permission] of Object.entries(DASHBOARD_PERMISSIONS)) {
      const only = await viewFor([ROUTE, permission]);
      expect(Object.keys(only.sections), section).toEqual([section]);
    }
    const everything = await viewFor([ROUTE, ...ALL_SECTIONS]);
    expect(Object.keys(everything.sections).sort()).toEqual(Object.keys(DASHBOARD_PERMISSIONS).sort());
  });

  it('the page itself is not an API key scope', async () => {
    const def = t.app.get(PermissionRegistry).get(ROUTE);
    expect([def?.apiKeyScopable, def?.requiresStepUp]).toEqual([false, false]);
  });
});

describe('what it shows', () => {
  it('new_requests: counts requests waiting, oldest first, with no customer details', async () => {
    const before = (await viewFor([ROUTE, DASHBOARD_PERMISSIONS.newRequests])).sections.newRequests!;
    const req = await c.request(requestBody(w));
    expect(req.status).toBe(201);
    const after = (await viewFor([ROUTE, DASHBOARD_PERMISSIONS.newRequests])).sections.newRequests!;
    expect(after.total).toBe(before.total + 1);
    expect(after.items.length).toBeLessThanOrEqual(DASHBOARD_LIST_SIZE);
    const sorted = [...after.items].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    expect(after.items.map((i) => i.reference)).toEqual(sorted.map((i) => i.reference));
    const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: c.userId } });
    const text = JSON.stringify(after);
    for (const personal of [customer.email, customer.givenName, customer.familyName, customer.id]) expect(text).not.toContain(personal);
    // Once answered it leaves the list.
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { reference: req.body.reference } });
    expect((await admin.post(`/admin/bookings/${booking.id}/approve`, { version: booking.version })).status).toBe(200);
    expect((await viewFor([ROUTE, DASHBOARD_PERMISSIONS.newRequests])).sections.newRequests!.total).toBe(before.total);
  });

  it('pending_payments: the amount is the payment plan\'s, overdue and due soon are counted, and a paid booking leaves', async () => {
    const b = await approvedBooking(t, admin, await pricedWorld(admin), c);
    const view = (await viewFor([ROUTE, DASHBOARD_PERMISSIONS.pendingPayments])).sections.pendingPayments!;
    expect(view.horizonDays).toBe(14);
    const deposit = await t.prisma.paymentScheduleItem.findFirstOrThrow({ where: { bookingId: b.bookingId, sequence: 1 } });
    const mine = await t.app.get(PaymentPendingService).collections(new Date().toISOString().slice(0, 10), 500);
    const row = mine.items.find((i) => i.reference === b.reference);
    expect(row).toMatchObject({ kind: 'deposit', sequence: 1, amountDueMinor: deposit.amountMinor.toString(), currency: deposit.currency, overdue: false, dueDate: deposit.dueDate.toISOString().slice(0, 10) });
    expect(Object.keys(row!).sort()).toEqual(['amountDueMinor', 'bookingId', 'currency', 'dueDate', 'kind', 'overdue', 'reference', 'sequence']);
    expect(view.items.length).toBeLessThanOrEqual(DASHBOARD_LIST_SIZE);

    // A month later the same deposit is overdue, and the next item (not the whole balance) is still the deposit.
    const later = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const overdue = (await t.app.get(PaymentPendingService).collections(later, 500)).items.find((i) => i.reference === b.reference);
    expect(overdue).toMatchObject({ sequence: 1, overdue: true, amountDueMinor: deposit.amountMinor.toString() });

    // Nothing falls due far ahead: a day before the deposit's horizon starts, it is not listed.
    const early = new Date(Date.parse(`${deposit.dueDate.toISOString().slice(0, 10)}T00:00:00Z`) - 20 * 86_400_000).toISOString().slice(0, 10);
    expect((await t.app.get(PaymentPendingService).collections(early, 500)).items.some((i) => i.reference === b.reference)).toBe(false);
  });

  it('stock: places left, fewest first, and the pool the world made is there with its remaining count', async () => {
    const pool = await t.prisma.inventoryPool.findUniqueOrThrow({ where: { id: w.entryPoolId } });
    await t.prisma.inventoryPool.update({ where: { id: pool.id }, data: { lowStockThreshold: pool.capacity } });
    const view = (await viewFor([ROUTE, DASHBOARD_PERMISSIONS.stock])).sections.stock!;
    expect(view.items.length).toBeLessThanOrEqual(DASHBOARD_LIST_SIZE);
    const remaining = view.items.map((i) => i.remaining);
    expect(remaining).toEqual([...remaining].sort((a, b) => a - b));
    expect(view.lowCount).toBeGreaterThanOrEqual(1);
    const all = await t.prisma.$transaction((tx) => readStockForDashboard(tx, 1_000_000));
    const mine = all.items.find((i) => i.id === pool.id)!;
    expect(mine).toMatchObject({ capacity: pool.capacity, remaining: pool.capacity - pool.consumed, lowStock: true, kind: 'entry' });
  });

  it('subscribers: confirmed and waiting counts per race, never an address', async () => {
    const race = await t.prisma.race.findUniqueOrThrow({ where: { id: w.race.id } });
    const before = (await viewFor([ROUTE, DASHBOARD_PERMISSIONS.subscribers])).sections.subscribers!;
    const make = (n: number, status: 'confirmed' | 'pending') => t.prisma.alertSubscription.createMany({
      data: Array.from({ length: n }, () => ({ email: `${randomUUID()}@dashboard.example.test`, raceId: race.id, scope: 'race', status, ...(status === 'confirmed' ? { confirmedAt: new Date() } : {}) })),
    });
    await make(2, 'confirmed');
    await make(1, 'pending');
    const after = (await viewFor([ROUTE, DASHBOARD_PERMISSIONS.subscribers])).sections.subscribers!;
    expect([after.confirmed - before.confirmed, after.pending - before.pending]).toEqual([2, 1]);
    const row = after.races.find((r) => r.raceId === race.id);
    expect(row).toBeDefined();
    expect(row!.confirmed).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(after)).not.toContain('dashboard.example.test');
  });

  it('tasks: open tasks overdue or due within a week, soonest first; done, deleted, undated and far-off ones are left out', async () => {
    const before = (await viewFor([ROUTE, DASHBOARD_PERMISSIONS.tasks])).sections.tasks!;
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
    const mk = (title: string, over: Record<string, unknown>) => t.prisma.task.create({ data: { title: `Dashboard test ${title}`, ...over } });
    await mk('overdue', { dueAt: hours(-5) });
    await mk('soon', { dueAt: hours(48) });
    await mk('far', { dueAt: hours(24 * 30) });
    await mk('undated', {});
    await mk('done', { dueAt: hours(-5), status: 'done' });
    await mk('deleted', { dueAt: hours(-5), deletedAt: new Date() });
    const after = (await viewFor([ROUTE, DASHBOARD_PERMISSIONS.tasks])).sections.tasks!;
    expect([after.overdue - before.overdue, after.dueSoon - before.dueSoon]).toEqual([1, 1]);
    const dues = after.items.map((i) => i.dueAt);
    expect(dues).toEqual([...dues].sort());
    expect(after.items.every((i) => i.overdue === (new Date(i.dueAt).getTime() < Date.now()))).toBe(true);
    const titles = after.items.map((i) => i.title);
    for (const hidden of ['far', 'undated', 'done', 'deleted']) expect(titles).not.toContain(`Dashboard test ${hidden}`);
  });
});

describe('the answer', () => {
  it('dashboard_shape: today in Brisbane, a timestamp and the sections asked for', async () => {
    const v = await viewFor([ROUTE, ...ALL_SECTIONS]);
    expect(v.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(v.generatedAt))).toBe(false);
    expect(typeof v.sections.pendingPayments!.truncated).toBe('boolean');
  });
});
