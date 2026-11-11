import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { PermissionRegistry } from '../access/permissions';
import { EntityRegistry } from '../entities/entity-registry';
import { BulkService } from './bulk.service';
import { CommonController } from './common.controller';
import { CsvService } from './csv.service';
import { HistoryService } from './history.service';
import { NotesService } from './notes.service';
import { COMMON_PERMISSIONS } from './permissions';
import { SearchIndexService } from './search.service';
import { SoftDeleteService } from './soft-delete.service';
import { TableAccessService } from './table-access.service';
import { TablesService } from './tables.service';
import { TagsService } from './tags.service';
import { taskTable } from './tasks/task.table';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { ViewsService } from './views.service';

/** The shared table capabilities and their example table (task 0.5). PlatformModule is global, so nothing is imported. */
@Module({
  controllers: [CommonController, TasksController],
  providers: [
    TableAccessService, SearchIndexService, SoftDeleteService, TagsService, NotesService, TablesService, ViewsService, BulkService, CsvService, HistoryService, TasksService,
  ],
  exports: [TableAccessService, SearchIndexService, SoftDeleteService, TagsService, TasksService],
})
export class CommonModule implements OnModuleInit {
  constructor(
    @Inject(PermissionRegistry) private readonly permissions: PermissionRegistry,
    @Inject(EntityRegistry) private readonly entities: EntityRegistry,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  onModuleInit(): void {
    this.permissions.register(COMMON_PERMISSIONS);
    this.tasks.table = taskTable(this.tasks);
    this.entities.register({ entityType: 'Task', model: 'Task', table: this.tasks.table });
  }
}
