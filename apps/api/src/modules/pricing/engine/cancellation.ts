// The cancellation penalty (task 6.4, plan docs/plans/6.4-cancellation-policies.md, sections 3 and 4). Pure: no
// database, no clock. Percentages go through applyBps, THE rounding rule (rounding.ts); nothing here divides.
import { PricingError } from './errors';
import { applyBps } from './rounding';
import { daysBetween } from './calendar';

export type CancellationPenaltyMode = 'percent' | 'fixed_per_person' | 'fixed_per_booking';
export type CancellationBasis = 'policy' | 'not_contracted' | 'no_policy' | 'operator_cancelled';

export interface CancellationTierInput {
  id: string;
  minDaysBeforeDeparture: number;
  penaltyMode: CancellationPenaltyMode;
  penaltyBps: number | null;
  penaltyMinor: bigint | null;
  currency: string | null;
}

export interface CancellationPolicyInput {
  id: string;
  currency: string | null;
  tiers: readonly CancellationTierInput[];
}

/** States a cancellation can start from, and those where the booking is a contract (deposit covered). */
export const CANCELLABLE_STATES = ['requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid'] as const;
export const CONTRACTED_STATES: readonly string[] = ['deposit_paid', 'confirmed', 'balance_paid'];

export const MAX_TIERS = 10;
export const MAX_TIER_DAYS = 3650;
/** The cap of plan 0.1, 1.1 on a single amount (a 13-digit string of minor units). */
const MAX_FIXED_MINOR = 99_999_999_999n;

export interface CancellationQuoteInput {
  policy: CancellationPolicyInput | null;
  status: string;
  operatorCancelled: boolean;
  /** YYYY-MM-DD: the booking's departure date (extra nights before included). */
  departureDate: string;
  /** YYYY-MM-DD in the business time zone: the date the days are counted from. */
  effectiveDate: string;
  baseTotalMinor: bigint;
  places: number;
  currency: string;
  /** What the booking holds (collected, disputed money not yet withdrawn excluded); may be negative. */
  heldMinor: bigint;
}

export interface CancellationQuote {
  basis: CancellationBasis;
  daysBeforeDeparture: number;
  tier: CancellationTierInput | null;
  policyPenaltyMinor: bigint;
  penaltyMinor: bigint;
  waivedMinor: bigint;
  refundableMinor: bigint;
}

const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max0 = (a: bigint): bigint => (a > 0n ? a : 0n);

/** Tiers from the highest threshold down; the first one the days reach applies, the 0 tier covers the rest. */
export function tierFor(tiers: readonly CancellationTierInput[], days: number): CancellationTierInput {
  const sorted = [...tiers].sort((a, b) => b.minDaysBeforeDeparture - a.minDaysBeforeDeparture);
  const zero = sorted.find((t) => t.minDaysBeforeDeparture === 0);
  if (!zero) throw new PricingError('cancellation_policy_invalid', 'A cancellation policy needs a tier at 0 days');
  return sorted.find((t) => days >= t.minDaysBeforeDeparture) ?? zero;
}

/** The penalty of one tier on a total: rounded by THE rule, never above the total. */
export function tierPenalty(tier: CancellationTierInput, baseTotalMinor: bigint, places: number, currency: string): bigint {
  if (baseTotalMinor < 0n || !Number.isInteger(places) || places < 0) throw new PricingError('amount_negative', 'A cancellation needs a total and places of at least 0');
  let penalty: bigint;
  if (tier.penaltyMode === 'percent') {
    if (tier.penaltyBps === null) throw new PricingError('cancellation_policy_invalid', 'A percentage tier needs basis points');
    penalty = applyBps(baseTotalMinor, tier.penaltyBps);
  } else {
    if (tier.penaltyMinor === null || tier.currency === null) throw new PricingError('cancellation_policy_invalid', 'A fixed tier needs an amount and a currency');
    if (tier.currency !== currency) throw new PricingError('cancellation_currency_mismatch', 'The policy\'s fixed amount is in another currency than the booking', { tierId: tier.id });
    penalty = tier.penaltyMode === 'fixed_per_person' ? tier.penaltyMinor * BigInt(places) : tier.penaltyMinor;
  }
  return minOf(penalty, baseTotalMinor);
}

/** Section 2, decision 3 and section 13 (M3): which rule decides the penalty. */
export function basisFor(status: string, hasPolicy: boolean, operatorCancelled: boolean): CancellationBasis {
  if (!(CANCELLABLE_STATES as readonly string[]).includes(status)) throw new PricingError('cancellation_state_invalid', 'This booking cannot be cancelled in its state');
  if (operatorCancelled) return 'operator_cancelled';
  if (!CONTRACTED_STATES.includes(status)) return 'not_contracted';
  return hasPolicy ? 'policy' : 'no_policy';
}

/**
 * What a cancellation would owe and give back (section 4). The booking keeps owing only what it holds of the
 * policy's penalty (decision 5): the rest is waived, never charged after cancelling.
 */
export function quoteCancellation(input: CancellationQuoteInput): CancellationQuote {
  const basis = basisFor(input.status, input.policy !== null, input.operatorCancelled);
  const days = daysBetween(input.effectiveDate, input.departureDate);
  let tier: CancellationTierInput | null = null;
  let policyPenalty = 0n;
  if (basis === 'policy') {
    tier = tierFor(input.policy!.tiers, days);
    policyPenalty = tierPenalty(tier, input.baseTotalMinor, input.places, input.currency);
  }
  const held = max0(input.heldMinor);
  const penalty = minOf(policyPenalty, held);
  return { basis, daysBeforeDeparture: days, tier, policyPenaltyMinor: policyPenalty, penaltyMinor: penalty, waivedMinor: policyPenalty - penalty, refundableMinor: held - penalty };
}

export interface PolicyProblem {
  code: string;
  tier?: number;
}

/** Activation rules (section 4); the trigger in 0038 repeats the structural ones. Empty means valid. */
export function validatePolicy(tiers: readonly Omit<CancellationTierInput, 'id'>[]): { problems: PolicyProblem[]; currency: string | null } {
  const problems: PolicyProblem[] = [];
  if (tiers.length < 1) problems.push({ code: 'no_tiers' });
  if (tiers.length > MAX_TIERS) problems.push({ code: 'too_many_tiers' });
  const seen = new Set<number>();
  const currencies = new Set<string>();
  tiers.forEach((t, i) => {
    if (!Number.isInteger(t.minDaysBeforeDeparture) || t.minDaysBeforeDeparture < 0 || t.minDaysBeforeDeparture > MAX_TIER_DAYS) problems.push({ code: 'days_out_of_range', tier: i });
    if (seen.has(t.minDaysBeforeDeparture)) problems.push({ code: 'duplicate_days', tier: i });
    seen.add(t.minDaysBeforeDeparture);
    if (t.penaltyMode === 'percent') {
      if (t.penaltyBps === null || !Number.isInteger(t.penaltyBps) || t.penaltyBps < 0 || t.penaltyBps > 10_000) problems.push({ code: 'percent_out_of_range', tier: i });
      if (t.penaltyMinor !== null || t.currency !== null) problems.push({ code: 'percent_with_amount', tier: i });
    } else {
      if (t.penaltyMinor === null || t.penaltyMinor < 0n || t.penaltyMinor > MAX_FIXED_MINOR) problems.push({ code: 'amount_out_of_range', tier: i });
      if (t.currency === null || !/^[A-Z]{3}$/.test(t.currency)) problems.push({ code: 'fixed_without_currency', tier: i });
      else currencies.add(t.currency);
      if (t.penaltyBps !== null) problems.push({ code: 'fixed_with_percent', tier: i });
    }
  });
  if (tiers.length > 0 && !seen.has(0)) problems.push({ code: 'no_zero_tier' });
  if (currencies.size > 1) problems.push({ code: 'mixed_currencies' });
  return { problems, currency: currencies.size === 1 ? [...currencies][0]! : null };
}
