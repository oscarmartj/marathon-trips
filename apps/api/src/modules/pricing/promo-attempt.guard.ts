import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { normalisePromoCode } from '@mt/shared';
import { Lru } from '../../platform/auth/attempt-limiter';
import { ApiError } from '../../platform/http/api-error';

/** Distinct promo codes one address may try per window on the public quote (plan 2.2, section 9). */
export const PROMO_CODES_PER_WINDOW = 10;
export const PROMO_WINDOW_SECONDS = 900;

/**
 * The address a limit applies to: an IPv4 address (also inside ::ffff:), or the /64 prefix of an IPv6 address, since
 * one subscriber usually holds a whole /64 (plan 2.2, section 15, point 7).
 */
export function attemptKeyOf(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return `v4:${v4[1]}`;
  if (!ip.includes(':')) return `other:${ip}`;
  const bare = ip.toLowerCase().split('%')[0]!;
  const halves = bare.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length > 1 ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `v6:${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/** Distinct values per key within a sliding window, in memory (one API instance, like the other limiters). */
export class DistinctLimiter {
  private readonly entries: Lru<Array<{ value: string; at: number }>>;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    this.entries = new Lru(10_000, windowMs);
  }

  /**
   * True when `value` was already seen for `key` in the window (its time is renewed), or there is room for one more.
   * In memory: the 10 000 most recent keys, so a flood of addresses can empty it, and a block of addresses wider than
   * a /64 is several keys (code review 2.2).
   */
  allow(key: string, value: string, now: number = Date.now()): boolean {
    const recent = (this.entries.get(key, now) ?? []).filter((e) => e.at > now - this.windowMs);
    if (recent.some((e) => e.value === value)) {
      // Renewed on every use: the code a customer keeps using keeps its place (code review 2.2, round 2).
      this.entries.set(key, recent.map((e) => (e.value === value ? { value, at: now } : e)), now);
      return true;
    }
    if (recent.length >= this.max) {
      this.entries.set(key, recent, now);
      return false;
    }
    this.entries.set(key, [...recent, { value, at: now }], now);
    return true;
  }
}

/**
 * Limits how many different promo codes one address can try on the public quote (plan 2.2, section 9): the same code
 * again (the builder quotes on every change) does not count, a quote without a code is never limited here, and the
 * decision comes before any lookup, so a refusal says nothing about whether a code exists. What counts is the code as
 * it would be compared (trimmed, upper case), well-formed or not.
 */
@Injectable()
export class PromoAttemptGuard implements CanActivate {
  private readonly logger = new Logger('PromoAttempts');
  private readonly limiter = new DistinctLimiter(PROMO_CODES_PER_WINDOW, PROMO_WINDOW_SECONDS * 1000);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const raw = (req.body as { promoCode?: unknown } | undefined)?.promoCode;
    if (typeof raw !== 'string') return true;
    const code = normalisePromoCode(raw);
    if (code === '' || code.length > 40) return true; // the schema refuses it with a 422; nothing is looked up
    if (this.limiter.allow(attemptKeyOf(req.ip), code)) return true;
    // No address and no code in the log: a fixed event name only.
    this.logger.warn('promo_attempts_exceeded');
    throw new ApiError(429, 'promo_attempts_exceeded', 'Too many different codes tried. Try again later.', { 'Retry-After': String(PROMO_WINDOW_SECONDS) });
  }
}
