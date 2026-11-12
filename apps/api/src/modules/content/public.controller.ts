import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { publicContentQuerySchema, slugSchema } from '@mt/shared';
import type { z } from 'zod';
import { Public } from '../../platform/access/access.decorators';
import { notFound } from '../../platform/http/api-error';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { PublicContentService } from './public.service';

type Q = z.infer<typeof publicContentQuerySchema>;
const query = () => new ZodPipe(publicContentQuerySchema);
const slugOrNotFound = (s: string): string => {
  if (!slugSchema.safeParse(s).success) throw notFound('not_found', 'Not found');
  return s;
};

/** The public site's content: published pages, race guides, FAQs, active banners, menus and redirects. No drafts, no staff data. */
@Controller('content')
export class ContentPublicController {
  constructor(@Inject(PublicContentService) private readonly content: PublicContentService) {}

  @Get('pages')
  @Public('titles and addresses of the published general pages')
  pages(@Query(query()) q: Q) { return this.content.pages(q.locale); }

  @Get('pages/:slug')
  @Public('one published page, with its legal review state')
  page(@Param('slug') slug: string, @Query(query()) q: Q) { return this.content.page(slugOrNotFound(slug), q.locale); }

  @Get('guides/:raceSlug')
  @Public('the published guide of a published race')
  guide(@Param('raceSlug') raceSlug: string, @Query(query()) q: Q) { return this.content.guide(slugOrNotFound(raceSlug), q.locale); }

  @Get('faqs')
  @Public('published frequently asked questions')
  faqs(@Query(query()) q: Q) { return this.content.faqs(q.locale); }

  @Get('banners')
  @Public('banners that are published and inside their dates right now')
  banners(@Query(query()) q: Q) { return this.content.banners(q.locale); }

  @Get('menu')
  @Public('published menu items for the header and the footer')
  menu(@Query(query()) q: Q) { return this.content.menu(q.locale); }

  @Get('redirects')
  @Public('enabled redirects the web app applies')
  redirects() { return this.content.redirects(); }
}
