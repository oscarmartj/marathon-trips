import { Body, Controller, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { taskInputSchema, taskUpdateSchema } from '@mt/shared';
import { RequirePermission } from '../../access/access.decorators';
import type { ApiRequest } from '../../http/request-context';
import { ZodPipe } from '../../http/zod.pipe';
import { COMMON_PERMISSIONS_KEYS as K } from '../permissions';
import { callerOf } from '../table-access.service';
import { TasksService } from './tasks.service';

/** The example table's writes. Reading, searching, tagging, exporting and the rest go through /admin/tables/Task. */
@Controller('admin/tasks')
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @Post()
  @RequirePermission(K.taskWrite)
  create(@Body(new ZodPipe(taskInputSchema)) body: Parameters<TasksService['create']>[1], @Req() req: ApiRequest) {
    return this.tasks.create(callerOf(req), body);
  }

  @Patch(':id')
  @RequirePermission(K.taskWrite)
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(taskUpdateSchema)) body: Parameters<TasksService['update']>[2], @Req() req: ApiRequest) {
    return this.tasks.update(callerOf(req), id, body);
  }
}
