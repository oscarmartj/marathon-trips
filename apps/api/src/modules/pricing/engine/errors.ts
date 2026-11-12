/**
 * A pricing failure with a stable code. The service turns it into an HTTP answer: configuration problems are 422,
 * missing prices or versions are 409. `details` holds ids and kinds only, never free text.
 */
export class PricingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Codes that mean "the catalogue or its prices are not ready", not "the request is wrong". Errors that carry
 * `details.origin` (a stored rule or the promo code) are configuration errors and are answered by the service
 * (plan 2.2, section 15, points 1 and 10), never as the caller's fault.
 */
export const NOT_READY_CODES: ReadonlySet<string> = new Set(['rate_missing', 'no_current_price_version', 'deposit_not_configured', 'currency_mismatch', 'adjustment_above_limit']);

/** Codes that mean the engine itself broke an invariant: a bug, answered as a logged 500, never as the caller's fault. */
export const INTERNAL_CODES: ReadonlySet<string> = new Set(['total_negative', 'total_inconsistent', 'rounding_invalid', 'amount_negative']);
