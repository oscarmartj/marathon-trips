// Money for the PayPal adapter (plan docs/plans/4.3-paypal-adapter.md, section 5.1): our integer minor units to PayPal's
// decimal strings and back, exactly, with bigint and string operations only. Only two-decimal currencies exist here.

/** Currencies the adapter can express: two decimals each (developer.paypal.com/api/rest/reference/currency-codes/). */
export const TWO_DECIMAL_CURRENCIES: readonly string[] = ['AUD'];
/** Smallest and largest amount the adapter sends (A$0.01 to A$9,999,999.99, plan D14). */
export const PAYPAL_MIN_AMOUNT = 1n;
export const PAYPAL_MAX_AMOUNT = 999_999_999n;

const VALUE = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/;

/** Minor units as PayPal's `value`, or null outside the bounds or for a currency without two decimals. */
export function toPayPalValue(amountMinor: bigint, currency: string): string | null {
  if (!TWO_DECIMAL_CURRENCIES.includes(currency)) return null;
  if (amountMinor < PAYPAL_MIN_AMOUNT || amountMinor > PAYPAL_MAX_AMOUNT) return null;
  const units = amountMinor / 100n;
  const cents = amountMinor % 100n;
  return `${units.toString()}.${cents.toString().padStart(2, '0')}`;
}

/** PayPal's `value` as minor units, or null for anything that is not a plain non-negative decimal with at most two places. */
export function fromPayPalValue(value: unknown, currency: unknown): bigint | null {
  if (typeof value !== 'string' || typeof currency !== 'string' || !TWO_DECIMAL_CURRENCIES.includes(currency)) return null;
  const m = VALUE.exec(value);
  if (!m) return null;
  const fraction = (m[2] ?? '').padEnd(2, '0');
  return BigInt(m[1]!) * 100n + BigInt(fraction);
}
