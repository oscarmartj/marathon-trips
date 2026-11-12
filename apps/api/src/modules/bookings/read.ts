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
  /** The package's setting, read now (plan 3.2, assumption 4): it is not part of the snapshot. */
  autoConfirmOnDeposit: boolean;
}

declare const lockedBooking: unique symbol;

/**
 * A booking read FOR UPDATE in the caller's transaction (plan 3.2, section 11, point 11). Payments needs one to lock a
 * payment, so the global order Booking → Payment (plan 0.1, 6.3) is checked by the compiler.
 */
export type LockedBooking = BookingForPayments & { readonly [lockedBooking]: true };

/**
 * Reads a booking with the amounts of its current snapshot (plan 3.1, section 4.2). `lock` takes the booking row
 * FOR UPDATE, first in the global lock order (plan 0.1, 6.3); without it, a plain read.
 */
export async function readBookingForPayments(tx: Tx, where: { id: string } | { reference: string }, lock: true): Promise<LockedBooking | null>;
export async function readBookingForPayments(tx: Tx, where: { id: string } | { reference: string }, lock?: false): Promise<BookingForPayments | null>;
export async function readBookingForPayments(tx: Tx, where: { id: string } | { reference: string }, lock = false): Promise<BookingForPayments | null> {
  const byId = 'id' in where;
  const value = byId ? where.id : where.reference;
  const rows = await tx.$queryRawUnsafe<BookingForPayments[]>(
    `SELECT b.id::text AS id, b.reference, b."customerId"::text AS "customerId", b.status::text AS status, b.currency,
            s."totalMinor", s."depositMinor", b."balanceDueDate", b."departureDate", b."residenceCountry", b."approvalExpiresAt",
            p."autoConfirmOnDeposit"
       FROM bookings b JOIN booking_snapshots s ON s."bookingId" = b.id AND s.version = b."currentSnapshotVersion"
       JOIN packages p ON p.id = b."packageId"
      WHERE ${byId ? 'b.id = $1::uuid' : 'b.reference = $1'}
      ${lock ? 'FOR UPDATE OF b' : ''}`,
    value,
  );
  return rows[0] ?? null;
}

/** What automations read about a booking (task 7.4): ids and codes for conditions, and what its emails need. */
export interface BookingForAutomations {
  id: string;
  reference: string;
  status: BookingStatus;
  packageId: string;
  editionId: string;
  raceId: string;
  fromQuote: boolean;
  tagIds: string[];
  customer: { id: string; email: string; givenName: string; preferredLocale: string; unavailable: boolean };
  trip: { raceName: unknown; year: number; packageName: unknown };
}

/** A plain read, no lock. Null when the booking does not exist. */
export async function readBookingForAutomations(tx: Tx, id: string): Promise<BookingForAutomations | null> {
  const b = await tx.booking.findUnique({
    where: { id },
    select: {
      id: true, reference: true, status: true, packageId: true, editionId: true, quote: { select: { id: true } },
      customer: { select: { id: true, email: true, givenName: true, preferredLocale: true, anonymisedAt: true, deletedAt: true } },
      package: { select: { name: true } }, edition: { select: { year: true, raceId: true, race: { select: { name: true } } } },
    },
  });
  if (!b) return null;
  const tags = await tx.tagging.findMany({ where: { entityType: 'Booking', entityId: id }, select: { tagId: true }, orderBy: { tagId: 'asc' } });
  return {
    id: b.id, reference: b.reference, status: b.status as BookingStatus, packageId: b.packageId, editionId: b.editionId, raceId: b.edition.raceId,
    fromQuote: !!b.quote, tagIds: tags.map((t) => t.tagId),
    customer: { id: b.customer.id, email: b.customer.email, givenName: b.customer.givenName, preferredLocale: b.customer.preferredLocale, unavailable: !!(b.customer.anonymisedAt || b.customer.deletedAt) },
    trip: { raceName: b.edition.race.name, year: b.edition.year, packageName: b.package.name },
  };
}
