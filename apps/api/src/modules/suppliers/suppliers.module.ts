import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { FlagRegistry } from '../../platform/flags/flag-registry';
import { SuppliersAdminController } from './admin.controller';
import { AllotmentService } from './allotment.service';
import { CostService } from './cost.service';
import { suppliersManifest } from './manifest';
import { SupplierService } from './supplier.service';

@Module({
  controllers: [SuppliersAdminController],
  providers: [SupplierService, AllotmentService, CostService],
  exports: [AllotmentService, CostService, SupplierService],
})
export class SuppliersModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(FlagRegistry) private readonly flags: FlagRegistry,
  ) {}

  /** Runs before AccessService syncs the permission table (onApplicationBootstrap). */
  onModuleInit(): void {
    this.permissions.register(suppliersManifest.permissions);
    this.flags.declareModule('suppliers', 'Suppliers, contracts, contracted allotments and supplier cost prices');
  }
}
