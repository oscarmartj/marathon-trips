import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { createApiKeySchema, createWebhookSchema, updateWebhookSchema } from '@mt/shared';
import type { z } from 'zod';
import { RequirePermission } from '../access/access.decorators';
import { actorOf } from '../access/actor';
import { RequiresModule } from '../flags/requires-module.guard';
import type { ApiRequest } from '../http/request-context';
import { ZodPipe } from '../http/zod.pipe';
import { ApiKeysService } from './api-keys.service';
import { INTEGRATIONS_MODULE, INTEGRATIONS_PERMISSIONS as P } from './permissions';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhooksService } from './webhooks.service';

const uuid = () => new ParseUUIDPipe();
type In<T extends z.ZodType> = z.infer<T>;

/**
 * API keys and outgoing webhooks in the panel (task 8.4). 404 while the integrations flag is off. Reading needs the read
 * permission; every change needs the manage permission, which requires a recent TOTP check, so API keys cannot use it.
 * Secrets appear only in the response that creates or rotates them.
 */
@Controller('admin/integrations')
@RequiresModule(INTEGRATIONS_MODULE)
export class IntegrationsController {
  constructor(
    @Inject(ApiKeysService) private readonly keys: ApiKeysService,
    @Inject(WebhooksService) private readonly webhooks: WebhooksService,
    @Inject(WebhookDeliveryService) private readonly deliveries: WebhookDeliveryService,
  ) {}

  @Get('api-keys') @RequirePermission(P.apiKeyRead)
  listKeys(@Req() req: ApiRequest) { return this.keys.list(req.auth!); }

  @Get('api-key-scopes') @RequirePermission(P.apiKeyRead)
  scopes(@Req() req: ApiRequest) { return this.keys.scopable(req.auth!); }

  @Post('api-keys') @RequirePermission(P.apiKeyManage)
  createKey(@Body(new ZodPipe(createApiKeySchema)) b: In<typeof createApiKeySchema>, @Req() req: ApiRequest) { return this.keys.create(actorOf(req), req.auth!, b); }

  @Post('api-keys/:id/revoke') @HttpCode(204) @RequirePermission(P.apiKeyManage)
  async revokeKey(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.keys.revoke(actorOf(req), id); }

  @Get('webhook-events') @RequirePermission(P.webhookRead)
  events(@Req() req: ApiRequest) { return this.webhooks.catalogue(req.auth!); }

  @Get('webhooks') @RequirePermission(P.webhookRead)
  listWebhooks() { return this.webhooks.list(); }

  @Post('webhooks') @RequirePermission(P.webhookManage)
  createWebhook(@Body(new ZodPipe(createWebhookSchema)) b: In<typeof createWebhookSchema>, @Req() req: ApiRequest) { return this.webhooks.create(actorOf(req), req.auth!, b); }

  @Patch('webhooks/:id') @RequirePermission(P.webhookManage)
  updateWebhook(@Param('id', uuid()) id: string, @Body(new ZodPipe(updateWebhookSchema)) b: In<typeof updateWebhookSchema>, @Req() req: ApiRequest) {
    return this.webhooks.update(actorOf(req), req.auth!, id, b);
  }

  @Delete('webhooks/:id') @HttpCode(204) @RequirePermission(P.webhookManage)
  async deleteWebhook(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.webhooks.remove(actorOf(req), id); }

  @Post('webhooks/:id/rotate-secret') @HttpCode(200) @RequirePermission(P.webhookManage)
  rotate(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { return this.webhooks.rotate(actorOf(req), id); }

  @Post('webhooks/:id/test') @HttpCode(202) @RequirePermission(P.webhookManage)
  test(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { return this.webhooks.test(actorOf(req), id); }

  @Get('webhooks/:id/deliveries') @RequirePermission(P.webhookRead)
  deliveriesOf(@Param('id', uuid()) id: string) { return this.webhooks.listDeliveries(id); }

  @Post('webhook-deliveries/:id/retry') @HttpCode(202) @RequirePermission(P.webhookManage)
  async retry(@Param('id', uuid()) id: string, @Req() req: ApiRequest) { await this.deliveries.retry(actorOf(req), id); }
}
