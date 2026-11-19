// Reconciliation, the customer money report and receipts in the panel (task 4.6, plan
// docs/plans/4.6-reconciliation-receipts.md, section 6). Amounts travel as strings of digits; nothing is cached.
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { notFound } from '../../platform/http/api-error';
import { contentDisposition } from '../../platform/http/content-disposition';
import type { ApiRequest } from '../../platform/http/request-context';
import { NoStoreGuard } from './controllers';
import { ClientMoneyService } from './core/client-money.service';
import { ReceiptsService } from './core/receipts.service';
import { ReconciliationService } from './core/reconciliation.service';
import { PAYMENTS_PERMISSIONS as P } from './manifest';

const uuid = () => new ParseUUIDPipe();

/** bigint → string of digits, everywhere in a response. */
export function jsonSafe<T>(v: T): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(jsonSafe);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]));
}

@Controller('admin/payments')
@UseGuards(NoStoreGuard)
export class PaymentReconciliationAdminController {
  constructor(
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(ClientMoneyService) private readonly clientMoney: ClientMoneyService,
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
  ) {}

  @Get('reconciliation/runs') @RequirePermission(P.reconciliationRead)
  async runs(@Query('accountId') accountId?: string) {
    const valid = accountId && /^[0-9a-f-]{36}$/.test(accountId) ? accountId : undefined;
    return { runs: await this.reconciliation.list(valid ? { accountId: valid } : {}) };
  }

  @Get('reconciliation/runs/:id') @RequirePermission(P.reconciliationRead)
  async run(@Param('id', uuid()) id: string) {
    const r = await this.reconciliation.view(id);
    if (!r) throw notFound('reconciliation_run_not_found', 'Reconciliation run not found');
    return r;
  }

  @Post('reconciliation/accounts/:id/run') @HttpCode(200) @RequirePermission(P.reconciliationRun)
  runNow(@Param('id', uuid()) id: string, @Req() req: ApiRequest) {
    return this.reconciliation.runManually(id, actorOf(req));
  }

  @Get('reports/client-money') @RequirePermission(P.clientMoneyReport)
  async report() {
    return jsonSafe(await this.clientMoney.report());
  }

  @Get('bookings/:id/receipts') @RequirePermission(P.receiptRead)
  async bookingReceipts(@Param('id', uuid()) id: string) {
    return { documents: await this.receipts.listForBooking(id) };
  }

  @Get('receipts/:number') @RequirePermission(P.receiptRead)
  async receiptPdf(@Param('number') number: string, @Res() res: Response) {
    const doc = await this.receipts.pdf(number, null);
    if (!doc) throw notFound('receipt_not_found', 'Receipt not found');
    res.status(200).set({ 'Content-Type': 'application/pdf', 'Content-Disposition': contentDisposition('attachment', doc.filename), 'Cache-Control': 'no-store' }).send(doc.pdf);
  }
}
