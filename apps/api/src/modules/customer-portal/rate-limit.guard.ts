import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WindowLimiter } from '../../platform/auth/attempt-limiter';
import { tooManyRequests } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';

/** Document downloads per hour, per customer user and per IP (review m3): each one renders a PDF. In memory. */
@Injectable()
export class DocumentRateLimitGuard implements CanActivate {
  private readonly perUser = new WindowLimiter(60, 3_600_000);
  private readonly perIp = new WindowLimiter(600, 3_600_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.perIp.allow(`documents:ip:${req.ip ?? 'unknown'}`)) throw tooManyRequests(3600);
    if (!this.perUser.allow(`documents:user:${req.auth?.userId ?? 'none'}`)) throw tooManyRequests(3600);
    return true;
  }
}

/**
 * A customer's changes to a booking (task 6.3): every preview prices the booking twice with the engine. Per customer user
 * and per IP, in memory: 30 previews and 10 changes per 10 minutes per user.
 */
@Injectable()
export class AmendmentRateLimitGuard implements CanActivate {
  private readonly previews = new WindowLimiter(30, 600_000);
  private readonly changes = new WindowLimiter(10, 600_000);
  private readonly perIp = new WindowLimiter(300, 600_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const preview = /\/preview$/.test(req.path ?? '');
    if (!this.perIp.allow(`amendments:ip:${req.ip ?? 'unknown'}`)) throw tooManyRequests(600);
    if (!(preview ? this.previews : this.changes).allow(`amendments:user:${req.auth?.userId ?? 'none'}`)) throw tooManyRequests(600);
    return true;
  }
}
