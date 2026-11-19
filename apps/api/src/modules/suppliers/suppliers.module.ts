import { Inject, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CommonModule } from '../../platform/common/common.module';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { ConsumerRegistry } from '../../platform/events/consumers';
import { FlagRegistry } from '../../platform/flags/flag-registry';
import { JobsService } from '../../platform/jobs/jobs.service';
import { QUEUES } from '../../platform/jobs/queues';
import { PaymentsModule } from '../payments';
import { SuppliersAdminController } from './admin.controller';
import { AllotmentService } from './allotment.service';
import { CostService } from './cost.service';
import { suppliersManifest } from './manifest';
import { PaymentScheduleService, SUPPLIERS_MODULE } from './payment-schedule.service';
import { SupplierPaymentsAdminController } from './payments.controller';
import { SupplierPaymentService } from './supplier-payment.service';
import { SupplierService } from './supplier.service';

@Module({
  imports: [CommonModule, PaymentsModule],
  // The payments controller first: its fixed `payments/...` paths must win over `:id`.
  controllers: [SupplierPaymentsAdminController, SuppliersAdminController],
  providers: [SupplierService, AllotmentService, CostService, SupplierPaymentService, PaymentScheduleService],
  exports: [AllotmentService, CostService, SupplierService, PaymentScheduleService],
})
export class SuppliersModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(FlagRegistry) private readonly flags: FlagRegistry,
    @Inject(ConsumerRegistry) private readonly consumers: ConsumerRegistry,
    @Inject(PaymentScheduleService) private readonly schedule: PaymentScheduleService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Runs before AccessService syncs the permission table (onApplicationBootstrap). */
  onModuleInit(): void {
    this.permissions.register(suppliersManifest.permissions);
    this.flags.declareModule(SUPPLIERS_MODULE, 'Suppliers, contracts, contracted allotments, supplier cost prices and supplier payments');
    // Task 6.2 (plan section 3.4): a cancelled or changed booking may change what suppliers are owed. Booking events are
    // protected, so they wait while the module is off.
    this.consumers.register({
      name: 'suppliers.cost_review', module: SUPPLIERS_MODULE, events: ['bookings.booking.cancelled', 'bookings.booking.amended'], whenDisabled: 'hold',
      handle: (event, ctx) => this.schedule.onBookingChanged(event, ctx.tx),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.JOBS_WORKERS !== 'on') return;
    await this.jobs.work(QUEUES.suppliersPaymentAlerts, async () => void (await this.schedule.sweep()));
    // Hourly: Brisbane midnight falls inside an hour, so a daily run could be up to a day late.
    await this.jobs.schedule(QUEUES.suppliersPaymentAlerts, '20 * * * *');
  }
}
