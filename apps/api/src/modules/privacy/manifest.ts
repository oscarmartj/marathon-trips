import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action>. Export and erasure reveal or remove everything about a person: they
// need a recent authenticator check and, in the service, the owner role (plan docs/plans/5.5-privacy-export-erase.md,
// section 8). None is an API key scope.
export const PRIVACY_PERMISSIONS = {
  read: 'privacy.customer.read',
  export: 'privacy.customer.export',
  erase: 'privacy.customer.erase',
} as const;

const def = (key: string, description: string, requiresStepUp: boolean): PermissionDef => ({ key, module: 'privacy', description, requiresStepUp, apiKeyScopable: false });

export const PRIVACY_EVENTS = { customerErased: 'privacy.customer.erased' } as const;

export const privacyManifest = {
  key: 'privacy',
  /** Core module with no feature flag: exporting and erasing personal data and honouring unsubscribes are legal duties. */
  flagKey: null,
  permissions: [
    def(PRIVACY_PERMISSIONS.read, "See a customer's marketing consent, privacy requests and whether they can be erased", false),
    def(PRIVACY_PERMISSIONS.export, "Download everything held about a customer (owners only)", true),
    def(PRIVACY_PERMISSIONS.erase, "Erase a customer's personal data (owners only; bookings and payments are kept, anonymised)", true),
  ] satisfies PermissionDef[],
  publishes: [PRIVACY_EVENTS.customerErased] as string[],
  subscribes: [] as string[],
} as const;
