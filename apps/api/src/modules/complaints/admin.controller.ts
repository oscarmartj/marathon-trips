import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { complaintQuerySchema, complaintTransitionSchema, createComplaintSchema, updateComplaintSchema } from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { ComplaintService } from './complaint.service';
import { COMPLAINTS_PERMISSIONS as P } from './manifest';

const uuid = () => new ParseUUIDPipe();
type In<T extends z.ZodType> = z.infer<T>;

/** The panel's complaints routes. Every route names one permission. */
@Controller('admin/complaints')
export class ComplaintsAdminController {
  constructor(@Inject(ComplaintService) private readonly complaints: ComplaintService) {}

  // Fixed paths first, so they are not read as a complaint id.
  @Get('summary') @RequirePermission(P.read)
  summary() { return this.complaints.summary(); }

  @Get('owners') @RequirePermission(P.manage)
  owners() { return this.complaints.owners(); }

  @Get() @RequirePermission(P.read)
  list(@Query(new ZodPipe(complaintQuerySchema)) q: In<typeof complaintQuerySchema>) { return this.complaints.list(q); }

  @Post() @RequirePermission(P.manage)
  create(@Body(new ZodPipe(createComplaintSchema)) b: In<typeof createComplaintSchema>, @Req() req: ApiRequest) { return this.complaints.create(actorOf(req), b); }

  @Get(':id') @RequirePermission(P.read)
  get(@Param('id', uuid()) id: string) { return this.complaints.get(id); }

  @Patch(':id') @RequirePermission(P.manage)
  update(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateComplaintSchema)) b: In<typeof updateComplaintSchema>, @Req() req: ApiRequest) { return this.complaints.update(actorOf(req), id, b); }

  @Post(':id/status') @HttpCode(200) @RequirePermission(P.manage)
  transition(@Param('id', uuid()) id: string, @Body(new ZodPipe(complaintTransitionSchema)) b: In<typeof complaintTransitionSchema>, @Req() req: ApiRequest) { return this.complaints.transition(actorOf(req), id, b); }
}
