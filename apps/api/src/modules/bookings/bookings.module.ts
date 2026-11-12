import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { PrismaService } from '../../platform/database/prisma.service';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { SettingsService } from '../../platform/flags/flags.service';
import { CatalogueModule } from '../catalogue';
import { PricingModule } from '../pricing';
import { WaitlistModule } from '../waitlist';
import { BookingAdminService } from './admin.service';
import { BookingRequestsController, BookingsAdminController } from './controllers';
import { CustomerService } from './customer.service';
import { BOOKING_ENTITIES } from './entities';
import { BookingExpiryService } from './expiry.service';
import { BookingTransitionHooks } from './hooks';
import { bookingsManifest } from './manifest';
import { setOwnershipDb } from './ownership';
import { BookingRequestRateLimitGuard } from './rate-limit.guard';
import { BookingRequestService } from './request.service';
import { defineBookingSettings } from './settings';
import { BookingStateMachine } from './state-machine';
import { ReferenceGenerator } from './support';

@Module({
  imports: [CatalogueModule, PricingModule, WaitlistModule],
  controllers: [BookingRequestsController, BookingsAdminController],
  providers: [
    BookingRequestService, BookingStateMachine, BookingAdminService, BookingExpiryService, BookingTransitionHooks, CustomerService,
    ReferenceGenerator, BookingRequestRateLimitGuard,
  ],
  exports: [BookingTransitionHooks, BookingStateMachine],
})
export class BookingsModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Permissions, settings, the customer links of every bookings table and the ownership check, before serving. */
  onModuleInit(): void {
    this.permissions.register(bookingsManifest.permissions);
    defineBookingSettings(this.settings);
    for (const e of BOOKING_ENTITIES) this.entities.register(e);
    setOwnershipDb(this.prisma);
  }
}
