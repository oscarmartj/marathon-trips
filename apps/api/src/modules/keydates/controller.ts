import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { calendarQuerySchema, createKeyDateSchema, deleteKeyDateSchema, updateKeyDateSchema } from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { RequiresModule } from '../../platform/flags/requires-module.guard';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { KeyDatesService } from './keydates.service';
import { KEYDATES_MODULE, KEYDATES_PERMISSIONS as P } from './manifest';

type In<T extends z.ZodType> = z.infer<T>;

/** The key dates calendar routes. 404 while the `keydates` module flag is off; every route names one permission. */
@Controller('admin/key-dates')
@RequiresModule(KEYDATES_MODULE)
export class KeyDatesAdminController {
  constructor(@Inject(KeyDatesService) private readonly service: KeyDatesService) {}

  @Get() @RequirePermission(P.read)
  calendar(@Query(new ZodPipe(calendarQuerySchema)) q: In<typeof calendarQuerySchema>) { return this.service.calendar(q); }

  @Post() @RequirePermission(P.manage)
  create(@Body(new ZodPipe(createKeyDateSchema)) b: In<typeof createKeyDateSchema>, @Req() req: ApiRequest) { return this.service.create(actorOf(req), b); }

  @Patch(':id') @RequirePermission(P.manage)
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(updateKeyDateSchema)) b: In<typeof updateKeyDateSchema>, @Req() req: ApiRequest) { return this.service.update(actorOf(req), id, b); }

  @Delete(':id') @HttpCode(204) @RequirePermission(P.manage)
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @Query(new ZodPipe(deleteKeyDateSchema)) b: In<typeof deleteKeyDateSchema>, @Req() req: ApiRequest) { await this.service.remove(actorOf(req), id, b); }
}
