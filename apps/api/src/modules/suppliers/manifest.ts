import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action> (plan 1.5). Costs reveal the margin, so they have their own pair.
export const SUPPLIERS_PERMISSIONS = {
  supplierRead: 'suppliers.supplier.read',
  supplierManage: 'suppliers.supplier.manage',
  allotmentManage: 'suppliers.allotment.manage',
  costRead: 'suppliers.cost.read',
  costManage: 'suppliers.cost.manage',
} as const;

const def = (key: string, description: string): PermissionDef => ({ key, module: 'suppliers', description, requiresStepUp: false });

export const suppliersManifest = {
  key: 'suppliers',
  flagKey: 'module.suppliers',
  permissions: [
    def(SUPPLIERS_PERMISSIONS.supplierRead, 'See suppliers, contacts, contracts, contracted allotments, release dates and stock cover'),
    def(SUPPLIERS_PERMISSIONS.supplierManage, 'Create and edit suppliers, their contacts and their contracts'),
    def(SUPPLIERS_PERMISSIONS.allotmentManage, 'Create, edit and release contracted allotments'),
    def(SUPPLIERS_PERMISSIONS.costRead, 'See supplier cost prices and the cost totals'),
    def(SUPPLIERS_PERMISSIONS.costManage, 'Create and edit supplier cost items'),
  ] satisfies PermissionDef[],
  publishes: ['suppliers.allotment.released'],
  subscribes: [] as string[],
} as const;
