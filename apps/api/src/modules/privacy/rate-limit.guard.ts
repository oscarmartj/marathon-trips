import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WindowLimiter } from '../../platform/auth/attempt-limiter';
import { tooManyRequests } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';

/** Customer data exports: 5 per hour per user and 30 per IP (each one reads everything about a person). In memory. */
@Injectable()
export class CustomerExportRateLimitGuard implements CanActivate {
  private readonly perUser = new WindowLimiter(5, 3_600_000);
  private readonly perIp = new WindowLimiter(30, 3_600_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.perIp.allow(`privacy-export:ip:${req.ip ?? 'unknown'}`)) throw tooManyRequests(3600);
    if (!this.perUser.allow(`privacy-export:user:${req.auth?.userId ?? 'none'}`)) throw tooManyRequests(3600);
    return true;
  }
}

/** Staff exports: 10 per hour per staff user. */
@Injectable()
export class StaffExportRateLimitGuard implements CanActivate {
  private readonly perUser = new WindowLimiter(10, 3_600_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.perUser.allow(`privacy-export:staff:${req.auth?.userId ?? 'none'}`)) throw tooManyRequests(3600);
    return true;
  }
}
