import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { archiveCustomFieldSchema, createCustomFieldSchema, customFieldListQuerySchema, updateCustomFieldSchema, type CreateCustomFieldInput, type UpdateCustomFieldInput } from '@mt/shared';
import { RequirePermission } from '../../access/access.decorators';
import type { ApiRequest } from '../../http/request-context';
import { ZodPipe } from '../../http/zod.pipe';
import { COMMON_PERMISSIONS_KEYS as K } from '../permissions';
import { callerOf } from '../table-access.service';
import { CustomFieldsService } from './custom-fields.service';

type Out<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/** Definitions of custom fields. Values are written through each record's own routes (races, packages, suppliers). */
@Controller('admin/custom-fields')
export class CustomFieldsController {
  constructor(@Inject(CustomFieldsService) private readonly fields: CustomFieldsService) {}

  @Get()
  @RequirePermission(K.customFieldRead)
  list(@Query(new ZodPipe(customFieldListQuerySchema)) q: Out<typeof customFieldListQuerySchema>) {
    return this.fields.list(q);
  }

  @Get(':id/usage')
  @RequirePermission(K.customFieldRead)
  usage(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.fields.usage(id);
  }

  @Post()
  @RequirePermission(K.customFieldManage)
  create(@Body(new ZodPipe(createCustomFieldSchema)) body: CreateCustomFieldInput, @Req() req: ApiRequest) {
    return this.fields.create(callerOf(req).actor, body);
  }

  @Patch(':id')
  @RequirePermission(K.customFieldManage)
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(updateCustomFieldSchema)) body: UpdateCustomFieldInput, @Req() req: ApiRequest) {
    const caller = callerOf(req);
    return this.fields.update(caller.actor, caller.auth, id, body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission(K.customFieldManage)
  archive(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(archiveCustomFieldSchema)) body: Out<typeof archiveCustomFieldSchema>, @Req() req: ApiRequest) {
    return this.fields.archive(callerOf(req).actor, id, body);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission(K.customFieldManage)
  restore(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(archiveCustomFieldSchema)) body: Out<typeof archiveCustomFieldSchema>, @Req() req: ApiRequest) {
    const caller = callerOf(req);
    return this.fields.restore(caller.actor, caller.auth, id, body);
  }
}
