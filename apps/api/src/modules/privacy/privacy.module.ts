import { Inject, Module, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CommonModule } from '../../platform/common/common.module';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { BookingsModule } from '../bookings';
import { AccountPrivacyService } from './account.service';
import { ConsentService } from './consent.service';
import { AccountPrivacyController, PrivacyAdminController, UnsubscribeController } from './controllers';
import { ErasureService } from './erasure.service';
import { ExportService } from './export.service';
import { privacyManifest } from './manifest';
import { CustomerExportRateLimitGuard, StaffExportRateLimitGuard } from './rate-limit.guard';
import { StaffPrivacyService } from './staff.service';

/**
 * Privacy (task 5.5): export and erasure of a customer's data, marketing consent and one-click unsubscribe. Core, no flag.
 * It owns no customer data of its own: it runs the handlers every module registers in the entity registry.
 */
@Module({
  imports: [CommonModule, BookingsModule],
  controllers: [AccountPrivacyController, PrivacyAdminController, UnsubscribeController],
  providers: [ConsentService, ErasureService, ExportService, AccountPrivacyService, StaffPrivacyService, CustomerExportRateLimitGuard, StaffExportRateLimitGuard],
  exports: [ConsentService, ErasureService],
})
export class PrivacyModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
  ) {}

  onModuleInit(): void {
    this.permissions.register(privacyManifest.permissions);
    this.entities.register({ entityType: 'PrivacyRequest', model: 'PrivacyRequest' });
    this.entities.register({ entityType: 'ConsentRecord', model: 'ConsentRecord' });
  }

  /** Every module has registered its tables by now: a broken customer link stops the API from starting. */
  onApplicationBootstrap(): void {
    this.entities.validate();
  }
}
