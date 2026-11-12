import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { TEMPLATE_CHANNELS, createTemplateSchema, listTemplatesQuerySchema, previewTemplateSchema, templateStatusSchema, updateTemplateSchema } from '@mt/shared';
import type { TemplateChannelValue } from '@mt/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { notFound } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { TEMPLATES_PERMISSIONS as P } from './manifest';
import { TemplatesService } from './templates.service';

const uuid = () => new ParseUUIDPipe();
type In<T extends z.ZodType> = z.infer<T>;

/** An unknown channel in the path is a 404, so the generic routes never answer for something that is not a template. */
const channelOf = (c: string): TemplateChannelValue => {
  if (!(TEMPLATE_CHANNELS as readonly string[]).includes(c)) throw notFound('not_found', 'Not found');
  return c as TemplateChannelValue;
};

/** The panel's template routes (task 5.4): emails and PDF documents share one set, told apart by the channel in the path. */
@Controller('admin/templates')
export class TemplatesAdminController {
  constructor(@Inject(TemplatesService) private readonly templates: TemplatesService) {}

  @Get('definitions') @RequirePermission(P.read)
  definitions() { return { items: this.templates.definitions() }; }

  @Get(':channel') @RequirePermission(P.read)
  list(@Param('channel') channel: string, @Query(new ZodPipe(listTemplatesQuerySchema)) q: In<typeof listTemplatesQuerySchema>) { return this.templates.list(channelOf(channel), q); }

  @Post(':channel') @RequirePermission(P.manage)
  create(@Param('channel') channel: string, @Body(new ZodPipe(createTemplateSchema)) b: In<typeof createTemplateSchema>, @Req() req: ApiRequest) { return this.templates.create(actorOf(req), channelOf(channel), b); }

  @Post(':channel/preview') @HttpCode(200) @RequirePermission(P.read)
  preview(@Param('channel') channel: string, @Body(new ZodPipe(previewTemplateSchema)) b: In<typeof previewTemplateSchema>) { return this.templates.previewWording(channelOf(channel), b); }

  @Get(':channel/:id') @RequirePermission(P.read)
  get(@Param('channel') channel: string, @Param('id', uuid()) id: string) { return this.templates.get(channelOf(channel), id); }

  @Patch(':channel/:id') @RequirePermission(P.manage)
  update(@Param('channel') channel: string, @Param('id', uuid()) id: string, @Body(new ZodPipe(updateTemplateSchema)) b: In<typeof updateTemplateSchema>, @Req() req: ApiRequest) { return this.templates.update(actorOf(req), channelOf(channel), id, b); }

  @Get(':channel/:id/preview') @RequirePermission(P.read)
  previewSaved(@Param('channel') channel: string, @Param('id', uuid()) id: string) { return this.templates.previewSaved(channelOf(channel), id); }

  /** The saved document as a PDF with sample data. Documents only. */
  @Get(':channel/:id/pdf') @RequirePermission(P.read)
  async pdf(@Param('channel') channel: string, @Param('id', uuid()) id: string, @Res({ passthrough: true }) res: Response) {
    if (channelOf(channel) !== 'document') throw notFound('not_found', 'Not found');
    const pdf = await this.templates.previewPdf(id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="preview.pdf"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(pdf);
  }

  @Post(':channel/:id/activate') @HttpCode(200) @RequirePermission(P.publish)
  activate(@Param('channel') channel: string, @Param('id', uuid()) id: string, @Body(new ZodPipe(templateStatusSchema)) b: In<typeof templateStatusSchema>, @Req() req: ApiRequest) { return this.templates.activate(actorOf(req), channelOf(channel), id, b); }

  @Post(':channel/:id/archive') @HttpCode(200) @RequirePermission(P.publish)
  archive(@Param('channel') channel: string, @Param('id', uuid()) id: string, @Body(new ZodPipe(templateStatusSchema)) b: In<typeof templateStatusSchema>, @Req() req: ApiRequest) { return this.templates.archive(actorOf(req), channelOf(channel), id, b); }
}
