import { z } from 'zod';

// What a booking snapshot may hold (plan 0.1, 4.9 and 5.4; plan 2.4, section 4, step 8): ids, slots, codes, dates and
// amounts as strings of digits. Strict at every level and with no free-form string, so no personal data or free text
// can ever reach an immutable row. A new field from the engine fails here, loudly, until this schema names it.

const uuid = z.uuid();
const digits = z.string().regex(/^\d{1,13}$/);
const signedDigits = z.string().regex(/^-?\d{1,13}$/);
const slot = z.number().int().min(1).max(80);
const code = z.string().regex(/^[a-z][a-z_]{0,39}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PARTICIPATION = z.enum(['runner_with_entry', 'runner_own_entry', 'supporter']);
const TARGET = z.enum(['accommodation', 'participation', 'extras', 'subtotal']);

export const snapshotConfigurationSchema = z.strictObject({
  packageId: uuid,
  rooms: z.array(z.strictObject({
    roomOptionId: uuid,
    occupancy: z.number().int().min(1).max(4),
    travellers: z.array(z.strictObject({ slot, participationType: PARTICIPATION, raceDistanceId: uuid.nullable() })).min(1).max(4),
  })).min(1).max(20),
  extraNightsBefore: z.number().int().min(0).max(30),
  extraNightsAfter: z.number().int().min(0).max(30),
  extras: z.array(z.strictObject({ extraId: uuid, travellerSlots: z.array(slot).max(80), quantity: z.number().int().min(1).max(1000) })).max(50),
});

const line = z.strictObject({
  key: z.string().regex(/^[a-z_]+(:[0-9a-f-]{36})?(:\d{1,2})?$/),
  component: TARGET,
  kind: z.enum(['room', 'extra_nights', 'participation', 'extra', 'rule', 'promo']),
  direction: z.enum(['charge', 'surcharge', 'discount']),
  travellerSlot: slot.nullable(),
  refId: uuid.nullable(),
  unitAmountMinor: signedDigits,
  quantity: z.number().int().min(0).max(1000),
  amountMinor: signedDigits,
  cappedFromMinor: signedDigits.nullable(),
  effect: z.strictObject({
    kind: code,
    direction: z.enum(['discount', 'surcharge']),
    effectMode: z.enum(['percent', 'fixed']),
    valueBps: z.number().int().min(0).max(100_000).nullable(),
    valueMinor: digits.nullable(),
    per: z.enum(['person', 'booking']),
    appliesTo: TARGET,
  }).nullable(),
});

export const snapshotBreakdownSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceVersionId: uuid,
  engineVersion: z.string().regex(/^pricing-\d+\.\d+\.\d+$/),
  computedAt: z.iso.datetime(),
  configuration: snapshotConfigurationSchema,
  departureDate: isoDate,
  returnDate: isoDate,
  lines: z.array(line).max(1000),
  subtotals: z.strictObject({ accommodation: signedDigits, participation: signedDigits, extras: signedDigits, subtotal: signedDigits }),
  surchargesMinor: digits,
  discountsMinor: digits,
  totalMinor: digits,
  perTraveller: z.array(z.strictObject({ slot, amountMinor: signedDigits })).max(80),
  unattributedMinor: signedDigits,
  depositMinor: digits,
  balanceMinor: digits,
  balanceDueDate: isoDate,
  fullPaymentDue: z.boolean(),
  promo: z.strictObject({ status: z.enum(['none', 'applied', 'not_combinable', 'conditions_not_met', 'invalid']) }),
  trace: z.array(z.strictObject({
    ruleId: uuid,
    outcome: z.enum(['applied', 'disabled', 'out_of_validity', 'out_of_scope', 'other_currency', 'conditions_not_met', 'filter_matches_nobody', 'blocked_by_non_stackable']),
  })).max(200),
});

export type SnapshotBreakdown = z.infer<typeof snapshotBreakdownSchema>;
