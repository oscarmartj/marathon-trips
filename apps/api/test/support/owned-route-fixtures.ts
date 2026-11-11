/**
 * Test data for every @OwnedBy route on a customer resource (not `self`): given two customers, it must create a
 * resource of customer A and return the request customer B makes for it. `every_owned_route_rejects_other_customer`
 * fails when a route has no entry here. Task 0.3 has only `self` routes; later tasks add their fixtures.
 */
export const OWNED_ROUTE_FIXTURES: Record<string, unknown> = {};
