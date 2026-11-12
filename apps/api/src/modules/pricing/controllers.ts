import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  adminQuoteRequestSchema, archiveSchema, createPriceRuleSchema, createPriceVersionSchema, createPromoCodeSchema, publishPriceVersionSchema,
  quoteRequestSchema, setRatesSchema, updatePriceRuleSchema, updatePromoCodeSchema, withdrawPriceVersionSchema,
} from '@mt/shared';
import { z } from 'zod';
import { Public, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { PRICING_PERMISSIONS as P } from './manifest';
import { PriceVersionService } from './price-version.service';
import { PromoAttemptGuard } from './promo-attempt.guard';
import { PromoCodeService } from './promo-code.service';
import { QuoteRateLimitGuard } from './quote-rate-limit.guard';
import { PriceRuleService } from './rule.service';
import { QuoteService } from './quote.service';

const uuid = () => new ParseUUIDPipe();
type In<T extends z.ZodType> = z.infer<T>;

/** Filters of the rule and code lists. */
const adjustmentListQuery = z.strictObject({
  scopeType: z.enum(['global', 'edition', 'package']).optional(),
  packageId: z.uuid().optional(),
  editionId: z.uuid().optional(),
  includeArchived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

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

  @Post('price-versions/:id/withdraw') @HttpCode(200) @RequirePermission(P.versionPublish)
  withdraw(@Param('id', uuid()) id: string, @Body(new ZodPipe(withdrawPriceVersionSchema)) b: In<typeof withdrawPriceVersionSchema>, @Req() req: ApiRequest) {
    return this.versions.withdraw(actorOf(req), id, b);
  }

  @Delete('price-versions/:id') @HttpCode(204) @RequirePermission(P.versionManage)
  async discard(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.versions.discard(actorOf(req), id); }

  @Post('quotes') @HttpCode(200) @RequirePermission(P.quotePreview)
  preview(@Body(new ZodPipe(adminQuoteRequestSchema)) b: In<typeof adminQuoteRequestSchema>) { return this.quotes.quoteStaff(b); }
}

/** Price rules and promo codes in the panel (plan 2.2, sections 3 and 4). Changes need a recent TOTP check. */
@Controller('admin/pricing')
export class PricingAdjustmentsController {
  constructor(
    @Inject(PriceRuleService) private readonly rules: PriceRuleService,
    @Inject(PromoCodeService) private readonly codes: PromoCodeService,
  ) {}

  @Get('rules') @RequirePermission(P.ruleRead)
  listRules(@Query(new ZodPipe(adjustmentListQuery)) q: In<typeof adjustmentListQuery>) { return this.rules.list(q); }

  @Get('rules/:id') @RequirePermission(P.ruleRead)
  getRule(@Param('id', uuid()) id: string) { return this.rules.get(id); }

  @Post('rules') @RequirePermission(P.ruleManage)
  createRule(@Body(new ZodPipe(createPriceRuleSchema)) b: In<typeof createPriceRuleSchema>, @Req() req: ApiRequest) { return this.rules.create(actorOf(req), b); }

  @Patch('rules/:id') @RequirePermission(P.ruleManage)
  updateRule(@Param('id', uuid()) id: string, @Body(new ZodPipe(updatePriceRuleSchema)) b: In<typeof updatePriceRuleSchema>, @Req() req: ApiRequest) {
    return this.rules.update(actorOf(req), id, b);
  }

  @Post('rules/:id/archive') @HttpCode(200) @RequirePermission(P.ruleManage)
  archiveRule(@Param('id', uuid()) id: string, @Body(new ZodPipe(archiveSchema)) b: In<typeof archiveSchema>, @Req() req: ApiRequest) {
    return this.rules.archive(actorOf(req), id, b);
  }

  @Get('promo-codes') @RequirePermission(P.promoCodeRead)
  listCodes(@Query(new ZodPipe(adjustmentListQuery)) q: In<typeof adjustmentListQuery>) { return this.codes.list(q); }

  @Get('promo-codes/:id') @RequirePermission(P.promoCodeRead)
  getCode(@Param('id', uuid()) id: string) { return this.codes.get(id); }

  @Post('promo-codes') @RequirePermission(P.promoCodeManage)
  createCode(@Body(new ZodPipe(createPromoCodeSchema)) b: In<typeof createPromoCodeSchema>, @Req() req: ApiRequest) { return this.codes.create(actorOf(req), b); }

  @Patch('promo-codes/:id') @RequirePermission(P.promoCodeManage)
  updateCode(@Param('id', uuid()) id: string, @Body(new ZodPipe(updatePromoCodeSchema)) b: In<typeof updatePromoCodeSchema>, @Req() req: ApiRequest) {
    return this.codes.update(actorOf(req), id, b);
  }

  @Post('promo-codes/:id/archive') @HttpCode(200) @RequirePermission(P.promoCodeManage)
  archiveCode(@Param('id', uuid()) id: string, @Body(new ZodPipe(archiveSchema)) b: In<typeof archiveSchema>, @Req() req: ApiRequest) {
    return this.codes.archive(actorOf(req), id, b);
  }
}

/** The public quote: a configuration in, the API's total and breakdown out. No amount is ever accepted. */
@Controller('pricing')
export class PricingPublicController {
  constructor(@Inject(QuoteService) private readonly quotes: QuoteService) {}

  @Post('quotes') @HttpCode(200)
  @Public('price of a configuration of an open package: total, breakdown, deposit; no stock numbers, no rule details')
  @UseGuards(QuoteRateLimitGuard, PromoAttemptGuard)
  quote(@Body(new ZodPipe(quoteRequestSchema)) b: In<typeof quoteRequestSchema>) { return this.quotes.quotePublic(b); }
}
