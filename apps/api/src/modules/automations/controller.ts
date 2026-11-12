import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  createAutomationSchema, deleteAutomationQuerySchema, disableAutomationSchema, enableAutomationSchema, listAutomationRunsQuerySchema, testAutomationSchema,
  triggerOf, updateAutomationSchema,
} from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { AccessService } from '../../platform/access/access.service';
import { actorOf } from '../../platform/access/actor';
import { PrismaService } from '../../platform/database/prisma.service';
import { RequiresModule } from '../../platform/flags/requires-module.guard';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { AutomationEngine } from './engine';
import { AUTOMATIONS_MODULE, AUTOMATIONS_PERMISSIONS as P, ENTITY_READ_PERMISSION } from './manifest';
import { AutomationRulesService } from './rules.service';
import type { Caller } from './rules.service';

const uuid = () => new ParseUUIDPipe();
type In<T extends z.ZodType> = z.infer<T>;
const callerOf = (req: ApiRequest): Caller => ({ auth: req.auth!, actor: actorOf(req) });

/** The panel's automation routes (task 7.4). 404 while the module is off. */
@Controller('admin/automations')
@RequiresModule(AUTOMATIONS_MODULE)
export class AutomationsAdminController {
  constructor(
    @Inject(AutomationRulesService) private readonly rules: AutomationRulesService,
    @Inject(AutomationEngine) private readonly engine: AutomationEngine,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get() @RequirePermission(P.read)
  list() { return this.rules.list(); }

  @Get('catalogue') @RequirePermission(P.read)
  catalogue() { return this.rules.catalogue(); }

  @Post() @RequirePermission(P.manage)
  create(@Body(new ZodPipe(createAutomationSchema)) b: In<typeof createAutomationSchema>, @Req() req: ApiRequest) { return this.rules.create(callerOf(req), b); }

  @Get(':id') @RequirePermission(P.read)
  get(@Param('id', uuid()) id: string) { return this.rules.get(id); }

  @Patch(':id') @RequirePermission(P.manage)
  update(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateAutomationSchema)) b: In<typeof updateAutomationSchema>, @Req() req: ApiRequest) { return this.rules.update(callerOf(req), id, b); }

  @Post(':id/enable') @HttpCode(200) @RequirePermission(P.enable)
  enable(@Param('id', uuid()) id: string, @Body(new ZodPipe(enableAutomationSchema)) b: In<typeof enableAutomationSchema>, @Req() req: ApiRequest) { return this.rules.enable(callerOf(req), id, b); }

  @Post(':id/disable') @HttpCode(200) @RequirePermission(P.manage)
  disable(@Param('id', uuid()) id: string, @Body(new ZodPipe(disableAutomationSchema)) b: In<typeof disableAutomationSchema>, @Req() req: ApiRequest) { return this.rules.disable(callerOf(req), id, b); }

  @Delete(':id') @HttpCode(204) @RequirePermission(P.manage)
  async remove(@Param('id', uuid()) id: string, @Query(new ZodPipe(deleteAutomationQuerySchema)) q: In<typeof deleteAutomationQuerySchema>, @Req() req: ApiRequest) {
    await this.rules.remove(callerOf(req), id, q.version);
  }

  /** Runs the rule as a test: nothing is sent or changed. Testing with a record also needs permission to read it. */
  @Post(':id/test') @HttpCode(200) @RequirePermission(P.manage)
  async test(@Param('id', uuid()) id: string, @Body(new ZodPipe(testAutomationSchema)) b: In<typeof testAutomationSchema>, @Req() req: ApiRequest) {
    const rule = await this.rules.get(id);
    const trigger = rule.eventType ? triggerOf(rule.eventType) : undefined;
    if (trigger) await this.access.assertPermission(this.prisma, req.auth, ENTITY_READ_PERMISSION[trigger.entityType]);
    const out = await this.engine.test(id, b.entityId);
    return { runId: out.runId, status: out.status, reasonCode: out.reasonCode, steps: out.steps, conditions: out.conditions, testMode: true };
  }

  @Get(':id/runs') @RequirePermission(P.read)
  runs(@Param('id', uuid()) id: string, @Query(new ZodPipe(listAutomationRunsQuerySchema)) q: In<typeof listAutomationRunsQuerySchema>) { return this.rules.runs(id, q); }
}
