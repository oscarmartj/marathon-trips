import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action> (plan 0.1, 1.5). None of them is an API key scope (plan 2.4, section 7):
// reading exposes customers' personal data to an integration, and approving, declining and cancelling will create or
// change payment plans from task 3.1 on (plan 0.1, 9.30 keeps them out of automations too). Cancelling is irreversible
// and needs a recent TOTP check.
export const BOOKINGS_PERMISSIONS = {
  read: 'bookings.booking.read',
  approve: 'bookings.booking.approve',
  decline: 'bookings.booking.decline',
  cancel: 'bookings.booking.cancel',
} as const;

const def = (key: string, description: string, requiresStepUp = false): PermissionDef => ({ key, module: 'bookings', description, requiresStepUp, apiKeyScopable: false });

export const BOOKING_EVENTS = {
  requested: 'bookings.booking.requested',
  approved: 'bookings.booking.approved',
  declined: 'bookings.booking.declined',
  cancelled: 'bookings.booking.cancelled',
  expired: 'bookings.booking.expired',
} as const;

export const bookingsManifest = {
  key: 'bookings',
  /** bookings has no feature flag: switching it off would leave requests and stock half-done (plan 0.1, 9.12). */
  flagKey: null,
  permissions: [
    def(BOOKINGS_PERMISSIONS.read, 'See booking requests and bookings with the customer contact, snapshots and held stock'),
    def(BOOKINGS_PERMISSIONS.approve, 'Approve a booking request'),
    def(BOOKINGS_PERMISSIONS.decline, 'Decline a booking request, which gives its stock and promo code back'),
    def(BOOKINGS_PERMISSIONS.cancel, 'Cancel a request or an approved booking, which gives its stock and promo code back; cannot be undone', true),
  ] satisfies PermissionDef[],
  publishes: Object.values(BOOKING_EVENTS),
  subscribes: [] as string[],
} as const;
