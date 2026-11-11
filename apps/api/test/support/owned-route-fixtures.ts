import type { Test } from 'supertest';
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
export const OWNED_ROUTE_FIXTURES: Record<string, OwnedRouteFixture> = {};
