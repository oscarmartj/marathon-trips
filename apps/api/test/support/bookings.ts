import { randomBytes, randomUUID } from 'node:crypto';
import { BOOKINGS_PERMISSIONS } from '../../src/modules/bookings';
import { STATE_HEADERS, TestApp, signInCustomer, uniqueEmail } from './auth';
import type { StaffFixture } from './auth';
import { CATALOGUE_AND_PRICING, Client, staffClient } from './catalogue';
import { quoteBody } from './pricing';
import type { PricedWorld } from './pricing';

export const ALL_BOOKING_PERMISSIONS = Object.values(BOOKINGS_PERMISSIONS);

const hex64 = () => randomBytes(32).toString('hex');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const reference = () => `MT-${Array.from(randomBytes(6), (b) => CROCKFORD[b & 31]).join('')}`;

/** A customer row without a user (as staff would create one in 2.5). */
export async function makeCustomer(t: TestApp, over: Record<string, unknown> = {}): Promise<string> {
  const c = await t.prisma.customer.create({ data: { email: uniqueEmail('cust'), givenName: 'Test', familyName: 'Customer', countryOfResidence: 'AU', source: 'panel', ...over } });
  return c.id;
}

/**
 * A real booking (and its customer, unless given) with its first snapshot, written straight to the tables in one
 * transaction: the snapshot is required at commit by the "totals mirror the snapshot" trigger. For tests of other
 * modules that need a booking to point at (plan 2.4, section 13: the promo redemption tests of 2.2).
 */
export async function makeBookingFor(t: TestApp, w: { pkg: { id: string }; edition: { id: string }; versionId: string }, customerId?: string, requestedAt?: Date, amounts: { totalMinor: bigint; depositMinor: bigint } = { totalMinor: 10000n, depositMinor: 0n }, opts: { isDemo?: boolean } = {}): Promise<{ customerId: string; bookingId: string }> {
  const cid = customerId ?? (await makeCustomer(t));
  const now = requestedAt ?? new Date();
  const bookingId = await t.prisma.$transaction(async (tx) => {
    const b = await tx.booking.create({
      data: {
        reference: reference(), customerId: cid, kind: 'catalogue', packageId: w.pkg.id, editionId: w.edition.id, status: 'requested', currentSnapshotVersion: 1,
        departureDate: new Date('2027-06-18'), returnDate: new Date('2027-06-21'), currency: 'AUD', totalMinor: amounts.totalMinor, depositMinor: amounts.depositMinor, balanceDueDate: new Date('2027-04-18'),
        residenceCountry: 'AU', requestedAt: now, requestExpiresAt: new Date(now.getTime() + 86_400_000), sourceChannel: 'panel',
        requestKeyHash: hex64(), requestConfigHash: hex64(), requestContactHmac: hex64(), ...(opts.isDemo ? { isDemo: true } : {}),
      },
      select: { id: true },
    });
    await tx.bookingSnapshot.create({
      data: { bookingId: b.id, version: 1, kind: 'original', configuration: {}, priceBreakdown: {}, totalMinor: amounts.totalMinor, depositMinor: amounts.depositMinor, currency: 'AUD', priceVersionId: w.versionId, engineVersion: 'pricing-0.0.0' },
    });
    return b.id;
  });
  return { customerId: cid, bookingId };
}

export const contact = (over: Record<string, unknown> = {}) => ({ givenName: 'Ada', familyName: 'Runner', phone: '+61 400 000 000', countryOfResidence: 'AU', ...over });

/** A booking request body: the priced world's default configuration (a runner and a supporter in the double) and a contact. */
export const requestBody = (w: PricedWorld, over: Record<string, unknown> = {}) => ({ ...quoteBody(w), contact: contact(), ...over });

export interface CustomerClient {
  cookie: string;
  userId: string;
  email: string;
  request: (body: object, key?: string) => ReturnType<ReturnType<TestApp['http']>['post']>;
  get: (reference: string) => ReturnType<ReturnType<TestApp['http']>['get']>;
}

/** A signed-in customer (real magic link) that sends requests with a fresh Idempotency-Key unless one is given. */
export async function customerClient(t: TestApp, email = uniqueEmail('customer')): Promise<CustomerClient> {
  const s = await signInCustomer(t, email);
  return {
    ...s,
    request: (body, key = randomUUID()) => t.http().post('/booking-requests').set(STATE_HEADERS).set('Cookie', s.cookie).set('Idempotency-Key', key).send(body),
    get: (ref) => t.http().get(`/booking-requests/${ref}`).set('Cookie', s.cookie),
  };
}

/** Staff that can manage the catalogue, prices and bookings. */
export const bookingStaff = (t: TestApp): Promise<Client & { staff: StaffFixture }> => staffClient(t, [...CATALOGUE_AND_PRICING, ...ALL_BOOKING_PERMISSIONS]);

/** Removes the events booking tests leave behind, so other test files start clean. */
export async function cleanBookingEvents(t: TestApp): Promise<void> {
  await t.prisma.$executeRawUnsafe(`DELETE FROM event_deliveries WHERE "eventId" IN (SELECT id FROM outbox_events WHERE type LIKE 'bookings.%')`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM outbox_events WHERE type LIKE 'bookings.%'`);
}

/**
 * Task 6.4: a staff cancellation as the panel makes it, reading the quote first and sending its digest (the cancel route
 * requires it). A quote that fails (no permission, unknown booking) sends a dummy digest, so the cancel answers its own error.
 */
export async function staffCancel(admin: Pick<Client, 'get' | 'post'>, bookingId: string, body: { version: number; reason: string; operatorCancelled?: boolean }): Promise<Awaited<ReturnType<Client['post']>>> {
  const q = await admin.get(`/admin/bookings/${bookingId}/cancellation-quote${body.operatorCancelled ? '?operatorCancelled=true' : ''}`);
  const quoteDigest = q.status === 200 ? (q.body as { quoteDigest: string }).quoteDigest : '0'.repeat(64);
  return admin.post(`/admin/bookings/${bookingId}/cancel`, { ...body, quoteDigest });
}

/**
 * Task 6.4: a booking moved into `cancelled` by SQL (the matrices' walks) needs its cancellation record in the same
 * transaction (deferred trigger of 0038). Written as staff would, with penalty 0 and everything held refundable.
 */
export async function insertBareCancellation(tx: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> }, bookingId: string): Promise<void> {
  await tx.$executeRawUnsafe(`
    INSERT INTO cancellations (id, "bookingId", currency, "requestedBy", "requestedById", "bookingStatus", "snapshotVersion", basis, "businessDate", "processedDate",
      "daysBeforeDeparture", "policySnapshot", "baseTotalMinor", places, "collectedMinor", "policyPenaltyMinor", "penaltyMinor", "waivedMinor", "refundableMinor")
    SELECT gen_random_uuid(), b.id, b.currency, 'staff', gen_random_uuid(), b.status, b."currentSnapshotVersion",
      CASE WHEN b.status IN ('requested', 'approved') THEN 'not_contracted'::"CancellationBasis" ELSE 'operator_cancelled'::"CancellationBasis" END,
      (now() AT TIME ZONE 'Australia/Brisbane')::date, (now() AT TIME ZONE 'Australia/Brisbane')::date, 0, '{}'::jsonb, b."totalMinor", 1, 0, 0, 0, 0, 0
    FROM bookings b WHERE b.id = $1::uuid`, bookingId);
}
