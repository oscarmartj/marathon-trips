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
};
