// Task 6.2: supplier payment routes (plan docs/plans/6.2-supplier-payments.md, section 8). Recording a payment does not
// send money: it records one already made from the bank. No route takes the payment amount: the server sums the costs.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { createInstalmentsSchema, previewSupplierPaymentSchema, recordSupplierPaymentSchema, supplierScheduleQuerySchema, voidSupplierPaymentSchema } from '@mt/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { RequiresModule } from '../../platform/flags/requires-module.guard';
import { unprocessable } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { CostService } from './cost.service';
import { SUPPLIERS_PERMISSIONS as P } from './manifest';
import { PaymentScheduleService } from './payment-schedule.service';
import { SupplierPaymentService } from './supplier-payment.service';

const uuid = () => new ParseUUIDPipe();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;
type In<T extends z.ZodType> = z.infer<T>;

const requireKey = (key: string | undefined): string => {
  if (!key || !IDEMPOTENCY_KEY.test(key)) throw unprocessable('idempotency_key_required', 'Send an Idempotency-Key header (16 to 64 letters, digits or hyphens)');
  return key;
};

/** Registered before SuppliersAdminController, so `payments/...` is never read as a supplier id. */
@Controller('admin/suppliers')
@RequiresModule('suppliers')
export class SupplierPaymentsAdminController {
  constructor(
    @Inject(SupplierPaymentService) private readonly payments: SupplierPaymentService,
    @Inject(PaymentScheduleService) private readonly schedule: PaymentScheduleService,
    @Inject(CostService) private readonly costs: CostService,
  ) {}

  @Get('payments/schedule') @RequirePermission(P.costRead)
  paymentSchedule(@Query(new ZodPipe(supplierScheduleQuerySchema)) q: In<typeof supplierScheduleQuerySchema>) { return this.schedule.schedule(q); }

  @Get('payments/:paymentId') @RequirePermission(P.costRead)
  getPayment(@Param('paymentId', uuid()) id: string) { return this.payments.get(id); }

  @Post('payments/:paymentId/void') @HttpCode(200) @RequirePermission(P.paymentVoid)
  voidPayment(@Param('paymentId', uuid()) id: string, @Body(new ZodPipe(voidSupplierPaymentSchema)) b: In<typeof voidSupplierPaymentSchema>, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest) {
    return this.payments.voidPayment(actorOf(req), id, b, requireKey(key));
  }

  @Get(':id/payments') @RequirePermission(P.costRead)
  listPayments(@Param('id', uuid()) id: string) { return this.payments.listForSupplier(id); }

  // A read (writes nothing), so no step-up: the permission of seeing costs.
  @Post(':id/payments/preview') @HttpCode(200) @RequirePermission(P.costRead)
  preview(@Param('id', uuid()) id: string, @Body(new ZodPipe(previewSupplierPaymentSchema)) b: In<typeof previewSupplierPaymentSchema>) { return this.payments.preview(id, b); }

  @Post(':id/payments') @RequirePermission(P.paymentRecord)
  async record(@Param('id', uuid()) id: string, @Body(new ZodPipe(recordSupplierPaymentSchema)) b: In<typeof recordSupplierPaymentSchema>, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const out = await this.payments.record(actorOf(req), id, b, requireKey(key));
    res.status(out.status);
    return out.payment;
  }

  @Post(':id/costs/instalments') @RequirePermission(P.costManage)
  instalments(@Param('id', uuid()) id: string, @Body(new ZodPipe(createInstalmentsSchema)) b: In<typeof createInstalmentsSchema>, @Req() req: ApiRequest) { return this.costs.createInstalments(actorOf(req), id, b); }
}
