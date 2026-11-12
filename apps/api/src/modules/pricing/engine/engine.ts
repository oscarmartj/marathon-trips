import { MAX_LINE_MINOR, MAX_TOTAL_MINOR } from '@mt/shared';
import { BUSINESS_TIME_ZONE, addDays, calendarDateIn, daysBetween } from './calendar';
import { PricingError } from './errors';
import { MAX_DISCOUNT_BPS, MAX_SURCHARGE_BPS, applyBps, mulDivHalfUp } from './rounding';
import {
  CatalogueView, Component, Effect, EngineRequest, ParticipationType, PriceBreakdown, PriceLine, PricedConfiguration, PromoInput, PromoStatus,
  RatesView, RuleConditions, RuleInput, RuleTrace, Target,
} from './types';

/**
 * Bumped whenever the order or the meaning of any step changes (plan 2.1, section 4). Bookings keep the version that
 * priced them and are never recalculated.
 */
export const ENGINE_VERSION = 'pricing-2.1.0';

const RUNNER_TYPES: readonly ParticipationType[] = ['runner_with_entry', 'runner_own_entry'];
const TARGETS: readonly Target[] = ['accommodation', 'participation', 'extras', 'subtotal'];

interface Traveller {
  slot: number;
  occupancy: number;
  participationType: ParticipationType;
  raceDistanceId: string | null;
}

const fail = (code: string, message: string, details: Record<string, unknown> = {}): never => {
  throw new PricingError(code, message, details);
};

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

function checkLine(amount: bigint, key: string): bigint {
  if (amount < 0n) fail('amount_negative', 'A line cannot be negative', { key });
  if (amount > MAX_LINE_MINOR) fail('amount_above_limit', 'A line is above the allowed amount', { key });
  return amount;
}

// ---- Step 1: validate the configuration against the catalogue ----

function validate(req: EngineRequest, view: CatalogueView): { travellers: Traveller[]; configuration: PricedConfiguration } {
  const roomsById = new Map(view.rooms.map((r) => [r.id, r]));
  const travellers: Traveller[] = [];
  const configuration: PricedConfiguration = { packageId: view.packageId, rooms: [], extraNightsBefore: req.extraNightsBefore, extraNightsAfter: req.extraNightsAfter, extras: [] };
  for (const room of req.rooms) {
    const option = roomsById.get(room.roomOptionId) ?? fail('room_not_in_package', 'This room is not part of the package', { roomOptionId: room.roomOptionId });
    const occupancy = room.travellers.length;
    if (occupancy < option.minOccupancy || occupancy > option.maxOccupancy || occupancy < 1 || occupancy > 4) {
      fail('occupancy_out_of_range', 'This room does not take that many people', { roomOptionId: room.roomOptionId, occupancy });
    }
    const priced: PricedConfiguration['rooms'][number] = { roomOptionId: room.roomOptionId, occupancy, travellers: [] };
    for (const t of room.travellers) {
      if (!view.participationTypes.includes(t.participationType)) fail('participation_not_offered', 'The package does not offer this kind of traveller', { participationType: t.participationType });
      let distance: string | null = null;
      if (t.participationType === 'runner_with_entry') {
        if (!t.raceDistanceId) fail('distance_required', 'A runner with an entry needs a distance');
        if (!view.entryDistanceIds.includes(t.raceDistanceId!)) fail('distance_not_offered', 'The package has no entries for this distance', { raceDistanceId: t.raceDistanceId });
        distance = t.raceDistanceId!;
      } else if (t.raceDistanceId !== undefined) {
        fail('distance_not_allowed', 'Only a runner with an entry takes a distance', { participationType: t.participationType });
      }
      const slot = travellers.length + 1;
      travellers.push({ slot, occupancy, participationType: t.participationType, raceDistanceId: distance });
      priced.travellers.push({ slot, participationType: t.participationType, raceDistanceId: distance });
    }
    configuration.rooms.push(priced);
  }
  if (travellers.length < view.minTravellers || travellers.length > view.maxTravellers) {
    fail('travellers_out_of_range', 'The package does not take that many travellers', { travellers: travellers.length });
  }
  if (req.extraNightsBefore < 0 || req.extraNightsBefore > view.maxExtraNightsBefore || req.extraNightsAfter < 0 || req.extraNightsAfter > view.maxExtraNightsAfter) {
    fail('extra_nights_out_of_range', 'The package does not offer that many extra nights');
  }

  const extrasById = new Map(view.extras.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const eligible = (audience: 'all' | 'runners' | 'supporters', t: Traveller) =>
    audience === 'all' || (audience === 'runners' ? RUNNER_TYPES.includes(t.participationType) : t.participationType === 'supporter');
  const requested = new Map<string, EngineRequest['extras'][number]>();
  for (const e of req.extras) {
    if (seen.has(e.extraId)) fail('extra_duplicated', 'An extra is listed twice', { extraId: e.extraId });
    seen.add(e.extraId);
    if (!extrasById.has(e.extraId)) fail('extra_not_in_package', 'This extra is not part of the package', { extraId: e.extraId });
    requested.set(e.extraId, e);
  }
  // Mandatory extras always count (pricing rule: the total includes every mandatory component), asked for or not.
  for (const extra of [...view.extras].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const asked = requested.get(extra.id);
    if (!asked && !extra.mandatory) continue;
    if (extra.pricingUnit === 'per_person') {
      if (asked?.quantity !== undefined) fail('extra_quantity_invalid', 'A per-person extra takes traveller slots, not a quantity', { extraId: extra.id });
      let slots: number[];
      if (extra.mandatory) {
        slots = travellers.filter((t) => eligible(extra.availableTo, t)).map((t) => t.slot);
      } else {
        const asked2 = asked!.travellerSlots ?? [];
        if (asked2.length === 0) fail('traveller_slot_invalid', 'Choose who takes this extra', { extraId: extra.id });
        if (new Set(asked2).size !== asked2.length) fail('traveller_slot_duplicated', 'A traveller is listed twice for one extra', { extraId: extra.id });
        for (const s of asked2) {
          const t = travellers[s - 1] ?? fail('traveller_slot_invalid', 'No such traveller', { extraId: extra.id, slot: s });
          if (!eligible(extra.availableTo, t)) fail('extra_audience_mismatch', 'This extra is not available to that traveller', { extraId: extra.id, slot: s });
        }
        slots = [...asked2].sort((a, b) => a - b);
      }
      if (extra.maxPerBooking !== null && slots.length > extra.maxPerBooking) fail('extra_quantity_invalid', 'Too many of this extra', { extraId: extra.id });
      if (slots.length > 0) configuration.extras.push({ extraId: extra.id, travellerSlots: slots, quantity: slots.length });
    } else {
      if (asked?.travellerSlots !== undefined) fail('extra_quantity_invalid', 'A per-booking extra takes a quantity, not traveller slots', { extraId: extra.id });
      const quantity = asked?.quantity ?? 1;
      if (quantity < 1 || quantity > (extra.maxPerBooking ?? 1)) fail('extra_quantity_invalid', 'That quantity is not available', { extraId: extra.id, quantity });
      if (extra.availableTo !== 'all' && !travellers.some((t) => eligible(extra.availableTo, t))) {
        if (extra.mandatory) continue;
        fail('extra_audience_mismatch', 'This extra is not available to anyone in the booking', { extraId: extra.id });
      }
      configuration.extras.push({ extraId: extra.id, travellerSlots: [], quantity });
    }
  }
  return { travellers, configuration };
}

// ---- Effects of rules and promo codes ----

function validateEffect(e: Effect & { direction: 'discount' | 'surcharge' }, id: string): void {
  const bad = (why: string) => fail('rule_invalid', `Rule or code ${why}`, { id });
  if (!TARGETS.includes(e.appliesTo)) bad('has an unknown target');
  if (e.effectMode === 'percent') {
    if (e.valueBps === null || e.valueMinor !== null) bad('mixes percent and fixed');
    const max = e.direction === 'discount' ? MAX_DISCOUNT_BPS : MAX_SURCHARGE_BPS;
    if (!Number.isInteger(e.valueBps) || e.valueBps! < 0 || e.valueBps! > max) bad('has basis points out of range');
    if (e.per === 'person') bad('is a percentage per person');
  } else {
    if (e.valueMinor === null || e.valueBps !== null || e.currency === null) bad('needs an amount and its currency');
    if (e.valueMinor! < 0n || e.valueMinor! > MAX_LINE_MINOR) bad('has an amount out of range');
  }
}

function validateConditions(c: RuleConditions, kind: string, id: string): void {
  const bad = (why: string) => fail('rule_invalid', `Rule ${why}`, { id });
  const nonNegInt = (x: number | undefined) => x === undefined || (Number.isInteger(x) && x >= 0);
  if (!nonNegInt(c.minDaysBeforeCheckIn) || !nonNegInt(c.maxDaysBeforeCheckIn) || !nonNegInt(c.minTravellers) || !nonNegInt(c.maxTravellers)) bad('has an invalid number');
  if (c.occupancies && (c.occupancies.length === 0 || c.occupancies.some((o) => !Number.isInteger(o) || o < 1 || o > 4))) bad('has invalid occupancies');
  if (c.participationTypes && c.participationTypes.length === 0) bad('has an empty participation filter');
  if (kind === 'early_bird' && c.bookedOnOrBefore === undefined && c.minDaysBeforeCheckIn === undefined) bad('early_bird needs a date or a number of days');
  if (kind === 'late_supplement' && c.maxDaysBeforeCheckIn === undefined) bad('late_supplement needs a number of days');
  if (kind === 'group_discount' && c.minTravellers === undefined) bad('group_discount needs a minimum of travellers');
  if (kind === 'occupancy_supplement' && !c.occupancies) bad('occupancy_supplement needs occupancies');
}

/** Booking-level conditions; the traveller filter is applied separately. */
function conditionsHold(c: RuleConditions, today: string, view: CatalogueView, travellerCount: number): boolean {
  const days = daysBetween(today, view.checkInDate);
  if (c.bookedOnOrBefore !== undefined && today > c.bookedOnOrBefore) return false;
  if (c.minDaysBeforeCheckIn !== undefined && days < c.minDaysBeforeCheckIn) return false;
  if (c.maxDaysBeforeCheckIn !== undefined && days > c.maxDaysBeforeCheckIn) return false;
  if (c.minTravellers !== undefined && travellerCount < c.minTravellers) return false;
  if (c.maxTravellers !== undefined && travellerCount > c.maxTravellers) return false;
  return true;
}

const hasFilter = (c: RuleConditions) => c.occupancies !== undefined || c.participationTypes !== undefined;
const matches = (c: RuleConditions, t: Traveller) =>
  (c.occupancies === undefined || c.occupancies.includes(t.occupancy)) && (c.participationTypes === undefined || c.participationTypes.includes(t.participationType));

const inScope = (e: { scopeType: string; scopeId: string | null }, view: CatalogueView) =>
  e.scopeType === 'global' || (e.scopeType === 'package' && e.scopeId === view.packageId) || (e.scopeType === 'edition' && e.scopeId === view.editionId);

/**
 * A fixed effect in another currency is never applied (plan 0.1, 5.3): global ones are skipped, package and edition
 * ones are a configuration error.
 */
function currencyOk(e: Effect & { scopeType: string }, view: CatalogueView, id: string): boolean {
  if (e.effectMode !== 'fixed' || e.currency === view.currency) return true;
  if (e.scopeType === 'global') return false;
  return fail('currency_mismatch', 'A rule or code is in another currency', { id });
}

// ---- The engine ----

/**
 * price(request, catalogue, rates, rules, promo, now) → breakdown. Pure: no database, no clock, no floating point.
 * Steps in a fixed order (plan 2.1, section 4): validate, base lines, bases per target, surcharges, discounts (each
 * capped as it applies, so nothing goes below zero), promo code, total, deposit.
 */
export function price(req: EngineRequest, view: CatalogueView, rates: RatesView, rules: readonly RuleInput[], promo: PromoInput | null, now: Date): PriceBreakdown {
  if (rates.currency !== view.currency) fail('currency_mismatch', 'The price version is in another currency');
  const { travellers, configuration } = validate(req, view);
  const today = calendarDateIn(now, BUSINESS_TIME_ZONE);
  const nights = req.extraNightsBefore + req.extraNightsAfter;

  // ---- Step 3: base lines ----
  const lines: PriceLine[] = [];
  const own = (currency: string, what: Record<string, unknown>) => {
    if (currency !== view.currency) fail('currency_mismatch', 'A rate is in another currency', what);
  };
  const base = (component: Component, kind: PriceLine['kind'], key: string, slot: number | null, refId: string | null, unit: bigint, quantity: number) => {
    lines.push({ key, component, kind, direction: 'charge', travellerSlot: slot, refId, unitAmountMinor: unit, quantity, amountMinor: checkLine(unit * BigInt(quantity), key), cappedFromMinor: null, effect: null });
  };
  for (const room of configuration.rooms) {
    const rate = rates.roomRates.find((r) => r.roomOptionId === room.roomOptionId && r.occupancy === room.occupancy)
      ?? fail('rate_missing', 'No price for this room and occupancy', { kind: 'room', roomOptionId: room.roomOptionId, occupancy: room.occupancy });
    own(rate.currency, { roomOptionId: room.roomOptionId });
    for (const t of room.travellers) {
      base('accommodation', 'room', `room:${t.slot}`, t.slot, room.roomOptionId, rate.pricePerPersonMinor, 1);
      if (nights > 0) base('accommodation', 'extra_nights', `nights:${t.slot}`, t.slot, room.roomOptionId, rate.extraNightPerPersonMinor, nights);
    }
  }
  for (const t of travellers) {
    const rate = rates.participationRates.find((r) => r.participationType === t.participationType && r.raceDistanceId === t.raceDistanceId)
      ?? fail('rate_missing', 'No price for this kind of traveller', { kind: 'participation', participationType: t.participationType, raceDistanceId: t.raceDistanceId });
    own(rate.currency, { participationType: t.participationType });
    base('participation', 'participation', `participation:${t.slot}`, t.slot, t.raceDistanceId, rate.amountPerPersonMinor, 1);
  }
  for (const e of configuration.extras) {
    const rate = rates.extraRates.find((r) => r.extraId === e.extraId) ?? fail('rate_missing', 'No price for this extra', { kind: 'extra', extraId: e.extraId });
    own(rate.currency, { extraId: e.extraId });
    if (e.travellerSlots.length > 0) for (const s of e.travellerSlots) base('extras', 'extra', `extra:${e.extraId}:${s}`, s, e.extraId, rate.amountMinor, 1);
    else base('extras', 'extra', `extra:${e.extraId}`, null, e.extraId, rate.amountMinor, e.quantity);
  }

  // ---- Step 4: bases per target, and what is left of each as rules apply ----
  const baseOf = (target: Target, slots: Set<number> | null) =>
    sum(lines.filter((l) => (target === 'subtotal' || l.component === target) && (slots === null || (l.travellerSlot !== null && slots.has(l.travellerSlot)))).map((l) => l.amountMinor));
  const subtotals = {} as Record<Target, bigint>;
  for (const t of TARGETS) subtotals[t] = baseOf(t, null);
  const net: Record<Component, bigint> = { accommodation: subtotals.accommodation, participation: subtotals.participation, extras: subtotals.extras };
  let netTotal = subtotals.subtotal;

  const amountOf = (e: Effect, onAmount: bigint, persons: number, max: number): bigint =>
    e.effectMode === 'percent' ? applyBps(onAmount, e.valueBps!, max) : e.valueMinor! * BigInt(e.per === 'person' ? persons : 1);

  /** Applies one surcharge or discount line; a discount is capped, at the moment it applies, to what is left. */
  const apply = (id: string, kind: 'rule' | 'promo', ruleKind: string, direction: 'discount' | 'surcharge', e: Effect, persons: number, wanted: bigint, filteredBase: bigint | null) => {
    const target = e.appliesTo;
    const perPerson = e.effectMode === 'fixed' && e.per === 'person';
    let amount = wanted;
    if (direction === 'discount') {
      const left = target === 'subtotal' ? netTotal : (net[target] < netTotal ? net[target] : netTotal);
      const ceiling = filteredBase !== null && filteredBase < left ? filteredBase : left;
      if (amount > ceiling) amount = ceiling;
      if (target !== 'subtotal') net[target] -= amount;
      netTotal -= amount;
    } else {
      if (target !== 'subtotal') net[target] += amount;
      netTotal += amount;
    }
    const key = `${kind}:${id}`;
    lines.push({
      key, component: target, kind, direction, travellerSlot: null, refId: id,
      unitAmountMinor: perPerson ? e.valueMinor! : wanted, quantity: perPerson ? persons : 1, amountMinor: checkLine(amount, key),
      cappedFromMinor: amount === wanted ? null : wanted,
      effect: { kind: ruleKind, direction, effectMode: e.effectMode, valueBps: e.valueBps, valueMinor: e.valueMinor, per: e.per, appliesTo: e.appliesTo },
    });
    if (direction === 'discount' && netTotal < 0n) fail('total_negative', 'Internal error: the total went below zero');
  };

  // ---- Step 5: automatic rules. Surcharges first, then discounts; each by priority, then id ----
  const trace: RuleTrace[] = [];
  const applicable: Array<{ rule: RuleInput; slots: Set<number> | null }> = [];
  for (const rule of rules) {
    validateEffect(rule, rule.id);
    validateConditions(rule.conditions, rule.kind, rule.id);
    if (!rule.enabled) { trace.push({ ruleId: rule.id, outcome: 'disabled' }); continue; }
    if ((rule.validFrom && now.getTime() < rule.validFrom.getTime()) || (rule.validTo && now.getTime() >= rule.validTo.getTime())) { trace.push({ ruleId: rule.id, outcome: 'out_of_validity' }); continue; }
    if (!inScope(rule, view)) { trace.push({ ruleId: rule.id, outcome: 'out_of_scope' }); continue; }
    if (!currencyOk(rule, view, rule.id)) { trace.push({ ruleId: rule.id, outcome: 'other_currency' }); continue; }
    if (!conditionsHold(rule.conditions, today, view, travellers.length)) { trace.push({ ruleId: rule.id, outcome: 'conditions_not_met' }); continue; }
    let slots: Set<number> | null = null;
    if (hasFilter(rule.conditions)) {
      slots = new Set(travellers.filter((t) => matches(rule.conditions, t)).map((t) => t.slot));
      if (slots.size === 0) { trace.push({ ruleId: rule.id, outcome: 'filter_matches_nobody' }); continue; }
    }
    applicable.push({ rule, slots });
  }
  applicable.sort((a, b) =>
    a.rule.direction !== b.rule.direction ? (a.rule.direction === 'surcharge' ? -1 : 1)
      : a.rule.priority !== b.rule.priority ? a.rule.priority - b.rule.priority
        : a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0);
  // Stacking by group (direction, target): a non-stackable rule applies only to an empty group and closes it.
  const groups = new Map<string, { count: number; closed: boolean }>();
  const discountedTargets = new Set<Target>();
  for (const { rule, slots } of applicable) {
    const g = groups.get(`${rule.direction}:${rule.appliesTo}`) ?? { count: 0, closed: false };
    if (g.closed || (!rule.stackable && g.count > 0)) { trace.push({ ruleId: rule.id, outcome: 'blocked_by_non_stackable' }); continue; }
    const filteredBase = slots === null ? null : baseOf(rule.appliesTo, slots);
    const onAmount = filteredBase ?? subtotals[rule.appliesTo];
    const persons = slots === null ? travellers.length : slots.size;
    const wanted = amountOf(rule, onAmount, persons, rule.direction === 'discount' ? MAX_DISCOUNT_BPS : MAX_SURCHARGE_BPS);
    apply(rule.id, 'rule', rule.kind, rule.direction, rule, persons, wanted, rule.direction === 'discount' ? filteredBase : null);
    g.count += 1;
    if (!rule.stackable) g.closed = true;
    groups.set(`${rule.direction}:${rule.appliesTo}`, g);
    if (rule.direction === 'discount') discountedTargets.add(rule.appliesTo);
    trace.push({ ruleId: rule.id, outcome: 'applied' });
  }

  // ---- Step 7: promo code, on what is left of its target after the rules ----
  let promoStatus: PromoStatus = 'none';
  if (promo) {
    if (promo.usable) {
      validateEffect({ ...promo, direction: 'discount' }, promo.id);
      validateConditions(promo.conditions, 'custom', promo.id);
    }
    if (!promo.usable || !inScope(promo, view) || !currencyOk(promo, view, promo.id)) promoStatus = 'invalid';
    else if (!conditionsHold(promo.conditions, today, view, travellers.length)) promoStatus = 'conditions_not_met';
    else {
      const slots = hasFilter(promo.conditions) ? new Set(travellers.filter((t) => matches(promo.conditions, t)).map((t) => t.slot)) : null;
      if (slots !== null && slots.size === 0) promoStatus = 'conditions_not_met';
      else if (!promo.stackable && discountedTargets.has(promo.appliesTo)) promoStatus = 'not_combinable';
      else {
        const target = promo.appliesTo;
        const filteredBase = slots === null ? null : baseOf(target, slots);
        const left = target === 'subtotal' ? netTotal : net[target];
        const persons = slots === null ? travellers.length : slots.size;
        // On what is left of the target after the rules (plan 2.1, section 4, step 7). Rules are not split by traveller, so
        // with a traveller filter the code takes the filtered travellers' share of what is left, in proportion to their
        // base (code review, round 2), rounded by the one rule.
        const targetBase = subtotals[target];
        const on = filteredBase === null ? left : targetBase === 0n ? 0n : mulDivHalfUp(2n * left, filteredBase, 2n * targetBase);
        const wanted = amountOf(promo, on, persons, MAX_DISCOUNT_BPS);
        apply(promo.id, 'promo', 'promo_code', 'discount', promo, persons, wanted, filteredBase);
        promoStatus = 'applied';
      }
    }
  }

  // ---- Step 8: total, checked against an independent sum of the lines ----
  const of = (d: PriceLine['direction']) => sum(lines.filter((l) => l.direction === d).map((l) => l.amountMinor));
  const surcharges = of('surcharge');
  const discounts = of('discount');
  const total = of('charge') + surcharges - discounts;
  if (total !== netTotal || total < 0n) fail('total_inconsistent', 'Internal error: the total does not add up');
  if (total > MAX_TOTAL_MINOR) fail('amount_above_limit', 'The total is above the allowed amount');

  const perTraveller = travellers.map((t) => ({ slot: t.slot, amountMinor: sum(lines.filter((l) => l.travellerSlot === t.slot).map((l) => l.amountMinor)) }));
  const unattributed = sum(lines.filter((l) => l.travellerSlot === null).map((l) => (l.direction === 'discount' ? -l.amountMinor : l.amountMinor)));
  if (sum(perTraveller.map((p) => p.amountMinor)) + unattributed !== total) fail('total_inconsistent', 'Internal error: travellers do not add up to the total');

  // ---- Step 9: deposit and balance ----
  const fullPaymentDue = today >= view.balanceDueDate;
  let deposit: bigint | null = null;
  if (view.deposit) {
    deposit = view.deposit.mode === 'percent' ? applyBps(total, view.deposit.bps) : view.deposit.amountMinor * BigInt(view.deposit.mode === 'per_person' ? travellers.length : 1);
    if (deposit > total || fullPaymentDue) deposit = total;
  }

  return {
    currency: view.currency,
    priceVersionId: rates.priceVersionId,
    engineVersion: ENGINE_VERSION,
    computedAt: now.toISOString(),
    configuration,
    departureDate: addDays(view.checkInDate, -req.extraNightsBefore),
    returnDate: addDays(view.checkOutDate, req.extraNightsAfter),
    lines,
    subtotals,
    surchargesMinor: surcharges,
    discountsMinor: discounts,
    totalMinor: total,
    perTraveller,
    unattributedMinor: unattributed,
    depositMinor: deposit,
    balanceMinor: deposit === null ? null : total - deposit,
    balanceDueDate: view.balanceDueDate,
    fullPaymentDue,
    promo: { status: promoStatus },
    trace,
  };
}

