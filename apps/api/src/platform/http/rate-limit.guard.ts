import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { WindowLimiter } from '../auth/attempt-limiter';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../database/prisma.service';
import { tooManyRequests } from './api-error';

const RATE_LIMITED = 'auth-rate-limit';
/** Sign-in, code and magic-link routes: AUTH_RATE_LIMIT_PER_MINUTE requests per minute and IP, per route (plan 4.1). */
export const AuthRateLimit = () => SetMetadata(RATE_LIMITED, true);

/**
 * In memory, so it holds for one API instance (plan 2); the IP is Express's req.ip, which honours X-Forwarded-For only
 * from a proxy named in TRUST_PROXY (T15).
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly limiter: WindowLimiter;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.limiter = new WindowLimiter(config.AUTH_RATE_LIMIT_PER_MINUTE, 60_000);
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.reflector.getAllAndOverride<boolean | undefined>(RATE_LIMITED, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const key = `${context.getClass().name}.${context.getHandler().name}:${req.ip ?? 'unknown'}`;
    if (!this.limiter.allow(key)) throw tooManyRequests(60);
    return true;
  }
}
