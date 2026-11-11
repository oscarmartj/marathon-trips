import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../database/prisma.service';
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
    if (req.header('origin') !== this.origin || req.header(CSRF_HEADER) !== '1') throw forbidden('csrf_rejected', 'The request was refused');
    return true;
  }
}
