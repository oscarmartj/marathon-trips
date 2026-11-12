// The simulator's hosted checkout (plan 3.6, sections 3.2 and 10): where a person (pnpm dev) or Playwright (CI)
// finishes a simulated payment, as on a gateway's hosted page. It lives outside adapters/ because it uses the platform
// (config, logging, HTTP); the gateway side of the work is the adapter's own completeCheckout. Development, test and
// ci only, in two layers: the controller is not registered elsewhere, and if it were it answers 404 before anything.
import { Body, Controller, Get, HttpCode, Inject, Injectable, Logger, Param, Post, Res, Type } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { AppEnv } from '@mt/shared';
import { Public } from '../../../platform/access/access.decorators';
import type { AppConfig } from '../../../platform/config/config';
import { APP_CONFIG } from '../../../platform/database/prisma.service';
import { CsrfExempt } from '../../../platform/http/csrf.guard';
import { notFound } from '../../../platform/http/api-error';
import { ZodPipe } from '../../../platform/http/zod.pipe';
import { SimulatorProvider } from '../adapters/simulator/simulator';
import type { CheckoutResult } from '../adapters/simulator/simulator';
import { ProviderGateway, TEST_ADAPTER_ENVS } from '../core/gateway';
import { ProviderError } from '../core/provider';
import { PaymentWebhooksService } from '../core/webhooks.service';
import { checkoutPage } from './checkout.page';

/** Only `outcome`: no amount, reference or card field can be sent (422 otherwise). */
export const checkoutSubmitSchema = z.object({ outcome: z.enum(['pay', 'decline']) }).strict();

const isTestEnv = (env: string | undefined): boolean => !!env && (TEST_ADAPTER_ENVS as readonly string[]).includes(env);

@Injectable()
export class SimulatorCheckoutService {
  private readonly logger = new Logger('SimulatorCheckout');

  constructor(
    @Inject(ProviderGateway) private readonly gateway: ProviderGateway,
    @Inject(PaymentWebhooksService) private readonly webhooks: PaymentWebhooksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The simulator adapter, only in development, test and ci; otherwise the same 404 as a route that does not exist. */
  private simulator(): SimulatorProvider {
    const sim = this.gateway.registry.get('simulator');
    if (!isTestEnv(this.config.APP_ENV) || !(sim instanceof SimulatorProvider)) throw notFound();
    return sim;
  }

  page(token: string): string {
    const view = this.simulator().checkoutView(token);
    if (!view) throw notFound();
    return checkoutPage(view.status === 'requires_action' ? 'open' : 'finished', view.amount, view.returnUrl);
  }

  async submit(token: string, outcome: 'pay' | 'decline'): Promise<string> {
    const sim = this.simulator();
    const view = sim.checkoutView(token);
    if (!view) throw notFound();
    // Through the gateway wrapper: it applies the environment rule again before decrypting the account's secret.
    let result: CheckoutResult;
    try {
      result = await this.gateway.call(view.accountId, 'webhook', async (provider, ctx) => {
        if (!(provider instanceof SimulatorProvider)) throw new ProviderError('provider_not_found', false);
        return provider.completeCheckout(ctx, token, outcome);
      });
    } catch (err) {
      if (err instanceof ProviderError) throw notFound();
      throw err;
    }
    if (!result.changed) return checkoutPage('finished', view.amount, view.returnUrl);
    try {
      await this.webhooks.receiveForAccountId(view.accountId, result.webhook.body, result.webhook.headers);
    } catch (err) {
      // As with a gateway whose delivery failed: the object is settled; resuming or the sweep reads it (plan 3.6, 3.2).
      this.logger.warn(`simulator checkout: webhook delivery failed (${(err as { code?: string }).code ?? 'unexpected_error'})`);
    }
    return checkoutPage(result.payment.status === 'succeeded' ? 'paid' : 'declined', view.amount, view.returnUrl);
  }
}

/** HTML headers only on a page: an error keeps the API's JSON (and its 404 stays the same as any unknown route's). */
function asHtml(res: Response, page: string): string {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return page;
}

@Controller('payments/simulator/checkout')
export class SimulatorCheckoutController {
  constructor(@Inject(SimulatorCheckoutService) private readonly checkout: SimulatorCheckoutService) {}

  @Get(':token')
  @Public('simulator hosted checkout, development, test and ci only: the checkout token in the path is the credential')
  show(@Param('token') token: string, @Res({ passthrough: true }) res: Response): string {
    return asHtml(res, this.checkout.page(token));
  }

  @Post(':token')
  @HttpCode(200)
  @Public('simulator hosted checkout, development, test and ci only: the checkout token in the path is the credential')
  @CsrfExempt('simulator hosted checkout: a form on a gateway page, protected by the unguessable checkout token')
  async submit(@Param('token') token: string, @Body(new ZodPipe(checkoutSubmitSchema)) body: z.infer<typeof checkoutSubmitSchema>, @Res({ passthrough: true }) res: Response): Promise<string> {
    return asHtml(res, await this.checkout.submit(token, body.outcome));
  }
}

/** The checkout's controllers for an environment: none outside development, test and ci (plan 3.6, 10.6). */
export function simulatorCheckoutControllers(env: AppEnv | string | undefined): Type<unknown>[] {
  return isTestEnv(env) ? [SimulatorCheckoutController] : [];
}
