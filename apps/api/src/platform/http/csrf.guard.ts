import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../database/prisma.service';
import { ACCESS_MARK_KEYS } from '../access/access.decorators';
import { hasAuthorization } from '../integrations/api-key-token';
import { forbidden } from './api-error';

const CSRF_EXEMPT = 'csrf-exempt';
/** Only for routes protected by a signature instead of a cookie (incoming gateway webhooks, later tasks). */
export const CsrfExempt = (reason: string) => SetMetadata(CSRF_EXEMPT, reason);

export const CSRF_HEADER = 'x-mt-csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every request that changes data must come from the web app's origin and carry X-MT-CSRF: 1 (plan 4.1). A form on
 * another site can set neither; a missing Origin is rejected too.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly origin: string;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.origin = new URL(config.WEB_ORIGIN).origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<string | undefined>(CSRF_EXEMPT, [context.getHandler(), context.getClass()])) return true;
    if (this.apiKeyRequest(context, req)) return true;
    if (req.header('origin') !== this.origin || req.header(CSRF_HEADER) !== '1') throw forbidden('csrf_rejected', 'The request was refused');
    return true;
  }

  /**
   * Task 8.4: an API key client is not a browser, and a browser on another site cannot send Authorization without a
   * CORS preflight, which the API never answers. So the check is skipped only when all three hold: the route needs a
   * permission (the access guard then accepts the key and nothing else), an Authorization header is present, and the
   * request carries no cookie at all.
   */
  private apiKeyRequest(context: ExecutionContext, req: Request): boolean {
    if (!hasAuthorization(req) || req.headers.cookie !== undefined) return false;
    const marks = [context.getHandler(), context.getClass()].flatMap((t) => ACCESS_MARK_KEYS.map((k) => this.reflector.get<{ type: string } | undefined>(k, t)));
    const present = marks.filter((m): m is { type: string } => !!m);
    return present.length === 1 && present[0]!.type === 'permission';
  }
}
