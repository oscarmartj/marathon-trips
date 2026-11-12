import type { PermissionDef } from '../../platform/access/permissions';

// Task 7.3. Neither is an API key scope: the calendar counts bookings with a balance to collect, and an integration
// that could write dates would be opening tasks for staff.
export const KEYDATES_PERMISSIONS = {
  read: 'keydates.date.read',
  manage: 'keydates.date.manage',
} as const;

export const KEYDATES_MODULE = 'keydates';

const def = (key: string, description: string): PermissionDef => ({ key, module: KEYDATES_MODULE, description, requiresStepUp: false, apiKeyScopable: false });

export const keydatesManifest = {
  key: KEYDATES_MODULE,
  flagKey: `module.${KEYDATES_MODULE}`,
  permissions: [
    def(KEYDATES_PERMISSIONS.read, 'See the key dates calendar: allotment release dates, balance due dates, entry submission deadlines and custom dates'),
    def(KEYDATES_PERMISSIONS.manage, 'Add, change and delete entry submission deadlines and custom dates'),
  ] satisfies PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;

/** The business time zone (plan 0.1, assumption 1). Brisbane has no daylight saving, so a day starts at 14:00 UTC the day before. */
export const KEYDATES_TIME_ZONE = 'Australia/Brisbane';
