import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WindowLimiter } from '../../platform/auth/attempt-limiter';
import { tooManyRequests } from '../../platform/http/api-error';
import type { ApiRequest } from '../../platform/http/request-context';

/** Visit requests per minute and address. In production the address is the visitor's (the proxy hops are set), so this is a per-person cap. */
export const VISITS_PER_MINUTE = 60;
/** The same visitor counts once per race and kind in this long: a reload or a script cannot raise the numbers. */
export const VISIT_DEDUPE_MS = 30 * 60_000;

/** Previews and runs per minute and staff user: each one reads every booking in its range. */
export const REPORT_RUNS_PER_MINUTE = 120;

/** Caps previews and saved-report runs per staff user (in memory, per API instance). */
@Injectable()
export class ReportRunRateLimitGuard implements CanActivate {
  private readonly limiter = new WindowLimiter(REPORT_RUNS_PER_MINUTE, 60_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.limiter.allow(`report-run:${req.auth?.userId ?? req.ip ?? 'unknown'}`)) throw tooManyRequests(60);
    return true;
  }
}

@Injectable()
export class VisitRateLimitGuard implements CanActivate {
  private readonly limiter = new WindowLimiter(VISITS_PER_MINUTE, 60_000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    if (!this.limiter.allow(`race-event:${req.ip ?? 'unknown'}`)) throw tooManyRequests(60);
    return true;
  }
}

/**
 * Remembers, in memory only and in a bounded cache, that an address already counted for a race and kind. Nothing is
 * stored in the database and the key is forgotten after the window. Per API instance, so it is a guide, not a proof.
 */
@Injectable()
export class VisitDeduper {
  private readonly seen = new WindowLimiter(1, VISIT_DEDUPE_MS);

  /** True the first time in the window. */
  first(ip: string | undefined, raceSlug: string, kind: string, now: number = Date.now()): boolean {
    return this.seen.allow(`${ip ?? 'unknown'}|${raceSlug}|${kind}`, now);
  }
}
