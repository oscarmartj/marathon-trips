import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { createQuoteSchema, listQuotesQuerySchema, quoteVersionSchema } from '@mt/shared';
import type { z } from 'zod';
import { OwnedBy, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { CRM_PERMISSIONS as P } from './manifest';
import { QuoteAcceptanceService } from './acceptance.service';
import { ownsQuoteReference } from './ownership';
import { QuoteService } from './quote.service';

type In<T extends z.ZodType> = z.infer<T>;
const uuid = () => new ParseUUIDPipe();

/** The panel's quotes. Each route names one permission. The price comes from the engine: the body has no amount. */
@Controller('admin/quotes')
export class QuotesAdminController {
  constructor(@Inject(QuoteService) private readonly quotes: QuoteService) {}

  @Get() @RequirePermission(P.quoteRead)
  list(@Query(new ZodPipe(listQuotesQuerySchema)) q: In<typeof listQuotesQuerySchema>) { return this.quotes.list(q); }

  @Get(':id') @RequirePermission(P.quoteRead)
  get(@Param('id', uuid()) id: string) { return this.quotes.get(id); }

  @Post() @RequirePermission(P.quoteCreate)
  create(@Body(new ZodPipe(createQuoteSchema)) b: In<typeof createQuoteSchema>, @Req() req: ApiRequest) { return this.quotes.create(actorOf(req), b); }

  @Post(':id/send') @HttpCode(200) @RequirePermission(P.quoteSend)
  send(@Param('id', uuid()) id: string, @Body(new ZodPipe(quoteVersionSchema)) b: In<typeof quoteVersionSchema>, @Req() req: ApiRequest) { return this.quotes.send(actorOf(req), id, b.version); }

  @Post(':id/withdraw') @HttpCode(200) @RequirePermission(P.quoteWithdraw)
  withdraw(@Param('id', uuid()) id: string, @Body(new ZodPipe(quoteVersionSchema)) b: In<typeof quoteVersionSchema>, @Req() req: ApiRequest) { return this.quotes.withdraw(actorOf(req), id, b.version); }
}

/** A customer's own quotes: look at one, accept it. Another customer's quote is a 404, as if it did not exist. */
@Controller('quotes')
export class CustomerQuotesController {
  constructor(
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(QuoteAcceptanceService) private readonly acceptance: QuoteAcceptanceService,
  ) {}

  @Get(':reference')
  @OwnedBy({ kind: 'customer', resource: 'quote', fixture: 'quote', owns: (ctx) => ownsQuoteReference(ctx) })
  get(@Param('reference') reference: string) { return this.quotes.customerView(reference); }

  @Post(':reference/accept') @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'quote', fixture: 'quote-accept', owns: (ctx) => ownsQuoteReference(ctx) })
  async accept(@Param('reference') reference: string, @Req() req: ApiRequest) {
    const actor = actorOf(req);
    const r = await this.acceptance.accept(actor.id!, reference, actor);
    return { bookingReference: r.bookingReference, created: r.created };
  }
}
