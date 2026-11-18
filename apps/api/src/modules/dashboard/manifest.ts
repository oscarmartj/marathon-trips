import type { PermissionDef } from '../../platform/access/permissions';

export const DASHBOARD_MODULE = 'dashboard';
export const DASHBOARD_ROUTE_PERMISSION = 'dashboard.home.read';

// The start page itself. Opening it shows nothing on its own: each section appears only when the person also holds the
// permission that reads it (bookings, payments, catalogue, alerts, tasks). Not an API key scope: it is a screen, and an
// integration should call the module that owns the data.
export const dashboardManifest = {
  key: DASHBOARD_MODULE,
  flagKey: null,
  permissions: [
    { key: DASHBOARD_ROUTE_PERMISSION, module: DASHBOARD_MODULE, description: 'Open the staff start page. Each section shows only if you can also read what it lists: booking requests, payments, places left, alert subscribers or tasks', requiresStepUp: false, apiKeyScopable: false },
  ] satisfies PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;
