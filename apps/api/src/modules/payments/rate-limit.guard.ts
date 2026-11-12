import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../platform/config/config';
import { APP_CONFIG } from '../../platform/database/prisma.service';
import { WindowLimiter } from '../../platform/auth/attempt-limiter';
import { tooManyRequests } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';

/** Payment starts per hour, per customer user and per IP (plan 3.1, section 7), in memory like the other limits. */
@Injectable()
export class PaymentAttemptRateLimitGuard implements CanActivate {
  private readonly perUser: WindowLimiter;
  private readonly perIp: WindowLimiter;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.perUser = new WindowLimiter(config.PAYMENT_ATTEMPTS_PER_HOUR_PER_USER, 3_600_000);
    this.perIp = new WindowLimiter(config.PAYMENT_ATTEMPTS_PER_HOUR_PER_IP, 3_600_000);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.perIp.allow(`payment-start:ip:${req.ip ?? 'unknown'}`)) throw tooManyRequests(3600);
    if (!this.perUser.allow(`payment-start:user:${req.auth?.userId ?? 'none'}`)) throw tooManyRequests(3600);
    return true;
  }
}
