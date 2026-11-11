// The public API of the catalogue module (plan 3.1). Other modules import from here and nowhere else in this folder.
export { CatalogueModule } from './catalogue.module';
export { catalogueManifest, CATALOGUE_PERMISSIONS } from './manifest';
export { InventoryService, stockOf } from './inventory.service';
export type { HoldContext, StockState } from './inventory.service';
export { PackageOpenGates } from './open-gates';
export type { OpenGate, OpenGateResult, GatedPackage } from './open-gates';
export { PublicCatalogueService, guaranteedEntryOf } from './public.service';
export { SALE_TRANSITIONS } from './transitions';
