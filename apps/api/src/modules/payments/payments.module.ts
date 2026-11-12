import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { AuthModule } from '../../platform/auth/auth.module';
import { CommonModule } from '../../platform/common/common.module';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { SettingsService } from '../../platform/flags/flags.service';
import { RawBodyRoutes } from '../../platform/http/raw-body';
import { BookingTransitionHooks, BookingsModule } from '../bookings';
import { PaymentAdminService } from './admin.service';
import { createAdapters } from './adapters';
import { PaymentCustomerController, PaymentWebhooksController, PaymentsAdminController } from './controllers';
import { ProviderAccountsService } from './core/accounts.service';
import { PaymentStateMachine } from './core/attempt-state';
import { PaymentAttemptSyncService } from './core/attempt-sync.service';
import { PaymentAttemptsService } from './core/attempts.service';
import { ProviderGateway } from './core/gateway';
import { PaymentsMaintenanceService } from './core/maintenance.service';
import { PaymentAdapterRegistry } from './core/registry';
import { PaymentRouting } from './core/routing';
import { PaymentScheduleService } from './core/schedule.service';
import { PaymentCoverageService } from './core/coverage.service';
import { definePaymentSettings } from './core/settings';
import { WEBHOOK_MAX_BYTES, WEBHOOK_PATH_PREFIX, PaymentWebhooksService } from './core/webhooks.service';
import { PAYMENT_ENTITIES } from './entities';
import { paymentsManifest } from './manifest';
import { PaymentAttemptRateLimitGuard } from './rate-limit.guard';
import { SimulatorCheckoutService, simulatorCheckoutControllers } from './simulator-checkout/checkout.controller';

@Module({
  imports: [AuthModule, CommonModule, BookingsModule],
  // The simulator's hosted checkout exists only in development, test and ci (plan 3.6, 10.6); APP_ENV is the variable
  // the configuration is parsed from.
  controllers: [PaymentCustomerController, PaymentWebhooksController, PaymentsAdminController, ...simulatorCheckoutControllers(process.env.APP_ENV)],
  providers: [
    { provide: PaymentAdapterRegistry, useFactory: (config: AppConfig) => new PaymentAdapterRegistry(createAdapters({ webOrigin: config.WEB_ORIGIN })), inject: [APP_CONFIG] },
    ProviderGateway, PaymentRouting, PaymentStateMachine, PaymentScheduleService, PaymentAttemptsService, PaymentAttemptSyncService,
    PaymentWebhooksService, PaymentsMaintenanceService, ProviderAccountsService, PaymentAdminService, PaymentAttemptRateLimitGuard, PaymentCoverageService,
    SimulatorCheckoutService,
  ],
  exports: [ProviderAccountsService, PaymentAttemptsService],
})
export class PaymentsModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(BookingTransitionHooks) private readonly hooks: BookingTransitionHooks,
    @Inject(PaymentScheduleService) private readonly schedule: PaymentScheduleService,
    @Inject(PaymentCoverageService) private readonly coverage: PaymentCoverageService,
    @Inject(RawBodyRoutes) private readonly rawBody: RawBodyRoutes,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Permissions, settings, entities, the booking hooks (the plan and its coverage follow the booking) and the webhook bytes. */
  onModuleInit(): void {
    this.permissions.register(paymentsManifest.permissions);
    definePaymentSettings(this.settings);
    for (const e of PAYMENT_ENTITIES) this.entities.register(e);
    this.schedule.register(this.hooks);
    this.coverage.register(this.hooks);
    this.rawBody.register(WEBHOOK_PATH_PREFIX, { maxBytes: WEBHOOK_MAX_BYTES, perIpPerMinute: this.config.PAYMENT_WEBHOOKS_PER_MINUTE_PER_IP });
  }
}
