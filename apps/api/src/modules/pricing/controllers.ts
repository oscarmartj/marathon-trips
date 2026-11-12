import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { adminQuoteRequestSchema, createPriceVersionSchema, publishPriceVersionSchema, quoteRequestSchema, setRatesSchema } from '@mt/shared';
import type { z } from 'zod';
import { Public, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { PRICING_PERMISSIONS as P } from './manifest';
import { PriceVersionService } from './price-version.service';
import { QuoteRateLimitGuard } from './quote-rate-limit.guard';
import { QuoteService } from './quote.service';

const uuid = () => new ParseUUIDPipe();
type In<T extends z.ZodType> = z.infer<T>;

/** The panel's pricing routes. Every route names one permission; publishing also needs a recent TOTP check. */
@Controller('admin/pricing')
export class PricingAdminController {
  constructor(
    @Inject(PriceVersionService) private readonly versions: PriceVersionService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
  ) {}

  @Get('packages/:packageId/price-versions') @RequirePermission(P.versionRead)
  list(@Param('packageId', uuid()) packageId: string) { return this.versions.list(packageId); }

  @Get('price-versions/:id') @RequirePermission(P.versionRead)
  get(@Param('id', uuid()) id: string) { return this.versions.get(id); }

  @Post('packages/:packageId/price-versions') @RequirePermission(P.versionManage)
  create(@Param('packageId', uuid()) packageId: string, @Body(new ZodPipe(createPriceVersionSchema)) b: In<typeof createPriceVersionSchema>, @Req() req: ApiRequest) {
    return this.versions.create(actorOf(req), packageId, b);
  }

  @Put('price-versions/:id/rates') @RequirePermission(P.versionManage)
  setRates(@Param('id', uuid()) id: string, @Body(new ZodPipe(setRatesSchema)) b: In<typeof setRatesSchema>, @Req() req: ApiRequest) {
    return this.versions.setRates(actorOf(req), id, b);
  }

  @Post('price-versions/:id/publish') @HttpCode(200) @RequirePermission(P.versionPublish)
  publish(@Param('id', uuid()) id: string, @Body(new ZodPipe(publishPriceVersionSchema)) b: In<typeof publishPriceVersionSchema>, @Req() req: ApiRequest) {
    return this.versions.publish(actorOf(req), id, b);
  }

  @Delete('price-versions/:id') @HttpCode(204) @RequirePermission(P.versionManage)
  async discard(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.versions.discard(actorOf(req), id); }

  @Post('quotes') @HttpCode(200) @RequirePermission(P.quotePreview)
  preview(@Body(new ZodPipe(adminQuoteRequestSchema)) b: In<typeof adminQuoteRequestSchema>) { return this.quotes.quoteStaff(b); }
}

/** The public quote: a configuration in, the API's total and breakdown out. No amount is ever accepted. */
@Controller('pricing')
export class PricingPublicController {
  constructor(@Inject(QuoteService) private readonly quotes: QuoteService) {}

  @Post('quotes') @HttpCode(200)
  @Public('price of a configuration of an open package: total, breakdown, deposit; no stock numbers, no rule details')
  @UseGuards(QuoteRateLimitGuard)
  quote(@Body(new ZodPipe(quoteRequestSchema)) b: In<typeof quoteRequestSchema>) { return this.quotes.quotePublic(b); }
}
