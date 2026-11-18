import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { SettingsService } from '../../platform/flags/flags.service';
import { BookingAmendmentHooks, BookingsModule } from '../bookings';
import { PaymentsModule } from '../payments';
import { TemplatesModule } from '../templates';
import { CustomerAccountService } from './account.service';
import { CustomerAmendmentsService } from './amendments';
import { CustomerAccountController } from './controller';
import { TRAVELLER_ENTITIES } from './entities';
import { AmendmentRateLimitGuard, DocumentRateLimitGuard } from './rate-limit.guard';
import { TravellerDetailsService, defineTravellerSettings } from './traveller.service';

/** The customer area (task 5.1) and traveller details (task 5.2): no permissions, no flag; it reads through other modules' public services. Its one table holds the travellers. */
@Module({
  imports: [BookingsModule, PaymentsModule, TemplatesModule],
  controllers: [CustomerAccountController],
  providers: [CustomerAccountService, DocumentRateLimitGuard, TravellerDetailsService, CustomerAmendmentsService, AmendmentRateLimitGuard],
})
export class CustomerPortalModule implements OnModuleInit {
  constructor(
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(BookingAmendmentHooks) private readonly amendmentHooks: BookingAmendmentHooks,
    @Inject(CustomerAmendmentsService) private readonly amendments: CustomerAmendmentsService,
  ) {}

  /** Traveller details (task 5.2): the setting and the registry entry that lets 5.5 export and erase them. */
  onModuleInit(): void {
    defineTravellerSettings(this.settings);
    for (const e of TRAVELLER_ENTITIES) this.entities.register(e);
    this.amendments.register(this.amendmentHooks);
  }
}
