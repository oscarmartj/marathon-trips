import { publicPromoStatus } from '../pricing';
import type { SnapshotBreakdown } from './snapshot-schema';
import { Tx, jsonOf } from './support';

type Db = Pick<Tx, 'booking'>;

/**
 * What the customer sees of a request (plan 2.4, section 4): its reference, status and dates, and the price from its
 * snapshot, never recomputed; no rule trace, one promo status as on the public quote, no internal id.
 */
export async function customerView(db: Db, where: { id: string } | { reference: string }) {
  const b = await db.booking.findUnique({
    where,
    select: {
      reference: true, status: true, requestedAt: true, requestExpiresAt: true, departureDate: true, returnDate: true, balanceDueDate: true,
      currency: true, totalMinor: true, depositMinor: true, currentSnapshotVersion: true,
      package: { select: { id: true, slug: true, name: true, edition: { select: { year: true, race: { select: { slug: true, name: true } } } } } },
      snapshots: { select: { version: true, priceBreakdown: true } },
    },
  });
  if (!b) return null;
  const snapshot = b.snapshots.find((s) => s.version === b.currentSnapshotVersion)!;
  const { trace: _trace, ...price } = snapshot.priceBreakdown as unknown as SnapshotBreakdown;
  return jsonOf({
    reference: b.reference, status: b.status, isRequest: b.status === 'requested',
    requestedAt: b.requestedAt, requestExpiresAt: b.requestExpiresAt, departureDate: b.departureDate, returnDate: b.returnDate, balanceDueDate: b.balanceDueDate,
    currency: b.currency, totalMinor: b.totalMinor, depositMinor: b.depositMinor,
    package: { id: b.package.id, slug: b.package.slug, name: b.package.name, editionYear: b.package.edition.year, race: b.package.edition.race },
    price: { ...price, promo: { status: publicPromoStatus(price.promo.status) } },
  });
}

/** What the panel sees (permission bookings.booking.read): the booking, its customer's contact, snapshots, places and stock. */
export async function staffView(db: Db, id: string) {
  const b = await db.booking.findUnique({
    where: { id },
    omit: { requestKeyHash: true, requestConfigHash: true, requestContactHmac: true },
    include: {
      customer: { select: { id: true, email: true, givenName: true, familyName: true, phone: true, countryOfResidence: true } },
      snapshots: { orderBy: { version: 'asc' } },
      travellers: { orderBy: { slot: 'asc' } },
      // As the booking stands (task 6.3: a change marks the rows it replaces removed); the snapshots keep the history.
      rooms: { where: { removedInVersion: null } },
      extras: { where: { removedInVersion: null } },
      amendments: { orderBy: { toVersion: 'asc' }, omit: { requestKeyHash: true, requestBodyHash: true } },
      claims: { orderBy: { poolId: 'asc' } },
      promoRedemptions: { select: { promoCodeId: true, redeemedAt: true, releasedAt: true } },
    },
  });
  return b ? jsonOf(b) : null;
}
