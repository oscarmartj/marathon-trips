// The public API of the catalogue module (plan 3.1). Other modules import from here and nowhere else in this folder.
export { CatalogueModule } from './catalogue.module';
export { catalogueManifest, CATALOGUE_PERMISSIONS } from './manifest';
export { InventoryService, stockOf } from './inventory.service';
export type { DemandConfiguration, HoldContext, StockState } from './inventory.service';
export { CatalogueChangeGuards, PackageOpenGates } from './open-gates';
export type { OpenGate, OpenGateResult, GatedPackage, ChangeGuard, ChangeTarget } from './open-gates';
export { PackagePricingReader } from './pricing-view';
export type { PackagePricingView } from './pricing-view';
export { lockPackage } from './support';
export { LIVE_SALE_STATUSES } from './transitions';
export { PublicCatalogueService, guaranteedEntryOf } from './public.service';
export { SALE_TRANSITIONS } from './transitions';
export { readPackageForAutomations, existingCatalogueIds } from './automation-read';
export type { PackageForAutomations } from './automation-read';
