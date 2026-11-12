import type { EntityDef } from '../../platform/entities/entity-registry';
import type { Tx } from './support';

const ERASED = '[redacted]';

/**
 * How each bookings table reaches its customer, and what export and erasure do (plan 0.1, 4.9; task 5.5 runs them).
 * Snapshots, places, rooms, extras and claims hold no personal data: they export ids and erasure leaves them alone.
 */
export const BOOKING_ENTITIES: EntityDef[] = [
  {
    entityType: 'Customer', model: 'Customer', customerLink: { kind: 'self' },
    handlers: {
      export: (tx: Tx, customerId) => tx.customer.findMany({ where: { id: customerId }, select: { email: true, givenName: true, familyName: true, phone: true, countryOfResidence: true, preferredLocale: true, createdAt: true } }),
      anonymise: async (tx: Tx, customerId) => {
        await tx.customer.updateMany({
          where: { id: customerId },
          data: { givenName: ERASED, familyName: ERASED, phone: null, countryOfResidence: 'ZZ', email: `erased+${customerId}@invalid`, customFields: {}, anonymisedAt: new Date() },
        });
      },
    },
  },
  {
    entityType: 'Booking', model: 'Booking', customerLink: { kind: 'column', column: 'customerId' },
    handlers: {
      export: (tx: Tx, customerId) => tx.booking.findMany({ where: { customerId }, select: { reference: true, status: true, departureDate: true, returnDate: true, residenceCountry: true, requestedAt: true } }),
      anonymise: async (tx: Tx, customerId) => {
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
