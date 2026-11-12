import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action>. A complaint holds the complainant's own words and often their
// contact details, and the register is evidence for the complaints procedure, so none of these is an API key scope.
export const COMPLAINTS_PERMISSIONS = {
  read: 'complaints.complaint.read',
  manage: 'complaints.complaint.manage',
} as const;

const def = (key: string, description: string): PermissionDef => ({ key, module: 'complaints', description, requiresStepUp: false, apiKeyScopable: false });

export const complaintsManifest = {
  key: 'complaints',
  /** complaints is a core module with no feature flag: the register is part of the complaints procedure, not an optional extra. */
  flagKey: null,
  permissions: [
    def(COMPLAINTS_PERMISSIONS.read, 'See the complaints register: complaints, their deadlines, notes and history'),
    def(COMPLAINTS_PERMISSIONS.manage, 'Log complaints, edit them, assign an owner, move them through their statuses, resolve them and add notes'),
  ] satisfies PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;
