import { Controller, Get, Inject } from '@nestjs/common';
import { RequirePermission } from '../access/access.decorators';
import { PERMISSIONS } from '../access/permissions';
import { SystemMonitorService } from './system-monitor.service';

/** The system monitor (task 8.6). Staff with platform.system.read; counts and ages only. */
@Controller('admin/system')
export class SystemController {
  constructor(@Inject(SystemMonitorService) private readonly monitor: SystemMonitorService) {}

  @Get('status')
  @RequirePermission(PERMISSIONS.systemRead)
  status() {
    return this.monitor.status();
  }
}
