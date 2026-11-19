// What the daily reconciliation records (plan docs/plans/4.6-reconciliation-receipts.md, sections 2.3 and 12). A
// difference holds codes, our ids or the gateway's references, statuses and amounts: never personal data and never a
// gateway's own words. The schema below is checked before a run's differences are written.
import { z } from 'zod';

export const DIFFERENCE_CODES = [
  // Our objects against the gateway (any adapter).
  'payment_missing_at_gateway', 'payment_status_differs', 'payment_amount_differs',
  'refund_missing_at_gateway', 'refund_status_differs', 'refund_amount_differs',
  'dispute_status_differs', 'dispute_funds_differ', 'dispute_unknown_at_gateway',
  // The gateway's activity against ours (adapters that list it).
  'unknown_gateway_payment', 'unknown_gateway_refund', 'unknown_gateway_dispute', 'gateway_amount_differs',
  // Settlements (adapters that list them).
  'settlement_totals_inconsistent', 'settlement_line_unmatched', 'settlement_line_amount_differs', 'settlement_currency_differs', 'settlement_changed', 'settlement_line_duplicate',
  // Internal.
  'receipt_missing', 'not_settled_in_time',
] as const;
export type DifferenceCode = (typeof DIFFERENCE_CODES)[number];

export const DIFFERENCE_ENTITY_TYPES = ['Payment', 'Refund', 'Dispute', 'Settlement', 'SettlementLine', 'GatewayObject'] as const;

const side = z.object({
  status: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  amountMinor: z.string().regex(/^-?\d{1,19}$/).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).strict();

export const differenceSchema = z.object({
  code: z.enum(DIFFERENCE_CODES),
  entityType: z.enum(DIFFERENCE_ENTITY_TYPES),
  /** Our id (a uuid) or, for an object only the gateway has, the gateway's reference. */
  entityId: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/),
  ours: side.optional(),
  gateway: side.optional(),
}).strict();
export type Difference = z.infer<typeof differenceSchema>;
export const differencesSchema = z.array(differenceSchema).max(5000);

export const moneySide = (amountMinor: bigint | null | undefined, currency?: string, status?: string): Difference['ours'] => ({
  ...(status ? { status } : {}),
  ...(amountMinor !== null && amountMinor !== undefined ? { amountMinor: amountMinor.toString() } : {}),
  ...(currency ? { currency } : {}),
});

/** One difference per code and object, whatever found it first. */
export function dedupe(list: readonly Difference[]): Difference[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const k = `${d.code}:${d.entityType}:${d.entityId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Errors after which an account's run stops (plan review R10): the gateway is not answering. */
export const CUT_OFF_CODES: ReadonlySet<string> = new Set(['provider_unavailable', 'provider_timeout']);
export const CUT_OFF_AFTER = 3;
