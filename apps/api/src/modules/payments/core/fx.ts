// Task 6.6 (plan docs/plans/6.6-trip-result-forecast.md, section 2): currency decimal places and the rate implied by two
// amounts staff typed from the bank statement. Nothing here converts money: the rate is shown for information and is never an
// input to any amount. Integer arithmetic only. Finding 3 of plan 0.1 "Aparcado: dinero".

/** Decimal places of a currency, from the platform's own currency data (AUD 2, JPY 0, KWD 3). */
export function currencyExponent(currency: string): number {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/**
 * An amount in minor units as an exact decimal text in major units: 123450 AUD is "1234.50", 1234 JPY is "1234", -5 AUD is
 * "-0.05". Built from the digits of the bigint, so there is no float and no rounding.
 */
export function minorToDecimal(minor: bigint, currency: string): string {
  const places = currencyExponent(currency);
  const abs = minor < 0n ? -minor : minor;
  const digits = abs.toString().padStart(places + 1, '0');
  const body = places > 0 ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  return minor < 0n ? `-${body}` : body;
}

const E9 = 1_000_000_000n;

/**
 * The rate implied by two typed amounts: major units of `bCurrency` per one major unit of `aCurrency`, times 10^9. Both
 * amounts are in minor units, so the currencies' decimal places are applied (10 000 JPY for 100.00 AUD is 0.01 AUD per JPY,
 * not 1). The one rounding rule of task 6.6: half up, on bigint. Information only.
 */
export function impliedRateE9(aMinor: bigint, aCurrency: string, bMinor: bigint, bCurrency: string): bigint {
  if (aMinor <= 0n || bMinor <= 0n) throw new RangeError('an implied rate needs two amounts above 0');
  if (aCurrency === bCurrency) throw new RangeError('an implied rate needs two currencies');
  const ea = BigInt(currencyExponent(aCurrency));
  const eb = BigInt(currencyExponent(bCurrency));
  const num = bMinor * 10n ** ea * E9;
  const den = aMinor * 10n ** eb;
  return (2n * num + den) / (2n * den);
}
