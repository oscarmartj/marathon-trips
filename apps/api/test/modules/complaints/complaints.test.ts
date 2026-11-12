// The complaints register (task 7.6): logging, deadlines, the status flow, resolution, notes, erasure and access.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { COMPLAINT_TRANSITIONS } from '@mt/shared';
import { COMPLAINTS_PERMISSIONS as CP, ComplaintService } from '../../../src/modules/complaints';
import { ComplaintReferences } from '../../../src/modules/complaints/support';
import { todayInBrisbane } from '../../../src/modules/bookings';
import { PermissionRegistry, PERMISSIONS } from '../../../src/platform/access/permissions';
import { EntityRegistry } from '../../../src/platform/entities/entity-registry';
import { TestApp, makeApp, uniqueEmail } from '../../support/auth';
import { CATALOGUE_AND_PRICING, anonymous, closeCatalogue, staffClient } from '../../support/catalogue';
import { makeBookingFor, makeCustomer } from '../../support/bookings';
import { pricedWorld } from '../../support/pricing';
import type { PricedWorld } from '../../support/pricing';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof staffClient>>;
let w: PricedWorld;
let service: ComplaintService;
const realNow = ComplaintService.prototype.now;

beforeAll(async () => {
  t = await makeApp();
  admin = await staffClient(t, [...CATALOGUE_AND_PRICING, CP.read, CP.manage, 'common.table.use', PERMISSIONS.auditRead]);
  w = await pricedWorld(admin);
  service = t.app.get(ComplaintService);
});
afterEach(() => {
  service.now = realNow;
});
afterAll(async () => {
  await closeCatalogue(t);
});

const token = () => `tok${Math.random().toString(36).slice(2, 10)}`;
const body = (over: Record<string, unknown> = {}) => ({
  complainantName: 'Pat Complainant', complainantEmail: 'pat@example.com', channel: 'email', category: 'accommodation', summary: `Room not as described ${token()}`, description: 'The hotel room was smaller than the photos.', ...over,
});
const must = <T extends { status: number; body: unknown }>(r: T, what: string, status = 200): T => {
  if (r.status !== status) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
};
const log = async (over: Record<string, unknown> = {}) => must(await admin.post('/admin/complaints', body(over)), 'log a complaint', 201).body;
const move = (id: string, version: number, status: string, extra: Record<string, unknown> = {}) => admin.post(`/admin/complaints/${id}/status`, { status, version, ...extra });
const resolution = { outcome: 'upheld', resolutionSummary: 'We apologised and arranged a room change for the next trip.' };
const clockAt = (iso: string) => {
  service.now = () => new Date(iso);
};

describe('access', () => {
  it('anonymous callers are refused and every route names a permission', async () => {
    expect([401, 403]).toContain((await anonymous(t).get('/admin/complaints')).status);
    const readOnly = await staffClient(t, [CP.read]);
    expect((await readOnly.get('/admin/complaints')).status).toBe(200);
    expect((await readOnly.get('/admin/complaints/summary')).status).toBe(200);
    const c = await log();
    expect((await readOnly.get(`/admin/complaints/${c.id}`)).status).toBe(200);
    expect((await readOnly.post('/admin/complaints', body())).status).toBe(403);
    expect((await readOnly.patch(`/admin/complaints/${c.id}`, { summary: 'x', version: 0 })).status).toBe(403);
    expect((await move(c.id, 0, 'acknowledged')).status).toBe(200);
    expect((await readOnly.post(`/admin/complaints/${c.id}/status`, { status: 'investigating', version: 1 })).status).toBe(403);
    expect((await readOnly.get('/admin/complaints/owners')).status).toBe(403);
    const none = await staffClient(t, []);
    for (const path of ['/admin/complaints', '/admin/complaints/summary', `/admin/complaints/${c.id}`]) expect((await none.get(path)).status).toBe(403);
  });

  it('the permissions are not API key scopes and need no step-up', () => {
    for (const key of Object.values(CP)) {
      const def = t.app.get(PermissionRegistry).get(key);
      expect([key, def?.apiKeyScopable, def?.requiresStepUp]).toEqual([key, false, false]);
    }
  });
});

describe('logging a complaint', () => {
  it('starts as received with a random reference and the usual deadlines counted from today', async () => {
    const c = await log();
    const today = todayInBrisbane(new Date());
    expect(c).toMatchObject({ status: 'received', receivedDate: today, version: 0, owner: null, outcome: null, resolutionSummary: null, acknowledgedAt: null, customer: null, booking: null });
    expect(c.reference).toMatch(/^CP-[0-9A-HJKMNP-TV-Z]{6}$/);
    const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    expect(days(c.receivedDate, c.acknowledgeDueDate)).toBe(2);
    expect(days(c.receivedDate, c.resolveDueDate)).toBe(30);
    expect(c.deadlines.acknowledge).toMatchObject({ state: 'due_soon', daysLeft: 2 });
    expect(c.deadlines.resolve).toMatchObject({ state: 'pending', daysLeft: 30 });
  });

  it('the history says who logged it and keeps the complainant\'s words out of the plain changes', async () => {
    const c = await log({ summary: `Secret detail ${token()}` });
    const row = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Complaint', entityId: c.id, action: 'complaints.complaint.logged' } });
    expect(row.actorId).toBe(admin.staff.id);
    const changes = row.changes as Record<string, unknown>;
    expect(changes.summary).toBe('[pii]');
    expect(changes.description).toBe('[pii]');
    expect(changes.complainantName).toBe('[pii]');
    expect(JSON.stringify(changes)).not.toContain('Secret detail');
    expect(changes.status).toEqual({ before: null, after: 'received' });
  });

  it('refuses bad input', async () => {
    const cases: Array<[string, Record<string, unknown>, number, string?]> = [
      ['unknown field', { amountMinor: '1000' }, 422],
      ['empty summary', { summary: '  ' }, 422],
      ['bad category', { category: 'rude' }, 422],
      ['bad email', { complainantEmail: 'not-an-email' }, 422],
      ['no complainant and no customer', { complainantName: undefined }, 422, 'complainant_required'],
      ['received in the future', { receivedDate: '2999-01-01' }, 422, 'received_in_future'],
      ['unknown owner', { ownerId: crypto.randomUUID() }, 422, 'owner_unknown'],
      ['unknown customer', { customerId: crypto.randomUUID() }, 422, 'customer_not_found'],
      ['unknown booking', { bookingId: crypto.randomUUID() }, 422, 'booking_not_found'],
    ];
    for (const [what, over, status, code] of cases) {
      const res = await admin.post('/admin/complaints', body(over));
      expect([what, res.status]).toEqual([what, status]);
      if (code) expect([what, res.body.code]).toEqual([what, code]);
    }
  });

  it('a deadline that is not the usual one needs a reason, and the deadlines stay in order', async () => {
    const received = '2027-01-10';
    clockAt('2027-01-12T02:00:00Z');
    const noReason = await admin.post('/admin/complaints', body({ receivedDate: received, resolveDueDate: '2027-03-01' }));
    expect([noReason.status, noReason.body.code]).toEqual([422, 'deadline_reason_required']);
    const outOfOrder = await admin.post('/admin/complaints', body({ receivedDate: received, acknowledgeDueDate: '2027-02-20', resolveDueDate: '2027-02-10', reason: 'x' }));
    expect([outOfOrder.status, outOfOrder.body.code]).toEqual([422, 'deadlines_out_of_order']);
    const beforeReceived = await admin.post('/admin/complaints', body({ receivedDate: received, acknowledgeDueDate: '2027-01-01', reason: 'x' }));
    expect([beforeReceived.status, beforeReceived.body.code]).toEqual([422, 'deadlines_out_of_order']);
    const ok = must(await admin.post('/admin/complaints', body({ receivedDate: received, resolveDueDate: '2027-03-01', reason: 'The organiser asked for more time' })), 'log', 201).body;
    expect(ok).toMatchObject({ receivedDate: received, acknowledgeDueDate: '2027-01-12', resolveDueDate: '2027-03-01' });
  });

  it('survives a clash of references by drawing another', async () => {
    const first = await log();
    const refs = t.app.get(ComplaintReferences);
    const real = refs.next.bind(refs);
    const queue = [first.reference, first.reference];
    const spy = vi.spyOn(refs, 'next').mockImplementation(() => queue.shift() ?? real());
    try {
      const second = await log();
      expect(second.reference).not.toBe(first.reference);
      expect(spy.mock.calls.length).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('a customer or a booking fills in the complainant and links the record; mismatches and erased customers are refused', async () => {
    const customerId = await makeCustomer(t, { givenName: 'Alex', familyName: 'Runner', email: uniqueEmail('cmp') });
    const fromCustomer = await log({ customerId, complainantName: undefined, complainantEmail: undefined });
    expect(fromCustomer).toMatchObject({ customerId, complainantName: 'Alex Runner', customer: { id: customerId, givenName: 'Alex' } });
    expect(fromCustomer.complainantEmail).toMatch(/@/);

    const booked = await makeBookingFor(t, w);
    const fromBooking = await log({ bookingId: booked.bookingId });
    expect(fromBooking).toMatchObject({ customerId: booked.customerId, bookingId: booked.bookingId, booking: { id: booked.bookingId, status: 'requested' } });
    expect(fromBooking.booking.reference).toMatch(/^MT-/);

    const mismatch = await admin.post('/admin/complaints', body({ bookingId: booked.bookingId, customerId }));
    expect([mismatch.status, mismatch.body.code]).toEqual([422, 'booking_customer_mismatch']);

    const erasedId = await makeCustomer(t, { anonymisedAt: new Date() });
    const erased = await admin.post('/admin/complaints', body({ customerId: erasedId }));
    expect([erased.status, erased.body.code]).toEqual([409, 'customer_erased']);
  });
});

describe('the status flow and the resolution', () => {
  it('goes received, acknowledged, investigating, resolved, closed, stamping each step', async () => {
    const c = await log();
    const ack = must(await move(c.id, 0, 'acknowledged'), 'acknowledge').body;
    expect(ack).toMatchObject({ status: 'acknowledged', version: 1 });
    expect(ack.acknowledgedAt).toBeTruthy();
    expect(ack.deadlines.acknowledge.state).toBe('met');

    const inv = must(await move(c.id, 1, 'investigating'), 'investigate').body;
    expect(inv.acknowledgedAt).toBe(ack.acknowledgedAt);

    const done = must(await move(c.id, 2, 'resolved', resolution), 'resolve').body;
    expect(done).toMatchObject({ status: 'resolved', outcome: 'upheld', resolutionSummary: resolution.resolutionSummary, version: 3 });
    expect(done.resolvedAt).toBeTruthy();
    expect(done.deadlines.resolve.state).toBe('met');

    const closed = must(await move(c.id, 3, 'closed'), 'close').body;
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toBeTruthy();
    expect(closed.outcome).toBe('upheld');

    const actions = (await t.prisma.auditLog.findMany({ where: { entityType: 'Complaint', entityId: c.id }, orderBy: { occurredAt: 'asc' } })).map((r) => r.action);
    expect(actions).toEqual(['complaints.complaint.logged', ...Array(4).fill('complaints.complaint.status_changed')]);
  });

  it('resolving straight from received also acknowledges, and the resolution is mandatory', async () => {
    const c = await log();
    for (const bad of [{}, { outcome: 'upheld' }, { resolutionSummary: 'We looked into it.' }, { outcome: 'maybe', resolutionSummary: 'x' }]) {
      expect((await move(c.id, 0, 'resolved', bad)).status).toBe(422);
    }
    expect((await move(c.id, 0, 'investigating', resolution)).status).toBe(422);
    const done = must(await move(c.id, 0, 'resolved', { outcome: 'not_upheld', resolutionSummary: 'The room matched its listing.' }), 'resolve').body;
    expect(done.acknowledgedAt).toBeTruthy();
    expect(done.deadlines.acknowledge.state).not.toBe('not_applicable');
  });

  it('only the moves in the table are allowed, and every other pair is a 409', async () => {
    const statuses = Object.keys(COMPLAINT_TRANSITIONS);
    for (const from of statuses) {
      const allowed = COMPLAINT_TRANSITIONS[from as keyof typeof COMPLAINT_TRANSITIONS];
      for (const to of ['acknowledged', 'investigating', 'resolved', 'closed', 'withdrawn']) {
        if (allowed.includes(to as never)) continue;
        // Put a complaint into `from` with raw SQL-free steps, then try the forbidden move.
        const c = await log();
        let v = 0;
        const path: Record<string, Array<[string, Record<string, unknown>]>> = {
          received: [], acknowledged: [['acknowledged', {}]], investigating: [['investigating', {}]],
          resolved: [['resolved', resolution]], closed: [['resolved', resolution], ['closed', {}]], withdrawn: [['withdrawn', {}]],
        };
        for (const [s, extra] of path[from]!) must(await move(c.id, v++, s, extra), `to ${s}`);
        const res = await move(c.id, v, to, to === 'resolved' ? resolution : {});
        expect([from, to, res.status, res.body.code]).toEqual([from, to, 409, 'transition_not_allowed']);
      }
    }
  });

  it('a stale version is a 409, and two moves at once let only one through', async () => {
    const c = await log();
    must(await move(c.id, 0, 'acknowledged'), 'ack');
    const stale = await move(c.id, 0, 'investigating');
    expect([stale.status, stale.body.code]).toEqual([409, 'version_conflict']);
    const results = await Promise.all([move(c.id, 1, 'investigating'), move(c.id, 1, 'resolved', resolution)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('reopening a resolved complaint clears the resolution but the history keeps it', async () => {
    const c = await log();
    must(await move(c.id, 0, 'resolved', resolution), 'resolve');
    const back = must(await move(c.id, 1, 'investigating', { reason: 'The customer sent new photos' }), 'reopen').body;
    expect(back).toMatchObject({ status: 'investigating', outcome: null, resolutionSummary: null, resolvedAt: null });
    expect(back.deadlines.resolve.state).not.toBe('met');
    const reopened = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Complaint', entityId: c.id, action: 'complaints.complaint.reopened' } });
    expect(reopened.changes).toMatchObject({ _context: { from: 'resolved', to: 'investigating' } });
    const pii = await t.prisma.auditPiiValue.findMany({ where: { auditLogId: reopened.id, field: 'resolutionSummary' } });
    expect(pii).toHaveLength(1);
    expect(pii[0]!.before).toBe(resolution.resolutionSummary);
  });

  it('withdrawing unanswered leaves no acknowledgement owed; closed and withdrawn complaints cannot be edited', async () => {
    const c = await log();
    const w1 = must(await move(c.id, 0, 'withdrawn'), 'withdraw').body;
    expect(w1).toMatchObject({ status: 'withdrawn', acknowledgedAt: null });
    expect(w1.withdrawnAt).toBeTruthy();
    expect(w1.deadlines.acknowledge.state).toBe('not_applicable');
    expect(w1.deadlines.resolve.state).toBe('not_applicable');
    const edit = await admin.patch(`/admin/complaints/${c.id}`, { summary: 'Changed', version: 1 });
    expect([edit.status, edit.body.code]).toEqual([409, 'complaint_final']);

    const d = await log();
    must(await move(d.id, 0, 'resolved', resolution), 'resolve');
    must(await move(d.id, 1, 'closed'), 'close');
    expect((await admin.patch(`/admin/complaints/${d.id}`, { summary: 'Changed', version: 2 })).body.code).toBe('complaint_final');
  });

  it('the database refuses a resolved complaint with no resolution, even around the API', async () => {
    const c = await log();
    await expect(t.prisma.complaint.update({ where: { id: c.id }, data: { status: 'resolved', acknowledgedAt: new Date() } })).rejects.toThrow(/complaints_resolution_complete/);
    await expect(t.prisma.complaint.update({ where: { id: c.id }, data: { outcome: 'upheld' } })).rejects.toThrow(/complaints_resolution_only_when_resolved/);
    await expect(t.prisma.complaint.update({ where: { id: c.id }, data: { status: 'investigating' } })).rejects.toThrow(/complaints_acknowledged_when_past_received/);
    await expect(t.prisma.complaint.update({ where: { id: c.id }, data: { resolveDueDate: new Date('2000-01-01') } })).rejects.toThrow(/complaints_deadlines_in_order/);
  });
});

describe('editing and the owner', () => {
  it('changes fields with a version, assigns an owner, and logs it', async () => {
    const c = await log();
    const upd = must(await admin.patch(`/admin/complaints/${c.id}`, { category: 'pricing', summary: 'Charged twice', ownerId: admin.staff.id, version: 0 }), 'update').body;
    expect(upd).toMatchObject({ category: 'pricing', summary: 'Charged twice', version: 1, owner: { id: admin.staff.id } });
    expect(upd.owner.email).toMatch(/@/);
    expect((await admin.patch(`/admin/complaints/${c.id}`, { summary: 'Again', version: 0 })).body.code).toBe('version_conflict');
    expect((await admin.patch(`/admin/complaints/${c.id}`, { ownerId: crypto.randomUUID(), version: 1 })).body.code).toBe('owner_unknown');
    expect((await admin.patch(`/admin/complaints/${c.id}`, { receivedDate: '2020-01-01', version: 1 })).status).toBe(422);
    expect((await admin.patch(`/admin/complaints/${crypto.randomUUID()}`, { summary: 'x', version: 0 })).status).toBe(404);
    const unassigned = must(await admin.patch(`/admin/complaints/${c.id}`, { ownerId: null, version: 1 }), 'unassign').body;
    expect(unassigned.owner).toBeNull();
    const owners = must(await admin.get('/admin/complaints/owners'), 'owners').body;
    // The list is capped, so on a busy test database this staff member may not be on it: check its shape and who is left out.
    expect(owners.items.length).toBeLessThanOrEqual(200);
    for (const o of owners.items) expect(Object.keys(o).sort()).toEqual(['email', 'id']);
    const leaver = await staffClient(t, []);
    await t.prisma.user.update({ where: { id: leaver.staff.id }, data: { status: 'disabled' } });
    const disabled = await admin.patch(`/admin/complaints/${c.id}`, { ownerId: leaver.staff.id, version: 2 });
    expect([disabled.status, disabled.body.code]).toEqual([422, 'owner_unknown']);
    expect((await admin.get('/admin/complaints/owners')).body.items.map((o: { id: string }) => o.id)).not.toContain(leaver.staff.id);
  });

  it('changing a deadline needs a reason and an order that still makes sense, and the reason is in the history', async () => {
    const c = await log();
    const noReason = await admin.patch(`/admin/complaints/${c.id}`, { resolveDueDate: addDaysTo(c.resolveDueDate, 14), version: 0 });
    expect([noReason.status, noReason.body.code]).toEqual([422, 'deadline_reason_required']);
    const order = await admin.patch(`/admin/complaints/${c.id}`, { acknowledgeDueDate: addDaysTo(c.resolveDueDate, 1), version: 0, reason: 'x' });
    expect([order.status, order.body.code]).toEqual([422, 'deadlines_out_of_order']);
    const ok = must(await admin.patch(`/admin/complaints/${c.id}`, { resolveDueDate: addDaysTo(c.resolveDueDate, 14), version: 0, reason: 'Waiting for the hotel to reply' }), 'extend').body;
    expect(ok.resolveDueDate).toBe(addDaysTo(c.resolveDueDate, 14));
    const log1 = await t.prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Complaint', entityId: c.id, action: 'complaints.complaint.updated' } });
    expect(log1.changes).toMatchObject({ resolveDueDate: { before: c.resolveDueDate, after: addDaysTo(c.resolveDueDate, 14) } });
    const reason = await t.prisma.auditPiiValue.findFirst({ where: { auditLogId: log1.id, field: '_reason' } });
    expect(reason?.after).toBe('Waiting for the hotel to reply');
  });
});

const addDaysTo = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('deadlines on the register', () => {
  it('moves from pending to due soon to overdue to late as the days pass, in Brisbane time', async () => {
    // Received Monday 8 March 2027; acknowledge due Wednesday 10th; resolve due Wednesday 7 April.
    clockAt('2027-03-08T01:00:00Z'); // 11:00 on the 8th in Brisbane
    const c = await log({ receivedDate: '2027-03-08' });
    expect(c).toMatchObject({ acknowledgeDueDate: '2027-03-10', resolveDueDate: '2027-04-07' });
    const at = async (iso: string) => {
      clockAt(iso);
      return (await admin.get(`/admin/complaints/${c.id}`)).body.deadlines;
    };
    expect((await at('2027-03-08T01:00:00Z')).acknowledge).toMatchObject({ state: 'due_soon', daysLeft: 2 });
    // 14:30 UTC on the 10th is 00:30 on the 11th in Brisbane (+10): the due date has passed there.
    expect((await at('2027-03-10T13:59:00Z')).acknowledge).toMatchObject({ state: 'due_soon', daysLeft: 0 });
    expect((await at('2027-03-10T14:01:00Z')).acknowledge).toMatchObject({ state: 'overdue', daysLeft: -1 });
    expect((await at('2027-03-10T14:01:00Z')).resolve).toMatchObject({ state: 'pending' });
    expect((await at('2027-04-04T00:00:00Z')).resolve).toMatchObject({ state: 'due_soon', daysLeft: 3 });
    expect((await at('2027-04-08T00:00:00Z')).resolve).toMatchObject({ state: 'overdue', daysLeft: -1 });

    // Acknowledged on the 11th (Brisbane): one day late, and it stays late for the record.
    clockAt('2027-03-11T00:00:00Z');
    const acked = must(await move(c.id, 0, 'acknowledged'), 'ack').body;
    expect(acked.deadlines.acknowledge).toMatchObject({ state: 'late', doneOn: '2027-03-11' });
    clockAt('2027-04-09T00:00:00Z');
    const resolved = must(await move(c.id, 1, 'resolved', resolution), 'resolve').body;
    expect(resolved.deadlines.resolve).toMatchObject({ state: 'late', doneOn: '2027-04-09' });
  });

  it('the attention filters and the summary count the right complaints', async () => {
    const mark = token();
    clockAt('2027-06-15T02:00:00Z'); // 12:00 on 15 June 2027 in Brisbane
    const base = (await admin.get('/admin/complaints/summary')).body;
    const mk = (over: Record<string, unknown>) => log({ summary: `${mark} ${token()}`, ...over });
    // acknowledge due 06-12, resolve due 07-12: acknowledge overdue
    const ackOverdue = await mk({ receivedDate: '2027-06-10' });
    // acknowledged, resolve due 06-16: due soon, and unowned
    const soon = await mk({ receivedDate: '2027-05-17' });
    must(await move(soon.id, 0, 'acknowledged'), 'ack');
    // acknowledged, resolve due 06-14: resolve overdue
    const resOverdue = await mk({ receivedDate: '2027-05-15', ownerId: admin.staff.id });
    must(await move(resOverdue.id, 0, 'acknowledged'), 'ack');
    // resolved long ago: never counted as open
    const resolved = await mk({ receivedDate: '2027-04-01' });
    must(await move(resolved.id, 0, 'resolved', resolution), 'resolve');
    // fresh: nothing to flag
    const fresh = await mk({ receivedDate: '2027-06-15' });

    const ids = async (query: string) => ((await admin.get(`/admin/complaints?q=${mark}&${query}`)).body.items as Array<{ id: string }>).map((i) => i.id).sort();
    expect(await ids('attention=acknowledge_overdue')).toEqual([ackOverdue.id]);
    expect(await ids('attention=resolve_overdue')).toEqual([resOverdue.id]);
    expect(await ids('attention=due_soon')).toEqual([soon.id, fresh.id].sort());
    expect(await ids('status=open')).toEqual([ackOverdue.id, soon.id, resOverdue.id, fresh.id].sort());
    expect(await ids('status=resolved')).toEqual([resolved.id]);
    expect(await ids(`ownerId=${admin.staff.id}`)).toEqual([resOverdue.id]);

    const after = (await admin.get('/admin/complaints/summary')).body;
    expect(after.today).toBe('2027-06-15');
    expect(after.open - base.open).toBe(4);
    expect(after.acknowledgeOverdue - base.acknowledgeOverdue).toBe(1);
    expect(after.resolveOverdue - base.resolveOverdue).toBe(1);
    expect(after.dueSoon - base.dueSoon).toBe(2);
    expect(after.unowned - base.unowned).toBe(3);
  });

  it('the list is paged, newest first, and carries no free text beyond the title', async () => {
    const mark = token();
    for (let i = 0; i < 3; i++) await log({ summary: `${mark} ${i}`, description: 'private words', complainantEmail: 'private@example.com' });
    const page1 = (await admin.get(`/admin/complaints?q=${mark}&pageSize=2`)).body;
    expect(page1).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(JSON.stringify(page1)).not.toContain('private');
    const page2 = (await admin.get(`/admin/complaints?q=${mark}&pageSize=2&page=2`)).body;
    expect(page2.items).toHaveLength(1);
    expect((await admin.get('/admin/complaints?status=nonsense')).status).toBe(422);
    expect((await admin.get('/admin/complaints?pageSize=1000')).status).toBe(422);
  });
});

describe('notes, history, export and erasure', () => {
  it('notes need the manage permission, show up in the history, and the history keeps personal values apart', async () => {
    const c = await log();
    const add = await admin.post(`/admin/tables/Complaint/${c.id}/notes`, { body: 'Phoned the hotel; they will reply Friday.', pinned: false });
    expect(add.status).toBe(201);
    const list = (await admin.get(`/admin/tables/Complaint/${c.id}/notes`)).body;
    expect(list).toHaveLength(1);
    const readOnly = await staffClient(t, [CP.read, 'common.table.use']);
    expect((await readOnly.get(`/admin/tables/Complaint/${c.id}/notes`)).status).toBe(200);
    expect((await readOnly.post(`/admin/tables/Complaint/${c.id}/notes`, { body: 'no', pinned: false })).status).toBe(403);
    const history = (await admin.get(`/admin/tables/Complaint/${c.id}/history`)).body;
    expect(JSON.stringify(history)).toContain('complaints.complaint.logged');
    expect(JSON.stringify(history)).toContain('common.note.added');
  });

  it('exports a customer\'s complaints with their notes, and erasure redacts the words but keeps the dates, status and outcome', async () => {
    const customerId = await makeCustomer(t, { email: uniqueEmail('erase') });
    const otherId = await makeCustomer(t, { email: uniqueEmail('other') });
    const mine = await log({ customerId, summary: 'Mine to erase', description: 'Names and details', complainantName: 'Erin Erased' });
    must(await move(mine.id, 0, 'resolved', resolution), 'resolve');
    await admin.post(`/admin/tables/Complaint/${mine.id}/notes`, { body: 'Her phone number is 0400 000 000', pinned: false });
    const theirs = await log({ customerId: otherId, summary: 'Not mine', description: 'Keep this', complainantName: 'Olly Other' });
    await admin.post(`/admin/tables/Complaint/${theirs.id}/notes`, { body: 'Keep this note', pinned: false });

    const handlers = t.app.get(EntityRegistry).get('Complaint')!.handlers!;
    const exported = (await t.prisma.$transaction((tx) => handlers.export(tx, customerId))) as Array<Record<string, unknown>>;
    expect(exported.map((r) => r.summary ?? r.body)).toEqual(['Mine to erase', 'Her phone number is 0400 000 000']);
    expect(exported[0]).toMatchObject({ reference: mine.reference, complainantName: 'Erin Erased', status: 'resolved', outcome: 'upheld', resolutionSummary: resolution.resolutionSummary });

    await t.prisma.$transaction((tx) => handlers.anonymise(tx, customerId));
    const erased = await t.prisma.complaint.findUniqueOrThrow({ where: { id: mine.id } });
    expect(erased).toMatchObject({
      complainantName: '[redacted]', complainantEmail: null, summary: '[redacted]', description: '[redacted]', resolutionSummary: '[redacted]',
      status: 'resolved', outcome: 'upheld', reference: mine.reference, customerId,
    });
    expect(erased.receivedDate.toISOString().slice(0, 10)).toBe(mine.receivedDate);
    expect((await t.prisma.note.findMany({ where: { entityType: 'Complaint', entityId: mine.id } })).map((n) => n.body)).toEqual(['[redacted]']);
    const kept = await t.prisma.complaint.findUniqueOrThrow({ where: { id: theirs.id } });
    expect([kept.summary, kept.complainantName]).toEqual(['Not mine', 'Olly Other']);
    expect((await t.prisma.note.findMany({ where: { entityType: 'Complaint', entityId: theirs.id } })).map((n) => n.body)).toEqual(['Keep this note']);
    // The audit values of the erased customer are findable by the data subject (the entity links to the customer).
    const subject = await t.prisma.auditPiiValue.count({ where: { subjectCustomerId: customerId } });
    expect(subject).toBeGreaterThan(0);
  });
});
