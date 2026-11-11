import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  bulkSchema, csvImportSchema, deleteRecordSchema, exportBodySchema, noteInputSchema, noteUpdateSchema, savedViewInputSchema, savedViewUpdateSchema,
  searchParamsSchema, setTagsSchema, tableListParamsSchema, tagInputSchema, tagUpdateSchema,
  type TableListParams,
} from '@mt/shared';
import type { Response } from 'express';
import { RequirePermission } from '../access/access.decorators';
import type { ApiRequest } from '../http/request-context';
import { ZodPipe } from '../http/zod.pipe';
import { BulkService } from './bulk.service';
import { CsvService } from './csv.service';
import { HistoryService } from './history.service';
import { NotesService } from './notes.service';
import { COMMON_PERMISSIONS_KEYS as K } from './permissions';
import { SearchIndexService } from './search.service';
import { TableAccessService, callerOf } from './table-access.service';
import { snake } from './table-def';
import { TablesService } from './tables.service';
import { TagsService } from './tags.service';
import { ViewsService } from './views.service';

type Body_<T extends { parse: (v: unknown) => unknown }> = ReturnType<T['parse']>;

/**
 * The shared table routes. Every route carries one access mark: the baseline `common.table.use` (tag management has its own) `common.table.use`; the services then require the
 * table's own permission for the entity type in the URL (an unknown type is a 404, a missing permission a 403).
 */
@Controller('admin')
export class CommonController {
  constructor(
    @Inject(TableAccessService) private readonly access: TableAccessService,
    @Inject(TablesService) private readonly tables: TablesService,
    @Inject(CsvService) private readonly csv: CsvService,
    @Inject(BulkService) private readonly bulk: BulkService,
    @Inject(ViewsService) private readonly views: ViewsService,
    @Inject(TagsService) private readonly tags: TagsService,
    @Inject(NotesService) private readonly notes: NotesService,
    @Inject(HistoryService) private readonly history: HistoryService,
    @Inject(SearchIndexService) private readonly search: SearchIndexService,
  ) {}

  @Get('search')
  @RequirePermission(K.tableUse)
  globalSearch(@Query(new ZodPipe(searchParamsSchema)) q: { q: string; limit: number }, @Req() req: ApiRequest) {
    return this.search.search(callerOf(req), q.q, q.limit);
  }

  @Get('tags')
  @RequirePermission(K.tableUse)
  listTags() {
    return this.tags.list();
  }

  @Post('tags')
  @RequirePermission(K.tagManage)
  createTag(@Body(new ZodPipe(tagInputSchema)) b: Body_<typeof tagInputSchema>, @Req() req: ApiRequest) {
    return this.tags.create(callerOf(req).actor, b as never);
  }

  @Patch('tags/:id')
  @RequirePermission(K.tagManage)
  updateTag(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(tagUpdateSchema)) b: Body_<typeof tagUpdateSchema>, @Req() req: ApiRequest) {
    return this.tags.update(callerOf(req).actor, id, b as never);
  }

  @Delete('tags/:id')
  @HttpCode(204)
  @RequirePermission(K.tagManage)
  deleteTag(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: ApiRequest) {
    return this.tags.remove(callerOf(req).actor, id);
  }

  @Get('tables/:entityType/meta')
  @RequirePermission(K.tableUse)
  meta(@Param('entityType') t: string, @Req() req: ApiRequest) {
    return this.tables.meta(callerOf(req), this.access.def(t));
  }

  @Get('tables/:entityType/rows')
  @RequirePermission(K.tableUse)
  rows(@Param('entityType') t: string, @Query(new ZodPipe(tableListParamsSchema)) p: TableListParams, @Req() req: ApiRequest) {
    return this.tables.list(callerOf(req), this.access.def(t), p.query, p.paging);
  }

  @Post('tables/:entityType/export')
  @HttpCode(200)
  @RequirePermission(K.tableUse)
  async export(@Param('entityType') t: string, @Body(new ZodPipe(exportBodySchema)) b: Body_<typeof exportBodySchema>, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const def = this.access.def(t);
    const out = await this.csv.export(callerOf(req), def, (b as { query: never }).query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snake(def.entityType)}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    return out.csv;
  }

  @Post('tables/:entityType/import')
  @HttpCode(200)
  @RequirePermission(K.tableUse)
  importCsv(@Param('entityType') t: string, @Body(new ZodPipe(csvImportSchema)) b: Body_<typeof csvImportSchema>, @Req() req: ApiRequest) {
    return this.csv.import(callerOf(req), this.access.def(t), b as { csv: string; dryRun: boolean });
  }

  @Post('tables/:entityType/bulk')
  @HttpCode(200)
  @RequirePermission(K.tableUse)
  runBulk(@Param('entityType') t: string, @Body(new ZodPipe(bulkSchema)) b: Body_<typeof bulkSchema>, @Req() req: ApiRequest) {
    return this.bulk.run(callerOf(req), this.access.def(t), b as { action: string; ids: string[]; reason?: string });
  }

  @Get('tables/:entityType/views')
  @RequirePermission(K.tableUse)
  listViews(@Param('entityType') t: string, @Req() req: ApiRequest) {
    return this.views.list(callerOf(req), this.access.def(t));
  }

  @Post('tables/:entityType/views')
  @RequirePermission(K.tableUse)
  createView(@Param('entityType') t: string, @Body(new ZodPipe(savedViewInputSchema)) b: Body_<typeof savedViewInputSchema>, @Req() req: ApiRequest) {
    return this.views.create(callerOf(req), this.access.def(t), b as never);
  }

  @Patch('tables/:entityType/views/:viewId')
  @RequirePermission(K.tableUse)
  updateView(@Param('entityType') t: string, @Param('viewId', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(savedViewUpdateSchema)) b: Body_<typeof savedViewUpdateSchema>, @Req() req: ApiRequest) {
    return this.views.update(callerOf(req), this.access.def(t), id, b as never);
  }

  @Delete('tables/:entityType/views/:viewId')
  @HttpCode(204)
  @RequirePermission(K.tableUse)
  deleteView(@Param('entityType') t: string, @Param('viewId', new ParseUUIDPipe()) id: string, @Req() req: ApiRequest) {
    return this.views.remove(callerOf(req), this.access.def(t), id);
  }

  @Get('tables/:entityType/:id')
  @RequirePermission(K.tableUse)
  one(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: ApiRequest) {
    return this.tables.one(callerOf(req), this.access.def(t), id);
  }

  @Post('tables/:entityType/:id/delete')
  @HttpCode(200)
  @RequirePermission(K.tableUse)
  async remove(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(deleteRecordSchema)) b: { reason?: string }, @Req() req: ApiRequest) {
    await this.bulk.deleteOrRestore(callerOf(req), this.access.def(t), true, id, b.reason);
    return { id };
  }

  @Post('tables/:entityType/:id/restore')
  @HttpCode(200)
  @RequirePermission(K.tableUse)
  async restore(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(deleteRecordSchema)) b: { reason?: string }, @Req() req: ApiRequest) {
    await this.bulk.deleteOrRestore(callerOf(req), this.access.def(t), false, id, b.reason);
    return { id };
  }

  @Get('tables/:entityType/:id/history')
  @RequirePermission(K.tableUse)
  recordHistory(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: ApiRequest) {
    return this.history.list(callerOf(req), this.access.def(t), id);
  }

  @Put('tables/:entityType/:id/tags')
  @RequirePermission(K.tableUse)
  async setTags(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(setTagsSchema)) b: { tagIds: string[]; reason?: string }, @Req() req: ApiRequest) {
    const c = callerOf(req);
    const def = this.access.def(t);
    await this.access.require(c, def, 'annotate');
    return this.tags.setTags(c.actor, def, id, b.tagIds, b.reason);
  }

  @Get('tables/:entityType/:id/notes')
  @RequirePermission(K.tableUse)
  listNotes(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: ApiRequest) {
    return this.notes.list(callerOf(req), this.access.def(t), id);
  }

  @Post('tables/:entityType/:id/notes')
  @RequirePermission(K.tableUse)
  addNote(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(noteInputSchema)) b: Body_<typeof noteInputSchema>, @Req() req: ApiRequest) {
    return this.notes.add(callerOf(req), this.access.def(t), id, b as never);
  }

  @Patch('tables/:entityType/:id/notes/:noteId')
  @RequirePermission(K.tableUse)
  updateNote(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Param('noteId', new ParseUUIDPipe()) noteId: string, @Body(new ZodPipe(noteUpdateSchema)) b: Body_<typeof noteUpdateSchema>, @Req() req: ApiRequest) {
    return this.notes.update(callerOf(req), this.access.def(t), id, noteId, b as never);
  }

  @Delete('tables/:entityType/:id/notes/:noteId')
  @HttpCode(204)
  @RequirePermission(K.tableUse)
  deleteNote(@Param('entityType') t: string, @Param('id', new ParseUUIDPipe()) id: string, @Param('noteId', new ParseUUIDPipe()) noteId: string, @Req() req: ApiRequest) {
    return this.notes.remove(callerOf(req), this.access.def(t), id, noteId);
  }
}
