// Task 6.2: the supplier payment schedule, its alert tasks and the cost review after a cancellation or a change (plan
// docs/plans/6.2-supplier-payments.md, sections 3, 7 and 15). Times are passed in, so Brisbane boundaries are exact.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaymentScheduleService } from '../../../src/modules/suppliers/payment-schedule.service';
import type { DeliveredEvent } from '../../../src/platform/events/consumers';
import { TestApp, makeApp } from '../../support/auth';
import { ALL_BOOKING_PERMISSIONS, customerClient, requestBody } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { ALL_PAYMENT_PERMISSIONS } from '../../support/payments';
import { pricedWorld } from '../../support/pricing';
import { ALL, adminWith, buildWorld, must, setSuppliersFlag, supplierBody } from '../../support/suppliers';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Staff = Awaited<ReturnType<typeof adminWith>>;
let t: TestApp;
let admin: Staff;
let schedule: PaymentScheduleService;
let world: Awaited<ReturnType<typeof buildWorld>>;
beforeAll(async () => {
  t = await makeApp();
  await setSuppliersFlag(t, true);
  admin = await adminWith(t, [...ALL, ...ALL_BOOKING_PERMISSIONS, ...ALL_PAYMENT_PERMISSIONS]);
  schedule = t.app.get(PaymentScheduleService);
  world = await buildWorld(admin);
});
afterAll(async () => {
  await setSuppliersFlag(t, true);
  await closeCatalogue(t);
});

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date());
const daysFrom = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Noon in Brisbane on a calendar date. */
const at = (date: string) => new Date(`${date}T02:00:00.000Z`);

async function newSupplier(currency = 'DKK') {
  return must(await admin.post('/admin/suppliers', supplierBody({ name: `Lodge ${randomUUID().slice(0, 6)}`, defaultCurrency: currency })), 'supplier').body as { id: string };
}
async function newCost(supplierId: string, over: Record<string, unknown> = {}) {
  return must(await admin.post(`/admin/suppliers/${supplierId}/costs`, { description: 'Rooms for the Secretname party', basis: 'fixed', quantity: 1, unitAmountMinor: '50000', currency: 'DKK', packageId: world.pkg.id, ...over }), 'cost').body as { id: string; version: number };
}
const pay = (supplierId: string, costs: Array<{ id: string; version: number }>) =>
  admin.post(`/admin/suppliers/${supplierId}/payments`, { items: costs.map((c) => ({ costItemId: c.id, version: c.version })), paidOn: today(), reference: 'INV-1' }).set('Idempotency-Key', `k-${randomUUID()}`);
const tasksOf = (entityId: string) => t.prisma.task.findMany({ where: { entityId, source: 'system' }, orderBy: { createdAt: 'asc' } });

describe('the schedule (section 3)', () => {
  it('schedule_buckets_through_the_api_and_service: overdue and undated always listed, totals per bucket and currency', async () => {
    const s = await newSupplier();
    const D = '2031-03-10';
    const due = await newCost(s.id, { dueDate: D });
    const undated = await newCost(s.id, { dueDate: null });
    const eur = await newCost(s.id, { dueDate: D, currency: 'EUR', unitAmountMinor: '700' });
    const rows: Array<[string, string]> = [['2031-03-01T13:59:59.999Z', 'later'], ['2031-03-02T14:00:00.000Z', 'upcoming'], ['2031-03-10T13:59:59.999Z', 'due_today'], ['2031-03-10T14:00:00.000Z', 'overdue']];
    for (const [now, bucket] of rows) {
      const r = await schedule.schedule({ supplierId: s.id }, new Date(now));
      const byId = new Map(r.items.map((i) => [i.costItemId, i.bucket]));
      expect([now, byId.get(due.id), byId.get(eur.id), byId.get(undated.id)]).toEqual([now, bucket, bucket, 'undated']);
      // schedule_totals_per_currency_never_mixed
      expect(r.totals.filter((x) => x.bucket === bucket)).toEqual([{ bucket, currency: 'DKK', amountMinor: '50000' }, { bucket, currency: 'EUR', amountMinor: '700' }]);
    }
    // A window that ends before the due date leaves it out, unless it is overdue.
    expect((await schedule.schedule({ supplierId: s.id, from: '2031-01-01', to: '2031-01-31' }, new Date('2031-01-05T00:00:00Z'))).items.map((i) => i.costItemId)).toEqual([undated.id]);
    expect((await schedule.schedule({ supplierId: s.id, from: '2031-01-01', to: '2031-01-31' }, new Date('2031-04-05T00:00:00Z'))).items.map((i) => i.costItemId).sort()).toEqual([due.id, eur.id, undated.id].sort());
    const api = must(await admin.get(`/admin/suppliers/payments/schedule?supplierId=${s.id}&currency=EUR&from=2031-01-01&to=2031-12-31`), 'api').body;
    expect(api.items.map((i: { costItemId: string }) => i.costItemId)).toEqual([eur.id]);
    expect((await admin.get('/admin/suppliers/payments/schedule?from=2031-02-01&to=2031-01-01')).body.code).toBe('range_invalid');
  });

  it('schedule_excludes_paid_and_cancelled', async () => {
    const s = await newSupplier();
    const paid = await newCost(s.id, { dueDate: today() });
    const gone = await newCost(s.id, { dueDate: today() });
    const owed = await newCost(s.id, { dueDate: today() });
    must(await pay(s.id, [paid]), 'pay');
    must(await admin.post(`/admin/suppliers/costs/${gone.id}/status`, { status: 'cancelled', version: gone.version }), 'cancel');
    expect((await schedule.schedule({ supplierId: s.id })).items.map((i) => i.costItemId)).toEqual([owed.id]);
  });

  it('schedule_shows_release_dates_at_stake: held places with their own totals; released ones are gone; passed ones flagged', async () => {
    const s = await newSupplier();
    const contract = must(await admin.post(`/admin/suppliers/${s.id}/contracts`, { reference: `C-${randomUUID().slice(0, 6)}`, editionId: world.edition.id }), 'contract').body;
    const add = async (releaseDate: string, quantity: number) => must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: world.roomPoolId, quantity, releaseDate, unitCostMinor: '12500', currency: 'DKK' }), 'allotment').body;
    const soon = await add(daysFrom(today(), 20), 4);
    const passed = await add(daysFrom(today(), -3), 2);
    const released = await add(daysFrom(today(), 25), 1);
    must(await admin.post(`/admin/suppliers/allotments/${released.id}/release`, { version: released.version }), 'release');
    const r = await schedule.schedule({ supplierId: s.id });
    expect(r.releases.map((x) => [x.allotmentId, x.passed, x.quantity, x.atStakeMinor])).toEqual([[passed.id, true, 2, '25000'], [soon.id, false, 4, '50000']]);
    expect(r.releaseTotals).toEqual([{ currency: 'DKK', atStakeMinor: '75000' }]);
    // At-stake amounts never add into what is owed.
    expect(r.totals).toEqual([]);
  });

  it('instalments_created_atomically: 2 to 12 fixed costs, dates going up, a bad row rejects all', async () => {
    const s = await newSupplier();
    const contract = must(await admin.post(`/admin/suppliers/${s.id}/contracts`, { reference: `C-${randomUUID().slice(0, 6)}`, editionId: world.edition.id }), 'contract').body;
    const base = { contractId: contract.id, packageId: world.pkg.id, currency: 'DKK' };
    const two = [{ description: 'Deposit', unitAmountMinor: '30000', dueDate: '2031-01-10' }, { description: 'Balance', unitAmountMinor: '70000', dueDate: '2031-05-10' }];
    expect((await admin.post(`/admin/suppliers/${s.id}/costs/instalments`, { ...base, instalments: [two[1], two[0]] })).body.code).toBe('instalment_dates_not_increasing');
    expect((await admin.post(`/admin/suppliers/${s.id}/costs/instalments`, { ...base, instalments: [two[0]] })).status).toBe(422);
    expect((await admin.post(`/admin/suppliers/${s.id}/costs/instalments`, { ...base, instalments: [two[0], { ...two[1], unitAmountMinor: '0' }] })).status).toBe(422);
    expect((await admin.post(`/admin/suppliers/${s.id}/costs/instalments`, { ...base, contractId: randomUUID(), instalments: two })).status).toBe(404);
    expect(await t.prisma.costItem.count({ where: { supplierId: s.id } })).toBe(0);
    const made = must(await admin.post(`/admin/suppliers/${s.id}/costs/instalments`, { ...base, instalments: two }), 'instalments').body;
    expect(made.items.map((i: { basis: string; quantity: number; amountMinor: string; dueDate: string }) => [i.basis, i.quantity, i.amountMinor, i.dueDate])).toEqual([['fixed', 1, '30000', '2031-01-10'], ['fixed', 1, '70000', '2031-05-10']]);
  });
});

describe('alert tasks (section 7)', () => {
  it('supplier_payment_alerts_open_once_and_close_when_paid: upcoming, overdue, paid, voided, re-dated, a person closing it', async () => {
    const s = await newSupplier();
    const D = daysFrom(today(), 30);
    const c = await newCost(s.id, { dueDate: D });
    await schedule.sweep(at(daysFrom(D, -8)));
    expect(await tasksOf(c.id)).toEqual([]);
    await Promise.all([schedule.sweep(at(daysFrom(D, -7))), schedule.sweep(at(daysFrom(D, -7)))]);
    let tasks = await tasksOf(c.id);
    expect(tasks.map((x) => [x.sourceRef, x.status])).toEqual([[`suppliers:payment_upcoming:${c.id}:g0:${D}`, 'open']]);
    expect(tasks[0]!.dueAt!.toISOString()).toBe(`${D}T13:59:59.999Z`);
    await schedule.sweep(at(daysFrom(D, 1)));
    tasks = await tasksOf(c.id);
    expect(tasks.map((x) => [x.sourceRef, x.status])).toEqual([[`suppliers:payment_upcoming:${c.id}:g0:${D}`, 'done'], [`suppliers:payment_overdue:${c.id}:g0:${D}`, 'open']]);
    // alert_tasks_carry_no_amounts_or_personal_data
    for (const x of tasks) expect(`${x.title} ${x.description ?? ''}`).not.toMatch(/Secretname|50000|500\.00/);
    // Paying closes it in the same transaction.
    const fresh = await t.prisma.costItem.findUniqueOrThrow({ where: { id: c.id } });
    const p = must(await pay(s.id, [{ id: c.id, version: fresh.version }]), 'pay').body;
    expect((await tasksOf(c.id)).every((x) => x.status === 'done')).toBe(true);
    // A void makes it owed again: a new generation of references, so a new task.
    must(await admin.post(`/admin/suppliers/payments/${p.id}/void`, { version: p.version, reason: 'Mistake' }).set('Idempotency-Key', `k-${randomUUID()}`), 'void');
    await schedule.sweep(at(daysFrom(D, 2)));
    const g1 = (await tasksOf(c.id)).find((x) => x.sourceRef === `suppliers:payment_overdue:${c.id}:g1:${D}`)!;
    expect(g1.status).toBe('open');
    // A person closes it: never opened again.
    await t.prisma.task.update({ where: { id: g1.id }, data: { status: 'done' } });
    await schedule.sweep(at(daysFrom(D, 3)));
    expect((await tasksOf(c.id)).filter((x) => x.status === 'open')).toEqual([]);
    // Re-dated into the future: the upcoming one for the new date opens.
    const now = await t.prisma.costItem.findUniqueOrThrow({ where: { id: c.id } });
    const E = daysFrom(D, 10);
    must(await admin.patch(`/admin/suppliers/costs/${c.id}`, { dueDate: E, version: now.version }), 'redate');
    await schedule.sweep(at(daysFrom(D, 4)));
    expect((await tasksOf(c.id)).filter((x) => x.status === 'open').map((x) => x.sourceRef)).toEqual([`suppliers:payment_upcoming:${c.id}:g1:${E}`]);
    // Called off: the open task closes.
    const v = await t.prisma.costItem.findUniqueOrThrow({ where: { id: c.id } });
    must(await admin.post(`/admin/suppliers/costs/${c.id}/status`, { status: 'cancelled', version: v.version }), 'cancel');
    await schedule.sweep(at(daysFrom(D, 4)));
    expect((await tasksOf(c.id)).filter((x) => x.status === 'open')).toEqual([]);
  });

  it('overdue has no age limit (plan review, point 8); the flag off opens nothing', async () => {
    const s = await newSupplier();
    const old = await newCost(s.id, { dueDate: daysFrom(today(), -400) });
    await setSuppliersFlag(t, false);
    try {
      expect(await schedule.sweep()).toEqual({ opened: 0, closed: 0 });
    } finally {
      await setSuppliersFlag(t, true);
    }
    expect(await tasksOf(old.id)).toEqual([]);
    await schedule.sweep();
    expect((await tasksOf(old.id)).map((x) => [x.sourceRef?.split(':')[1], x.status])).toEqual([['payment_overdue', 'open']]);
  });

  it('release_passed_task_once_per_allotment, closed when the places are released', async () => {
    const s = await newSupplier();
    const contract = must(await admin.post(`/admin/suppliers/${s.id}/contracts`, { reference: `C-${randomUUID().slice(0, 6)}`, editionId: world.edition.id }), 'contract').body;
    const a = must(await admin.post(`/admin/suppliers/contracts/${contract.id}/allotments`, { poolId: world.roomPoolId, quantity: 3, releaseDate: daysFrom(today(), -1), unitCostMinor: '9000', currency: 'DKK' }), 'allotment').body;
    await schedule.sweep();
    await schedule.sweep();
    const open = await tasksOf(a.id);
    expect(open.map((x) => [x.sourceRef, x.status, x.entityType])).toEqual([[`suppliers:release_passed:${a.id}:${daysFrom(today(), -1)}`, 'open', 'Allotment']]);
    expect(open[0]!.title).not.toMatch(/9000|27000/);
    must(await admin.post(`/admin/suppliers/allotments/${a.id}/release`, { version: a.version }), 'release');
    await schedule.sweep();
    expect((await tasksOf(a.id)).map((x) => x.status)).toEqual(['done']);
  });
});

describe('cancellation and amendment effects (section 3.4)', () => {
  it('booking_cancellation_opens_supplier_review_task: only when something is at stake, one per trip while open, amendments too', async () => {
    const w = await pricedWorld(admin);
    const c = await customerClient(t);
    const res = await c.request(requestBody(w));
    expect(res.status).toBe(201);
    const booking = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference } });
    const event = (type: string): DeliveredEvent => ({ id: randomUUID(), type, schemaVersion: 1, aggregateType: 'Booking', aggregateId: booking.id, aggregateVersion: 1, payload: { bookingId: booking.id, packageId: w.pkg.id }, actorType: 'staff', actorId: null, occurredAt: new Date() });
    const run = (type: string) => t.prisma.$transaction((tx) => schedule.onBookingChanged(event(type), tx));
    await run('bookings.booking.cancelled');
    expect(await tasksOf(w.pkg.id)).toEqual([]);
    const s = await newSupplier();
    await newCost(s.id, { packageId: w.pkg.id, dueDate: daysFrom(today(), 40) });
    await run('bookings.booking.cancelled');
    await run('bookings.booking.amended');
    const tasks = await tasksOf(w.pkg.id);
    expect(tasks.map((x) => [x.sourceRef, x.status, x.entityType])).toEqual([[`suppliers:cost_review:${w.pkg.id}`, 'open', 'Package']]);
    expect(`${tasks[0]!.title} ${tasks[0]!.description}`).toContain(booking.reference);
    expect(`${tasks[0]!.title} ${tasks[0]!.description}`).not.toMatch(/Secretname|50000|@/);
    // The consumer is registered for both events and holds them while the module is off.
    const { ConsumerRegistry } = await import('../../../src/platform/events/consumers');
    const reg = t.app.get(ConsumerRegistry);
    for (const type of ['bookings.booking.cancelled', 'bookings.booking.amended']) expect(reg.forEvent(type).find((d) => d.name === 'suppliers.cost_review')?.whenDisabled).toBe('hold');
  });
});
