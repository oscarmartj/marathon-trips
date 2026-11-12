import { randomUUID } from 'node:crypto';
import type { Test } from 'supertest';
import { STATE_HEADERS } from './auth';
import type { TestApp } from './auth';

export interface CustomerSession {
  cookie: string;
  userId: string;
}

/**
 * Test data for an @OwnedBy route on a customer resource (not `self`). `create` makes a resource that belongs to
 * customer A and returns two requests for it: A's (must succeed) and B's (must get 404, as if it did not exist).
 * `every_owned_route_rejects_other_customer` fails when a route's fixture is missing, and runs every fixture.
 */
export interface OwnedRouteFixture {
  create(t: TestApp, a: CustomerSession, b: CustomerSession): Promise<{ asOwner: () => Test; asOther: () => Test }>;
}

/** Task 0.3 has only `self` routes; later tasks add one entry per customer-resource route. */
export const OWNED_ROUTE_FIXTURES: Record<string, OwnedRouteFixture> = {
  // Task 2.4: GET /booking-requests/:reference. Customer A sends a request for an open package; B asks for it.
  'booking-request': {
    async create(t, a, b) {
      const { bookingStaff, requestBody } = await import('./bookings');
      const { pricedWorld } = await import('./pricing');
      const w = await pricedWorld(await bookingStaff(t));
      const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', a.cookie).set('Idempotency-Key', randomUUID()).send(requestBody(w));
      if (res.status !== 201) throw new Error(`booking request failed: ${res.status} ${JSON.stringify(res.body)}`);
      const path = `/booking-requests/${res.body.reference as string}`;
      return { asOwner: () => t.http().get(path).set('Cookie', a.cookie), asOther: () => t.http().get(path).set('Cookie', b.cookie) };
    },
  },
  // Task 3.1: GET /booking-requests/:reference/payment-plan. A's request, approved by staff (the hook creates the plan).
  'booking-payment-plan': {
    async create(t, a, b) {
      const ref = await approvedRequestOf(t, a);
      const path = `/booking-requests/${ref}/payment-plan`;
      return { asOwner: () => t.http().get(path).set('Cookie', a.cookie), asOther: () => t.http().get(path).set('Cookie', b.cookie) };
    },
  },
  // Task 3.1: POST /booking-requests/:reference/payments. A pays the deposit against the simulator; B tries the same.
  'booking-payment-start': {
    async create(t, a, b) {
      const { simulatorAccount } = await import('./payments');
      await simulatorAccount(t);
      const ref = await approvedRequestOf(t, a);
      const path = `/booking-requests/${ref}/payments`;
      const send = (s: CustomerSession) => t.http().post(path).set(STATE_HEADERS).set('Cookie', s.cookie).set('Idempotency-Key', randomUUID()).send({ method: 'card' });
      return { asOwner: () => send(a), asOther: () => send(b) };
    },
  },
  // Task 2.5: GET /quotes/:reference. A quote sent to customer A; B asks for it.
  quote: {
    async create(t, a, b) {
      const { sentQuoteFixture } = await import('./crm');
      const ref = await sentQuoteFixture(t, a);
      return { asOwner: () => t.http().get(`/quotes/${ref}`).set('Cookie', a.cookie), asOther: () => t.http().get(`/quotes/${ref}`).set('Cookie', b.cookie) };
    },
  },
  // Task 2.5: POST /quotes/:reference/accept. A quote sent to customer A; B tries to accept it.
  'quote-accept': {
    async create(t, a, b) {
      const { sentQuoteFixture } = await import('./crm');
      const ref = await sentQuoteFixture(t, a);
      return {
        asOwner: () => t.http().post(`/quotes/${ref}/accept`).set(STATE_HEADERS).set('Cookie', a.cookie).send({}),
        asOther: () => t.http().post(`/quotes/${ref}/accept`).set(STATE_HEADERS).set('Cookie', b.cookie).send({}),
      };
    },
  },
  // Task 6.5: the waiting list entry routes. A is offered the place a holder gave up; B tries the same routes.
  'waitlist-entry': {
    async create(t, a, b) {
      const id = await offeredEntryOf(t, a);
      return { asOwner: () => t.http().get(`/waitlist/entries/${id}`).set('Cookie', a.cookie), asOther: () => t.http().get(`/waitlist/entries/${id}`).set('Cookie', b.cookie) };
    },
  },
  'waitlist-entry-accept': {
    async create(t, a, b) {
      const id = await offeredEntryOf(t, a);
      const send = (s: CustomerSession) => t.http().post(`/waitlist/entries/${id}/accept`).set(STATE_HEADERS).set('Cookie', s.cookie).send({});
      return { asOwner: () => send(a), asOther: () => send(b) };
    },
  },
  'waitlist-entry-withdraw': {
    async create(t, a, b) {
      const id = await offeredEntryOf(t, a);
      const send = (s: CustomerSession) => t.http().post(`/waitlist/entries/${id}/withdraw`).set(STATE_HEADERS).set('Cookie', s.cookie).send({});
      return { asOwner: () => send(a), asOther: () => send(b) };
    },
  },
};

/** Customer A is on the waiting list of a sold out package whose only place has just come back: A holds an offer. */
async function offeredEntryOf(t: TestApp, a: CustomerSession): Promise<string> {
  const { bookingStaff, requestBody } = await import('./bookings');
  const { soldOutWorld, cancelHolder } = await import('./waitlist');
  const admin = await bookingStaff(t);
  const s = await soldOutWorld(t, admin);
  const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', a.cookie).set('Idempotency-Key', randomUUID()).send(requestBody(s.w));
  if (res.status !== 201) throw new Error(`join failed: ${res.status} ${JSON.stringify(res.body)}`);
  const entry = await t.prisma.waitlistEntry.findFirstOrThrow({ where: { customer: { userId: a.userId }, packageId: s.w.pkg.id } });
  await cancelHolder(t, s);
  return entry.id;
}

/** A booking request by customer A for a fresh priced package, approved by staff. Returns its reference. */
async function approvedRequestOf(t: TestApp, a: CustomerSession): Promise<string> {
  const { requestBody } = await import('./bookings');
  const { paymentsStaff } = await import('./payments');
  const { pricedWorld } = await import('./pricing');
  const admin = await paymentsStaff(t);
  const w = await pricedWorld(admin);
  const res = await t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', a.cookie).set('Idempotency-Key', randomUUID()).send(requestBody(w));
  if (res.status !== 201) throw new Error(`booking request failed: ${res.status} ${JSON.stringify(res.body)}`);
  const booking = await t.prisma.booking.findUniqueOrThrow({ where: { reference: res.body.reference as string } });
  const ok = await admin.post(`/admin/bookings/${booking.id}/approve`, { version: booking.version });
  if (ok.status !== 200) throw new Error(`approve failed: ${ok.status} ${JSON.stringify(ok.body)}`);
  return booking.reference;
}
