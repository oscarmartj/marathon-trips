import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createRoutingRuleSchema, deleteRoutingRuleSchema, restoreDefaultRulesSchema, routingPreviewSchema, updateRoutingRuleSchema } from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { NoStoreGuard } from './controllers';
import { RoutingRulesAdminService } from './core/routing-admin.service';
import { PAYMENTS_PERMISSIONS as P } from './manifest';

type In<S extends z.ZodType> = z.infer<S>;
const uuid = () => new ParseUUIDPipe();

/**
 * Payment routing rules in the panel (task 4.2, plan docs/plans/4.2-routing-rules.md, section 8). Reading needs the
 * account read permission; every change needs `payments.routingRule.manage` (step-up) and runs in the coverage guard.
 */
@Controller('admin/payments')
@UseGuards(NoStoreGuard)
export class RoutingRulesAdminController {
  constructor(@Inject(RoutingRulesAdminService) private readonly rules: RoutingRulesAdminService) {}

  @Get('routing-rules') @RequirePermission(P.accountRead)
  list() {
    return this.rules.list();
  }

  @Get('routing/warnings') @RequirePermission(P.accountRead)
  warnings() {
    return this.rules.warnings();
  }

  @Get('routing/preview') @RequirePermission(P.accountRead)
  preview(@Query(new ZodPipe(routingPreviewSchema)) q: In<typeof routingPreviewSchema>) {
    return this.rules.preview(q);
  }

  @Post('routing-rules') @RequirePermission(P.routingRuleManage)
  create(@Body(new ZodPipe(createRoutingRuleSchema)) b: In<typeof createRoutingRuleSchema>, @Req() req: ApiRequest) {
    return this.rules.create(b, actorOf(req));
  }

  @Patch('routing-rules/:id') @RequirePermission(P.routingRuleManage)
  update(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateRoutingRuleSchema)) b: In<typeof updateRoutingRuleSchema>, @Req() req: ApiRequest) {
    return this.rules.update(id, b, actorOf(req));
  }

  @Post('routing-rules/:id/delete') @HttpCode(200) @RequirePermission(P.routingRuleManage)
  remove(@Param('id', uuid()) id: string, @Body(new ZodPipe(deleteRoutingRuleSchema)) b: In<typeof deleteRoutingRuleSchema>, @Req() req: ApiRequest) {
    return this.rules.remove(id, b, actorOf(req));
  }

  @Post('provider-accounts/:id/routing-rules/defaults') @HttpCode(200) @RequirePermission(P.routingRuleManage)
  restoreDefaults(@Param('id', uuid()) id: string, @Body(new ZodPipe(restoreDefaultRulesSchema)) _b: In<typeof restoreDefaultRulesSchema>, @Req() req: ApiRequest) {
    return this.rules.restoreDefaults(id, actorOf(req));
  }
}
