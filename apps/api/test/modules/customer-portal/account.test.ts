// The customer area (task 5.1, plan docs/plans/5.1-customer-area.md, sections 3, 4 and 7): the list of a customer's
// bookings, one booking with its plan, payments and documents, and the documents themselves. Simulator only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOOKING_STATUSES, CUSTOMER_DOCUMENT_KINDS } from '@mt/shared';
import type { BookingStatus } from '@mt/shared';
import { documentsFor } from '../../../src/modules/customer-portal';
import { STATE_HEADERS, TestApp, makeApp, signInCustomer } from '../../support/auth';
import { cleanBookingEvents, customerClient } from '../../support/bookings';
import { closeCatalogue } from '../../support/catalogue';
import { customerBookingIn } from '../../support/customer-portal';
import { pricedWorld } from '../../support/pricing';
import { PayingCustomer, SimAccount, approvedBooking, cleanPayments, ensureTerms, onlyAccount, payingCustomer, paymentsStaff, sim, simulatorAccount } from '../../support/payments';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let t: TestApp;
let admin: Awaited<ReturnType<typeof paymentsStaff>>;
let acc: SimAccount;
let c: PayingCustomer;
beforeAll(async () => {
  t = await makeApp();
  admin = await paymentsStaff(t);
  acc = await simulatorAccount(t);
  await onlyAccount(t, acc.id);
  c = await payingCustomer(t);
  await ensureTerms(t);
});
afterAll(async () => {
  await cleanPayments(t);
  await cleanBookingEvents(t);
  await closeCatalogue(t);
});

const list = (who: { cookie: string }) => t.http().get('/account/bookings').set('Cookie', who.cookie);
const detail = (ref: string, who: { cookie: string } = c) => t.http().get(`/account/bookings/${ref}`).set('Cookie', who.cookie);
const doc = (ref: string, kind: string, who: { cookie: string } = c) => t.http().get(`/account/bookings/${ref}/documents/${kind}`).set('Cookie', who.cookie).buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (x: Buffer) => chunks.push(x));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const pdfText = (b: Buffer) => b.toString('latin1');

/** Pays the next item through checkout and the simulator, and lets the refresh record it. */
async function payNext(ref: string, bookingId: string): Promise<void> {
  expect((await c.pay(ref, { method: 'card' })).status).toBe(201);
  const p = (await t.prisma.payment.findMany({ where: { bookingId }, orderBy: { attemptNumber: 'asc' } })).at(-1)!;
  sim.settle(acc.id, p.providerPaymentRef!, 'succeeded');
  expect((await t.http().post(`/booking-requests/${ref}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({})).status).toBe(200);
}

describe('the list of my bookings', () => {
  it('account_bookings_lists_only_own: newest first, the stored totals, no ids and nothing of another customer', async () => {
    const me = await customerClient(t);
    const other = await customerClient(t);
    const first = await customerBookingIn(t, me, 'requested');
    const second = await customerBookingIn(t, me, 'approved');
    const theirs = await customerBookingIn(t, other, 'requested');
    const res = await list(me);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { reference: string }) => i.reference)).toEqual([second.reference, first.reference]);
    expect(JSON.stringify(res.body)).not.toContain(theirs.reference);
    const stored = await t.prisma.booking.findUniqueOrThrow({ where: { id: second.bookingId }, select: { totalMinor: true, currency: true, status: true } });
    const item = res.body.items[0];
    expect(Object.keys(item).sort()).toEqual(['currency', 'departureDate', 'package', 'reference', 'requestedAt', 'returnDate', 'status', 'totalMinor']);
    expect(Object.keys(item.package).sort()).toEqual(['editionYear', 'name', 'race', 'slug']);
    expect(Object.keys(item.package.race).sort()).toEqual(['name', 'slug']);
    expect([item.totalMinor, item.currency, item.status]).toEqual([stored.totalMinor.toString(), stored.currency, stored.status]);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('a user with no customer, and a closed customer, see an empty list', async () => {
    const fresh = await signInCustomer(t);
    expect((await list(fresh)).body).toEqual({ items: [] });
    const me = await customerClient(t);
    await customerBookingIn(t, me, 'requested');
    await t.prisma.customer.updateMany({ where: { userId: me.userId }, data: { deletedAt: new Date() } });
    expect((await list(me)).body).toEqual({ items: [] });
  });

  it('a customer staff created with the same address is not shown until a request links it', async () => {
    const me = await customerClient(t);
    await t.prisma.customer.create({ data: { email: me.email, givenName: 'Other', familyName: 'Person', countryOfResidence: 'AU', source: 'panel' } });
    expect((await list(me)).body).toEqual({ items: [] });
  });

  it('a staff session is refused on every customer-area route, and a closed customer reads nothing', async () => {
    const { reference } = await customerBookingIn(t, c, 'confirmed');
    for (const path of ['/account/bookings', `/account/bookings/${reference}`, `/account/bookings/${reference}/documents/confirmation`]) {
      const res = await admin.get(path);
      expect([path, res.status === 401 || res.status === 403]).toEqual([path, true]);
    }
    const me = await customerClient(t);
    const mine = await customerBookingIn(t, me, 'confirmed');
    expect((await detail(mine.reference, me)).status).toBe(200);
    await t.prisma.customer.updateMany({ where: { userId: me.userId }, data: { deletedAt: new Date() } });
    expect((await detail(mine.reference, me)).status).toBe(404);
    expect((await doc(mine.reference, 'confirmation', me)).status).toBe(404);
    const other = await customerClient(t);
    const theirs = await customerBookingIn(t, other, 'confirmed');
    await t.prisma.customer.updateMany({ where: { userId: other.userId }, data: { anonymisedAt: new Date() } });
    expect((await detail(theirs.reference, other)).status).toBe(404);
    expect((await doc(theirs.reference, 'confirmation', other)).status).toBe(404);
    expect((await list(other)).body).toEqual({ items: [] });
  });

  it('signed out is 401 on every customer-area route', async () => {
    const { reference } = await customerBookingIn(t, c, 'confirmed');
    for (const path of ['/account/bookings', `/account/bookings/${reference}`, `/account/bookings/${reference}/documents/confirmation`]) {
      expect([path, (await t.http().get(path)).status]).toEqual([path, 401]);
    }
  });
});

describe('one of my bookings', () => {
  it('account_booking_amounts_are_the_apis: the snapshot view, the payment plan and only succeeded payments', async () => {
    const { reference, bookingId } = await approvedBooking(t, admin, await pricedWorld(admin), c);
    // A declined attempt first: it must not appear among the payments.
    expect((await c.pay(reference, { method: 'card' })).status).toBe(201);
    const declined = (await t.prisma.payment.findFirstOrThrow({ where: { bookingId } }));
    sim.settle(acc.id, declined.providerPaymentRef!, 'failed');
    await t.http().post(`/booking-requests/${reference}/payments/refresh`).set(STATE_HEADERS).set('Cookie', c.cookie).send({});
    await payNext(reference, bookingId);

    const res = await detail(reference);
    expect(res.status).toBe(200);
    // Task 6.4: the cancellation record and whether the customer may cancel online.
    expect(Object.keys(res.body).sort()).toEqual(['booking', 'cancellation', 'changes', 'documents', 'payments', 'plan']);
    // Task 6.3: no changes yet, and customers' online changes are off by default.
    expect(res.body.changes).toEqual({ items: [], customerChangesEnabled: false });
    expect(res.body.booking).toEqual((await c.get(reference)).body);
    expect(res.body.plan).toEqual((await c.plan(reference)).body);
    const ok = await t.prisma.payment.findMany({ where: { bookingId, status: 'succeeded' } });
    expect(ok).toHaveLength(1);
    expect(res.body.payments).toEqual([{ succeededAt: ok[0]!.succeededAt!.toISOString(), amountMinor: ok[0]!.amountMinor.toString(), currency: ok[0]!.currency, method: 'card' }]);
    expect(JSON.stringify(res.body.payments)).not.toContain(ok[0]!.providerPaymentRef!);
    // The default priced world confirms on deposit: a confirmation and an itinerary, no voucher until paid in full.
    expect(res.body.booking.status).toBe('confirmed');
    expect(res.body.documents).toEqual(['confirmation', 'itinerary']);
  });

  it('a requested booking has its plan view (not payable) and no documents', async () => {
    const { reference } = await customerBookingIn(t, c, 'requested');
    const res = await detail(reference);
    expect(res.status).toBe(200);
    expect([res.body.plan.payable, res.body.plan.notPayableReason, res.body.payments, res.body.documents]).toEqual([false, 'booking_not_payable', [], []]);
  });
});

describe('documents', () => {
  it('documents_by_status_matrix: every booking status by every kind, from the enum', async () => {
    const EXPECTED: Record<BookingStatus, string[]> = {
      requested: [], approved: [], deposit_paid: [], confirmed: ['confirmation', 'itinerary'], balance_paid: ['confirmation', 'itinerary', 'voucher'],
      completed: ['confirmation', 'itinerary', 'voucher'], declined: [], expired: [], cancelled: [], refunded: [],
    };
    expect(Object.keys(EXPECTED).sort()).toEqual([...BOOKING_STATUSES].sort());
    for (const status of BOOKING_STATUSES) {
      expect([status, documentsFor(status)]).toEqual([status, EXPECTED[status]]);
      const { reference } = await customerBookingIn(t, c, status);
      expect([status, (await detail(reference)).body.documents]).toEqual([status, EXPECTED[status]]);
      for (const kind of [...CUSTOMER_DOCUMENT_KINDS, 'receipt']) {
        const res = await doc(reference, kind);
        const want = kind === 'receipt' ? 404 : EXPECTED[status].includes(kind) ? 200 : 409;
        expect([status, kind, res.status]).toEqual([status, kind, want]);
        if (want === 200) {
          expect(res.headers['content-type']).toBe('application/pdf');
          expect(res.headers['content-disposition']).toBe(`attachment; filename="${reference}-${kind}.pdf"`);
          expect(res.headers['cache-control']).toBe('no-store');
        }
        if (want === 409) expect(JSON.parse(res.body.toString()).code).toBe('document_not_available');
      }
    }
  }, 600_000);

  it('document_values_from_snapshot: the reference, the stored total and the customer, and the live template when there is one', async () => {
    const { reference, bookingId } = await customerBookingIn(t, c, 'balance_paid');
    const b = await t.prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { totalMinor: true, customer: { select: { givenName: true, familyName: true } } } });
    const res = await doc(reference, 'confirmation');
    expect(res.status).toBe(200);
    const text = pdfText(res.body as Buffer);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain(reference);
    expect(text).toContain(`${b.customer.givenName} ${b.customer.familyName}`);
    const whole = (b.totalMinor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    // The starter confirmation has no total; the voucher's starter neither. Use a live revision with {{total}}.
    await t.prisma.messageTemplate.updateMany({ where: { channel: 'document', key: 'voucher', status: 'active' }, data: { status: 'archived' } });
    const last = await t.prisma.messageTemplate.aggregate({ where: { channel: 'document', key: 'voucher', locale: 'en-AU' }, _max: { revision: true } });
    const tpl = await t.prisma.messageTemplate.create({ data: { channel: 'document', key: 'voucher', locale: 'en-AU', revision: (last._max.revision ?? 0) + 1, status: 'active', subject: 'Voucher', body: 'Voucher {{reference}} for {{customerName}}. Paid: {{total}}.\n{{itinerary}}' } });
    try {
      const v = pdfText((await doc(reference, 'voucher')).body as Buffer);
      expect(v).toContain(`Voucher ${reference}`);
      expect(v).toContain(`A$${whole}.`);
      expect(v).toContain('race day');
    } finally {
      await t.prisma.messageTemplate.update({ where: { id: tpl.id }, data: { status: 'archived' } });
    }
  });

  it('an unknown kind is 404 after ownership; another customer gets the same 404 for a real kind', async () => {
    const { reference } = await customerBookingIn(t, c, 'confirmed');
    const other = await customerClient(t);
    expect((await doc(reference, 'nonsense')).status).toBe(404);
    expect((await doc(reference, 'confirmation', other)).status).toBe(404);
    expect((await doc('MT-000000', 'confirmation')).status).toBe(404);
  });

  it('document_download_rate_limited_429: past the hourly limit per customer', async () => {
    const me = await customerClient(t);
    const { reference } = await customerBookingIn(t, me, 'confirmed');
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await doc(reference, 'itinerary', me)).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  }, 300_000);
});
