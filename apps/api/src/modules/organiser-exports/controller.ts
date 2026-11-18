import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { organiserExportBodySchema, organiserExportQuerySchema } from '@mt/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { ORGANISER_EXPORT_PERMISSIONS as P } from './manifest';
import { ExportCheckRateLimitGuard, ExportFileRateLimitGuard } from './rate-limit.guard';
import { OrganiserExportService } from './service';
import { contentDisposition } from '../../platform/http/content-disposition';

/**
 * Organiser exports (task 7.2). Staff only, two permissions, never an API key. The file is a POST: it needs a body, it
 * is audited, and it must never be fetched by a link, a prefetch or a cache. Everything answers `Cache-Control: no-store`.
 */
@Controller('admin/organiser-exports')
export class OrganiserExportController {
  constructor(@Inject(OrganiserExportService) private readonly service: OrganiserExportService) {}

  @Get('formats') @RequirePermission(P.read)
  async formats(@Query(new ZodPipe(organiserExportQuerySchema)) q: z.infer<typeof organiserExportQuerySchema>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.formats(q.editionId);
  }

  @Post('check') @HttpCode(200) @RequirePermission(P.read) @UseGuards(ExportCheckRateLimitGuard)
  async check(@Body(new ZodPipe(organiserExportBodySchema)) b: z.infer<typeof organiserExportBodySchema>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.check(b);
  }

  @Post() @HttpCode(200) @RequirePermission(P.generate) @UseGuards(ExportFileRateLimitGuard)
  async generate(@Body(new ZodPipe(organiserExportBodySchema)) b: z.infer<typeof organiserExportBodySchema>, @Req() req: ApiRequest, @Res() res: Response) {
    const r = await this.service.generate(actorOf(req), b);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (r.kind === 'issues') {
      res.status(422).json({ code: 'export_has_issues', message: 'Some runners are missing details this format needs. Nothing was exported.', issues: r.issues });
      return;
    }
    res.status(200).set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition('attachment', r.filename),
      'X-Content-Type-Options': 'nosniff',
      'X-Row-Count': String(r.rowCount),
      'X-Excluded-Count': String(r.excluded),
    }).send(r.body);
  }
}
