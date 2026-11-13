import { looksLikeToken, tokenHash } from '../../platform/auth/tokens';
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

/**
 * Terms acceptance and "where is my payment" calls per hour, per customer user and per IP. Generous: the return page asks a
 * few times while a payment settles (task 3.5, plan section 3). In memory, like the other limits.
 */
@Injectable()
export class CheckoutRateLimitGuard implements CanActivate {
  private readonly perUser = new WindowLimiter(240, 3_600_000);
  private readonly perIp = new WindowLimiter(1_200, 3_600_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.perIp.allow(`checkout:ip:${req.ip ?? 'unknown'}`)) throw tooManyRequests(3600);
    if (!this.perUser.allow(`checkout:user:${req.auth?.userId ?? 'none'}`)) throw tooManyRequests(3600);
    return true;
  }
}

/**
 * Payment link calls (task 5.1): per IP, and per token so one leaked link cannot be hammered from many addresses. The
 * token is only hashed here, never kept or logged. In memory, like the other limits.
 */
@Injectable()
export class PaymentLinkRateLimitGuard implements CanActivate {
  private readonly perIp = new WindowLimiter(300, 3_600_000);
  private readonly perToken = new WindowLimiter(60, 3_600_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.perIp.allow(`payment-link:ip:${req.ip ?? 'unknown'}`)) throw tooManyRequests(3600);
    const token = (req.body as { token?: unknown } | undefined)?.token;
    const key = looksLikeToken(token) ? tokenHash(token) : 'malformed';
    if (!this.perToken.allow(`payment-link:token:${key}`)) throw tooManyRequests(3600);
    return true;
  }
}
