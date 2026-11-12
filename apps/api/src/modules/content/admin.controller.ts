import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { contentListQuerySchema, contentStatusSchema, createRedirectSchema, legalReviewSchema, updateRedirectSchema } from '@mt/shared';
import type { ContentKind } from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { notFound } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { ContentService } from './content.service';
import { KINDS, isContentKind } from './kinds';
import { CONTENT_PERMISSIONS as P } from './manifest';
import { RedirectService } from './redirect.service';

const uuid = () => new ParseUUIDPipe();
type In<T extends z.ZodType> = z.infer<T>;

/** An unknown kind in the path is a 404, so the generic routes never answer for something that is not content. */
const kindOf = (k: string): ContentKind => {
  if (!isContentKind(k)) throw notFound('not_found', 'Not found');
  return k;
};

/**
 * The panel's content routes. Pages, guides, FAQs, banners, menu items and images share one set of routes
 * (`/admin/content/:kind`), each body checked against that kind's shared schema; redirects have their own routes
 * because they have their own permission.
 */
@Controller('admin/content')
export class ContentAdminController {
  constructor(
    @Inject(ContentService) private readonly content: ContentService,
    @Inject(RedirectService) private readonly redirects: RedirectService,
  ) {}

  // ---- Redirects (fixed path first, so it is not read as a kind) ----
  @Get('redirects') @RequirePermission(P.contentRead)
  listRedirects() { return this.redirects.list(); }

  @Post('redirects') @RequirePermission(P.redirectManage)
  createRedirect(@Body(new ZodPipe(createRedirectSchema)) b: In<typeof createRedirectSchema>, @Req() req: ApiRequest) { return this.redirects.create(actorOf(req), b); }

  @Get('redirects/:id') @RequirePermission(P.contentRead)
  getRedirect(@Param('id', uuid()) id: string) { return this.redirects.get(id); }

  @Patch('redirects/:id') @RequirePermission(P.redirectManage)
  updateRedirect(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateRedirectSchema)) b: In<typeof updateRedirectSchema>, @Req() req: ApiRequest) { return this.redirects.update(actorOf(req), id, b); }

  @Delete('redirects/:id') @HttpCode(204) @RequirePermission(P.redirectManage)
  async removeRedirect(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.redirects.remove(actorOf(req), id); }

  // ---- Legal review ----
  @Post('pages/:id/legal-review') @HttpCode(200) @RequirePermission(P.legalReview)
  legalReview(@Param('id', uuid()) id: string, @Body(new ZodPipe(legalReviewSchema)) b: In<typeof legalReviewSchema>, @Req() req: ApiRequest) { return this.content.setLegalReview(actorOf(req), id, b); }

  // ---- Pages, guides, FAQs, banners, menu items and images ----
  @Get(':kind') @RequirePermission(P.contentRead)
  list(@Param('kind') kind: string, @Query(new ZodPipe(contentListQuerySchema)) q: In<typeof contentListQuerySchema>) { return this.content.list(kindOf(kind), q); }

  @Post(':kind') @RequirePermission(P.contentManage)
  create(@Param('kind') kind: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const k = kindOf(kind);
    return this.content.create(actorOf(req), k, KINDS[k].create.parse(body ?? {}) as Record<string, unknown>);
  }

  @Get(':kind/:id') @RequirePermission(P.contentRead)
  get(@Param('kind') kind: string, @Param('id', uuid()) id: string) { return this.content.get(kindOf(kind), id); }

  @Patch(':kind/:id') @RequirePermission(P.contentManage)
  update(@Param('kind') kind: string, @Param('id', uuid()) id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    const k = kindOf(kind);
    return this.content.update(actorOf(req), k, id, KINDS[k].update.parse(body ?? {}) as Record<string, unknown>);
  }

  @Post(':kind/:id/status') @HttpCode(200) @RequirePermission(P.contentPublish)
  status(@Param('kind') kind: string, @Param('id', uuid()) id: string, @Body(new ZodPipe(contentStatusSchema)) b: In<typeof contentStatusSchema>, @Req() req: ApiRequest) {
    return this.content.setStatus(actorOf(req), kindOf(kind), id, b);
  }

  @Delete(':kind/:id') @HttpCode(204) @RequirePermission(P.contentManage)
  async remove(@Param('kind') kind: string, @Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.content.remove(actorOf(req), kindOf(kind), id); }
}
