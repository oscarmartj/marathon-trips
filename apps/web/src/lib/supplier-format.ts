// Display and input helpers for supplier costs. Amounts are integers in minor units, carried as strings of digits.
// Nothing here works out a price: it only shows what the API returned and turns what a person typed into minor units.

const digitsOf = (currency: string): number => new Intl.NumberFormat('en-AU', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

/** '95050' in DKK is 'DKK 950.50'. Done with string maths so a large amount never passes through a float. */
export function formatMinor(amountMinor: string, currency: string): string {
  const d = digitsOf(currency);
  const neg = amountMinor.startsWith('-');
  const raw = (neg ? amountMinor.slice(1) : amountMinor).padStart(d + 1, '0');
  const whole = raw.slice(0, raw.length - d);
  const frac = d > 0 ? raw.slice(-d) : '';
  const decimal = `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency, currencyDisplay: 'code' }).format(decimal as unknown as number);
}

/** What a person typed ('950.5', '1,200') to minor units as a string, or null when it is not a valid amount for the currency. */
export function toMinor(input: string, currency: string): string | null {
  const d = digitsOf(currency);
  const clean = input.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(clean);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > d) return null;
  const minor = `${m[1]}${frac.padEnd(d, '0')}`.replace(/^0+(?=\d)/, '');
  return minor;
}

/** The inverse of toMinor, for filling an edit form. */
export function fromMinor(amountMinor: string, currency: string): string {
  const d = digitsOf(currency);
  if (d === 0) return amountMinor;
  const raw = amountMinor.padStart(d + 1, '0');
  return `${raw.slice(0, raw.length - d)}.${raw.slice(-d)}`;
}
