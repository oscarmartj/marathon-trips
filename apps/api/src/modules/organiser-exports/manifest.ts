import type { PermissionDef } from '../../platform/access/permissions';

// Task 7.2. Personal data leaves the system to a third party, so: no API key scope, no role holds them by default (the
// owner role holds every permission, so owner-only until the owner gives them to a role), and the file needs a recent
// authenticator check. Looking at the formats and the dry-run check shows no personal value and needs none.
export const ORGANISER_EXPORT_PERMISSIONS = {
  read: 'exports.runnerData.read',
  generate: 'exports.runnerData.generate',
} as const;

export const ORGANISER_EXPORTS_MODULE = 'organiser-exports';

export const organiserExportsManifest = {
  key: ORGANISER_EXPORTS_MODULE,
  permissions: [
    { key: ORGANISER_EXPORT_PERMISSIONS.read, module: 'exports', description: 'See the organiser export formats of an edition and check which runners are ready (counts and problems, no personal details)', requiresStepUp: false, apiKeyScopable: false },
    { key: ORGANISER_EXPORT_PERMISSIONS.generate, module: 'exports', description: 'Download runner data in a race organiser format (personal data leaves the system)', requiresStepUp: true, apiKeyScopable: false },
  ] satisfies PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;

/** Booking states whose runners are exported: the deposit is paid and the booking is still on. */
export const EXPORT_BOOKING_STATUSES = ['deposit_paid', 'confirmed', 'balance_paid'] as const;

/** Most runners one file can hold; more is a 422 rather than a slow request. */
export const MAX_EXPORT_RUNNERS = 5000;
