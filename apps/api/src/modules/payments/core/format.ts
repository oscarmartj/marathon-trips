/** Decimal places of a currency, from the platform's own currency data (AUD 2, JPY 0). */
const digitsOf = (currency: string): number => new Intl.NumberFormat('en-AU', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

/** 123456 in AUD is "A$1,234.56". Only formats an amount the payment plan already states; nothing is computed. */
export function formatMinor(minor: bigint, currency: string): string {
  const d = digitsOf(currency);
  const abs = minor < 0n ? -minor : minor;
  const s = abs.toString().padStart(d + 1, '0');
  const whole = s.slice(0, s.length - d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'AUD' ? 'A$' : `${currency} `;
  return `${minor < 0n ? '-' : ''}${symbol}${whole}${d > 0 ? `.${s.slice(s.length - d)}` : ''}`;
}
