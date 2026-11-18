import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { erasureRequestSchema, exportAudienceSchema, marketingConsentSchema } from '@mt/shared';
import type { z } from 'zod';
import { OwnedBy, Public, RequirePermission } from '../../platform/access/access.decorators';
import { actorOf } from '../../platform/access/actor';
import { clearCookie } from '../../platform/auth/cookies';
import { SessionService } from '../../platform/auth/session.service';
import { WindowLimiter } from '../../platform/auth/attempt-limiter';
import { tooManyRequests } from '../../platform/http/api-error';
import { CsrfExempt } from '../../platform/http/csrf.guard';
import { AuthRateLimit } from '../../platform/http/rate-limit.guard';
import type { ApiRequest } from '../../platform/http/request-context';
import { ZodPipe } from '../../platform/http/zod.pipe';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { AccountPrivacyService } from './account.service';
import { ConsentService } from './consent.service';
import { ErasureService } from './erasure.service';
import { ExportService } from './export.service';
import { PRIVACY_PERMISSIONS } from './manifest';
import { CustomerExportRateLimitGuard, StaffExportRateLimitGuard } from './rate-limit.guard';
import { StaffPrivacyService } from './staff.service';

type In<T extends z.ZodType> = z.infer<T>;
const uuid = () => new ParseUUIDPipe();

/** Answers an export as a JSON file that no cache keeps (plan section 6). */
function sendExport(res: Response, data: Record<string, unknown>): void {
  const day = new Date().toISOString().slice(0, 10);
  res.status(200).set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="marathon-trips-data-${day}.json"`,
    'Cache-Control': 'no-store',
  }).send(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

/** The signed-in customer's privacy page: consent, download, erasure request (task 5.5). No route takes an id. */
@Controller('account/privacy')
export class AccountPrivacyController {
  constructor(
    @Inject(AccountPrivacyService) private readonly account: AccountPrivacyService,
    @Inject(ExportService) private readonly exports: ExportService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get()
  @OwnedBy({ kind: 'customer', resource: 'self' })
  view(@Req() req: ApiRequest) {
    const actor = actorOf(req);
    return this.account.view(actor.id, actor);
  }

  @Put('marketing-consent')
  @OwnedBy({ kind: 'customer', resource: 'self' })
  consent(@Body(new ZodPipe(marketingConsentSchema)) b: In<typeof marketingConsentSchema>, @Req() req: ApiRequest) {
    const actor = actorOf(req);
    return this.account.setMarketingConsent(actor.id, b.granted, b.wordingKey, actor);
  }

  @Post('erasure-request') @HttpCode(200)
  @OwnedBy({ kind: 'customer', resource: 'self' })
  erasure(@Body(new ZodPipe(erasureRequestSchema)) b: In<typeof erasureRequestSchema>, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const actor = actorOf(req);
    return this.account.requestErasure(actor.id, b.confirm === true, actor).then((r) => {
      // The account is gone: its session cookie goes with it.
      if (r.status === 'completed') clearCookie(res, 'customer', this.sessions.secureCookies);
      return r;
    });
  }

  @Get('export')
  @OwnedBy({ kind: 'customer', resource: 'self' })
  @UseGuards(CustomerExportRateLimitGuard)
  async export(@Req() req: ApiRequest, @Res() res: Response) {
    const actor = actorOf(req);
    const who = await this.account.exportSubject(actor.id, actor);
    const data = await this.exports.build(who, 'subject');
    await this.exports.record(who, 'customer', actor, 'subject');
    sendExport(res, data);
  }
}

/** The panel: a customer's privacy state, the owner's export and erasure (task 5.5, plan sections 5, 6, 8). */
@Controller('admin/privacy/customers')
export class PrivacyAdminController {
  constructor(
    @Inject(StaffPrivacyService) private readonly staff: StaffPrivacyService,
    @Inject(ExportService) private readonly exports: ExportService,
    @Inject(ErasureService) private readonly erasure: ErasureService,
  ) {}

  @Get(':id') @RequirePermission(PRIVACY_PERMISSIONS.read)
  view(@Param('id', uuid()) id: string) {
    return this.staff.view(id);
  }

  @Get(':id/export') @RequirePermission(PRIVACY_PERMISSIONS.export)
  @UseGuards(StaffExportRateLimitGuard)
  async export(@Param('id', uuid()) id: string, @Query(new ZodPipe(exportAudienceSchema)) q: In<typeof exportAudienceSchema>, @Req() req: ApiRequest, @Res() res: Response) {
    const actor = actorOf(req);
    await this.erasure.assertOwner(actor.id);
    const who = await this.staff.exportSubject(id);
    const audience = q.audience ?? 'subject';
    const data = await this.exports.build(who, audience);
    await this.exports.record(who, 'staff', actor, audience);
    sendExport(res, data);
  }

  @Post(':id/erasure') @HttpCode(200) @RequirePermission(PRIVACY_PERMISSIONS.erase)
  async erase(@Param('id', uuid()) id: string, @Req() req: ApiRequest) {
    const actor = actorOf(req);
    await this.erasure.assertOwner(actor.id);
    return this.erasure.erase(id, actor);
  }
}

/**
 * One-click unsubscribe from marketing email (task 5.5, plan section 7; RFC 8058). The address is the List-Unsubscribe
 * header's: `<outboundEmailId>.<hmac>`. POST unsubscribes; GET changes nothing and sends the person to the web page,
 * with the reference in the fragment so it never reaches a server log.
 */
@Controller('unsubscribe')
export class UnsubscribeController {
  /**
   * Review M1: RFC 8058 one-click POSTs come from a few mail-provider addresses, so a per-IP limit on valid links would
   * lose unsubscribes after a marketing send. Only links whose HMAC is wrong count (guessing), 30 a minute per address;
   * a valid link is never refused (it is idempotent and only ever withdraws consent).
   */
  private readonly badLinks = new WindowLimiter(30, 60_000);
  /**
   * Review round 2: the same valid link repeated. After 20 successful unsubscribes in an hour the answer is still 200 (it
   * is idempotent) but nothing more is done, so a loop cannot keep locking the customer. Failures are not counted.
   */
  private readonly sameLink = new WindowLimiter(20, 3_600_000);

  constructor(
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post(':ref') @HttpCode(200)
  @CsrfExempt('one-click unsubscribe (RFC 8058): mail clients POST without a browser origin; protected by the HMAC in the address')
  @Public('the email id with the HMAC from a marketing email; unsubscribes that address from marketing; wrong HMACs are rate limited')
  async unsubscribe(@Param('ref') ref: string, @Req() req: ApiRequest) {
    const valid = this.consent.isValidRef(ref);
    const linkKey = `unsubscribe:${ref.slice(0, 36)}`;
    if (!valid) {
      if (!this.badLinks.allow(`unsubscribe:${req.ip ?? 'unknown'}`)) throw tooManyRequests(60);
    } else if (!this.sameLink.wouldAllow(linkKey)) {
      return { unsubscribed: true };
    }
    await this.consent.unsubscribe(ref);
    // Counted only once it has worked (round 3): failed attempts never use up the link.
    if (valid) this.sameLink.allow(linkKey);
    return { unsubscribed: true };
  }

  @Get(':ref') @AuthRateLimit()
  @Public('a redirect to the unsubscribe page; changes nothing')
  page(@Param('ref') ref: string, @Res() res: Response) {
    const safe = /^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(ref) ? ref : '';
    res.redirect(303, `${new URL(this.config.WEB_ORIGIN).origin}/unsubscribe${safe ? `#ref=${safe}` : ''}`);
  }
}
