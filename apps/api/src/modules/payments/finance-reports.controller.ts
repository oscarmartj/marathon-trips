// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md, sections 3 to 6): the result per trip, the cash forecast and the
// accountant's files. Amounts travel as strings of digits; nothing is cached; the file is a POST (it has a body, it is audited,
// and it is never fetched by a link or a prefetch).
import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { accountantExportBodySchema, cashForecastQuerySchema } from '@mt/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { contentDisposition } from '../../platform/http/content-disposition';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { NoStoreGuard } from './controllers';
import { AccountantExportService } from './core/accountant-export.service';
import { CashForecastService } from './core/cash-forecast.service';
import { TripResultService } from './core/trip-result.service';
import { PAYMENTS_PERMISSIONS as P } from './manifest';
import { AccountantExportRateLimitGuard } from './rate-limit.guard';
import { jsonSafe } from './reconciliation.controller';

@Controller('admin/payments')
@UseGuards(NoStoreGuard)
export class PaymentFinanceReportsController {
  constructor(
    @Inject(TripResultService) private readonly results: TripResultService,
    @Inject(CashForecastService) private readonly forecast: CashForecastService,
    @Inject(AccountantExportService) private readonly exports: AccountantExportService,
  ) {}

  @Get('reports/trip-result') @RequirePermission(P.tripResultReport)
  async tripResult() {
    return jsonSafe(await this.results.report());
  }

  @Get('reports/cash-forecast') @RequirePermission(P.cashForecastReport)
  async cashForecast(@Query(new ZodPipe(cashForecastQuerySchema)) q: z.infer<typeof cashForecastQuerySchema>) {
    return jsonSafe(await this.forecast.forecast(q));
  }

  @Post('exports/accountant') @HttpCode(200) @RequirePermission(P.accountantExport) @UseGuards(AccountantExportRateLimitGuard)
  async accountant(@Body(new ZodPipe(accountantExportBodySchema)) b: z.infer<typeof accountantExportBodySchema>, @Req() req: ApiRequest, @Res() res: Response) {
    const f = await this.exports.generate(actorOf(req), b);
    res.status(200).set({
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': contentDisposition('attachment', f.filename), 'Cache-Control': 'no-store', Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'X-Row-Count': String(f.rowCount),
    }).send(f.body);
  }
}
