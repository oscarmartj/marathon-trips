import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action>. None is an API key scope (plan 2.5, section 2, point 2): a quote names a
// customer and sending or withdrawing one writes to that customer.
export const CRM_PERMISSIONS = {
  quoteRead: 'crm.quote.read',
  quoteCreate: 'crm.quote.create',
  quoteSend: 'crm.quote.send',
  quoteWithdraw: 'crm.quote.withdraw',
} as const;

const def = (key: string, description: string): PermissionDef => ({ key, module: 'crm', description, requiresStepUp: false, apiKeyScopable: false });

export const CRM_EVENTS = {
  quoteSent: 'crm.quote.sent',
  quoteAccepted: 'crm.quote.accepted',
  quoteExpired: 'crm.quote.expired',
} as const;

export const crmManifest = {
  key: 'crm',
  /** crm has no feature flag: it sends the emails that tell customers what happened to their booking (plan 0.1, 9.12). */
  flagKey: null,
  permissions: [
    def(CRM_PERMISSIONS.quoteRead, 'See quotes, with the customer they are for and the price they hold'),
    def(CRM_PERMISSIONS.quoteCreate, 'Prepare a quote for a customer; the price comes from the pricing engine'),
    def(CRM_PERMISSIONS.quoteSend, 'Send a quote to its customer, who can then accept it until it expires'),
    def(CRM_PERMISSIONS.quoteWithdraw, 'Withdraw a quote so it can no longer be accepted'),
  ] satisfies PermissionDef[],
  publishes: Object.values(CRM_EVENTS),
  subscribes: ['bookings.booking.*'],
} as const;
