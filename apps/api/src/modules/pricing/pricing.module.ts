import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { CatalogueModule, CatalogueChangeGuards, PackageOpenGates } from '../catalogue';
import { PricingAdjustmentsController, PricingAdminController, PricingPublicController } from './controllers';
import { pricingManifest } from './manifest';
import { PriceVersionService } from './price-version.service';
import { PromoAttemptGuard } from './promo-attempt.guard';
import { PromoCodeService } from './promo-code.service';
import { PromoRedemptionService } from './promo-redemption.service';
import { QuoteRateLimitGuard } from './quote-rate-limit.guard';
import { PriceRuleService } from './rule.service';
import { QuoteService } from './quote.service';

@Module({
  imports: [CatalogueModule],
  controllers: [PricingAdminController, PricingAdjustmentsController, PricingPublicController],
  providers: [PriceVersionService, QuoteService, QuoteRateLimitGuard, PromoAttemptGuard, PriceRuleService, PromoCodeService, PromoRedemptionService],
  exports: [QuoteService, PromoRedemptionService, PromoAttemptGuard],
})
export class PricingModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(PackageOpenGates) private readonly gates: PackageOpenGates,
    @Inject(CatalogueChangeGuards) private readonly changes: CatalogueChangeGuards,
    @Inject(PriceVersionService) private readonly versions: PriceVersionService,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
  ) {}

  /** Permissions, the open gate (pending since 1.1) and the change guards, before the app serves anything. */
  onModuleInit(): void {
    this.permissions.register(pricingManifest.permissions);
    this.gates.register('pricing.current_price_version', (tx, pkg) => this.versions.openGate(tx, pkg.id));
    this.changes.register('pricing.rates', (tx, target) => this.versions.changeGate(tx, target));
    // A redemption links a promo code to the customer's booking (task 5.5): the code and dates are theirs to see; no
    // personal data, so erasure keeps it.
    this.entities.register({
      entityType: 'PromoRedemption', model: 'PromoRedemption', customerLink: { kind: 'column', column: 'customerId' },
      handlers: {
        export: (tx, customerId) => tx.promoRedemption.findMany({ where: { customerId }, select: { bookingId: true, redeemedAt: true, releasedAt: true, promoCode: { select: { code: true } } }, orderBy: { redeemedAt: 'asc' } }),
        anonymise: async () => undefined,
      },
    });
  }
}
