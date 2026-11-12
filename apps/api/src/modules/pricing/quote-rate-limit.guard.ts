import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { WindowLimiter } from '../../platform/auth/attempt-limiter';
import { tooManyRequests } from '../../platform/http/api-error';

/** Public quotes per IP and minute: enough for the builder, which asks on every change, and a cap on scraping (M13). */
export const PUBLIC_QUOTES_PER_MINUTE = 120;

/** In memory, like the sign-in limiter (one API instance, plan 0.3); the IP is Express's req.ip (TRUST_PROXY). */
@Injectable()
export class QuoteRateLimitGuard implements CanActivate {
  private readonly limiter = new WindowLimiter(PUBLIC_QUOTES_PER_MINUTE, 60_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!this.limiter.allow(`quote:${req.ip ?? 'unknown'}`)) throw tooManyRequests(60);
    return true;
  }
}
