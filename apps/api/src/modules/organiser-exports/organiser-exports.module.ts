import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { OrganiserExportController } from './controller';
import { organiserExportsManifest } from './manifest';
import { ExportCheckRateLimitGuard, ExportFileRateLimitGuard } from './rate-limit.guard';
import { OrganiserExportService } from './service';

/** Task 7.2: runner data in each race organiser's format. Reads travellers, bookings and the catalogue; writes nothing but an audit row. */
@Module({
  controllers: [OrganiserExportController],
  providers: [OrganiserExportService, ExportFileRateLimitGuard, ExportCheckRateLimitGuard],
})
export class OrganiserExportsModule implements OnModuleInit {
  constructor(@Inject(PermissionRegistry) private readonly permissions: PermissionRegistry) {}

  onModuleInit(): void {
    this.permissions.register(organiserExportsManifest.permissions);
  }
}
