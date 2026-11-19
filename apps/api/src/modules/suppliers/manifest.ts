import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action> (plan 1.5). Costs reveal the margin, so they have their own pair.
export const SUPPLIERS_PERMISSIONS = {
  supplierRead: 'suppliers.supplier.read',
  supplierManage: 'suppliers.supplier.manage',
  allotmentManage: 'suppliers.allotment.manage',
  costRead: 'suppliers.cost.read',
  costManage: 'suppliers.cost.manage',
  /** Task 6.2: record a payment already made to a supplier (the app sends no money). */
  paymentRecord: 'suppliers.payment.record',
  /** Task 6.2: void a supplier payment recorded by mistake. */
  paymentVoid: 'suppliers.payment.void',
} as const;

/** Task 6.2: events of recorded and voided supplier payments (ids and amounts only). Not in the outbound webhook catalogue. */
export const SUPPLIER_PAYMENT_EVENTS = {
  recorded: 'suppliers.payment.recorded',
  voided: 'suppliers.payment.voided',
} as const;

const def = (key: string, description: string): PermissionDef => ({ key, module: 'suppliers', description, requiresStepUp: false });

export const suppliersManifest = {
  key: 'suppliers',
  flagKey: 'module.suppliers',
  permissions: [
    { ...def(SUPPLIERS_PERMISSIONS.supplierRead, 'See suppliers, contacts, contracts, contracted allotments, release dates and stock cover'), apiKeyScopable: true },
    { ...def(SUPPLIERS_PERMISSIONS.supplierManage, 'Create and edit suppliers, their contacts and their contracts'), apiKeyScopable: true },
    { ...def(SUPPLIERS_PERMISSIONS.allotmentManage, 'Create, edit and release contracted allotments'), apiKeyScopable: true },
    def(SUPPLIERS_PERMISSIONS.costRead, 'See supplier cost prices and the cost totals'),
    def(SUPPLIERS_PERMISSIONS.costManage, 'Create and edit supplier cost items'),
    // Money facts: step-up, never an API key (plan 6.2, section 8).
    { ...def(SUPPLIERS_PERMISSIONS.paymentRecord, 'Record a payment you already made to a supplier from your bank (no money is sent)'), requiresStepUp: true, apiKeyScopable: false },
    { ...def(SUPPLIERS_PERMISSIONS.paymentVoid, 'Void a supplier payment that was recorded by mistake'), requiresStepUp: true, apiKeyScopable: false },
  ] satisfies PermissionDef[],
  publishes: ['suppliers.allotment.released', ...Object.values(SUPPLIER_PAYMENT_EVENTS)],
  subscribes: ['bookings.booking.cancelled', 'bookings.booking.amended'] as string[],
} as const;
