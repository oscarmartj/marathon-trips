import type { PermissionDef } from '../../platform/access/permissions';

export const ALERTS_PERMISSIONS = { subscriptionRead: 'alerts.subscription.read' } as const;

export const alertsManifest = {
  key: 'alerts',
  /** alerts is a core module with no feature flag (plan 3.1). */
  flagKey: null,
  permissions: [
    { key: ALERTS_PERMISSIONS.subscriptionRead, module: 'alerts', description: 'See how many people are subscribed to opening alerts for each race (counts only, never addresses)', requiresStepUp: false },
  ] satisfies PermissionDef[],
  publishes: ['alerts.subscription.confirmed'],
  subscribes: ['catalogue.package.sale_status_changed'],
} as const;
