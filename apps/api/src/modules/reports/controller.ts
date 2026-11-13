import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { createReportSchema, deleteReportSchema, funnelQuerySchema, previewReportSchema, raceEventSchema, updateReportSchema } from '@mt/shared';
import type { z } from 'zod';
import { Public, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { RequiresModule } from '../../platform/flags/requires-module.guard';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { VisitDeduper, VisitRateLimitGuard } from './rate-limit.guard';
import { REPORTS_MODULE, REPORTS_PERMISSIONS as P } from './manifest';
import { ReportsService } from './reports.service';
import type { Caller } from './reports.service';

type In<T extends z.ZodType> = z.infer<T>;
const callerOf = (req: ApiRequest): Caller => ({ auth: req.auth!, actor: actorOf(req) });
const uuid = () => new ParseUUIDPipe();

/** The anonymous visit counter. Nothing identifies the visitor, and the answer is the same for any slug. */
@Controller('analytics')
export class AnalyticsPublicController {
  constructor(
    @Inject(ReportsService) private readonly service: ReportsService,
    @Inject(VisitDeduper) private readonly deduper: VisitDeduper,
  ) {}

  @Post('race-events') @HttpCode(204) @UseGuards(VisitRateLimitGuard)
  @Public('a race slug and a kind (view or builder); counts one anonymous visit and answers the same for any slug')
  async raceEvent(@Body(new ZodPipe(raceEventSchema)) b: In<typeof raceEventSchema>, @Req() req: ApiRequest) {
    // The same address counts once per race and kind in half an hour; the answer is the same either way.
    if (this.deduper.first(req.ip, b.raceSlug, b.kind)) await this.service.recordEvent(b);
  }
}

/** The funnel and the report builder. 404 while the `reports` module flag is off. */
@Controller('admin/reports')
@RequiresModule(REPORTS_MODULE)
export class ReportsAdminController {
  constructor(@Inject(ReportsService) private readonly service: ReportsService) {}

  @Get('funnel') @RequirePermission(P.funnelRead)
  funnel(@Query(new ZodPipe(funnelQuerySchema)) q: In<typeof funnelQuerySchema>) { return this.service.funnel(q); }

  // Fixed paths before ':id'.
  @Get('catalogue') @RequirePermission(P.read)
  catalogue(@Req() req: ApiRequest) { return this.service.catalogue(req.auth!); }

  @Post('preview') @HttpCode(200) @RequirePermission(P.read)
  preview(@Body(new ZodPipe(previewReportSchema)) b: In<typeof previewReportSchema>, @Req() req: ApiRequest) { return this.service.preview(req.auth!, b.definition); }

  @Get() @RequirePermission(P.read)
  list() { return this.service.list(); }

  @Post() @RequirePermission(P.manage)
  create(@Body(new ZodPipe(createReportSchema)) b: In<typeof createReportSchema>, @Req() req: ApiRequest) { return this.service.create(callerOf(req), b); }

  @Get(':id') @RequirePermission(P.read)
  get(@Param('id', uuid()) id: string) { return this.service.get(id); }

  @Post(':id/run') @HttpCode(200) @RequirePermission(P.read)
  run(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { return this.service.runSaved(req.auth!, id); }

  @Patch(':id') @RequirePermission(P.manage)
  update(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateReportSchema)) b: In<typeof updateReportSchema>, @Req() req: ApiRequest) { return this.service.update(callerOf(req), id, b); }

  @Delete(':id') @HttpCode(204) @RequirePermission(P.manage)
  async remove(@Param('id', uuid()) id: string, @Query(new ZodPipe(deleteReportSchema)) q: In<typeof deleteReportSchema>, @Req() req: ApiRequest) { await this.service.remove(callerOf(req), id, q.version); }
}
