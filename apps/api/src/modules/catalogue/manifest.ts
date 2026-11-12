import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action> (plan 1.5). Reading the catalogue in the panel is split by resource;
// claims that appear as badges on the website need a recent TOTP check.
export const CATALOGUE_PERMISSIONS = {
  raceRead: 'catalogue.race.read',
  raceManage: 'catalogue.race.manage',
  claimManage: 'catalogue.claim.manage',
  packageRead: 'catalogue.package.read',
  packageManage: 'catalogue.package.manage',
  packageSetSaleStatus: 'catalogue.package.setSaleStatus',
  hotelManage: 'catalogue.hotel.manage',
  inventoryManage: 'catalogue.inventory.manage',
} as const;

const def = (key: string, description: string, requiresStepUp = false): PermissionDef => ({ key, module: 'catalogue', description, requiresStepUp });

export const catalogueManifest = {
  key: 'catalogue',
  /** catalogue has no feature flag: it cannot be switched off (plan 3.1). */
  flagKey: null,
  permissions: [
    { ...def(CATALOGUE_PERMISSIONS.raceRead, 'See races, editions and distances, including drafts'), apiKeyScopable: true },
    { ...def(CATALOGUE_PERMISSIONS.raceManage, 'Create and edit races, distances and editions, and publish or archive a race'), apiKeyScopable: true },
    def(CATALOGUE_PERMISSIONS.claimManage, 'Turn race claims (official partner, accredited agent, guaranteed entry) on and off', true),
    { ...def(CATALOGUE_PERMISSIONS.packageRead, 'See packages, hotels, rooms, extras and stock levels, including drafts'), apiKeyScopable: true },
    { ...def(CATALOGUE_PERMISSIONS.packageManage, 'Create and edit packages, their hotels, rooms and extras'), apiKeyScopable: true },
    { ...def(CATALOGUE_PERMISSIONS.packageSetSaleStatus, 'Change the sale status of a package'), apiKeyScopable: true },
    { ...def(CATALOGUE_PERMISSIONS.hotelManage, 'Create and edit hotels'), apiKeyScopable: true },
    { ...def(CATALOGUE_PERMISSIONS.inventoryManage, 'Create stock pools and change their capacity and supplier confirmation'), apiKeyScopable: true },
  ] satisfies PermissionDef[],
  publishes: ['catalogue.race.published', 'catalogue.package.sale_status_changed', 'catalogue.inventory.released'],
  subscribes: [] as string[],
} as const;
