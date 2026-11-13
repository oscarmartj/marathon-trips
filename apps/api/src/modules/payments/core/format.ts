/** 123456 in AUD is "A$1,234.56". Only formats an amount the payment plan already states; nothing is computed. */
export function formatMinor(minor: bigint, currency: string): string {
  const abs = minor < 0n ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'AUD' ? 'A$' : `${currency} `;
  return `${minor < 0n ? '-' : ''}${symbol}${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}
