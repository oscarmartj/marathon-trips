// Cancellation policies on the web (task 6.4, plan docs/plans/6.4-cancellation-policies.md). Everything shown comes from
// the API: the tiers as configured and, for a booking, the penalty and refund it worked out. Nothing here computes money.
import type { CancellationPolicyPublicView, CancellationTierView } from '@mt/shared';
import { formatMoney } from './builder';
import { bpsToText } from './pricing-panel';

export type PolicyRef = { id: string; digest: string } | null;

/** What a request, a quote acceptance or the terms send back: the policy shown, or null when none was. */
export const policyRef = (p: CancellationPolicyPublicView | null | undefined): PolicyRef => (p ? { id: p.id, digest: p.digest } : null);

/** A configured percentage as people read it ("50%", "12.5%"): a rate cut from its text, never an amount. */
export const percentText = (bps: number): string => `${bpsToText(bps)}%`;

/** The message key and parameters for one tier's line, from the highest threshold down. */
export function tierLine(tier: CancellationTierView, higher: CancellationTierView | null): { key: string; params: Record<string, string> } {
  const when = tier.minDaysBeforeDeparture === 0
    ? (higher ? { key: 'lessThan', days: String(higher.minDaysBeforeDeparture) } : { key: 'any', days: '0' })
    : { key: 'atLeast', days: String(tier.minDaysBeforeDeparture) };
  const what = tier.penaltyMode === 'percent'
    ? { what: 'percent', amount: percentText(tier.penaltyBps ?? 0) }
    : { what: tier.penaltyMode === 'fixed_per_person' ? 'perPerson' : 'perBooking', amount: formatMoney(tier.penaltyMinor ?? '0', tier.currency ?? 'AUD') };
  return { key: `cancellation.tier.${when.key}.${what.what}`, params: { days: when.days, amount: what.amount } };
}

/** The tiers in the order the API gives them (highest threshold first), each with the one above it. */
export const tierLines = (p: CancellationPolicyPublicView) => p.tiers.map((tier, i) => tierLine(tier, i > 0 ? p.tiers[i - 1]! : null));
