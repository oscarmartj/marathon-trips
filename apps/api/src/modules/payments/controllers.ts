import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { startPaymentSchema } from '@mt/shared';
import type { z } from 'zod';
import { Public, OwnedBy, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { CsrfExempt } from '../../platform/http/csrf.guard';
import { unprocessable } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { ownsBookingReference } from '../bookings';
import { PaymentAttemptsService } from './core/attempts.service';
import { PaymentWebhooksService } from './core/webhooks.service';
import { PAYMENTS_PERMISSIONS as P } from './manifest';
import { PaymentAttemptRateLimitGuard } from './rate-limit.guard';
import { PaymentAdminService } from './admin.service';

const uuid = () => new ParseUUIDPipe();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{16,64}$/;
type In<S extends z.ZodType> = z.infer<S>;

/** The customer's payment routes, under their booking's reference (plan 3.1, section 7). Another customer gets 404. */
@Controller('booking-requests/:reference')
export class PaymentCustomerController {
  constructor(@Inject(PaymentAttemptsService) private readonly attempts: PaymentAttemptsService) {}

  @Get('payment-plan')
  @OwnedBy({ kind: 'customer', resource: 'booking', fixture: 'booking-payment-plan', owns: (ctx) => ownsBookingReference(ctx) })
  plan(@Param('reference') reference: string) {
    return this.attempts.planView(reference);
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

/** The panel's read-only payment routes. */
@Controller('admin')
export class PaymentsAdminController {
  constructor(@Inject(PaymentAdminService) private readonly admin: PaymentAdminService) {}

  @Get('payments/bookings/:id') @RequirePermission(P.paymentRead)
  bookingPayments(@Param('id', uuid()) id: string) {
    return this.admin.bookingPayments(id);
  }

  @Get('payments/provider-accounts') @RequirePermission(P.accountRead)
  async providerAccounts() {
    return { items: await this.admin.accounts() };
  }
}
