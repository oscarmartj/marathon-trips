import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { alertConfirmSchema, alertSubscribeSchema, alertUnsubscribeSchema } from '@mt/shared';
import type { z } from 'zod';
import { Public, RequirePermission } from '../../platform/access/access.decorators';
import { ZodPipe } from '../../platform/http/zod.pipe';
import { AuthRateLimit } from '../../platform/http/rate-limit.guard';
import { AlertsService } from './alerts.service';
import { ALERTS_PERMISSIONS } from './manifest';

type In<T extends z.ZodType> = z.infer<T>;

/** Public alert routes (subscribe, confirm, unsubscribe) and the panel's subscriber counts. */
@Controller()
export class AlertsController {
  constructor(@Inject(AlertsService) private readonly alerts: AlertsService) {}

  @Post('alerts/subscriptions') @HttpCode(202) @AuthRateLimit()
  @Public('an email address and a published race; the answer is the same whatever the state of the address')
  async subscribe(@Body(new ZodPipe(alertSubscribeSchema)) b: In<typeof alertSubscribeSchema>) {
    await this.alerts.subscribe(b);
    return { accepted: true };
  }

  @Post('alerts/confirm') @HttpCode(200) @AuthRateLimit()
  @Public('a one-time confirmation token from the email')
  async confirm(@Body(new ZodPipe(alertConfirmSchema)) b: In<typeof alertConfirmSchema>) {
    await this.alerts.confirm(b.token);
    return { confirmed: true };
  }

  @Post('alerts/unsubscribe') @HttpCode(200) @AuthRateLimit()
  @Public('a subscription id with the HMAC from the unsubscribe link')
  async unsubscribe(@Body(new ZodPipe(alertUnsubscribeSchema)) b: In<typeof alertUnsubscribeSchema>) {
    await this.alerts.unsubscribe(b.subscriptionId, b.token);
    return { unsubscribed: true };
  }

  @Get('admin/alerts/subscribers') @RequirePermission(ALERTS_PERMISSIONS.subscriptionRead)
  async subscribers() {
    return { items: await this.alerts.subscriberCounts() };
  }
}
