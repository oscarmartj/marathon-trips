import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WindowLimiter } from '../../platform/auth/attempt-limiter';
import { tooManyRequests } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';

/** Visits per minute and address. Generous, because until the hosting task names the proxies in front of the web app, every visitor shares one address. */
export const VISITS_PER_MINUTE = 600;

/** A cap on the anonymous visit counter (task 7.7), in memory like the other limits. */
@Injectable()
export class VisitRateLimitGuard implements CanActivate {
  private readonly limiter = new WindowLimiter(VISITS_PER_MINUTE, 60_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.limiter.allow(`race-event:${req.ip ?? 'unknown'}`)) throw tooManyRequests(60);
    return true;
  }
}
