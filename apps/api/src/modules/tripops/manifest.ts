import type { PermissionDef } from '../../platform/access/permissions';

// Task 7.1. Not an API key scope: the rooming and transfers lists carry travellers' names, so only a signed-in staff
// member with this permission (owner only until roles are assigned) can read or export them.
export const TRIPOPS_PERMISSIONS = {
  read: 'tripops.lists.read',
} as const;

export const TRIPOPS_MODULE = 'tripops';

const def = (key: string, description: string): PermissionDef => ({ key, module: TRIPOPS_MODULE, description, requiresStepUp: false, apiKeyScopable: false });

export const tripopsManifest = {
  key: TRIPOPS_MODULE,
  flagKey: `module.${TRIPOPS_MODULE}`,
  permissions: [
    def(TRIPOPS_PERMISSIONS.read, "See and download a trip's rooming list, transfers list and itinerary (the first two show travellers' names)"),
  ] satisfies PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;
