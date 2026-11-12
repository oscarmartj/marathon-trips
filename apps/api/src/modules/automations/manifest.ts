import type { PermissionDef } from '../../platform/access/permissions';

// Task 7.4. None of these is an API key scope: a rule acts in the background with its owner's permissions, so an
// integration that could write rules would act beyond its own scopes. Switching a rule on, or changing one that is on,
// needs a recent TOTP check: from then on it acts without anyone watching.
export const AUTOMATIONS_PERMISSIONS = {
  read: 'automations.rule.read',
  manage: 'automations.rule.manage',
  enable: 'automations.rule.enable',
} as const;

export const AUTOMATIONS_MODULE = 'automations';

export const AUTOMATION_EVENTS = {
  runCompleted: 'automations.run.completed',
} as const;

const def = (key: string, description: string, requiresStepUp = false): PermissionDef => ({ key, module: AUTOMATIONS_MODULE, description, requiresStepUp, apiKeyScopable: false });

export const automationsManifest = {
  key: AUTOMATIONS_MODULE,
  flagKey: `module.${AUTOMATIONS_MODULE}`,
  permissions: [
    def(AUTOMATIONS_PERMISSIONS.read, 'See automations and their run log (record ids and codes, no personal data)'),
    def(AUTOMATIONS_PERMISSIONS.manage, 'Create and change automations that are off, switch them off, delete them and run a test (which changes nothing)'),
    def(AUTOMATIONS_PERMISSIONS.enable, 'Switch an automation on, take it out of test mode, or change one that is on; it then acts with your permissions', true),
  ] satisfies PermissionDef[],
  publishes: Object.values(AUTOMATION_EVENTS),
  subscribes: ['bookings.booking.*', 'crm.quote.*', 'catalogue.package.sale_status_changed'],
} as const;

/** The read permission of each record type a rule can be about. */
export const ENTITY_READ_PERMISSION = {
  Booking: 'bookings.booking.read',
  Quote: 'crm.quote.read',
  Package: 'catalogue.package.read',
} as const;

/** The business time zone (plan 0.1, assumption 1), as in the pricing engine, until a setting exists. */
export const AUTOMATIONS_TIME_ZONE = 'Australia/Brisbane';
