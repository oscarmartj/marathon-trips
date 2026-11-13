import type { EntityDef } from '../../platform/entities/entity-registry';
import { bookingTable, customerTable } from './tables';
import type { Tx } from './support';

const ERASED = '[redacted]';

/**
 * The team's notes on a customer and on their bookings (task 2.5) are free text and can hold anything. They are staff
 * notes, so they are not part of these exports (task 5.5: the privacy module adds them to the owner's `full` export);
 * erasure redacts all of them, deleted ones included (the privacy module does it again for every registered entity).
 */
const bookingIdsOf = (tx: Tx, customerId: string) => tx.booking.findMany({ where: { customerId }, select: { id: true } }).then((rows) => rows.map((r) => r.id));
async function redactNotes(tx: Tx, entityType: 'Customer' | 'Booking', ids: string[]) {
  if (ids.length > 0) await tx.note.updateMany({ where: { entityType, entityId: { in: ids } }, data: { body: ERASED } });
}

/**
 * How each bookings table reaches its customer, and what export and erasure do (plan 0.1, 4.9; task 5.5 runs them).
 * Snapshots, places, rooms, extras and claims hold no personal data: they export ids and erasure leaves them alone.
 */
export const BOOKING_ENTITIES: EntityDef[] = [
  {
    entityType: 'Customer', model: 'Customer', customerLink: { kind: 'self' }, table: customerTable,
    handlers: {
      export: (tx: Tx, customerId) =>
        tx.customer.findMany({ where: { id: customerId }, select: { email: true, givenName: true, familyName: true, phone: true, countryOfResidence: true, preferredLocale: true, createdAt: true } }),
      anonymise: async (tx: Tx, customerId) => {
        await redactNotes(tx, 'Customer', [customerId]);
        await tx.customer.updateMany({
          where: { id: customerId },
          data: { givenName: ERASED, familyName: ERASED, phone: null, countryOfResidence: 'ZZ', email: `erased+${customerId}@invalid`, customFields: {}, anonymisedAt: new Date() },
        });
      },
    },
  },
  {
    entityType: 'Booking', model: 'Booking', customerLink: { kind: 'column', column: 'customerId' }, table: bookingTable,
    handlers: {
      export: (tx: Tx, customerId) =>
        tx.booking.findMany({ where: { customerId }, select: { reference: true, status: true, departureDate: true, returnDate: true, residenceCountry: true, requestedAt: true }, orderBy: { requestedAt: 'asc' } }),
      anonymise: async (tx: Tx, customerId) => {
        await redactNotes(tx, 'Booking', await bookingIdsOf(tx, customerId));
        await tx.booking.updateMany({ where: { customerId }, data: { residenceCountry: 'ZZ', customFields: {}, requestContactHmac: null } });
        await tx.booking.updateMany({ where: { customerId, statusReason: { not: null } }, data: { statusReason: ERASED } });
      },
    },
  },
  {
    entityType: 'BookingTraveller', model: 'BookingTraveller', customerLink: { kind: 'column', column: 'customerId' },
    handlers: { export: (tx: Tx, customerId) => tx.bookingTraveller.findMany({ where: { customerId }, select: { bookingId: true, slot: true, participationType: true } }), anonymise: async () => undefined },
  },
  ...(['BookingSnapshot', 'BookingRoom', 'BookingExtra', 'InventoryClaim'] as const).map((model): EntityDef => ({
    entityType: model, model, customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' },
    handlers: {
      export: (tx: Tx, customerId) => (tx as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown[]> }>)[model.charAt(0).toLowerCase() + model.slice(1)]!.findMany({ where: { booking: { customerId } }, select: { id: true, bookingId: true } }),
      anonymise: async () => undefined,
    },
  })),
];
