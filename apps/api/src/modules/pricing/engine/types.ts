// Inputs and outputs of the pure pricing engine (plan 2.1, section 4). Money is bigint in minor units everywhere.

export type ParticipationType = 'runner_with_entry' | 'runner_own_entry' | 'supporter';
export type Component = 'accommodation' | 'participation' | 'extras';
export type Target = Component | 'subtotal';
export const COMPONENTS: readonly Component[] = ['accommodation', 'participation', 'extras'];

/** What the engine needs to know about a package; the catalogue supplies it. */
export interface CatalogueView {
  packageId: string;
  editionId: string;
  currency: string;
  checkInDate: string;
  checkOutDate: string;
  balanceDueDate: string;
  minTravellers: number;
  maxTravellers: number;
  maxExtraNightsBefore: number;
  maxExtraNightsAfter: number;
  deposit: { mode: 'per_person' | 'per_booking'; amountMinor: bigint } | { mode: 'percent'; bps: number } | null;
  rooms: Array<{ id: string; minOccupancy: number; maxOccupancy: number }>;
  participationTypes: ParticipationType[];
  /** Distances offered through the package's entry options. */
  entryDistanceIds: string[];
  /** Extras that are not deleted. */
  extras: Array<{ id: string; pricingUnit: 'per_person' | 'per_booking'; availableTo: 'all' | 'runners' | 'supporters'; mandatory: boolean; maxPerBooking: number | null }>;
}

/** The rates of one price version. */
export interface RatesView {
  priceVersionId: string;
  currency: string;
  roomRates: Array<{ roomOptionId: string; occupancy: number; pricePerPersonMinor: bigint; extraNightPerPersonMinor: bigint; currency: string }>;
  participationRates: Array<{ participationType: ParticipationType; raceDistanceId: string | null; amountPerPersonMinor: bigint; currency: string }>;
  extraRates: Array<{ extraId: string; amountMinor: bigint; currency: string }>;
}

/** Conditions of a rule or a promo code, all of which must hold (plan 2.1, section 5). */
export interface RuleConditions {
  /** Business-zone calendar date, inclusive. */
  bookedOnOrBefore?: string;
  /** Calendar days from today (business zone) to the package's check-in date. */
  minDaysBeforeCheckIn?: number;
  maxDaysBeforeCheckIn?: number;
  minTravellers?: number;
  maxTravellers?: number;
  /** Traveller filter: narrows the base and the "per person" count; a filter nobody matches means the rule does not apply. */
  occupancies?: number[];
  participationTypes?: ParticipationType[];
}

export type RuleKind = 'early_bird' | 'late_supplement' | 'group_discount' | 'occupancy_supplement' | 'custom';

/** The effect shared by PriceRule and PromoCode (plan 0.1, 5.3). Amounts and basis points are never negative. */
export interface Effect {
  effectMode: 'percent' | 'fixed';
  valueBps: number | null;
  valueMinor: bigint | null;
  currency: string | null;
  per: 'person' | 'booking';
  appliesTo: Target;
}

export interface RuleInput extends Effect {
  id: string;
  scopeType: 'global' | 'edition' | 'package';
  scopeId: string | null;
  kind: RuleKind;
  direction: 'discount' | 'surcharge';
  conditions: RuleConditions;
  priority: number;
  stackable: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  enabled: boolean;
}

/** A promo code looked up by the service (2.2). `usable = false` covers unknown, disabled, expired and exhausted alike. */
export interface PromoInput extends Effect {
  id: string;
  usable: boolean;
  scopeType: 'global' | 'edition' | 'package';
  scopeId: string | null;
  conditions: RuleConditions;
  stackable: boolean;
}

export interface EngineRequest {
  rooms: Array<{ roomOptionId: string; travellers: Array<{ participationType: ParticipationType; raceDistanceId?: string | undefined }> }>;
  extraNightsBefore: number;
  extraNightsAfter: number;
  extras: Array<{ extraId: string; travellerSlots?: number[] | undefined; quantity?: number | undefined }>;
}

export type LineKind = 'room' | 'extra_nights' | 'participation' | 'extra' | 'rule' | 'promo';
export type Direction = 'charge' | 'surcharge' | 'discount';

export interface PriceLine {
  key: string;
  component: Target;
  kind: LineKind;
  direction: Direction;
  travellerSlot: number | null;
  refId: string | null;
  unitAmountMinor: bigint;
  quantity: number;
  amountMinor: bigint;
  cappedFromMinor: bigint | null;
  effect: (Omit<Effect, 'currency'> & { kind: string; direction: 'discount' | 'surcharge' }) | null;
}

export type PromoStatus = 'none' | 'applied' | 'not_combinable' | 'conditions_not_met' | 'invalid';

export interface PricedConfiguration {
  packageId: string;
  rooms: Array<{ roomOptionId: string; occupancy: number; travellers: Array<{ slot: number; participationType: ParticipationType; raceDistanceId: string | null }> }>;
  extraNightsBefore: number;
  extraNightsAfter: number;
  extras: Array<{ extraId: string; travellerSlots: number[]; quantity: number }>;
}

export interface RuleTrace {
  ruleId: string;
  outcome: 'applied' | 'disabled' | 'out_of_validity' | 'out_of_scope' | 'other_currency' | 'conditions_not_met' | 'filter_matches_nobody' | 'blocked_by_non_stackable';
}

export interface PriceBreakdown {
  currency: string;
  priceVersionId: string;
  engineVersion: string;
  computedAt: string;
  configuration: PricedConfiguration;
  departureDate: string;
  returnDate: string;
  lines: PriceLine[];
  subtotals: Record<Target, bigint>;
  surchargesMinor: bigint;
  discountsMinor: bigint;
  totalMinor: bigint;
  perTraveller: Array<{ slot: number; amountMinor: bigint }>;
  /** Signed: per-booking charges plus surcharges minus discounts, which belong to no one traveller. */
  unattributedMinor: bigint;
  depositMinor: bigint | null;
  balanceMinor: bigint | null;
  balanceDueDate: string;
  fullPaymentDue: boolean;
  promo: { status: PromoStatus };
  /** Why each rule did or did not apply. The panel preview shows it; the public answer leaves it out. */
  trace: RuleTrace[];
}
