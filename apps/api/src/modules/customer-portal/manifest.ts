import type { PermissionDef } from '../../platform/access/permissions';

// The customer area (task 5.1) and traveller details (task 5.2). It declares no permissions: every route is a customer's own.
export const customerPortalManifest = {
  key: 'customerPortal',
  /**
   * No feature flag, like complaints: the area is where customers see what they booked and how to pay it; switching it
   * off would leave them with payments due and nowhere to read about them (plan docs/plans/5.1-customer-area.md, 2.4).
   */
  flagKey: null,
  permissions: [] as PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;
