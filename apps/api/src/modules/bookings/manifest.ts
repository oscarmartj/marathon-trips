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
  confirm: 'bookings.booking.confirm',
  /** Task 6.3: change a booking after its deposit (rooms, travellers, nights, extras), with the difference recalculated. */
  amend: 'bookings.booking.amend',
} as const;

/** Task 2.5: the panel's customers, and notes and tags on bookings (the shared table tools of task 0.5). Not API key scopes either. */
export const BOOKINGS_CRM_PERMISSIONS = {
  annotate: 'bookings.booking.annotate',
  customerRead: 'bookings.customer.read',
  customerWrite: 'bookings.customer.write',
  customerAnnotate: 'bookings.customer.annotate',
} as const;

const def = (key: string, description: string, requiresStepUp = false): PermissionDef => ({ key, module: 'bookings', description, requiresStepUp, apiKeyScopable: false });

export const BOOKING_EVENTS = {
  requested: 'bookings.booking.requested',
  approved: 'bookings.booking.approved',
  declined: 'bookings.booking.declined',
  cancelled: 'bookings.booking.cancelled',
  expired: 'bookings.booking.expired',
  depositPaid: 'bookings.booking.deposit_paid',
  confirmed: 'bookings.booking.confirmed',
  balancePaid: 'bookings.booking.balance_paid',
  /** Task 6.3: a change of the booking (new snapshot, difference recalculated). */
  amended: 'bookings.booking.amended',
  /** Task 6.3: a change raised the total of a booking paid in full, which goes back from balance paid to confirmed. */
  balanceReopened: 'bookings.booking.balance_reopened',
  /** Task 3.4: a confirmed transfer was voided and the deposit is no longer covered, so the booking goes back to approved. */
  depositReopened: 'bookings.booking.deposit_reopened',
} as const;

export const bookingsManifest = {
  key: 'bookings',
  /** bookings has no feature flag: switching it off would leave requests and stock half-done (plan 0.1, 9.12). */
  flagKey: null,
  permissions: [
    def(BOOKINGS_PERMISSIONS.read, 'See booking requests and bookings with the customer contact, snapshots and held stock'),
    def(BOOKINGS_PERMISSIONS.approve, 'Approve a booking request'),
    def(BOOKINGS_PERMISSIONS.decline, 'Decline a booking request, which gives its stock and promo code back'),
    // Confirming cannot be undone until refunds and penalties exist (cancelling a confirmed booking is a 409): step-up
    // (plan 3.2, section 11, point 5).
    def(BOOKINGS_PERMISSIONS.confirm, 'Confirm a booking whose deposit is paid (it then moves to balance paid if the balance is paid too); cannot be undone', true),
    // A change moves what the customer owes, takes or gives back stock and cannot be undone except by another change:
    // step-up, owner only by default, never an API key scope (task 6.3).
    def(BOOKINGS_PERMISSIONS.amend, 'Change a booking after its deposit (rooms, travellers, nights, extras); the new price comes from the pricing engine and what is owed changes', true),
    def(BOOKINGS_PERMISSIONS.cancel, 'Cancel a request or an approved booking, which gives its stock and promo code back; cannot be undone', true),
    def(BOOKINGS_CRM_PERMISSIONS.annotate, 'Add notes and tags to a booking'),
    def(BOOKINGS_CRM_PERMISSIONS.customerRead, 'See customers with their contact details and history of bookings, quotes and emails'),
    def(BOOKINGS_CRM_PERMISSIONS.customerWrite, 'Add a customer and change a customer\'s contact details'),
    def(BOOKINGS_CRM_PERMISSIONS.customerAnnotate, 'Add notes and tags to a customer'),
  ] satisfies PermissionDef[],
  publishes: Object.values(BOOKING_EVENTS),
  subscribes: [] as string[],
} as const;
