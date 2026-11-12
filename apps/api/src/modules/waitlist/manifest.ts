import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action>. Reading the list shows customers' addresses and countries, so it is
// not an API key scope (the same reasoning as bookings.booking.read, plan 2.4, section 7).
export const WAITLIST_PERMISSIONS = { read: 'waitlist.entry.read' } as const;

export const WAITLIST_EVENTS = { joined: 'waitlist.entry.joined' } as const;

export const waitlistManifest = {
  key: 'waitlist',
  /** waitlist is a core module with no feature flag (plan 0.1, 3.2). */
  flagKey: null,
  permissions: [
    { key: WAITLIST_PERMISSIONS.read, module: 'waitlist', description: 'See who is on the waiting list for each package, with their contact and country of residence', requiresStepUp: false, apiKeyScopable: false },
  ] satisfies PermissionDef[],
  publishes: Object.values(WAITLIST_EVENTS),
  subscribes: [] as string[],
} as const;
