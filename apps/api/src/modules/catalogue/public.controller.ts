import { Controller, Get, Inject, Param, ParseIntPipe, Query } from '@nestjs/common';
import { publicRaceQuerySchema, slugSchema } from '@mt/shared';
import type { z } from 'zod';
import { Public } from '../../platform/access/access.decorators';
import { notFound } from '../../platform/http/api-error';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { PublicCatalogueService } from './public.service';

const slugOrNotFound = (s: string): string => {
  if (!slugSchema.safeParse(s).success) throw notFound('not_found', 'Not found');
  return s;
};

/** The public catalogue: published, non-demo races and packages that are not drafts. No personal data, no stock numbers. */
@Controller('catalogue')
export class CataloguePublicController {
  constructor(@Inject(PublicCatalogueService) private readonly catalogue: PublicCatalogueService) {}

  @Get('races')
  @Public('published races with their visible editions; filters: q, country, type, month, distance, year')
  search(@Query(new ZodPipe(publicRaceQuerySchema)) query: z.infer<typeof publicRaceQuerySchema>) {
    return this.catalogue.searchRaces(query);
  }

  @Get('races/:slug')
  @Public('one published race with its visible editions and packages')
  race(@Param('slug') slug: string) {
    return this.catalogue.getRace(slugOrNotFound(slug));
  }

  @Get('races/:slug/editions/:year/packages/:packageSlug')
  @Public('one visible package with hotels, rooms, extras and three-state availability')
  pkg(@Param('slug') slug: string, @Param('year', new ParseIntPipe()) year: number, @Param('packageSlug') packageSlug: string) {
    return this.catalogue.getPackage(slugOrNotFound(slug), year, slugOrNotFound(packageSlug));
  }
}
