import { z } from 'zod';
import { PAYMENT_METHODS } from './payments';

// Payment routing rules (task 4.2, plan docs/plans/4.2-routing-rules.md, section 8). Amounts are integer strings of
// minor units (never a float); the API checks every rule against the adapter's capabilities and answers with codes.
const minor = z.string().max(20);
const ruleFields = {
  method: z.enum(PAYMENT_METHODS),
  /** Null: any country. */
  countries: z.array(z.string().max(2)).max(250).nullable(),
  currency: z.string().max(3),
  minAmountMinor: minor.nullable().optional(),
  maxAmountMinor: minor.nullable().optional(),
  priority: z.number().int(),
  enabled: z.boolean(),
  fallbackForRuleId: z.string().uuid().nullable().optional(),
};

export const createRoutingRuleSchema = z.strictObject({ providerAccountId: z.string().uuid(), ...ruleFields, confirmCoverageLoss: z.boolean().optional() });
export const updateRoutingRuleSchema = z.strictObject({
  version: z.number().int().min(0),
  ...Object.fromEntries(Object.entries(ruleFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) as { [K in keyof typeof ruleFields]: z.ZodOptional<(typeof ruleFields)[K]> },
  confirmCoverageLoss: z.boolean().optional(),
});
export const deleteRoutingRuleSchema = z.strictObject({ version: z.number().int().min(0), confirmCoverageLoss: z.boolean().optional() });
export const restoreDefaultRulesSchema = z.strictObject({ confirmCoverageLoss: z.boolean().optional() });
export const routingPreviewSchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
  country: z.string().regex(/^[A-Z]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: z.string().regex(/^\d{1,13}$/).optional(),
});

export type CreateRoutingRule = z.infer<typeof createRoutingRuleSchema>;
export type UpdateRoutingRule = z.infer<typeof updateRoutingRuleSchema>;

/** Why a rule does not take a payment in the preview (plan 4.2, section 8). */
export const ROUTING_EXCLUSION_REASONS = [
  'disabled', 'method', 'currency', 'country', 'below_min', 'above_max', 'outside_adapter', 'account_not_active', 'adapter_blocked',
  'manual_off', 'unreachable', 'primary_serving', 'primary_not_matching',
] as const;
export type RoutingExclusionReason = (typeof ROUTING_EXCLUSION_REASONS)[number];

export interface RoutingRuleView {
  id: string;
  providerAccountId: string;
  accountName: string;
  accountStatus: string;
  adapterKey: string;
  adapterStatus: string;
  method: (typeof PAYMENT_METHODS)[number];
  countries: string[] | null;
  currency: string;
  minAmountMinor: string | null;
  maxAmountMinor: string | null;
  priority: number;
  enabled: boolean;
  fallbackForRuleId: string | null;
  matchesAdapter: boolean;
  version: number;
  createdAt: string;
}

export type RoutingWarning =
  | { code: 'account_unreachable'; accountId: string; until: string | null }
  | { code: 'account_auth_failed'; accountId: string }
  | { code: 'method_unreachable_now'; method: string; country: string }
  | { code: 'method_limited_by_amount'; method: string; country: string; gaps: Array<{ fromMinor: string; toMinor: string }> }
  | { code: 'active_account_without_rules'; accountId: string }
  | { code: 'rule_outside_adapter_capabilities'; ruleId: string }
  | { code: 'fallback_target_disabled'; ruleId: string; backupRuleIds: string[] }
  | { code: 'live_attempts_on_unreachable_account'; accountId: string; bookingIds: string[] };
