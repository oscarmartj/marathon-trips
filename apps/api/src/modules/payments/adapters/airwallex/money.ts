// Money for the Airwallex adapter (plan docs/plans/9.2-airwallex.md, sections 5, 19.6 and 20.7). Airwallex takes and
// gives decimals in major units ("12.50"), not minor units. Ours are integer minor units: converted here with bigint and
// string operations only, never through a JavaScript number. Only AUD (two decimals) is readable or sendable: a JPY
// "1250" or a KWD "12.500" is unreadable, never multiplied or guessed.

/** Currencies the adapter can express, all with two decimals. */
export const AIRWALLEX_CURRENCIES: readonly string[] = ['AUD'];
/** Smallest and largest amount the adapter sends (A$0.01 to A$9,999,999.99), as PayPal's. */
export const AIRWALLEX_MIN_AMOUNT = 1n;
export const AIRWALLEX_MAX_AMOUNT = 999_999_999n;

const VALUE = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/;

/** A validated decimal amount, written into a request body exactly as its text (plan 19.6): never a number. */
export class DecimalLiteral {
  private constructor(readonly text: string) {}

  /** Minor units as Airwallex's decimal, or null outside the bounds or for a currency the adapter does not handle. */
  static of(amountMinor: bigint, currency: string): DecimalLiteral | null {
    if (!AIRWALLEX_CURRENCIES.includes(currency)) return null;
    if (amountMinor < AIRWALLEX_MIN_AMOUNT || amountMinor > AIRWALLEX_MAX_AMOUNT) return null;
    return new DecimalLiteral(`${(amountMinor / 100n).toString()}.${(amountMinor % 100n).toString().padStart(2, '0')}`);
  }
}

/**
 * Airwallex's amount (the source text of a JSON number, or a JSON string) as minor units; null for anything that is not
 * a plain non-negative decimal with at most two places, or for a currency other than AUD.
 */
export function fromAirwallexAmount(value: unknown, currency: unknown): bigint | null {
  if (typeof value !== 'string' || typeof currency !== 'string' || !AIRWALLEX_CURRENCIES.includes(currency)) return null;
  const m = VALUE.exec(value);
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}
