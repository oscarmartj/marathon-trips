import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RequirePermission } from '../../platform/access/access.decorators';
import type { ApiRequest } from '../../platform/http/request-context';
import { DashboardService } from './dashboard.service';
import { DASHBOARD_ROUTE_PERMISSION } from './manifest';

/** The staff start page. One read; each section inside it is filtered by the caller's own permissions. */
@Controller('admin/dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly service: DashboardService) {}

  @Get() @RequirePermission(DASHBOARD_ROUTE_PERMISSION)
  view(@Req() req: ApiRequest) { return this.service.view(req.auth!); }
}
