import type { PermissionDef } from '../../platform/access/permissions';

// Task 7.7. None of these is an API key scope: they expose business metrics, and a saved report can email them.
export const REPORTS_PERMISSIONS = {
  funnelRead: 'reports.funnel.read',
  read: 'reports.report.read',
  manage: 'reports.report.manage',
} as const;

export const REPORTS_MODULE = 'reports';

const def = (key: string, description: string): PermissionDef => ({ key, module: REPORTS_MODULE, description, requiresStepUp: false, apiKeyScopable: false });

export const reportsManifest = {
  key: REPORTS_MODULE,
  flagKey: `module.${REPORTS_MODULE}`,
  permissions: [
    def(REPORTS_PERMISSIONS.funnelRead, 'See visits, builder use, requests and paid bookings for each race, and use the funnel as a report'),
    def(REPORTS_PERMISSIONS.read, 'See saved reports and run them (a report also needs the permission of the data it counts)'),
    def(REPORTS_PERMISSIONS.manage, 'Create, change and delete saved reports, and choose which staff receive them by email on a schedule'),
  ] satisfies PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;

/** The business time zone, as in the key dates calendar. Brisbane has no daylight saving: it is UTC+10 all year. */
export const REPORTS_TIME_ZONE = 'Australia/Brisbane';
export const REPORTS_UTC_OFFSET_HOURS = 10;
export const REPORT_EMAIL_TEMPLATE = 'reports.scheduled';
