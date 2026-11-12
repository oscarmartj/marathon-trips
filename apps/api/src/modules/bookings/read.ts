import type { BookingStatus } from '@mt/shared';
import type { Tx } from './support';

/** What the payments module reads about a booking (task 3.1): status, the current snapshot's amounts and the dates. */
export interface BookingForPayments {
  id: string;
  reference: string;
  customerId: string;
  status: BookingStatus;
  currency: string;
  /** From the current snapshot (the booking mirrors it, checked at commit). */
  totalMinor: bigint;
  depositMinor: bigint;
  balanceDueDate: Date;
  departureDate: Date;
  residenceCountry: string;
  approvalExpiresAt: Date | null;
}

/**
 * Reads a booking with the amounts of its current snapshot (plan 3.1, section 4.2). `lock` takes the booking row
 * FOR UPDATE, first in the global lock order (plan 0.1, 6.3); without it, a plain read.
 */
export async function readBookingForPayments(tx: Tx, where: { id: string } | { reference: string }, lock = false): Promise<BookingForPayments | null> {
  const byId = 'id' in where;
  const value = byId ? where.id : where.reference;
  const rows = await tx.$queryRawUnsafe<BookingForPayments[]>(
    `SELECT b.id::text AS id, b.reference, b."customerId"::text AS "customerId", b.status::text AS status, b.currency,
            s."totalMinor", s."depositMinor", b."balanceDueDate", b."departureDate", b."residenceCountry", b."approvalExpiresAt"
       FROM bookings b JOIN booking_snapshots s ON s."bookingId" = b.id AND s.version = b."currentSnapshotVersion"
      WHERE ${byId ? 'b.id = $1::uuid' : 'b.reference = $1'}
      ${lock ? 'FOR UPDATE OF b' : ''}`,
    value,
  );
  return rows[0] ?? null;
}
