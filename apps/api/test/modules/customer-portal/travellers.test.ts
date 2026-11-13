// Traveller details (task 5.2, plan docs/plans/5.2-traveller-details.md, section 6): who can read and change them,
// when, what is stored, and what erasure does. The customer is the booking's own; the deadline is the API's.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BookingStatus } from '@mt/shared';
import { TRAVELLER_ENTITIES } from '../../../src/modules/customer-portal';
import { TravellerDetailsService } from '../../../src/modules/customer-portal/traveller.service';
import { todayInBrisbane } from '../../../src/modules/bookings';
import { STATE_HEADERS, TestApp, makeApp } from '../../support/auth';
import { cleanBookingEvents, customerClient } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { customerBookingIn, walkTo } from '../../support/customer-portal';
import { cleanPayments, paymentsStaff } from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

type Who = { cookie: string; userId: string };
const path = (ref: string, slot?: number | string) => `/account/bookings/${ref}/travellers${slot === undefined ? '' : `/${slot}`}`;
const get = (ref: string, who: Who) => t.http().get(path(ref)).set('Cookie', who.cookie);
const put = (ref: string, slot: number | string, who: Who, body: object) => t.http().put(path(ref, slot)).set(STATE_HEADERS).set('Cookie', who.cookie).send(body);
const del = (ref: string, slot: number | string, who: Who) => t.http().delete(path(ref, slot)).set(STATE_HEADERS).set('Cookie', who.cookie).send();

const runner = { givenName: 'Ana', familyName: 'García-López', dateOfBirth: '1988-03-14', emergencyContactName: "Sean O'Neil", emergencyContactPhone: '+61 400 123 456', estimatedFinishSeconds: 14_400 };
const supporter = { givenName: 'Luis', familyName: 'Pérez' };

/** The day `n` days from today in Brisbane, as the API sees it. */
const dayFrom = (n: number): string => {
  const d = new Date(`${todayInBrisbane(new Date())}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const asDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** A booking of `who` in `status`, with its edition set to start on `startDate` and a key date when given. */
async function bookingWith(who: Who, status: BookingStatus, opts: { startDate?: string | null; keyDate?: string | null } = {}) {
  const b = await customerBookingIn(t, who, status);
  const { editionId } = await t.prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId }, select: { editionId: true } });
  await t.prisma.raceEdition.update({ where: { id: editionId }, data: opts.startDate === null ? { startDate: null, endDate: null, dateStatus: 'provisional' } : { startDate: asDate(opts.startDate ?? dayFrom(120)) } });
  if (opts.keyDate) await t.prisma.keyDate.create({ data: { editionId, kind: 'entry_submission', dueDate: asDate(opts.keyDate) } });
  return { ...b, editionId };
}
const setCutoff = (days: number | null) => days === null
  ? t.prisma.setting.deleteMany({ where: { key: 'travellerDetailsCutoffDays' } })
  : t.prisma.setting.upsert({ where: { key: 'travellerDetailsCutoffDays' }, create: { key: 'travellerDetailsCutoffDays', value: days }, update: { value: days } });

describe('who can read and change traveller details', () => {
  it('cross_customer_matrix: another customer gets 404 on read, save and clear, and nothing changes', async () => {
    const a = await customerClient(t);
    const b = await customerClient(t);
    const { reference } = await bookingWith(a, 'deposit_paid');
    expect((await put(reference, 1, a, runner)).status).toBe(200);
    const probes = [
      ['read', () => get(reference, b)],
      ['save', () => put(reference, 1, b, { givenName: 'Mallory', familyName: 'Intruder' })],
      ['clear', () => del(reference, 1, b)],
      ['unknown reference', () => get('MT-AAAAAA', a)],
    ] as const;
    for (const [label, probe] of probes) {
      const res = await probe();
      expect([label, res.status, res.body.code]).toEqual([label, 404, 'not_found']);
      expect(JSON.stringify(res.body)).not.toMatch(/Ana|Mallory|García/);
    }
    const mine = await get(reference, a);
    expect(mine.body.travellers[0].details).toEqual({ ...runner });
  });

  it('signed out is 401, a staff session is refused, and a closed customer reads and writes nothing', async () => {
    const a = await customerClient(t);
    const { reference } = await bookingWith(a, 'deposit_paid');
    await put(reference, 1, a, runner);
    expect((await t.http().get(path(reference))).status).toBe(401);
    expect((await t.http().put(path(reference, 1)).set(STATE_HEADERS).send(runner)).status).toBe(401);
    for (const res of [await admin.get(path(reference)), await admin.put(path(reference, 1), runner), await admin.delete(path(reference, 1))]) {
      expect([401, 403]).toContain(res.status);
    }
    await t.prisma.customer.updateMany({ where: { userId: a.userId }, data: { deletedAt: new Date() } });
    for (const res of [await get(reference, a), await put(reference, 1, a, runner), await del(reference, 1, a)]) expect(res.status).toBe(404);
  });

  it.each(['0', '81', '-1', '1.5', 'abc', '99999'])('place %s is not found', async (slot) => {
    const a = await customerClient(t);
    const { reference } = await bookingWith(a, 'deposit_paid');
    expect([(await put(reference, slot, a, supporter)).status, (await del(reference, slot, a)).status]).toEqual([404, 404]);
  });

  it('a place the booking does not have is not found, and a place that was removed is left out', async () => {
    const a = await customerClient(t);
    const { reference, bookingId } = await bookingWith(a, 'deposit_paid');
    expect((await put(reference, 3, a, supporter)).status).toBe(404);
    await t.prisma.$executeRawUnsafe(`UPDATE booking_travellers SET "removedInVersion" = 2 WHERE "bookingId" = $1::uuid AND slot = 2`, bookingId);
    expect((await get(reference, a)).body.travellers.map((x: { slot: number }) => x.slot)).toEqual([1]);
    expect((await put(reference, 2, a, supporter)).status).toBe(404);
  });
});

describe('saving, reading and clearing', () => {
  it('round trip: nothing saved, save a runner and a supporter, read back, overwrite, clear', async () => {
    const a = await customerClient(t);
    const { reference } = await bookingWith(a, 'deposit_paid');
    const before = await get(reference, a);
    expect(before.status).toBe(200);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(before.body.travellers).toEqual([
      { slot: 1, participationType: 'runner_with_entry', isLead: true, runner: true, details: null, complete: false },
      { slot: 2, participationType: 'supporter', isLead: false, runner: false, details: null, complete: false },
    ]);

    const saved = await put(reference, 1, a, runner);
    expect(saved.status).toBe(200);
    expect(saved.body.travellers[0]).toEqual({ slot: 1, participationType: 'runner_with_entry', isLead: true, runner: true, details: runner, complete: true });
    expect((await put(reference, 2, a, supporter)).body.travellers[1].details).toEqual({ ...supporter, dateOfBirth: null, emergencyContactName: null, emergencyContactPhone: null, estimatedFinishSeconds: null });
    expect((await get(reference, a)).body.travellers.map((x: { complete: boolean }) => x.complete)).toEqual([true, true]);

    // A save replaces the record: a key left out is cleared.
    const again = await put(reference, 1, a, { givenName: 'Ana', familyName: 'García-López' });
    expect(again.body.travellers[0].details).toEqual({ givenName: 'Ana', familyName: 'García-López', dateOfBirth: null, emergencyContactName: null, emergencyContactPhone: null, estimatedFinishSeconds: null });
    expect(again.body.travellers[0].complete).toBe(false); // a runner needs a date of birth
    expect(await t.prisma.traveller.count({ where: { booking: { reference } } })).toBe(2);

    const cleared = await del(reference, 1, a);
    expect(cleared.status).toBe(200);
    expect(cleared.body.travellers[0].details).toBeNull();
    expect((await del(reference, 1, a)).status).toBe(200); // idempotent
    expect(await t.prisma.traveller.count({ where: { booking: { reference } } })).toBe(1);
  });

  it('the view carries no ids and exactly the documented keys', async () => {
    const a = await customerClient(t);
    const { reference } = await bookingWith(a, 'deposit_paid');
    const res = await put(reference, 1, a, runner);
    expect(Object.keys(res.body).sort()).toEqual(['editable', 'editableUntil', 'reason', 'travellers']);
    expect(Object.keys(res.body.travellers[0]).sort()).toEqual(['complete', 'details', 'isLead', 'participationType', 'runner', 'slot']);
    expect(Object.keys(res.body.travellers[0].details).sort()).toEqual(['dateOfBirth', 'emergencyContactName', 'emergencyContactPhone', 'estimatedFinishSeconds', 'familyName', 'givenName']);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('concurrent saves of one place end with one row holding one of the saved records', async () => {
    const a = await customerClient(t);
    const { reference } = await bookingWith(a, 'deposit_paid');
    const names = ['Ana', 'Bea', 'Cleo', 'Dana', 'Eve'];
    const results = await Promise.all(names.map((n) => put(reference, 1, a, { givenName: n, familyName: 'Same' })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const rows = await t.prisma.traveller.findMany({ where: { booking: { reference } } });
    expect(rows).toHaveLength(1);
    expect(names).toContain(rows[0]!.givenName);
  });
});

describe('what is refused', () => {
  const ok = { givenName: 'Ana', familyName: 'Ruiz' };
  it.each([
    ['passport number', { passportNumber: 'X1234567' }], ['passport', { passport: 'X1234567' }], ['nationality', { nationality: 'ES' }], ['gender', { gender: 'f' }],
    ['email', { email: 'a@example.com' }], ['medical conditions', { medicalConditions: 'asthma' }], ['allergies', { allergies: 'nuts' }], ['dietary needs', { dietaryNeeds: 'vegan' }],
    ['notes', { notes: 'hello' }], ['a place or customer id', { slot: 2, customerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }],
    ['digits in a name', { familyName: 'Ruiz2' }], ['a note typed as a name', { givenName: 'Ana; allergic to penicillin 500mg' }], ['empty name', { givenName: '' }],
    ['impossible date', { dateOfBirth: '1990-02-30' }], ['date before 1900', { dateOfBirth: '1899-01-01' }], ['finish time too short', { estimatedFinishSeconds: 599 }],
    ['finish time too long', { estimatedFinishSeconds: 259_201 }], ['finish time as text', { estimatedFinishSeconds: '14400' }],
    ['emergency phone alone', { emergencyContactPhone: '0400123456' }], ['emergency name alone', { emergencyContactName: 'Bo' }],
    ['short phone', { emergencyContactName: 'Bo', emergencyContactPhone: '12345' }],
  ])('422 for %s, and nothing is written', async (_label, extra) => {
    const a = await customerClient(t);
    const { reference } = await bookingWith(a, 'deposit_paid');
    const res = await put(reference, 1, a, { ...ok, ...extra });
    expect(res.status).toBe(422);
    expect(await t.prisma.traveller.count({ where: { booking: { reference } } })).toBe(0);
  });

  it('a date of birth in the future is refused, and a runner-only field on a supporter is refused', async () => {
    const a = await customerClient(t);
    const { reference } = await bookingWith(a, 'deposit_paid');
    expect((await put(reference, 1, a, { ...runner, dateOfBirth: dayFrom(1) })).body.code).toBe('invalid_date_of_birth');
    expect((await put(reference, 1, a, { ...runner, dateOfBirth: dayFrom(0) })).status).toBe(200);
    expect((await put(reference, 2, a, { ...supporter, dateOfBirth: '1990-01-01' })).body.code).toBe('not_asked_for_supporters');
    expect((await put(reference, 2, a, { ...supporter, estimatedFinishSeconds: 14_400 })).body.code).toBe('not_asked_for_supporters');
    expect(await t.prisma.traveller.count({ where: { booking: { reference }, slot: 2 } })).toBe(0);
  });
});

describe('the edit window is decided by the API', () => {
  it('follows the booking through its statuses: closed until the deposit, open to the full payment, closed when completed', async () => {
    const a = await customerClient(t);
    const b = await bookingWith(a, 'requested');
    const expectState = async (editable: boolean, reason: string | null, status: number) => {
      const view = (await get(b.reference, a)).body;
      expect([view.editable, view.reason]).toEqual([editable, reason]);
      expect((await put(b.reference, 1, a, runner)).status).toBe(status);
    };
    await expectState(false, 'booking_status', 409);
    await walkTo(t, b.bookingId, 'approved');
    await expectState(false, 'booking_status', 409);
    await walkTo(t, b.bookingId, 'deposit_paid', 'approved');
    await expectState(true, null, 200);
    await walkTo(t, b.bookingId, 'confirmed', 'deposit_paid');
    await expectState(true, null, 200);
    await walkTo(t, b.bookingId, 'balance_paid', 'confirmed');
    await expectState(true, null, 200);
  });

  it.each(['cancelled', 'declined', 'expired'] as const)('a %s booking cannot be changed', async (status) => {
    const a = await customerClient(t);
    const b = await bookingWith(a, status);
    const res = await put(b.reference, 1, a, runner);
    expect([res.status, res.body.code]).toEqual([409, 'travellers_not_editable']);
    expect((await del(b.reference, 1, a)).status).toBe(409);
    expect(await t.prisma.traveller.count({ where: { bookingId: b.bookingId } })).toBe(0);
  });

  it('a completed trip keeps its details, readable but not changeable', async () => {
    const a = await customerClient(t);
    const b = await bookingWith(a, 'deposit_paid');
    expect((await put(b.reference, 1, a, runner)).status).toBe(200);
    await walkTo(t, b.bookingId, 'confirmed', 'deposit_paid');
    await t.prisma.$executeRawUnsafe(`UPDATE bookings SET status = 'completed', version = version + 1 WHERE id = $1::uuid`, b.bookingId);
    const res = await put(b.reference, 1, a, { ...runner, givenName: 'Changed' });
    expect([res.status, res.body.code]).toEqual([409, 'travellers_not_editable']);
    expect((await del(b.reference, 1, a)).status).toBe(409);
    const view = (await get(b.reference, a)).body;
    expect([view.editable, view.reason, view.travellers[0].details.givenName]).toEqual([false, 'booking_status', 'Ana']);
  });

  it('deadline_enforced_server_side: the key date wins, its own day is open, the next day is closed, and nothing is written after', async () => {
    const a = await customerClient(t);
    const open = await bookingWith(a, 'deposit_paid', { keyDate: dayFrom(0), startDate: dayFrom(200) });
    const lastDay = await get(open.reference, a);
    expect([lastDay.body.editable, lastDay.body.editableUntil]).toEqual([true, dayFrom(0)]);
    expect((await put(open.reference, 1, a, runner)).status).toBe(200);

    const closed = await bookingWith(a, 'deposit_paid', { keyDate: dayFrom(-1), startDate: dayFrom(200) });
    expect((await put(closed.reference, 1, a, runner)).status).toBe(409); // not saved though the race is far off: the key date wins
    const view = await get(closed.reference, a);
    expect([view.body.editable, view.body.reason, view.body.editableUntil]).toEqual([false, 'deadline_passed', dayFrom(-1)]);
    expect(await t.prisma.traveller.count({ where: { bookingId: closed.bookingId } })).toBe(0);
    const res = await put(closed.reference, 1, a, runner);
    expect([res.status, res.body.code]).toEqual([409, 'travellers_not_editable']);
    expect((await del(closed.reference, 1, a)).status).toBe(409);
  });

  it('after the deadline a saved record is kept as it was, and moving the key date reopens it', async () => {
    const a = await customerClient(t);
    const b = await bookingWith(a, 'deposit_paid', { keyDate: dayFrom(0) });
    expect((await put(b.reference, 1, a, runner)).status).toBe(200);
    await t.prisma.keyDate.updateMany({ where: { editionId: b.editionId }, data: { dueDate: asDate(dayFrom(-1)) } });
    expect((await put(b.reference, 1, a, { givenName: 'Late', familyName: 'Change' })).status).toBe(409);
    expect((await del(b.reference, 1, a)).status).toBe(409);
    expect((await get(b.reference, a)).body.travellers[0].details).toEqual(runner);
    await t.prisma.keyDate.updateMany({ where: { editionId: b.editionId }, data: { dueDate: asDate(dayFrom(3)) } });
    expect((await put(b.reference, 1, a, { givenName: 'Ana', familyName: 'Reopened' })).status).toBe(200);
  });

  it('without a key date the race start less the cutoff setting is the last day, and without either there is no deadline', async () => {
    const a = await customerClient(t);
    try {
      await setCutoff(null); // the default is 14 days
      const onTheLastDay = await bookingWith(a, 'deposit_paid', { startDate: dayFrom(14) });
      const v1 = (await get(onTheLastDay.reference, a)).body;
      expect([v1.editable, v1.editableUntil]).toEqual([true, dayFrom(0)]);
      const pastIt = await bookingWith(a, 'deposit_paid', { startDate: dayFrom(13) });
      const v2 = (await get(pastIt.reference, a)).body;
      expect([v2.editable, v2.reason, v2.editableUntil]).toEqual([false, 'deadline_passed', dayFrom(-1)]);
      expect((await put(pastIt.reference, 1, a, runner)).status).toBe(409);

      await setCutoff(30); // the setting moves the deadline
      const thirty = await bookingWith(a, 'deposit_paid', { startDate: dayFrom(31) });
      expect((await get(thirty.reference, a)).body.editableUntil).toBe(dayFrom(1));
      const tight = await bookingWith(a, 'deposit_paid', { startDate: dayFrom(20) });
      expect((await get(tight.reference, a)).body.editable).toBe(false);

      const undated = await bookingWith(a, 'deposit_paid', { startDate: null });
      const v3 = (await get(undated.reference, a)).body;
      expect([v3.editable, v3.reason, v3.editableUntil]).toEqual([true, null, null]);
      expect((await put(undated.reference, 1, a, runner)).status).toBe(200);
    } finally {
      await setCutoff(null);
    }
  });
});

describe('personal data handling', () => {
  it('audit keeps the values out of the log and in PII values tied to the customer', async () => {
    const a = await customerClient(t);
    const { reference, bookingId } = await bookingWith(a, 'deposit_paid');
    const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: a.userId }, select: { id: true } });
    expect((await put(reference, 1, a, runner)).status).toBe(200);
    expect((await put(reference, 1, a, { ...runner, givenName: 'Anita' })).status).toBe(200);
    expect((await del(reference, 1, a)).status).toBe(200);
    const row = await t.prisma.traveller.findMany({ where: { bookingId } });
    expect(row).toHaveLength(0);
    const logs = await t.prisma.auditLog.findMany({ where: { entityType: 'Traveller', actorId: a.userId }, orderBy: { occurredAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['customerPortal.traveller.saved', 'customerPortal.traveller.saved', 'customerPortal.traveller.cleared']);
    expect(logs.every((l) => l.actorType === 'customer')).toBe(true);
    const all = JSON.stringify(logs.map((l) => l.changes));
    for (const secret of ['Ana', 'García', '1988-03-14', "O'Neil", '400 123', '14400']) expect(all).not.toContain(secret);
    const pii = await t.prisma.auditPiiValue.findMany({ where: { auditLogId: { in: logs.map((l) => l.id) } } });
    expect(pii.length).toBeGreaterThan(5);
    expect(new Set(pii.map((p) => p.subjectCustomerId))).toEqual(new Set([customer.id]));
    expect(pii.some((p) => p.field === 'givenName' && p.after === 'Anita')).toBe(true);
  });

  it('erasure_handler_redacts_travellers: export has the details, anonymise overwrites every personal column', async () => {
    const a = await customerClient(t);
    const other = await customerClient(t);
    const mine = await bookingWith(a, 'deposit_paid');
    const theirs = await bookingWith(other, 'deposit_paid');
    await put(mine.reference, 1, a, runner);
    await put(mine.reference, 2, a, supporter);
    await put(theirs.reference, 1, other, runner);
    const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: a.userId }, select: { id: true } });
    const def = TRAVELLER_ENTITIES[0]!;
    expect(def.customerLink).toEqual({ kind: 'column', column: 'customerId' });

    const exported = await t.prisma.$transaction((tx) => def.handlers!.export(tx, customer.id)) as Array<{ givenName: string; slot: number }>;
    expect(exported.map((r) => [r.slot, r.givenName])).toEqual([[1, 'Ana'], [2, 'Luis']]);
    await t.prisma.$transaction((tx) => def.handlers!.anonymise(tx, customer.id));
    const rows = await t.prisma.traveller.findMany({ where: { bookingId: mine.bookingId }, orderBy: { slot: 'asc' } });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect([r.givenName, r.familyName, r.dateOfBirth, r.emergencyContactName, r.emergencyContactPhone, r.estimatedFinishSeconds]).toEqual(['[redacted]', '[redacted]', null, null, null, null]);
      expect(r.anonymisedAt).not.toBeNull();
    }
    expect((await t.prisma.traveller.findFirstOrThrow({ where: { bookingId: theirs.bookingId } })).givenName).toBe('Ana'); // only this customer's
    const erasedAt = rows.map((r) => r.anonymisedAt!.getTime());
    expect(await t.prisma.$transaction((tx) => def.handlers!.anonymise(tx, customer.id))).toBeUndefined(); // safe to run again...
    const again = await t.prisma.traveller.findMany({ where: { bookingId: mine.bookingId }, orderBy: { slot: 'asc' } });
    expect(again.map((r) => r.anonymisedAt!.getTime())).toEqual(erasedAt); // ...and it does not move the erasure time
  });

  it('no_form_asks_passport_or_medical: no column of the table can hold such data', async () => {
    const cols = await t.prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'travellers'`;
    expect(cols.map((c) => c.column_name).sort()).toEqual(['anonymisedAt', 'bookingId', 'createdAt', 'customerId', 'dateOfBirth', 'emergencyContactName', 'emergencyContactPhone', 'estimatedFinishSeconds', 'familyName', 'givenName', 'id', 'slot', 'updatedAt']);
    expect(cols.map((c) => c.column_name).join(' ')).not.toMatch(/passport|medical|health|allerg|dietary|disab|nationality|gender|licen[cs]e|visa|tax/i);
  });
});

describe('erasure racing a save', () => {
  it('a save that passed the guard before the erasure committed is a 404 and writes nothing', async () => {
    const svc = t.app.get(TravellerDetailsService);
    const a = await customerClient(t);
    const { reference, bookingId } = await bookingWith(a, 'deposit_paid');
    const actor = { type: 'customer' as const, id: a.userId, sessionId: null, requestId: 'test' };
    await svc.save(actor, reference, 2, supporter); // an existing row, to be erased
    const customer = await t.prisma.customer.findFirstOrThrow({ where: { userId: a.userId }, select: { id: true } });
    const def = TRAVELLER_ENTITIES[0]!;
    // The erasure commits after the route's guard let the request through and before the service writes.
    await t.prisma.$transaction(async (tx) => {
      await def.handlers!.anonymise(tx, customer.id);
      await tx.customer.update({ where: { id: customer.id }, data: { anonymisedAt: new Date() } });
    });
    await expect(svc.save(actor, reference, 1, runner)).rejects.toMatchObject({ status: 404 }); // would have created a row
    await expect(svc.save(actor, reference, 2, { givenName: 'Late', familyName: 'Write' })).rejects.toMatchObject({ status: 404 }); // would have hit the erased CHECK
    await expect(svc.clear(actor, reference, 2)).rejects.toMatchObject({ status: 404 });
    const rows = await t.prisma.traveller.findMany({ where: { bookingId }, orderBy: { slot: 'asc' } });
    expect(rows.map((r) => [r.slot, r.givenName])).toEqual([[2, '[redacted]']]);
  });
});

describe('the database itself', () => {
  it('traveller_of_other_customer_cannot_be_assigned: another customer, another booking or an unknown place is refused by the database', async () => {
    const a = await customerClient(t);
    const b = await customerClient(t);
    const mine = await bookingWith(a, 'deposit_paid');
    const theirs = await bookingWith(b, 'deposit_paid');
    const customerOf = async (who: Who) => (await t.prisma.customer.findFirstOrThrow({ where: { userId: who.userId }, select: { id: true } })).id;
    const [aId, bId] = [await customerOf(a), await customerOf(b)];
    const insert = (bookingId: string, customerId: string, slot: number) => t.prisma.$executeRawUnsafe(
      `INSERT INTO travellers (id, "bookingId", "customerId", slot, "givenName", "familyName", "updatedAt") VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'X', 'Y', now())`, bookingId, customerId, slot);
    await expect(insert(mine.bookingId, bId, 1)).rejects.toThrow(/travellers_bookingId_customerId_fkey/); // B's id on A's booking
    await expect(insert(theirs.bookingId, aId, 1)).rejects.toThrow(/travellers_bookingId_customerId_fkey/); // A's id on B's booking
    await expect(insert(mine.bookingId, aId, 9)).rejects.toThrow(/need a place of the booking/); // a place the booking does not have
    await expect(insert(mine.bookingId, aId, 1)).resolves.toBe(1);
    await expect(insert(mine.bookingId, aId, 1)).rejects.toThrow(/travellers_bookingId_slot_key/); // one row per place
  });

  it('a place of a booking cannot be rewritten, only marked removed', async () => {
    const a = await customerClient(t);
    const { bookingId } = await bookingWith(a, 'deposit_paid');
    const upd = (set: string) => t.prisma.$executeRawUnsafe(`UPDATE booking_travellers SET ${set} WHERE "bookingId" = $1::uuid AND slot = 2`, bookingId);
    for (const set of [`slot = 3`, `"participationType" = 'runner_own_entry'`, `"isLead" = true`, `"bookingId" = gen_random_uuid()`, `"addedInVersion" = 5`]) {
      await expect(upd(set), set).rejects.toThrow(/never changes/);
    }
    await expect(upd(`"removedInVersion" = 2`)).resolves.toBe(1);
  });

  it('bounds, erased rows and the place of a row are guarded by the database', async () => {
    const a = await customerClient(t);
    const { bookingId } = await bookingWith(a, 'deposit_paid');
    const customerId = (await t.prisma.customer.findFirstOrThrow({ where: { userId: a.userId }, select: { id: true } })).id;
    const row = await t.prisma.traveller.create({ data: { bookingId, customerId, slot: 1, givenName: 'Ana', familyName: 'Ruiz' } });
    const update = (set: string) => t.prisma.$executeRawUnsafe(`UPDATE travellers SET ${set} WHERE id = '${row.id}'::uuid`);
    const refused: Array<[string, RegExp]> = [
      [`"givenName" = '   '`, /travellers_names_check/], [`"familyName" = repeat('x', 101)`, /travellers_names_check/],
      [`"dateOfBirth" = DATE '1899-12-31'`, /travellers_birth_check/], [`"estimatedFinishSeconds" = 599`, /travellers_finish_check/], [`"estimatedFinishSeconds" = 259201`, /travellers_finish_check/],
      [`"emergencyContactName" = 'Bo'`, /travellers_emergency_check/], [`"emergencyContactName" = 'Bo', "emergencyContactPhone" = '123'`, /travellers_emergency_check/],
      [`"anonymisedAt" = now()`, /travellers_erased_check/], // marked erased while still holding a name
      [`slot = 2`, /place of a traveller never changes/], [`"bookingId" = gen_random_uuid()`, /place of a traveller never changes/], [`"customerId" = gen_random_uuid()`, /place of a traveller never changes/],
    ];
    for (const [set, message] of refused) await expect(update(set), set).rejects.toThrow(message);
    await expect(update(`"givenName" = '[redacted]', "familyName" = '[redacted]', "anonymisedAt" = now()`)).resolves.toBe(1);
  });
});
