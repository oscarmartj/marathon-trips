import { PricingError } from './errors';

/**
 * THE rounding rule (plan 0.1, 1.1; plan 2.1, section 3), stated once: integer arithmetic, to the minor unit, half up
 * on the absolute value, applied line by line. Totals add lines that are already rounded. This is the only file in
 * the pricing module allowed to divide (a test walks the syntax tree of every other file).
 */
export function mulDivHalfUp(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || denominator % 2n !== 0n) throw new PricingError('rounding_invalid', 'The denominator must be positive and even');
  if (numerator < 0n) throw new PricingError('rounding_invalid', 'The numerator cannot be negative');
  const abs = amount < 0n ? -amount : amount;
  const rounded = (abs * numerator + denominator / 2n) / denominator;
  return amount < 0n ? -rounded : rounded;
}

export const BPS_DENOMINATOR = 10_000n;
/** Discounts and deposits: 0 to 100 %. */
export const MAX_DISCOUNT_BPS = 10_000;
/** Surcharges: 0 to 1000 %. */
export const MAX_SURCHARGE_BPS = 100_000;

/** `amount × bps / 10 000`, rounded by the rule above. `bps` is a whole number of basis points within `[0, max]`. */
export function applyBps(amount: bigint, bps: number, max: number = MAX_DISCOUNT_BPS): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) throw new PricingError('rounding_invalid', 'Basis points out of range');
  return mulDivHalfUp(amount, BigInt(bps), BPS_DENOMINATOR);
}
