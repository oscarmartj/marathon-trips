import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WindowLimiter } from '../../platform/auth/attempt-limiter';
import { tooManyRequests } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';

/** Files per hour, per staff user and per IP (task 7.2): each one sends personal data out. In memory. */
@Injectable()
export class ExportFileRateLimitGuard implements CanActivate {
  private perUser = new WindowLimiter(10, 3_600_000);
  private perIp = new WindowLimiter(100, 3_600_000);

  /** For tests: forget every count. */
  reset(): void {
    this.perUser = new WindowLimiter(10, 3_600_000);
    this.perIp = new WindowLimiter(100, 3_600_000);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.perIp.allow(`export:ip:${req.ip ?? 'unknown'}`)) throw tooManyRequests(3600);
    if (!this.perUser.allow(`export:user:${req.auth?.userId ?? 'none'}`)) throw tooManyRequests(3600);
    return true;
  }
}

/** Dry-run checks per hour per staff user: each one reads the runners of an edition. */
@Injectable()
export class ExportCheckRateLimitGuard implements CanActivate {
  private perUser = new WindowLimiter(60, 3_600_000);

  /** For tests: forget every count. */
  reset(): void {
    this.perUser = new WindowLimiter(60, 3_600_000);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.perUser.allow(`export-check:user:${req.auth?.userId ?? 'none'}`)) throw tooManyRequests(3600);
    return true;
  }
}
