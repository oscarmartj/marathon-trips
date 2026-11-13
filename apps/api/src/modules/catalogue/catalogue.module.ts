import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CommonModule } from '../../platform/common/common.module';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { CatalogueAdminController } from './admin.controller';
import { CatalogueCsvService } from './csv.service';
import { InventoryService } from './inventory.service';
import { catalogueManifest } from './manifest';
import { CataloguePanelService } from './panel.service';
import { CatalogueChangeGuards, PackageOpenGates } from './open-gates';
import { PackageService } from './package.service';
import { PackagePricingReader } from './pricing-view';
import { CataloguePublicController } from './public.controller';
import { PublicCatalogueService } from './public.service';
import { RaceService } from './race.service';

@Module({
  imports: [CommonModule],
  controllers: [CatalogueAdminController, CataloguePublicController],
  providers: [RaceService, PackageService, InventoryService, PublicCatalogueService, PackageOpenGates, CatalogueChangeGuards, PackagePricingReader, CataloguePanelService, CatalogueCsvService],
  exports: [InventoryService, PublicCatalogueService, PackageOpenGates, CatalogueChangeGuards, PackagePricingReader],
})
export class CatalogueModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
  ) {}

  /** Runs before AccessService syncs the permission table (onApplicationBootstrap). */
  onModuleInit(): void {
    this.permissions.register(catalogueManifest.permissions);
    // A stock movement may name the booking it held places for (task 5.5): no personal data, append-only, kept on erasure.
    this.entities.register({
      entityType: 'InventoryMovement', model: 'InventoryMovement', customerLink: { kind: 'via', entityType: 'Booking', column: 'bookingId' },
      handlers: { export: async () => [], anonymise: async () => undefined },
    });
  }
}
