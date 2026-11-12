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

/** Codes that mean "the catalogue or its prices are not ready", not "the request is wrong". */
export const NOT_READY_CODES: ReadonlySet<string> = new Set(['rate_missing', 'no_current_price_version', 'deposit_not_configured', 'currency_mismatch', 'rule_invalid']);
