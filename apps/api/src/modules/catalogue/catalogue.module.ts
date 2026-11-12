import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CatalogueAdminController } from './admin.controller';
import { CatalogueCsvService } from './csv.service';
import { InventoryService } from './inventory.service';
import { catalogueManifest } from './manifest';
import { CataloguePanelService } from './panel.service';
import { CatalogueRemovalGuards, PackageOpenGates } from './open-gates';
import { PackageService } from './package.service';
import { PackagePricingReader } from './pricing-view';
import { CataloguePublicController } from './public.controller';
import { PublicCatalogueService } from './public.service';
import { RaceService } from './race.service';

@Module({
  controllers: [CatalogueAdminController, CataloguePublicController],
  providers: [RaceService, PackageService, InventoryService, PublicCatalogueService, PackageOpenGates, CatalogueRemovalGuards, PackagePricingReader, CataloguePanelService, CatalogueCsvService],
  exports: [InventoryService, PublicCatalogueService, PackageOpenGates, CatalogueRemovalGuards, PackagePricingReader],
})
export class CatalogueModule implements OnModuleInit {
  constructor(@Inject(PermissionRegistry) private readonly permissions: PermissionRegistry) {}

  /** Runs before AccessService syncs the permission table (onApplicationBootstrap). */
  onModuleInit(): void {
    this.permissions.register(catalogueManifest.permissions);
  }
}
