import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CommonModule } from '../../platform/common/common.module';
import { EntityRegistry } from '../../platform/entities/entity-registry';
import { SettingsService } from '../../platform/flags/flags.service';
import { BookingsModule } from '../bookings';
import { ComplaintsAdminController } from './admin.controller';
import { ComplaintService } from './complaint.service';
import { COMPLAINT_ENTITY } from './entities';
import { complaintsManifest } from './manifest';
import { defineComplaintSettings } from './settings';
import { ComplaintReferences } from './support';

@Module({
  imports: [CommonModule, BookingsModule],
  controllers: [ComplaintsAdminController],
  providers: [ComplaintService, ComplaintReferences],
  exports: [ComplaintService],
})
export class ComplaintsModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
  ) {}

  /** Runs before AccessService syncs the permission table (onApplicationBootstrap). */
  onModuleInit(): void {
    this.permissions.register(complaintsManifest.permissions);
    defineComplaintSettings(this.settings);
    this.entities.register(COMPLAINT_ENTITY);
  }
}
