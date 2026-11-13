import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { AlertsModule } from '../alerts';
import { BookingsModule } from '../bookings';
import { CatalogueModule } from '../catalogue';
import { PaymentsModule } from '../payments';
import { DashboardController } from './controller';
import { DashboardService } from './dashboard.service';
import { dashboardManifest } from './manifest';

/** The staff start page (task 5.6): no tables and no flag; it reads other modules through their public APIs. */
@Module({
  imports: [AlertsModule, BookingsModule, CatalogueModule, PaymentsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule implements OnModuleInit {
  constructor(@Inject(PermissionRegistry) private readonly permissions: PermissionRegistry) {}

  onModuleInit(): void {
    this.permissions.register(dashboardManifest.permissions);
  }
}
