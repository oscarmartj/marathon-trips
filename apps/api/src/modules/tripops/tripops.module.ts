import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../../platform/access/permissions';
import { CommonModule } from '../../platform/common/common.module';
import { TripOpsController } from './controller';
import { tripopsManifest } from './manifest';
import { TripOpsService } from './tripops.service';

/** Task 7.1: the rooming list, the transfers list and the itinerary of a trip. Read-only; it owns no table. */
@Module({
  imports: [CommonModule],
  controllers: [TripOpsController],
  providers: [TripOpsService],
  exports: [TripOpsService],
})
export class TripOpsModule implements OnModuleInit {
  constructor(@Inject(PermissionRegistry) private readonly permissions: PermissionRegistry) {}

  onModuleInit(): void {
    this.permissions.register(tripopsManifest.permissions);
  }
}
