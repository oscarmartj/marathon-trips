import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CatalogueModule, CatalogueChangeGuards, PackageOpenGates } from '../catalogue';
import { PricingAdminController, PricingPublicController } from './controllers';
import { pricingManifest } from './manifest';
import { PriceVersionService } from './price-version.service';
import { QuoteRateLimitGuard } from './quote-rate-limit.guard';
import { QuoteService } from './quote.service';

@Module({
  imports: [CatalogueModule],
  controllers: [PricingAdminController, PricingPublicController],
  providers: [PriceVersionService, QuoteService, QuoteRateLimitGuard],
  exports: [QuoteService],
})
export class PricingModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(PackageOpenGates) private readonly gates: PackageOpenGates,
    @Inject(CatalogueChangeGuards) private readonly changes: CatalogueChangeGuards,
    @Inject(PriceVersionService) private readonly versions: PriceVersionService,
  ) {}

  /** Permissions, the open gate (pending since 1.1) and the change guards, before the app serves anything. */
  onModuleInit(): void {
    this.permissions.register(pricingManifest.permissions);
    this.gates.register('pricing.current_price_version', (tx, pkg) => this.versions.openGate(tx, pkg.id));
    this.changes.register('pricing.rates', (tx, target) => this.versions.changeGate(tx, target));
  }
}
