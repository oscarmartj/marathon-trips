import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { AuthModule } from '../../platform/auth/auth.module';
import { CommonModule } from '../../platform/common/common.module';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG, PrismaService } from '../../platform/database/prisma.service';
import { TasksService } from '../../platform/common/tasks/tasks.service';
import { PrismaCardSessionStore } from './core/card-sessions/prisma-store';
import { CardSessionsService } from './core/card-sessions/card-sessions.service';
import { CardSessionsController } from './card-sessions.controller';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { SettingsService } from '../../platform/flags/flags.service';
import { RawBodyRoutes } from '../../platform/http/raw-body';
import { PricingModule } from '../pricing';
import { BookingAmendmentHooks, BookingCancellationHooks, BookingTransitionHooks, BookingsModule } from '../bookings';
import { TemplatesModule } from '../templates';
import { MailTemplateRegistry } from '../../platform/mail/templates';
import { PAYMENT_LINK_TEMPLATE, PaymentLinksService } from './core/payment-links.service';
import { PaymentPendingService } from './core/pending.service';
import { PAYMENT_REMINDER_TEMPLATE, PaymentRemindersService } from './core/reminders.service';
import { PaymentAdminService } from './admin.service';
import { adapterOptions, createAdapters } from './adapters';
import { ManualProvider } from './adapters/manual/manual';
import { ManualMethodsService } from './core/manual-methods.service';
import { ManualTransfersService } from './core/manual-transfers.service';
import { InboundPaymentHooks } from './core/inbound-hooks';
import { PaymentCustomerController, PaymentLinksController, PaymentWebhooksController, PaymentsAdminController, ProviderAccountsAdminController } from './controllers';
import { ProviderAccountsAdminService, ProviderAccountsBootCheck } from './core/account-admin.service';
import { CollectionCoverageGuard } from './core/coverage-guard';
import { ProviderAccountsService } from './core/accounts.service';
import { PaymentStateMachine } from './core/attempt-state';
import { PaymentAttemptSyncService } from './core/attempt-sync.service';
import { PaymentAttemptsService } from './core/attempts.service';
import { ProviderGateway } from './core/gateway';
import { PaymentsMaintenanceService } from './core/maintenance.service';
import { PaymentAdapterRegistry } from './core/registry';
import { PaymentRouting } from './core/routing';
import { ProviderHealthService } from './core/provider-health.service';
import { RoutingRulesAdminService } from './core/routing-admin.service';
import { RoutingRulesAdminController } from './routing.controller';
import { PaymentScheduleService } from './core/schedule.service';
import { PaymentCoverageService } from './core/coverage.service';
import { definePaymentSettings } from './core/settings';
import { WEBHOOK_MAX_BYTES, WEBHOOK_PATH_PREFIX, PaymentWebhooksService } from './core/webhooks.service';
import { PAYMENT_ENTITIES } from './entities';
import { paymentsManifest } from './manifest';
import { TermsService } from './core/terms.service';
import { LedgerService } from './core/ledger.service';
import { PaymentRefundStateMachine } from './core/refunds.service';
import { PaymentRefundSyncService } from './core/refund-sync.service';
import { PaymentLedgerCheckService } from './core/ledger-check.service';
import { PaymentAmendmentService } from './core/amendment-plan.service';
import { PaymentCancellationService } from './core/cancellation-money.service';
import { CheckoutRateLimitGuard, PaymentAttemptRateLimitGuard, PaymentLinkRateLimitGuard, PaymentLinkStartRateLimitGuard, ProviderAccountRateLimitGuard } from './rate-limit.guard';
import { SimulatorCheckoutService, simulatorCheckoutControllers } from './simulator-checkout/checkout.controller';
import { AppRefundsService } from './core/app-refunds.service';
import { PaymentDisputesService } from './core/disputes.service';
import { PaymentRefundsAdminController } from './refunds.controller';
import { PaymentReconciliationAdminController } from './reconciliation.controller';
import { SupplierLedger } from './core/supplier-ledger.service';
import { ClientMoneyService } from './core/client-money.service';
import { DisputeSyncService } from './core/dispute-sync.service';
import { RECEIPT_EVENTS, ReceiptsService } from './core/receipts.service';
import { ReconciliationService } from './core/reconciliation.service';
import { SettlementsService } from './core/settlements.service';
import { ConsumerRegistry } from '../../platform/events/consumers';

@Module({
  imports: [AuthModule, CommonModule, BookingsModule, TemplatesModule, PricingModule],
  // The simulator's hosted checkout exists only in development, test and ci (plan 3.6, 10.6); APP_ENV is the variable
  // the configuration is parsed from.
  controllers: [PaymentCustomerController, PaymentLinksController, PaymentWebhooksController, PaymentsAdminController, ProviderAccountsAdminController, RoutingRulesAdminController, PaymentRefundsAdminController, PaymentReconciliationAdminController, CardSessionsController, ...simulatorCheckoutControllers(process.env.APP_ENV)],
  providers: [
    {
      provide: PaymentAdapterRegistry,
      // Task 4.4: the card sessions of Pin Payments live in the database (migration 0039).
      useFactory: (config: AppConfig, prisma: PrismaService, tasks: TasksService) =>
        new PaymentAdapterRegistry([...createAdapters(adapterOptions(config.APP_ENV, config.WEB_ORIGIN, new PrismaCardSessionStore(prisma, tasks))), new ManualProvider()]),
      inject: [APP_CONFIG, PrismaService, TasksService],
    },
    ProviderGateway, ProviderHealthService, PaymentRouting, PaymentStateMachine, PaymentScheduleService, PaymentAttemptsService, PaymentAttemptSyncService,
    PaymentWebhooksService, PaymentsMaintenanceService, ProviderAccountsService, PaymentAdminService, PaymentAttemptRateLimitGuard, CheckoutRateLimitGuard, PaymentLinkRateLimitGuard, PaymentLinkStartRateLimitGuard, PaymentCoverageService, TermsService, PaymentLinksService, PaymentRemindersService, PaymentPendingService, PaymentAmendmentService, PaymentCancellationService,
    SimulatorCheckoutService, ManualMethodsService, ManualTransfersService, InboundPaymentHooks, LedgerService, PaymentRefundStateMachine, PaymentRefundSyncService, PaymentLedgerCheckService,
    CollectionCoverageGuard, ProviderAccountsAdminService, ProviderAccountsBootCheck, ProviderAccountRateLimitGuard, RoutingRulesAdminService,
    AppRefundsService, PaymentDisputesService,
    SettlementsService, DisputeSyncService, ReconciliationService, ReceiptsService, ClientMoneyService, CardSessionsService, SupplierLedger,
  ],
  exports: [SupplierLedger, ReceiptsService, ProviderAccountsService, ProviderAccountsAdminService, InboundPaymentHooks, PaymentAttemptsService, PaymentAttemptSyncService, PaymentPendingService, TermsService],
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
    @Inject(MailTemplateRegistry) private readonly mailTemplates: MailTemplateRegistry,
    @Inject(PaymentLinksService) private readonly links: PaymentLinksService,
    @Inject(PaymentRemindersService) private readonly reminders: PaymentRemindersService,
    @Inject(BookingAmendmentHooks) private readonly amendmentHooks: BookingAmendmentHooks,
    @Inject(PaymentAmendmentService) private readonly amendments: PaymentAmendmentService,
    @Inject(BookingCancellationHooks) private readonly cancellationHooks: BookingCancellationHooks,
    @Inject(PaymentCancellationService) private readonly cancellations: PaymentCancellationService,
    @Inject(InboundPaymentHooks) private readonly inbound: InboundPaymentHooks,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(ProviderAccountsAdminService) private readonly accountsAdmin: ProviderAccountsAdminService,
    @Inject(ConsumerRegistry) private readonly consumers: ConsumerRegistry,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
  ) {}

  /** Permissions, settings, entities, the booking hooks (the plan and its coverage follow the booking) and the webhook bytes. */
  onModuleInit(): void {
    this.permissions.register(paymentsManifest.permissions);
    definePaymentSettings(this.settings);
    for (const e of PAYMENT_ENTITIES) this.entities.register(e);
    this.schedule.register(this.hooks);
    this.coverage.register(this.hooks);
    this.amendments.register(this.amendmentHooks);
    // Task 6.4: what a cancellation needs to know about the money, and its after phase.
    this.cancellations.register(this.hooks, this.cancellationHooks);
    // Task 3.3: the ledger follows a confirmed bank transfer and its void (task 3.4's hooks), in the same transaction.
    this.inbound.onConfirmed('payments.ledger', async (tx, p) => void (await this.ledger.postPaymentSucceeded(tx, { id: p.bookingId, currency: p.currency }, p)));
    this.inbound.onVoided('payments.ledger', async (tx, p) => void (await this.ledger.postInboundVoided(tx, { id: p.bookingId, currency: p.currency }, p)));
    this.mailTemplates.register({ ...PAYMENT_LINK_TEMPLATE, render: (ctx) => this.links.renderEmail(ctx) });
    this.mailTemplates.register({ ...PAYMENT_REMINDER_TEMPLATE, render: (ctx) => this.reminders.renderEmail(ctx) });
    // Task 4.5: an account with a dispute still open cannot be archived (plan 4.1, 4.3 hook).
    this.accountsAdmin.registerArchiveCheck('payments.disputes', async (tx, accountId) => {
      const open = await tx.dispute.count({ where: { providerAccountId: accountId, status: { in: ['open', 'evidence_submitted'] } } });
      return open > 0 ? ['open_dispute'] : [];
    });
    // Task 4.6: every posting that records money in or out gets its receipt or note, in the delivery's transaction.
    this.consumers.register({
      name: 'payments.receipts', module: 'payments', events: [...RECEIPT_EVENTS], whenDisabled: 'hold',
      handle: (event, ctx) => this.receipts.onEvent(event, ctx.tx),
    });
    this.rawBody.register(WEBHOOK_PATH_PREFIX, { maxBytes: WEBHOOK_MAX_BYTES, perIpPerMinute: this.config.PAYMENT_WEBHOOKS_PER_MINUTE_PER_IP });
  }
}
