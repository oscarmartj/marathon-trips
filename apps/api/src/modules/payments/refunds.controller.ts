// Refunds from the panel and disputes (task 4.5, plan docs/plans/4.5-refunds-disputes.md, section 10). No route takes an
// amount: the API refunds what a payment can give back now. Responses are never cached (a destination, an evidence pack).
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import { confirmManualRefundSchema, refundDestinationSchema, refundVersionSchema, requestRefundSchema } from '@mt/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { unprocessable } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { NoStoreGuard } from './controllers';
import { AppRefundsService } from './core/app-refunds.service';
import { PaymentCoverageService } from './core/coverage.service';
import { PaymentDisputesService } from './core/disputes.service';
import { PrismaService } from '../../platform/database/prisma.service';
import { PAYMENTS_PERMISSIONS as P } from './manifest';

const uuid = () => new ParseUUIDPipe();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;
type In<S extends z.ZodType> = z.infer<S>;

@Controller('admin/payments')
@UseGuards(NoStoreGuard)
export class PaymentRefundsAdminController {
  constructor(
    @Inject(AppRefundsService) private readonly refunds: AppRefundsService,
    @Inject(PaymentDisputesService) private readonly disputes: PaymentDisputesService,
    @Inject(PaymentCoverageService) private readonly coverage: PaymentCoverageService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** What each payment can give back now, the booking's refunds and disputes, and whether its deposit was reversed. */
  @Get('bookings/:id/refunds') @RequirePermission(P.paymentRead)
  async bookingRefunds(@Param('id', uuid()) id: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!booking) return { refundable: [], refunds: [], disputes: [], depositReversed: false };
    const money = await this.coverage.money(this.prisma, id);
    const refunds = await this.prisma.refund.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const disputes = await this.prisma.dispute.findMany({
      where: { bookingId: id }, orderBy: { createdAt: 'asc' },
      select: { id: true, paymentId: true, providerDisputeRef: true, amountMinor: true, currency: true, reasonCode: true, status: true, evidenceDueBy: true, evidenceSubmittedAt: true, fundsWithdrawnAt: true, fundsReinstatedAt: true, version: true, createdAt: true },
    });
    return {
      refundable: await this.refunds.refundableView(id),
      refunds: await Promise.all(refunds.map((r) => this.refunds.view(r.id))),
      disputes: disputes.map((d) => ({ ...d, amountMinor: d.amountMinor.toString() })),
      // Plan 0.1, 6.2: a deposit no longer covered never moves the booking back; the panel says so.
      depositReversed: (booking.status === 'deposit_paid' || booking.status === 'confirmed') && !money.depositCovered,
    };
  }

  @Post('payments/:id/refunds') @RequirePermission(P.refundRequest)
  async request(@Param('id', uuid()) id: string, @Body(new ZodPipe(requestRefundSchema)) b: In<typeof requestRefundSchema>, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw unprocessable('idempotency_key_required', 'Send an Idempotency-Key header (16 to 64 letters, digits or hyphens)');
    const out = await this.refunds.request(id, b, key, actorOf(req));
    res.status(out.status);
    return out.refund;
  }

  @Post('refunds/:id/resolve') @HttpCode(200) @RequirePermission(P.refundRequest)
  resolve(@Param('id', uuid()) id: string, @Body(new ZodPipe(refundVersionSchema)) b: In<typeof refundVersionSchema>, @Req() req: ApiRequest) {
    return this.refunds.resolve(id, b.version, actorOf(req));
  }

  @Put('refunds/:id/destination') @RequirePermission(P.refundConfirmManual)
  setDestination(@Param('id', uuid()) id: string, @Body(new ZodPipe(refundDestinationSchema)) b: In<typeof refundDestinationSchema>, @Req() req: ApiRequest) {
    return this.refunds.setDestination(id, b, actorOf(req));
  }

  @Get('refunds/:id/destination') @RequirePermission(P.refundConfirmManual)
  destination(@Param('id', uuid()) id: string, @Req() req: ApiRequest) {
    return this.refunds.destination(id, actorOf(req));
  }

  @Post('refunds/:id/confirm-manual') @HttpCode(200) @RequirePermission(P.refundConfirmManual)
  confirmManual(@Param('id', uuid()) id: string, @Body(new ZodPipe(confirmManualRefundSchema)) b: In<typeof confirmManualRefundSchema>, @Req() req: ApiRequest) {
    return this.refunds.confirmManual(id, b, actorOf(req));
  }

  @Post('refunds/:id/cancel-manual') @HttpCode(200) @RequirePermission(P.refundConfirmManual)
  cancelManual(@Param('id', uuid()) id: string, @Body(new ZodPipe(refundVersionSchema)) b: In<typeof refundVersionSchema>, @Req() req: ApiRequest) {
    return this.refunds.cancelManual(id, b.version, actorOf(req));
  }

  @Post('disputes/:id/evidence-submitted') @HttpCode(200) @RequirePermission(P.disputeManage)
  evidenceSubmitted(@Param('id', uuid()) id: string, @Body(new ZodPipe(refundVersionSchema)) b: In<typeof refundVersionSchema>, @Req() req: ApiRequest) {
    return this.disputes.markEvidenceSubmitted(id, b.version, actorOf(req));
  }

  @Get('disputes/:id/evidence') @RequirePermission(P.disputeEvidence)
  async evidence(@Param('id', uuid()) id: string, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const pack = await this.disputes.evidence(id, actorOf(req));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${pack.filename}"`);
    return pack.body;
  }
}
