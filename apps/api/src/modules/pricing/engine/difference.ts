import { PricingError } from './errors';

/**
 * The difference a change of a booking makes to its price (task 6.3; plan docs/plans/6.3-booking-amendments.md, section 4).
 * Pure. It rounds nothing of its own: both totals come from the engine, each already rounded line by line by the single
 * rule of rounding.ts, and the difference is their exact integer subtraction, signed (a reduction is negative).
 */
export function priceDifference(previous: { totalMinor: bigint; currency: string }, next: { totalMinor: bigint; currency: string }): bigint {
  if (typeof previous.totalMinor !== 'bigint' || typeof next.totalMinor !== 'bigint') throw new PricingError('rounding_invalid', 'Totals must be integers in minor units');
  if (previous.currency !== next.currency) throw new PricingError('currency_mismatch', 'A change cannot move a booking to another currency');
  return next.totalMinor - previous.totalMinor;
}
