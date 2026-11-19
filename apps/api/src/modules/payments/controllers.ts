import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { acceptTermsSchema, confirmTransferSchema, manualMethodConfigSchema, voidTransferSchema, paymentLinkPaySchema, paymentLinkTokenSchema, sendPaymentLinkSchema, startPaymentSchema } from '@mt/shared';
import type { z } from 'zod';
import { Public, OwnedBy, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { CsrfExempt } from '../../platform/http/csrf.guard';
import { unprocessable } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { ownsBookingReference } from '../bookings';
import { PaymentAttemptSyncService } from './core/attempt-sync.service';
import { PaymentAttemptsService } from './core/attempts.service';
import { TermsService } from './core/terms.service';
import { PaymentWebhooksService } from './core/webhooks.service';
import { PAYMENTS_PERMISSIONS as P } from './manifest';
import { CheckoutRateLimitGuard, PaymentAttemptRateLimitGuard, PaymentLinkRateLimitGuard, PaymentLinkStartRateLimitGuard } from './rate-limit.guard';
import { PaymentLinksService } from './core/payment-links.service';
import { ManualMethodsService } from './core/manual-methods.service';
import { ManualTransfersService } from './core/manual-transfers.service';
import { PaymentAdminService } from './admin.service';

const uuid = () => new ParseUUIDPipe();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;
type In<S extends z.ZodType> = z.infer<S>;

/** The customer's payment routes, under their booking's reference (plan 3.1, section 7). Another customer gets 404. */
@Controller('booking-requests/:reference')
export class PaymentCustomerController {
  constructor(
    @Inject(PaymentAttemptsService) private readonly attempts: PaymentAttemptsService,
    @Inject(PaymentAttemptSyncService) private readonly sync: PaymentAttemptSyncService,
    @Inject(TermsService) private readonly terms: TermsService,
  ) {}

  @Get('payment-plan')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'booking-payment-plan', owns: (ctx) => ownsBookingReference(ctx) })
  plan(@Param('reference') reference: string) {
    return this.attempts.planView(reference);
  }

  /** The booking terms as they stand now, and whether this customer accepted exactly this text (task 3.5). */
  @Get('checkout-terms')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'booking-checkout-terms', owns: (ctx) => ownsBookingReference(ctx) })
  checkoutTerms(@Param('reference') reference: string) {
    return this.terms.view(reference);
  }

  @Post('terms-acceptance')
  @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'booking-terms-acceptance', owns: (ctx) => ownsBookingReference(ctx) })
  @UseGuards(CheckoutRateLimitGuard)
  acceptTerms(@Param('reference') reference: string, @Body(new ZodPipe(acceptTermsSchema)) b: In<typeof acceptTermsSchema>, @Req() req: ApiRequest) {
    return this.terms.accept(reference, b, actorOf(req));
  }

  /** Where the latest payment stands, read from the gateway when it is still open. Creates nothing and takes no amount. */
  @Post('payments/refresh')
  @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'booking-payment-refresh', owns: (ctx) => ownsBookingReference(ctx) })
  @UseGuards(CheckoutRateLimitGuard)
  refresh(@Param('reference') reference: string) {
    return this.sync.refresh(reference);
  }

  @Post('payments')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'booking-payment-start', owns: (ctx) => ownsBookingReference(ctx) })
  @UseGuards(PaymentAttemptRateLimitGuard)
  start(@Param('reference') reference: string, @Body(new ZodPipe(startPaymentSchema)) b: In<typeof startPaymentSchema>, @Headers('idempotency-key') key: string | undefined, @Req() req: ApiRequest) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw unprocessable('idempotency_key_required', 'Send an Idempotency-Key header (16 to 64 letters, digits or hyphens)');
    const actor = actorOf(req);
    return this.attempts.start({ id: actor.id }, reference, b, key, actor);
  }
}

/** Incoming gateway webhooks: the raw-body middleware has already limited rate and size (plan 3.1, section 6). */
@Controller('payments/webhooks')
export class PaymentWebhooksController {
  constructor(@Inject(PaymentWebhooksService) private readonly webhooks: PaymentWebhooksService) {}

  @Post(':pathToken')
  @HttpCode(200)
  @Public('signed payment gateway webhooks: nothing is returned but an acknowledgement')
  @CsrfExempt('payment gateway webhooks are protected by their signature')
  receive(@Param('pathToken') pathToken: string, @Req() req: ApiRequest) {
    return this.webhooks.receive(pathToken, req.body, req.headers);
  }
}

/**
 * Payment links without a session (task 5.1, plan section 5). The token travels in the body, never in the path or query,
 * so it stays out of access logs; any problem with it is one 404. The amount is always the plan's.
 */
@Controller('payment-links')
@UseGuards(PaymentLinkRateLimitGuard)
export class PaymentLinksController {
  constructor(@Inject(PaymentLinksService) private readonly links: PaymentLinksService) {}

  @Post('view') @HttpCode(200)
  @Public('payment link holders: reference, package, race, dates, currency, amount due now, methods, whether terms were accepted, link expiry')
  view(@Body(new ZodPipe(paymentLinkTokenSchema)) b: In<typeof paymentLinkTokenSchema>) {
    return this.links.view(b.token);
  }

  @Post('payments')
  @UseGuards(PaymentLinkStartRateLimitGuard)
  @Public('payment link holders: start (or resume) the payment of the link\'s plan item; the amount is the plan\'s')
  pay(@Body(new ZodPipe(paymentLinkPaySchema)) b: In<typeof paymentLinkPaySchema>, @Headers('idempotency-key') key: string | undefined) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw unprocessable('idempotency_key_required', 'Send an Idempotency-Key header (16 to 64 letters, digits or hyphens)');
    return this.links.pay(b.token, b.method, key);
  }

  @Post('refresh') @HttpCode(200)
  @Public('payment link holders: status, method and amount of the latest attempt made through this link')
  refresh(@Body(new ZodPipe(paymentLinkTokenSchema)) b: In<typeof paymentLinkTokenSchema>) {
    return this.links.refresh(b.token);
  }
}

/** The panel's payment routes: read-only, except sending and revoking payment links (task 5.1). */
@Controller('admin')
export class PaymentsAdminController {
  constructor(
    @Inject(PaymentAdminService) private readonly admin: PaymentAdminService,
    @Inject(PaymentLinksService) private readonly links: PaymentLinksService,
    @Inject(ManualMethodsService) private readonly methods: ManualMethodsService,
    @Inject(ManualTransfersService) private readonly transfers: ManualTransfersService,
  ) {}

  @Get('payments/bookings/:id') @RequirePermission(P.paymentRead)
  async bookingPayments(@Param('id', uuid()) id: string) {
    const view = await this.admin.bookingPayments(id);
    return { ...view, links: await this.links.adminLinks(id) };
  }

  @Post('payments/bookings/:id/payment-links') @RequirePermission(P.paymentLinkSend)
  sendLink(@Param('id', uuid()) id: string, @Body(new ZodPipe(sendPaymentLinkSchema)) _b: In<typeof sendPaymentLinkSchema>, @Req() req: ApiRequest) {
    return this.links.send(id, actorOf(req));
  }

  @Post('payments/payment-links/:id/revoke') @HttpCode(200) @RequirePermission(P.paymentLinkSend)
  revokeLink(@Param('id', uuid()) id: string, @Req() req: ApiRequest) {
    return this.links.revoke(id, actorOf(req));
  }

  /** Bank transfers (task 3.4): the manual methods' set-up, recording a transfer that arrived, and voiding a mistaken one. */
  @Get('payments/methods') @RequirePermission(P.methodRead)
  async manualMethods() {
    return { items: await this.methods.list() };
  }

  @Put('payments/methods/:method') @RequirePermission(P.methodManage)
  putManualMethod(@Param('method') method: string, @Body(new ZodPipe(manualMethodConfigSchema)) b: In<typeof manualMethodConfigSchema>, @Req() req: ApiRequest) {
    return this.methods.put(method, b, actorOf(req));
  }

  @Get('payments/methods/:method/test') @RequirePermission(P.methodRead)
  testManualMethod(@Param('method') method: string) {
    return this.methods.test(method);
  }

  @Post('payments/bookings/:id/inbound-payments') @HttpCode(200) @RequirePermission(P.confirmTransfer)
  confirmTransfer(@Param('id', uuid()) id: string, @Body(new ZodPipe(confirmTransferSchema)) b: In<typeof confirmTransferSchema>, @Req() req: ApiRequest) {
    return this.transfers.confirm(id, b, actorOf(req));
  }

  @Post('payments/payments/:id/void') @HttpCode(200) @RequirePermission(P.voidTransfer)
  voidTransfer(@Param('id', uuid()) id: string, @Body(new ZodPipe(voidTransferSchema)) b: In<typeof voidTransferSchema>, @Req() req: ApiRequest) {
    return this.transfers.void(id, b, actorOf(req));
  }

  @Get('payments/provider-accounts') @RequirePermission(P.accountRead)
  async providerAccounts() {
    return { items: await this.admin.accounts() };
  }
}
